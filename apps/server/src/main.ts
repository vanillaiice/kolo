import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { createApplication } from "./app.js";
import { readConfig } from "./config.js";
import { migrateToLatest, openDatabase, schemaCurrent } from "./database.js";
import { loadServerKey } from "./identity.js";
import { createAdminApplication } from "./admin/admin-app.js";
import { createAdmin, resetTotp } from "./admin/accounts.js";
import { CLI_ACTOR, createMetrics, issueCode, purgeRemovedShops } from "./admin/operations.js";

const config = readConfig();
const [command, ...args] = process.argv.slice(2);
const option = (name: string): string | undefined => { const index = args.indexOf(`--${name}`); return index === -1 ? undefined : args[index + 1]; };
const flag = (name: string): boolean => args.includes(`--${name}`);
const fail = (message: string): never => { process.stderr.write(`${message}\n`); process.exit(1); };
const version = (() => { try { return String((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version); } catch { return "unknown"; } })();
const uiDir = config.adminUiDir ?? (() => { const built = fileURLToPath(new URL("../../admin/dist", import.meta.url)); return existsSync(built) ? built : undefined; })();
const usage = `Usage: node dist/main.js [command]
  (none)                         serve sync and, unless KOLO_ADMIN_PORT=off, the operator dashboard
  migrate [--discard-plaintext]  apply schema migrations and exit
  invite --label <shop> [--days 7] [--months 0]   issue a single-use code for one shop (hosted: with paid months)
  admin create <username> [--role admin|viewer] [--password-stdin]
  admin reset-totp <username>    replace an operator's authenticator secret
  purge                          delete shops removed more than 30 days ago
`;

async function withDatabase<T>(work: (db: ReturnType<typeof openDatabase>) => Promise<T>): Promise<T> {
  if (config.databaseUrl === undefined) fail("DATABASE_URL is required");
  const db = openDatabase(config.databaseUrl!);
  try {
    if (command !== "migrate" && !await schemaCurrent(db)) fail("The schema is not current: run migrate first");
    return await work(db);
  } finally { await db.destroy(); }
}
async function readStdin(): Promise<string> { let text = ""; for await (const chunk of process.stdin) text += String(chunk); return text.replace(/\r?\n$/, ""); }
async function authenticatorQr(uri: string): Promise<string> { return QRCode.toString(uri, { type: "terminal", small: true }); }

if (command === "help" || command === "--help") process.stdout.write(usage);
// `migrate` applies pending schema migrations explicitly and exits; serving never migrates on its own.
else if (command === "migrate") {
  await withDatabase(async db => {
    try {
      const applied = await migrateToLatest(db, { discardPlaintext: flag("discard-plaintext") });
      process.stdout.write(applied.length === 0 ? "Schema already current\n" : `Applied ${applied.join(", ")}\n`);
    } catch (error) {
      const detail = String((error as { cause?: { message?: unknown } }).cause?.message ?? "");
      process.stderr.write(detail.includes("discard-plaintext") ? `Migration refused: ${detail}\n` : "Migration failed; the schema was left at its previous version\n");
      process.exitCode = 1;
    }
  });
} else if (command === "invite") {
  const label = option("label") ?? fail("Give the shop a name: invite --label \"Shop name\""), days = Number(option("days") ?? "7");
  if (config.publicUrl === undefined) fail("Set KOLO_PUBLIC_URL to the address tills use to reach this server");
  const key = loadServerKey(config.keyFile ?? ".kolo-server-key.json");
  const months = config.edition === "hosted" ? Number(option("months") ?? "0") : 0;
  const issued = await withDatabase(db => issueCode(db, key, config.publicUrl!, CLI_ACTOR, { label, days, now: new Date(), includedMonths: months }));
  process.stdout.write(`Connection code for ${issued.label} (single use, expires ${issued.expiresAt}):\n\n${issued.code}\n\n${await QRCode.toString(issued.code, { type: "terminal", small: true })}\n`);
} else if (command === "admin" && (args[0] === "create" || args[0] === "reset-totp")) {
  const username = args[1] ?? fail(usage);
  if (args[0] === "create") {
    const role = option("role") ?? "admin";
    if (role !== "admin" && role !== "viewer") fail("--role must be admin or viewer");
    const generated = !flag("password-stdin"), password = generated ? (await import("node:crypto")).randomBytes(18).toString("base64url") : await readStdin();
    const created = await withDatabase(db => createAdmin(db, { username, password, role: role as "admin" | "viewer" }));
    process.stdout.write(`Created ${role} ${username}.\n${generated ? `Password (shown once): ${password}\n` : ""}Add this account to an authenticator app:\n${created.uri}\n\n${await authenticatorQr(created.uri)}\n`);
  } else {
    const reset = await withDatabase(db => resetTotp(db, username));
    process.stdout.write(`New authenticator secret for ${username}; existing sessions were signed out.\n${reset.uri}\n\n${await authenticatorQr(reset.uri)}\n`);
  }
} else if (command === "purge") {
  const purged = await withDatabase(db => purgeRemovedShops(db, CLI_ACTOR, new Date()));
  process.stdout.write(purged.length === 0 ? "Nothing to purge\n" : `Purged ${purged.join(", ")}\n`);
} else if (command !== undefined) {
  process.stderr.write(usage); process.exitCode = 1;
} else {
  const key = config.databaseUrl === undefined ? undefined : loadServerKey(config.keyFile ?? ".kolo-server-key.json");
  const metrics = createMetrics();
  const application = await createApplication(config, key === undefined ? { metrics } : { key, metrics });
  await application.listen({ port: config.port, host: config.host });
  process.stdout.write(`KOLO server listening on ${config.host}:${config.port} (${config.edition === "hosted" ? `hosted, ${config.graceDays ?? 7}-day grace` : "self-hosted"})\n`);
  // Owners never retype this: connection codes carry it. It is printed for support and audits.
  if (key !== undefined) process.stdout.write(`Server fingerprint: ${key.fingerprint.replace(/(.{4})(?!$)/g, "$1 ")}\n`);
  if (process.env["KOLO_ENROLLMENT_CODE"]) process.stdout.write("KOLO_ENROLLMENT_CODE is no longer used: issue a connection code per shop with `invite` or the dashboard\n");
  if (config.publicUrl === undefined) process.stdout.write("Set KOLO_PUBLIC_URL to issue connection codes\n");

  const closers: (() => Promise<void>)[] = [() => application.close()];
  if (key !== undefined && config.admin !== undefined) {
    const db = openDatabase(config.databaseUrl!);
    const admin = await createAdminApplication({ db, key, publicUrl: config.publicUrl, metrics, version, uiDir, trustProxy: config.trustProxy ?? false,
      edition: { edition: config.edition ?? "selfhost", graceDays: config.graceDays ?? 7 }, totp: config.admin.totp ?? true });
    admin.addHook("onClose", async () => { await db.destroy(); });
    await admin.listen({ port: config.admin.port, host: config.admin.host });
    process.stdout.write(`Operator dashboard on http://${config.admin.host}:${config.admin.port}/admin/${uiDir === undefined ? " (API only: dashboard not built)" : ""}${config.admin.totp === false ? " (password only: KOLO_ADMIN_TOTP=off)" : ""}\n`);
    closers.push(() => admin.close());
    // Removed shops are purged once their grace period passes; failures wait for the next hour.
    const timer = setInterval(() => { void purgeRemovedShops(db, CLI_ACTOR, new Date()).catch(() => undefined); }, 3_600_000);
    timer.unref(); closers.push(async () => clearInterval(timer));
  }

  // Stop accepting requests and release PostgreSQL connections on orchestrator shutdown.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => { void Promise.all(closers.map(close => close())).then(() => process.exit(0), () => process.exit(1)); });
  }
}
