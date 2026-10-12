import { useEffect, useState } from "react";
import { Text } from "react-native";
import { useCameraPermissions } from "expo-camera";
import { QrScanner } from "../../components/qr-scanner.tsx";
import { finishJoin, lookupJoin, requestJoin, type JoinInvitation } from "@kolo/core/application/join";
import { cancelPairing } from "@kolo/core/application/pairing";
import { normalizeServerUrl } from "@kolo/core/application/server-sync";
import { validateLocalSecret } from "@kolo/core/identity/credentials";
import type { WorkspacePorts } from "@kolo/core/identity/types";
import type { SnapshotPort } from "@kolo/core/backup/types";
import type { Database } from "@kolo/core/data/database/driver";
import type { SignedPairingInvite } from "@kolo/contracts/transfer";
import { keyFingerprint } from "@kolo/core/application/server-sync";
import { parseLocalJoinLink, formatLocalJoinLink, localNetworkUrl } from "@kolo/contracts/local-sync";
import { lookupLocalJoin, requestLocalJoin, finishLocalJoin, localJoinTransport } from "@kolo/core/application/local-join";
import { normalizeJoinCode, parseJoinLink } from "@kolo/contracts/sync";
import { sealingCryptoOnDevice as crypto } from "../../data/auth/local-credentials-on-device.ts";
import { syncTransportOnDevice } from "../../data/sync/sync-on-device.ts";
import { rememberJoinServer } from "../../data/sync/join-server.ts";
import { useText } from "../../app/i18n.tsx";
import { FormProblem, syncFailureKey } from "../../app/failures.ts";
import { Button, Field, Notice, Section, useStyles } from "../../components/ui.tsx";

type Step = { readonly name: "code" } | { readonly name: "shop"; readonly code: string; readonly url: string; readonly fingerprint?: string; readonly localLink?: string; readonly invitation: JoinInvitation }
  | { readonly name: "waiting"; readonly code: string; readonly url: string; readonly fingerprint?: string; readonly localLink?: string; readonly shop: string; readonly owner: string };

/**
 * A new phone joins an existing shop with the code shown on its main till (ADR-032): scan or type it, name the phone,
 * choose its own code, then wait for the owner to allow it. No files, fingerprints or passwords.
 */
