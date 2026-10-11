import { useEffect, useState } from "react";
import { Share, Text } from "react-native";
import Constants from "expo-constants";
import { useCameraPermissions } from "expo-camera";
import { QrScanner } from "../../components/qr-scanner.tsx";
import { canEnrollServer, connectServer, disconnectServer, knowsServer, normalizeServerUrl, previewServer, serverConnections, synchronizeServer, type ServerConnection } from "@kolo/core/application/server-sync";
import { formatConnectionCode, parseConnectionCode } from "@kolo/contracts/sync";
import { sealingCryptoOnDevice as crypto } from "../../data/auth/local-credentials-on-device.ts";
import { syncTransportOnDevice } from "../../data/sync/sync-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { useNav } from "../../app/navigation.tsx";
import { useRevision, useSession } from "../../app/session.tsx";
import { FormProblem, syncFailureKey } from "../../app/failures.ts";
import { useAction } from "../../components/command.tsx";
import { Button, Confirm, Facts, Field, Notice, Screen, Section, useStyles } from "../../components/ui.tsx";
import { formatDate } from "../shared.tsx";

const grouped = (fingerprint: string): string => fingerprint.replace(/(.{4})(?!$)/g, "$1 ");

/** A pasted connection code with its address checked against the phone's address policy. */
function parsed(text: string): { readonly url: string; readonly fingerprint: string; readonly token?: string } {
  const code = parseConnectionCode(text);
  if (code === undefined) throw new FormProblem("invalidCode");
  try { return { ...code, url: normalizeServerUrl(code.url) }; } catch { throw new FormProblem("invalidServerAddress"); }
}
/** Runs sync work and turns its failures into the sync texts. */
async function syncWork<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { if (error instanceof FormProblem) throw error; throw new FormProblem(syncFailureKey(error)); }
}

/**
 * The optional sync server on this phone: paste a connection code, check it, connect; then see the last pass, sync
 * now, stop, and (on the owner's main till) share the server address with other tills. Background passes run on
 * their own while someone with shop-settings access is signed in.
 */
