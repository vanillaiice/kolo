import { parseArgs } from "node:util";
import { canonicalJson } from "@kolo/contracts/canonical";
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { initializeTill, TillState } from "./till-state.ts";
import { transferCrypto, sealingCrypto } from "./crypto.ts";
import { allProducts, importData } from "./till-import.ts";
import { currentInstallation } from "@kolo/core/identity/workspace";
import { previewPairingInvite, acceptPairingInvite, completePairing, cancelPairing } from "@kolo/core/application/pairing";
import { exchangeDestinations, exportBundle, previewBundle, importBundle, exportReceipt, importReceipt, exchangeDiagnostics } from "@kolo/core/application/file-exchange";
import { createBackup } from "@kolo/core/application/backup";
import { sealPendingEvents } from "@kolo/core/application/exchange";
import { pendingShopServer, connectServer, serverConnections, synchronizeServer, previewServer, normalizeServerUrl, type SyncTransport } from "@kolo/core/application/server-sync";
import { createHttpSyncTransport } from "@kolo/core/application/http-sync-transport";
import { lookupJoin, requestJoin, finishJoin } from "@kolo/core/application/join";
import { parseJoinLink, normalizeJoinCode } from "@kolo/contracts/sync";
import { LARGE_TRANSFER_LIMITS } from "@kolo/core/backup/types";
import * as reports from "@kolo/core/application/reports";
import type { OperationContext } from "@kolo/core/identity/types";
import { reportNames, type ReportName } from "./inspection.ts";
import { readSecretFile } from "./secrets.ts";