export function JoinByCode({ ports, files, platform, onActivated, onCancel }: {
  readonly ports: WorkspacePorts; readonly files: SnapshotPort; readonly platform: "ANDROID" | "IOS";
  readonly onActivated: (database: Database) => void; readonly onCancel: () => void;
}): React.JSX.Element {
  const { t } = useText(), s = useStyles();
  const [step, setStep] = useState<Step>({ name: "code" }), [typed, setTyped] = useState(""), [address, setAddress] = useState(""), [scanning, setScanning] = useState(false);
  const [nearby, setNearby] = useState(true);
  const [label, setLabel] = useState(platform === "IOS" ? "iPhone" : t("defaultSecondTill")), [secret, setSecret] = useState(""), [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState<string>(), [permission, askPermission] = useCameraPermissions();
  const fail = (error: unknown): void => setProblem(t(error instanceof FormProblem ? error.key : syncFailureKey(error)));
  const run = async (work: () => Promise<void>): Promise<void> => { if (busy) return; setBusy(true); setProblem(undefined); try { await work(); } catch (error) { fail(error); } finally { setBusy(false); } };

  const open = (code: string, url: string, fingerprint?: string, localLink?: string): Promise<void> => run(async () => {
    let server: string;
    try { server = normalizeServerUrl(url); } catch { throw new FormProblem("invalidServerAddress"); }
    if (localLink === undefined && fingerprint === undefined && nearby && localNetworkUrl(server) === undefined) throw new FormProblem("invalidServerAddress");
    const invitation = localLink === undefined ? await lookupJoin(fingerprint === undefined && nearby ? localJoinTransport(server) : syncTransportOnDevice(server), crypto, code) : await lookupLocalJoin(localLink, localJoinTransport(server), crypto);
    if (localLink === undefined && fingerprint === undefined && nearby) {
      if (localNetworkUrl(server) === undefined) throw new FormProblem("invalidServerAddress");
      const signed = JSON.parse(invitation.inviteText) as SignedPairingInvite;
      fingerprint = await keyFingerprint(signed.invite.source_public_key, crypto);
      localLink = formatLocalJoinLink({ url: server, fingerprint, code });
    }
    setStep({ name: "shop", code, url: server, ...(localLink === undefined ? {} : { localLink }), ...(fingerprint === undefined ? {} : { fingerprint }), invitation });
  });
  const scannedLink = (data: string): boolean => {
    const local = parseLocalJoinLink(data);
    if (local !== undefined) { setScanning(false); void open(local.code, local.url, local.fingerprint, data); return true; }
    const link = parseJoinLink(data);
    if (link === undefined) return false; // Another kind of QR code: keep looking.
    setScanning(false); void open(link.code, link.url, link.fingerprint);
    return true;
  };
  const ask = (current: Extract<Step, { name: "shop" }>): Promise<void> => run(async () => {
    if (secret !== confirmation) throw new FormProblem("codesMismatch");
    try { validateLocalSecret(secret); } catch { throw new FormProblem("codeRule"); }
    if (current.localLink === undefined) await requestJoin(current.code, current.invitation, { label: label.trim() || t("defaultSecondTill"), platform, secret }, ports, syncTransportOnDevice(current.url), crypto);
    else await requestLocalJoin(current.localLink, current.invitation, { label: label.trim() || t("defaultSecondTill"), platform, secret }, ports, localJoinTransport(current.url), crypto);
    setSecret(""); setConfirmation("");
    setStep({ name: "waiting", code: current.code, ...(current.localLink === undefined ? {} : { localLink: current.localLink }), url: current.url, ...(current.fingerprint === undefined ? {} : { fingerprint: current.fingerprint }), shop: current.invitation.businessName, owner: current.invitation.ownerName });
  });

  // While waiting, ask the server every two seconds whether the owner allowed this phone.
  useEffect(() => {
    if (step.name !== "waiting") return;
    let live = true, running = false;
    const timer = setInterval(() => {
      if (running) return; running = true;
      void (step.localLink === undefined ? finishJoin(step.code, ports, files, syncTransportOnDevice(step.url), crypto) : finishLocalJoin(step.localLink, ports, files, localJoinTransport(step.url), crypto)).then(async result => {
        if (!live || result === undefined) return;
        live = false; clearInterval(timer);
        if (step.localLink === undefined) await rememberJoinServer({ url: step.url, ...(step.fingerprint === undefined ? {} : { fingerprint: step.fingerprint }) });
        onActivated(result.database);
      }, error => { if (live) { live = false; clearInterval(timer); fail(error); } }).finally(() => { running = false; });
    }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [step, ports, files, onActivated]);

  const cancel = (): void => { try { cancelPairing(ports); } catch { /* Nothing pending. */ } onCancel(); };
  const notice = problem === undefined ? null : <Notice tone="error" text={problem} />;

  if (step.name === "waiting") return <Section>
    <Text style={s.heading}>{step.shop}</Text>
    <Text style={s.body}>{t("waitingForOwner", { owner: step.owner })}</Text>
    {notice}
    <Button label={t("cancelJoin")} variant="secondary" onPress={cancel} />
  </Section>;

  if (step.name === "shop") return <Section>
    <Text style={s.heading}>{step.invitation.businessName}</Text>
    <Text style={s.body}>{t("joinShopOf", { owner: step.invitation.ownerName })}</Text>
    <Field label={t("deviceName")} value={label} onChange={setLabel} />
    <Field label={t("newLocalSecret")} value={secret} onChange={setSecret} kind="secret" hint={t("codeRule")} />
    <Field label={t("confirmNewSecret")} value={confirmation} onChange={setConfirmation} kind="secret" />
    {notice}
    <Button label={t("askToJoin")} busy={busy} disabled={secret === "" || label.trim() === ""} onPress={() => { void ask(step); }} />
    <Button label={t("cancel")} variant="secondary" disabled={busy} onPress={cancel} />
  </Section>;

  return <Section>
    <Text style={s.body}>{t("joinByCodeHelp")}</Text>
    <Button label={t(nearby ? "localJoinMode" : "serverJoinMode")} variant="secondary" onPress={() => setNearby(value => !value)} />
    <Button label={t("scanCode")} busy={busy} onPress={() => { void (async () => { if (permission?.granted !== true && !(await askPermission()).granted) { setProblem(t("cameraDenied")); return; } setScanning(true); })(); }} />
    <Text style={[s.muted, { textAlign: "center" }]}>{t("orTypeCode")}</Text>
    <Field label={t("joinCodeLabel")} value={typed} onChange={setTyped} kind="code" placeholder="K7F2-9QXM-4D" />
    <Field label={t(nearby ? "localAddressLabel" : "serverAddressLabel")} value={address} onChange={setAddress} kind="code" placeholder={nearby ? "http://192.168.1.10:…" : "https://…"} hint={t("serverAddressHelp")} />
    {notice}
    <Button label={t("continue")} variant="secondary" busy={busy} disabled={typed.trim() === "" || address.trim() === "" && parseJoinLink(typed) === undefined && parseLocalJoinLink(typed) === undefined} onPress={() => {
      const local = parseLocalJoinLink(typed);
      if (local !== undefined) { void open(local.code, local.url, local.fingerprint, typed); return; }
      const link = parseJoinLink(typed), code = link?.code ?? normalizeJoinCode(typed);
      if (code === undefined) { setProblem(t("invalidJoinCode")); return; }
      void open(code, link?.url ?? address, link?.fingerprint);
    }} />
    <Button label={t("cancel")} variant="secondary" disabled={busy} onPress={onCancel} />
    <QrScanner visible={scanning} help={t("scanHelp")} accept={scannedLink} onClose={() => setScanning(false)} />
  </Section>;
}