export function ServerSyncScreen(): React.JSX.Element {
  const { t, language } = useText(), s = useStyles(), nav = useNav(), session = useSession(), { context } = session, action = useAction();
  const revision = useRevision(["authority", "sales", "inventory"]);
  const [refresh, setRefresh] = useState(0), [state, setState] = useState<{ servers: readonly ServerConnection[]; owner: boolean }>();
  const [scanning, setScanning] = useState(false), [permission, askPermission] = useCameraPermissions();
  const [code, setCode] = useState(""), [preview, setPreview] = useState<{ url: string; fingerprint: string; hasToken: boolean; attached: boolean }>(), [stopping, setStopping] = useState<string>();
  useEffect(() => {
    let live = true;
    void serverConnections(context, crypto).then(servers => { if (live) setState({ servers, owner: canEnrollServer(context) }); }, () => { if (live) setState({ servers: [], owner: false }); });
    return () => { live = false; };
  }, [context, revision, refresh]);
  const when = (value: string | null): string => value === null ? t("neverSynced") : formatDate(value, language);
  const check = (): void => { setPreview(undefined); void action.runAsync(() => syncWork(async () => {
    const target = parsed(code), identity = await previewServer(syncTransportOnDevice(target.url), crypto);
    if (identity.fingerprint !== target.fingerprint) throw new FormProblem("fingerprintMismatch");
    return { url: target.url, fingerprint: identity.fingerprint, hasToken: target.token !== undefined, attached: knowsServer(context, identity.server_device_id, identity.public_key) };
  }), setPreview); };
  const connect = (): void => { void action.runAsync(() => syncWork(async () => {
    const target = parsed(code), transport = syncTransportOnDevice(target.url);
    const destinationId = await connectServer(context, transport, { ...target, source: "code" }, crypto);
    await synchronizeServer(context, destinationId, transport, crypto).catch(() => undefined); // The status shows any first-pass failure.
  }), () => { setCode(""); setPreview(undefined); setRefresh(value => value + 1); }); };
  const syncNow = (server: ServerConnection): void => { void action.runAsync(() => syncWork(() => synchronizeServer(context, server.destinationId, syncTransportOnDevice(server.url), crypto)), summary => {
    setRefresh(value => value + 1);
    const extra = [summary.untrusted > 0 ? t("syncWaitingApproval", { count: summary.untrusted }) : "", summary.locked > 0 ? t("syncWaitingKey", { count: summary.locked }) : ""].filter(Boolean);
    action.show({ tone: "success", key: "syncDoneSummary", values: { sent: summary.pushed, received: summary.pulled, extra: extra.map(item => ` · ${item}`).join("") } });
  }).finally(() => setRefresh(value => value + 1)); };
  const stop = (): void => { const id = stopping; setStopping(undefined); if (id !== undefined) action.run(() => disconnectServer(context, id), () => setRefresh(value => value + 1)); };

  const servers = state?.servers ?? [];
  return <Screen title={t("serverSyncTitle")} onBack={nav.back} footer={servers.length === 0 && state !== undefined ? <>{action.notice}
    {preview === undefined ? <Button label={t("checkCode")} busy={action.busy} disabled={code.trim() === ""} onPress={check} />
      : <Button label={t("connectServer")} busy={action.busy} disabled={state.owner && !preview.hasToken && !preview.attached} onPress={connect} />}</> : undefined}>
    <Text style={s.muted}>{t("serverSyncHelp")}</Text>
    <Text style={s.muted}>{t("serverPrivacy")}</Text>
    {servers.map(server => <Section key={server.destinationId} title={server.url}>
      <Facts items={[[t("serverFingerprint"), grouped(server.fingerprint)], [t("lastSyncLabel"), when(server.lastSuccessAt)],
        [t("waitingToSendLabel"), String(server.pending + server.unsigned)]]} />
      {server.source === "shop" && <Text style={s.muted}>{t("connectedAutomatically")}</Text>}
      {server.service === "active" && server.paidUntil !== null && <Text style={s.muted}>{t("servicePaidUntil", { when: when(server.paidUntil) })}</Text>}
      {server.service === "grace" && <Notice tone="warning" text={t("serviceGrace", { when: when(server.graceUntil) })} />}
      {server.service === "inactive" && <Notice tone="error" text={t("serviceInactive")} />}
      {server.lastError !== null && server.service !== "inactive" && <Notice tone="warning" text={t("lastSyncFailed", { when: when(server.lastAttemptAt) })} />}
      {action.notice}
      <Button label={t("syncNow")} busy={action.busy} onPress={() => syncNow(server)} />
      <Button label={t("stopSyncing")} variant="secondary" disabled={action.busy} onPress={() => setStopping(server.destinationId)} />
      <Section title={t("supportDetails")}>
        {/* Plain facts an operator needs to help; no keys, codes or business data. */}
        <Text selectable style={s.mono}>{[`kolo ${Constants.expoConfig?.version ?? "0.0.0"}`, `server ${server.url}`, `fingerprint ${server.fingerprint}`, `connected ${server.connectedAt}${server.source === "shop" ? " (shop address)" : ""}`,
          `last success ${server.lastSuccessAt ?? "never"}`, `last attempt ${server.lastAttemptAt ?? "never"}`, `last error ${server.lastError ?? "none"}`, `waiting ${server.pending + server.unsigned}`,
          `service ${server.service ?? "unknown"}${server.paidUntil === null ? "" : ` until ${server.paidUntil}`}`].join("\n")}</Text>
      </Section>
      {state?.owner === true && <Section title={t("shareServerTitle")}>
        <Text style={s.muted}>{t("shareServerHelp")}</Text>
        <Text selectable style={s.mono}>{formatConnectionCode({ url: server.url, fingerprint: server.fingerprint })}</Text>
        <Button label={t("shareCode")} variant="secondary" onPress={() => { void session.systemUi(() => Share.share({ message: formatConnectionCode({ url: server.url, fingerprint: server.fingerprint }) })).catch(() => undefined); }} />
      </Section>}
    </Section>)}
    {state !== undefined && servers.length === 0 && <Section>
      <Button label={t("scanCode")} variant="secondary" onPress={() => { void (async () => { if (permission?.granted !== true && !(await askPermission()).granted) { action.show({ tone: "error", key: "cameraDenied" }); return; } setScanning(true); })(); }} />
      <QrScanner visible={scanning} help={t("scanServerHelp")} onClose={() => setScanning(false)} accept={data => { if (parseConnectionCode(data) === undefined) return false; setScanning(false); setCode(data); setPreview(undefined); return true; }} />
      <Field label={t("connectionCode")} value={code} onChange={value => { setCode(value); setPreview(undefined); }} multiline kind="code"
        hint={t(state.owner ? "connectionCodeOwnerHelp" : "connectionCodeTillHelp")} placeholder="kolo://connect?…" />
      {preview !== undefined && <Section title={t("serverChecked")}>
        <Facts items={[[t("serverAddressLabel"), preview.url], [t("serverFingerprint"), grouped(preview.fingerprint)]]} />
        {state.owner && !preview.hasToken && !preview.attached && <Notice tone="warning" text={t("codeNeedsToken")} />}
        {!state.owner && <Text style={s.muted}>{t("tillNeedsOwner")}</Text>}
      </Section>}
    </Section>}
    <Confirm visible={stopping !== undefined} title={t("stopSyncing")} text={t("stopSyncingHelp")} confirmLabel={t("stopSyncing")} onConfirm={stop} onCancel={() => setStopping(undefined)} />
  </Screen>;
}