export const tillHelp = `kolo till — a separately paired headless device

  init --state DIR
  status --state DIR
  pair inspect INVITE
  pair request INVITE --state DIR --fingerprint HEX --label NAME --out REQUEST
  pair complete ENROLLMENT --state DIR --code HEX
  pair cancel --state DIR
  join inspect LINK_OR_CODE [--url URL --fingerprint HEX]
  join request LINK_OR_CODE --state DIR --label NAME [--url URL --fingerprint HEX]
  join complete --state DIR
  connect --state DIR [--url URL --fingerprint HEX]
  sync --state DIR [--destination ID]
  peers --state DIR
  exchange export --state DIR --destination ID --out FILE
  exchange preview|import FILE --state DIR
  exchange receipt --state DIR --batch ID --out FILE
  exchange acknowledge FILE --state DIR --destination ID
  import products|prices|stock FILE --state DIR
  export products --state DIR [--out FILE]
  report ${reportNames.join("|")} --state DIR [--from ISO --to ISO --out FILE]
  backup --state DIR --out FILE

Use KOLO_TILL_SECRET or --secret-file for this till's local code/password.
Encrypted transfer files use KOLO_BACKUP_PASSWORD or --password-file (max 4 KB).
Import JSON: {"id":"unique UUID", "rows":[...]}; see apps/cli/README.md.
Commands hold one exclusive state lock. Join completion returns pending until
the owner allows this till; repeat it to poll. Use cron/systemd for schedules.
`;
function read(path: string, maximum = LARGE_TRANSFER_LIMITS.fileBytes): string {
  if (statSync(path).size > maximum) throw new Error("Input exceeds the supported size limit");
  return readFileSync(path, "utf8");
}
function secret(file: string | undefined, env: NodeJS.ProcessEnv, key: string): string {
  const result = file !== undefined ? readSecretFile(file) : env[key];
  if (!result) throw new Error(`Set ${key} or pass ${key === "KOLO_TILL_SECRET" ? "--secret-file" : "--password-file"}`);
  return result;
}
function period(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Use a UTC ISO date or timestamp");
  const result = new Date(value).toISOString();
  if (result.slice(0, 10) !== value.slice(0, 10)) throw new Error("Invalid calendar date"); return result;
}
function liveReport(context: OperationContext, name: ReportName, from: string, to: string): unknown {
  switch (name) {
    case "sales": return reports.salesBetween(context, from, to);
    case "profit": return reports.profitBetween(context, from, to);
    case "purchases": return reports.purchasesBetween(context, from, to);
    case "inventory": return reports.inventoryValuation(context);
    case "cash": return reports.cashFlow(context, from, to);
    case "customers": return reports.outstandingDebt(context);
    case "suppliers": return reports.supplierDebt(context);
  }
}
interface JoinSettings { url: string; fingerprint: string; code: string }
interface PendingJoin extends JoinSettings { businessId: string }
interface PendingPair { installationId: string; verificationCode: string }
export async function runTill(args: string[], env: NodeJS.ProcessEnv, stdout: (text: string) => void, transportOf: (url: string) => SyncTransport = createHttpSyncTransport): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, state: { type: "string" }, out: { type: "string" }, label: { type: "string" },
    fingerprint: { type: "string" }, code: { type: "string" }, url: { type: "string" }, destination: { type: "string" }, batch: { type: "string" },
    "secret-file": { type: "string" }, "password-file": { type: "string" }, from: { type: "string" }, to: { type: "string" },
  } });
  if (values.help || positionals.length === 0) { stdout(tillHelp); return 0; }
  const [command, action, input] = positionals;
  const emit = (value: unknown): void => { stdout(JSON.stringify(value, null, 2) + "\n"); };
  const write = (data: string): void => {
    if (!values.out) throw new Error("This command requires --out");
    writeFileSync(values.out, data, { flag: "wx", mode: 0o600 });
  };
  const result = (value: unknown): void => { const text = JSON.stringify(value, null, 2) + "\n"; if (values.out) write(text); else stdout(text); };
  const localSecret = (): string => secret(values["secret-file"], env, "KOLO_TILL_SECRET");
  const password = (): string => secret(values["password-file"], env, "KOLO_BACKUP_PASSWORD");
  const required = (value: string | undefined, what: string): string => { if (!value) throw new Error(`${what} is required`); return value; };
  const allowed: Record<string, { positional: number; flags: string[] }> = {
    init: { positional: 1, flags: ["state"] }, status: { positional: 1, flags: ["state"] },
    "pair inspect": { positional: 3, flags: [] },
    "pair request": { positional: 3, flags: ["state", "fingerprint", "label", "out", "secret-file"] },
    "pair complete": { positional: 3, flags: ["state", "code", "password-file"] },
    "pair cancel": { positional: 2, flags: ["state"] },
    "join inspect": { positional: 3, flags: ["url", "fingerprint"] },
    "join request": { positional: 3, flags: ["state", "label", "url", "fingerprint", "secret-file"] },
    "join complete": { positional: 2, flags: ["state"] },
    connect: { positional: 1, flags: ["state", "url", "fingerprint", "secret-file"] },
    sync: { positional: 1, flags: ["state", "destination", "secret-file"] }, peers: { positional: 1, flags: ["state", "secret-file"] },
    "exchange export": { positional: 2, flags: ["state", "destination", "out", "password-file", "secret-file"] },
    "exchange preview": { positional: 3, flags: ["state", "password-file", "secret-file"] },
    "exchange import": { positional: 3, flags: ["state", "password-file", "secret-file"] },
    "exchange receipt": { positional: 2, flags: ["state", "batch", "out", "password-file", "secret-file"] },
    "exchange acknowledge": { positional: 3, flags: ["state", "destination", "password-file", "secret-file"] },
    import: { positional: 3, flags: ["state", "secret-file"] }, export: { positional: 2, flags: ["state", "out", "secret-file"] },
    report: { positional: 2, flags: ["state", "out", "from", "to", "secret-file"] },
    backup: { positional: 1, flags: ["state", "out", "password-file", "secret-file"] },
  };
  const key = ["pair", "join", "exchange"].includes(command ?? "") ? `${command} ${action}` : command ?? "";
  const specification = allowed[key];
  if (!specification || positionals.length !== specification.positional) throw new Error("Invalid till command; use kolo till --help");
  for (const flag of Object.keys(values)) if (!specification.flags.includes(flag)) throw new Error(`--${flag} is not supported for ${key}`);
  // Resolve required outputs before operations that persist pairing/delivery state.
  if (["pair request", "exchange export", "exchange receipt", "backup"].includes(key)) required(values.out, "--out");
  if (values.out && existsSync(values.out)) throw new Error("Output already exists");
  if (key === "pair inspect") { emit(await previewPairingInvite(read(input!, 65536), transferCrypto)); return 0; }
  const joinSettings = (): JoinSettings => {
    const link = parseJoinLink(input!);
    if (link) {
      if (values.url || values.fingerprint) throw new Error("Join links already contain the server address and fingerprint");
      return { ...link, url: normalizeServerUrl(link.url) };
    }
    const code = normalizeJoinCode(input!);
    if (!code) throw new Error("Invalid join link or code");
    return { code, url: normalizeServerUrl(required(values.url, "--url")), fingerprint: required(values.fingerprint, "--fingerprint") };
  };
  const checkedTransport = async (settings: JoinSettings): Promise<SyncTransport> => {
    const transport = transportOf(settings.url), identity = await previewServer(transport, transferCrypto);
    if (identity.fingerprint !== settings.fingerprint.toLowerCase().replace(/\s/g, "")) throw new Error("fingerprint_mismatch");
    return transport;
  };
  if (key === "join inspect") { const settings = joinSettings(); const invitation = await lookupJoin(await checkedTransport(settings), sealingCrypto, settings.code); emit({ businessName: invitation.businessName, ownerName: invitation.ownerName, authorityAllowed: invitation.authorityAllowed }); return 0; }
  const statePath = required(values.state, "--state");
  if (command === "init") { initializeTill(statePath); emit({ initialized: true }); return 0; }
  const till = new TillState(statePath);
  try {
    if (command === "status") { emit({ ...currentInstallation(till.database), pairingPending: till.database.get("SELECT id FROM workspace_enrollment WHERE id=1") !== undefined }); return 0; }
    if (key === "pair request") {
      const accepted = await acceptPairingInvite(read(input!, 65536), { confirmedFingerprint: required(values.fingerprint, "--fingerprint"), label: required(values.label, "--label"), platform: "DESKTOP", secret: localSecret() }, till.ports(), transferCrypto);
      const request = JSON.parse(accepted.document.text) as { request: { installation_id: string } };
      await till.store.write("kolo.cli.pair", JSON.stringify({ installationId: request.request.installation_id, verificationCode: accepted.verificationCode } satisfies PendingPair));
      write(accepted.document.text); emit({ request: values.out, verificationCode: accepted.verificationCode }); return 0;
    }
    if (key === "pair complete") {
      const saved = await till.store.read("kolo.cli.pair"), state = currentInstallation(till.database);
      if (saved && (state.state === "locked" || state.state === "unlocked")) {
        const pending = JSON.parse(saved) as PendingPair;
        if (pending.installationId !== state.installation.installationId || pending.verificationCode !== required(values.code, "--code")) throw new Error("confirmation_required");
        await till.store.forget("kolo.cli.pair"); emit({ paired: true, installation: state.installation }); return 0;
      }
      const completed = await completePairing(read(input!), password(), required(values.code, "--code"), till.ports(), till.files, transferCrypto);
      till.adopt(completed.database); await till.store.forget("kolo.cli.pair"); emit({ paired: true, installation: completed.installation }); return 0;
    }
    if (key === "pair cancel") { cancelPairing(till.ports()); await till.store.forget("kolo.cli.join"); await till.store.forget("kolo.cli.pair"); emit({ cancelled: true }); return 0; }
    if (key === "join request") {
      const settings = joinSettings(), transport = await checkedTransport(settings), invitation = await lookupJoin(transport, sealingCrypto, settings.code);
      if (currentInstallation(till.database).state !== "empty") throw new Error("not_empty");
      // Persist the mailbox before posting, so a network interruption is resumable.
      const saved = await till.store.read("kolo.cli.join");
      const record: PendingJoin = { ...settings, businessId: (JSON.parse(invitation.inviteText) as { invite: { business_id: string } }).invite.business_id };
      if (saved && canonicalJson(record) !== canonicalJson(JSON.parse(saved))) throw new Error("A different join is pending; complete or cancel it first");
      await till.store.write("kolo.cli.join", canonicalJson(record));
      await requestJoin(settings.code, invitation, { label: required(values.label, "--label"), platform: "DESKTOP", secret: localSecret() }, till.ports(), transport, sealingCrypto);
      emit({ requested: true, businessName: invitation.businessName, ownerName: invitation.ownerName }); return 0;
    }
    if (key === "join complete") {
      const saved = await till.store.read("kolo.cli.join"); if (!saved) throw new Error("No join is pending");
      const settings = JSON.parse(saved) as PendingJoin, state = currentInstallation(till.database);
      if (state.state === "locked" || state.state === "unlocked") {
        if (state.installation.businessId !== settings.businessId) throw new Error("scope_mismatch");
        await till.store.forget("kolo.cli.join"); emit({ paired: true, installation: state.installation }); return 0;
      }
      const transport = await checkedTransport(settings);
      const completed = await finishJoin(settings.code, till.ports(), till.files, transport, sealingCrypto);
      if (!completed) { emit({ pending: true }); return 0; }
      till.adopt(completed.database); await till.store.forget("kolo.cli.join"); emit({ paired: true, installation: completed.installation }); return 0;
    }
    if (command === "import") { emit(await importData(till, action!, JSON.parse(read(input!, 16 * 1024 * 1024)), localSecret())); return 0; }
    const context = await till.unlock(localSecret());
    if (command === "connect") {
      let settings = pendingShopServer(context);
      if (values.url || values.fingerprint) settings = { url: normalizeServerUrl(required(values.url, "--url")), fingerprint: required(values.fingerprint, "--fingerprint"), serverDeviceId: "" };
      if (!settings) throw new Error("No shared server endpoint; provide --url and --fingerprint");
      emit({ destinationId: await connectServer(context, transportOf(settings.url), { url: settings.url, fingerprint: settings.fingerprint, source: "shop" }, transferCrypto) }); return 0;
    }
    if (command === "sync") {
      let connections = await serverConnections(context, transferCrypto);
      if (values.destination) { connections = connections.filter(connection => connection.destinationId === values.destination); if (!connections.length) throw new Error("Unknown server destination"); }
      if (!connections.length) throw new Error("Connect this till to its shop server first");
      const summaries = [];
      for (const connection of connections) summaries.push({ destinationId: connection.destinationId, ...await synchronizeServer(context, connection.destinationId, transportOf(connection.url), sealingCrypto) });
      emit(summaries); return summaries.some(summary => summary.rejected > 0 || summary.untrusted > 0 || summary.locked > 0) ? 1 : 0;
    }
    if (command === "peers") { emit({ peers: exchangeDestinations(context), servers: await serverConnections(context, transferCrypto), diagnostics: exchangeDiagnostics(context, "en") }); return 0; }
    if (command === "exchange") {
      if (action === "export") {
        const document = await exportBundle(context, required(values.destination, "--destination"), password(), transferCrypto);
        if (document) write(document.text); emit({ exported: Boolean(document), output: document ? values.out : null }); return 0;
      }
      if (action === "preview" || action === "import") {
        const preview = await previewBundle(context, read(input!), password(), transferCrypto);
        if (action === "preview") { emit(preview); return 0; }
        const outcomes = await importBundle(context, preview, transferCrypto); emit({ batchId: preview.batchId, outcomes });
        return outcomes.some(item => !["applied", "duplicate"].includes(item.outcome)) ? 1 : 0;
      }
      if (action === "receipt") {
        const document = await exportReceipt(context, required(values.batch, "--batch"), password(), transferCrypto);
        if (!document) throw new Error("Unknown completed batch"); write(document.text); emit({ output: values.out }); return 0;
      }
      emit({ acknowledged: await importReceipt(context, required(values.destination, "--destination"), read(input!), password(), transferCrypto) }); return 0;
    }
    if (command === "export") { if (action !== "products") throw new Error("Live export supports products; use offline export for other tables"); result(allProducts(context)); return 0; }
    if (command === "report") {
      if (!reportNames.includes(action as ReportName)) throw new Error("Unknown report");
      const from = period(values.from, "0001-01-01T00:00:00.000Z"), to = period(values.to, "9999-12-31T23:59:59.999Z");
      if (from >= to) throw new Error("--from must be before --to"); result(liveReport(context, action as ReportName, from, to)); return 0;
    }
    while (await sealPendingEvents(context, transferCrypto, 1000) === 1000) { /* Drain before capture. */ }
    write((await createBackup(context, password(), till.files, transferCrypto)).text); emit({ output: values.out }); return 0;
  } finally { till.close(); }
}
