import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { cancelBackupPreview, createBackup, previewBackup, restoreWorkspace, type BackupPreview } from "@kolo/core/application/backup";
import { confirmPairing, createPairingInvite, previewPairingInvite, previewPairingRequest } from "@kolo/core/application/pairing";
import { exchangeDestinations, exchangeDiagnostics, exportBundle, exportReceipt, importBundle, importReceipt, previewBundle, receivedBatches, type BundlePreview } from "@kolo/core/application/file-exchange";
import { exchangeStatus } from "@kolo/core/application/event-delivery";
import { retryDeferred } from "@kolo/core/application/event-application";
import { ownerRecoveryCode } from "@kolo/core/identity/recovery";
import { validateLocalSecret } from "@kolo/core/identity/credentials";
import type { TransferDocument } from "@kolo/core/backup/types";
import { transferCryptoOnDevice as crypto } from "../../data/auth/local-credentials-on-device.ts";
import { pickTransferFile, saveTransferFile } from "../../data/transfer/files-on-device.ts";
import { replaceShop } from "../../data/transfer/replace-shop.ts";
import { transferFileKind, type TransferFileKind } from "../../data/transfer/file-kind.ts";
import { useText } from "../../app/i18n.tsx";
import { useLeaveGuard, useNav } from "../../app/navigation.tsx";
import { useRevision, useSession } from "../../app/session.tsx";
import { FormProblem, useAction } from "../../components/command.tsx";
import { spacing, useTheme } from "../../components/theme.ts";
import { Button, Confirm, EmptyState, Facts, Field, ListRow, nextPaint, Notice, RowGroup, Screen, Section, Segmented, Toggle, useStyles, Working } from "../../components/ui.tsx";
import { formatDate } from "../shared.tsx";
import { PhotoUsage } from "../products/photos.tsx";

const platform = Platform.OS === "ios" ? "IOS" : "ANDROID";

/** File work shared by the device tasks: pick a recognized file and save prepared documents through system UI. */
function useFiles(): { pick: (expected: TransferFileKind) => Promise<string | undefined>; save: (document: TransferDocument | undefined) => Promise<boolean> } {
  const session = useSession();
  return {
    pick: async expected => {
      const text = await session.systemUi(() => pickTransferFile());
      if (text === undefined) return undefined;
      if (transferFileKind(text) !== expected) throw new FormProblem("wrongFileKind");
      return text;
    },
    save: async document => document === undefined ? false : session.systemUi(() => saveTransferFile(document)),
  };
}
/** A prepared file waiting to be saved; saving again after a cancelled folder picker reuses it. */
function PreparedFile({ document, onSave, busy }: { readonly document: TransferDocument | undefined; readonly onSave: () => void; readonly busy: boolean }): React.JSX.Element | null {
  const { t } = useText(), s = useStyles();
  if (document === undefined) return null;
  return <Section><Text selectable style={s.muted}>{t("readyFilename", { filename: document.filename })}</Text><Button label={t("saveReadyFile")} busy={busy} onPress={onSave} /></Section>;
}

/** Backup & devices: each owner file task on its own screen. */
export function DevicesScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { context } = useSession(), revision = useRevision(["authority"]);
  const pending = useMemo(() => { try { return exchangeDestinations(context).reduce((sum, peer) => sum + (exchangeStatus(context, peer.id)["pending"] ?? 0), 0); } catch { return 0; } }, [context, revision]);
  return <Screen title={t("devicesTitle")} onBack={nav.back}>
    <Text style={s.muted}>{t("transferHelp")}</Text>
    <RowGroup title={t("backupTitle")}>
      <ListRow title={t("createBackup")} subtitle={t("createBackupHelp")} onPress={() => nav.push("backupCreate")} />
      <ListRow title={t("restoreBackup")} subtitle={t("restoreBackupHelp")} onPress={() => nav.push("backupRestore")} />
      <ListRow title={t("viewRecoveryKey")} onPress={() => nav.push("recoveryKey")} />
    </RowGroup>
    <RowGroup title={t("pairDevices")}>
      <ListRow title={t("addTill")} subtitle={t("pairHelp")} onPress={() => nav.push("addTill")} />
    </RowGroup>
    <RowGroup title={t("exchangeTitle")}>
      <ListRow title={t("sendChanges")} subtitle={pending > 0 ? t("pendingEventCount", { count: pending }) : undefined} onPress={() => nav.push("exchangeSend")} />
      <ListRow title={t("receiveChanges")} onPress={() => nav.push("exchangeReceive")} />
      <ListRow title={t("confirmations")} subtitle={t("confirmationsHelp")} onPress={() => nav.push("exchangeConfirm")} />
      <ListRow title={t("exchangeHealth")} onPress={() => nav.push("exchangeStatus")} />
    </RowGroup>
  </Screen>;
}

/** Encrypted backup of the whole shop, with or without photos. */
export function BackupCreateScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { context, files } = useSession(), action = useAction(), io = useFiles();
  const [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState(""), [photos, setPhotos] = useState(true), [document, setDocument] = useState<TransferDocument>();
  const save = (doc: TransferDocument | undefined): Promise<void> => action.runAsync(async () => io.save(doc), saved => action.show({ tone: saved ? "success" : "warning", key: saved ? "backupSaved" : "notSaved" }));
  return <Screen title={t("createBackup")} onBack={nav.back} footer={<>{action.notice}
    <Button label={t("createEncryptedBackup")} busy={action.busy} disabled={password === ""} onPress={() => { void action.runAsync(async () => {
      if (password !== confirmation) throw new FormProblem("passwordsMismatch");
      const doc = await createBackup(context, password, files, crypto, { includePhotos: photos });
      setPassword(""); setConfirmation(""); setDocument(doc); return io.save(doc);
    }, saved => action.show({ tone: saved ? "success" : "warning", key: saved ? "backupSaved" : "notSaved" })); }} /></>}>
    <Section><Text style={s.muted}>{t("backupPasswordRule")}</Text>
      <Field label={t("filePassword")} value={password} onChange={setPassword} kind="secret" /><Field label={t("confirmPassword")} value={confirmation} onChange={setConfirmation} kind="secret" />
      <Toggle label={t("includePhotos")} value={photos} onChange={setPhotos} hint={t("includePhotosHelp")} /><PhotoUsage /></Section>
    <PreparedFile document={document} busy={action.busy} onSave={() => { void save(document); }} />
  </Screen>;
}

/** Owner restore over this shop: check the file, then typed names and a new code; the restored shop opens locked. */
export function BackupRestoreScreen(): React.JSX.Element {
  const { t, language } = useText(), s = useStyles(), nav = useNav(), session = useSession(), { context, files, ports, slots, businessName } = session, action = useAction(), io = useFiles();
  const [text, setText] = useState<string>(), [password, setPassword] = useState(""), [preview, setPreview] = useState<BackupPreview>();
  const [typed, setTyped] = useState(""), [label, setLabel] = useState(() => t("defaultTill")), [secret, setSecret] = useState(""), [confirmation, setConfirmation] = useState(""), [confirming, setConfirming] = useState(false);
  const staged = useRef<BackupPreview | undefined>(undefined);
  useEffect(() => () => { if (staged.current !== undefined) void cancelBackupPreview(staged.current); }, []);
  useLeaveGuard(preview !== undefined);
  const [working, setWorking] = useState<"workingReadFile" | "workingCheckBackup" | "workingRestore">();
  useEffect(() => { if (!action.busy) setWorking(undefined); }, [action.busy]);
  /** Shows what a long step is doing, on screen before its synchronous work starts. */
  const showing = async (key: "workingReadFile" | "workingCheckBackup" | "workingRestore"): Promise<void> => { setWorking(key); await nextPaint(); };
  const restore = (): void => { void action.runAsync(async () => {
    if (preview === undefined) throw new FormProblem("checkFileFirst");
    if (secret !== confirmation) throw new FormProblem("codesMismatch");
    validateLocalSecret(secret);
    // The same shop restores under the owner's authority; another shop replaces this one through an empty stage.
    const request = { deviceLabel: label.trim() || t("defaultTill"), platform, secret } as const;
    await showing("workingRestore");
    const database = preview.businessId === context.businessId
      ? (await restoreWorkspace(preview, { confirmedBusinessId: preview.businessId, ...request, recoveryContext: context }, ports)).database
      : await replaceShop(preview, request, ports, files, slots);
    staged.current = undefined; session.activate(database);
  }); };
  return <Screen title={t("restoreBackup")} onBack={nav.back} footer={action.notice}>
    <Notice tone="warning" text={t("replaceWarning", { current: businessName })} />
    {working !== undefined && <Working text={t(working)} />}
    <Section title={t("stepFile")}>
      <Button label={text === undefined ? t("pickFile") : t("pickAnotherFile")} variant="secondary" busy={action.busy} onPress={() => { void action.runAsync(async () => { await showing("workingReadFile"); const picked = await io.pick("backup"); if (picked !== undefined) { setText(picked); setPreview(undefined); } }); }} />
      {text !== undefined && <><Field label={t("filePassword")} value={password} onChange={setPassword} kind="secret" />
        <Button label={t("checkBackup")} busy={action.busy} disabled={password === ""} onPress={() => { void action.runAsync(async () => {
          if (staged.current !== undefined) { await cancelBackupPreview(staged.current); staged.current = undefined; }
          await showing("workingCheckBackup"); const checked = await previewBackup(text, password, files, crypto); staged.current = checked; setPreview(checked); setPassword("");
        }); }} /></>}
      <Text style={s.muted}>{t("importLimitsHelp")}</Text>
    </Section>
    {preview !== undefined && <Section title={preview.businessName}>
      <Text style={s.body}>{t("backupSummary", { owner: preview.ownerName, date: formatDate(preview.createdAt, language), count: preview.appliedEvents })}</Text>
      <Field label={t("confirmShopName")} value={typed} onChange={setTyped} hint={t("typeShopNameHelp", { name: preview.businessName })} />
      <Field label={t("deviceName")} value={label} onChange={setLabel} />
      <Field label={t("newLocalSecret")} value={secret} onChange={setSecret} kind="secret" hint={t("codeRule")} /><Field label={t("confirmNewSecret")} value={confirmation} onChange={setConfirmation} kind="secret" />
      <Button label={t("replaceShop")} variant="danger" disabled={typed.trim() !== preview.businessName || secret === ""} busy={action.busy} onPress={() => setConfirming(true)} />
    </Section>}
    <Confirm visible={confirming} destructive title={t("replaceTitle")} text={t("replaceText", { current: businessName, next: preview?.businessName ?? "" })} confirmLabel={t("replaceShop")}
      typed={{ label: t("typeCurrentShop", { name: businessName }), expected: businessName }} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); restore(); }} />
  </Screen>;
}

/** Add a till: an invite with its fingerprint, then the new till's request approved with the compared code. */
export function AddTillScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), { colors } = useTheme(), nav = useNav(), { context, files } = useSession(), action = useAction(), io = useFiles();
  const [allowStaff, setAllowStaff] = useState(false), [fingerprint, setFingerprint] = useState<string>(), [document, setDocument] = useState<TransferDocument>();
  const [request, setRequest] = useState<{ text: string; view: Awaited<ReturnType<typeof previewPairingRequest>> }>(), [code, setCode] = useState(""), [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const saved = (ok: boolean): void => action.show({ tone: ok ? "success" : "warning", key: ok ? "fileSaved" : "notSaved" });
  return <Screen title={t("addTill")} onBack={nav.back} footer={action.notice}>
    <Section title={t("stepInvite")}>
      <Toggle label={t("allowStaffManagement")} value={allowStaff} onChange={setAllowStaff} />
      <Button label={t("createInvite")} busy={action.busy} onPress={() => { void action.runAsync(async () => {
        const doc = await createPairingInvite(context, crypto, allowStaff); setDocument(doc); setFingerprint((await previewPairingInvite(doc.text, crypto)).fingerprint); return io.save(doc);
      }, saved); }} />
      {fingerprint !== undefined && <><Text style={s.muted}>{t("compareFingerprintHelp")}</Text><Text selectable style={[s.mono, { fontSize: 18, color: colors.text }]}>{fingerprint}</Text></>}
    </Section>
    <Section title={t("stepRequest")}>
      <Button label={t("checkRequest")} variant="secondary" busy={action.busy} onPress={() => { void action.runAsync(async () => {
        const text = await io.pick("request"); if (text === undefined) return; setRequest({ text, view: await previewPairingRequest(text, crypto) });
      }); }} />
      {request !== undefined && <>
        <Facts items={[[t("deviceName"), request.view.deviceLabel], [t("shopName"), request.view.businessName], [t("pairingCodeLabel"), request.view.verificationCode, "strong"]]} />
        <Field label={t("newTillCode")} value={code} onChange={setCode} kind="code" hint={t("compareCodeHelp")} />
        <Field label={t("filePassword")} value={password} onChange={setPassword} kind="secret" hint={t("enrollmentPasswordHelp")} /><Field label={t("confirmPassword")} value={confirmation} onChange={setConfirmation} kind="secret" />
        <Button label={t("approvePairing")} busy={action.busy} disabled={code.trim() === "" || password === ""} onPress={() => { void action.runAsync(async () => {
          if (password !== confirmation) throw new FormProblem("passwordsMismatch");
          const doc = await confirmPairing(context, request.text, code.trim(), password, files, crypto); setDocument(doc); setPassword(""); setConfirmation(""); return io.save(doc);
        }, saved); }} />
      </>}
    </Section>
    <PreparedFile document={document} busy={action.busy} onSave={() => { void action.runAsync(() => io.save(document), saved); }} />
  </Screen>;
}

/** Send changes to one paired device; an empty send says so instead of writing a file. */
export function ExchangeSendScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context } = useSession(), revision = useRevision(["authority"]), action = useAction(), io = useFiles();
  const peers = useMemo(() => { try { return exchangeDestinations(context).map(peer => ({ ...peer, pending: exchangeStatus(context, peer.id)["pending"] ?? 0 })); } catch { return []; } }, [context, revision]);
  const [destination, setDestination] = useState<string>(), [password, setPassword] = useState(""), [document, setDocument] = useState<TransferDocument>(), chosen = destination ?? peers[0]?.id;
  const saved = (ok: boolean): void => action.show({ tone: ok ? "success" : "warning", key: ok ? "fileSaved" : "notSaved" });
  if (peers.length === 0) return <Screen title={t("sendChanges")} onBack={nav.back}><EmptyState title={t("noPairedDevices")} text={t("unlockPairHelp")} /></Screen>;
  return <Screen title={t("sendChanges")} onBack={nav.back} footer={<>{action.notice}<Button label={t("exportToPeer")} busy={action.busy} disabled={chosen === undefined || password === ""} onPress={() => { void action.runAsync(async () => {
    const doc = await exportBundle(context, chosen!, password, crypto); setPassword("");
    if (doc === undefined) { action.show({ tone: "info", key: "nothingToExport" }); return undefined; }
    setDocument(doc); return io.save(doc);
  }, ok => { if (ok !== undefined) saved(ok); }); }} /></>}>
    <Segmented label={t("destinationDevice")} value={chosen} onChange={setDestination} options={peers.map(peer => ({ id: peer.id, label: `${peer.label} · ${t("pendingEventCount", { count: peer.pending })}` }))} />
    <Section><Field label={t("filePassword")} value={password} onChange={setPassword} kind="secret" hint={t("exchangePasswordHelp")} /></Section>
    <PreparedFile document={document} busy={action.busy} onSave={() => { void action.runAsync(() => io.save(document), saved); }} />
  </Screen>;
}

/** Receive changes: preview counts (duplicates, waiting dependencies, review) before the durable import. */
export function ExchangeReceiveScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { context } = useSession(), action = useAction(), io = useFiles();
  const [text, setText] = useState<string>(), [password, setPassword] = useState(""), [bundle, setBundle] = useState<BundlePreview>(), [processed, setProcessed] = useState<number>();
  useLeaveGuard(bundle !== undefined && processed === undefined);
  const counts = bundle === undefined ? undefined : { total: bundle.events.length, duplicates: bundle.events.filter(e => e.assessment === "duplicate").length,
    deferred: bundle.events.filter(e => e.assessment === "deferred").length, review: bundle.events.filter(e => e.assessment === "review").length };
  return <Screen title={t("receiveChanges")} onBack={nav.back} footer={action.notice}>
    <Section title={t("stepFile")}>
      <Button label={text === undefined ? t("pickFile") : t("pickAnotherFile")} variant="secondary" busy={action.busy} onPress={() => { void action.runAsync(async () => { const picked = await io.pick("exchange"); if (picked !== undefined) { setText(picked); setBundle(undefined); setProcessed(undefined); } }); }} />
      {text !== undefined && <><Field label={t("filePassword")} value={password} onChange={setPassword} kind="secret" />
        <Button label={t("previewEvents")} busy={action.busy} disabled={password === ""} onPress={() => { void action.runAsync(async () => { setBundle(await previewBundle(context, text, password, crypto)); }); }} /></>}
    </Section>
    {counts !== undefined && <Section title={t("preview")}>
      <Text style={s.body}>{t("eventPreviewSummary", counts)}</Text>
      {processed === undefined ? <Button label={t("importEvents")} busy={action.busy} onPress={() => { void action.runAsync(async () => (await importBundle(context, bundle!, crypto)).length, count => { setProcessed(count); action.show({ tone: "success", key: "eventsProcessed", values: { count } }); }); }} />
        : <><Notice tone="success" text={t("eventsProcessed", { count: processed })} /><Button label={t("createImportReceipt")} variant="secondary" onPress={() => nav.replace("exchangeConfirm")} /></>}
    </Section>}
  </Screen>;
}

/** Confirmations both ways: create a receipt for a received batch, or record a peer's receipt for what this till sent. */
export function ExchangeConfirmScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), { context } = useSession(), revision = useRevision(["authority"]), action = useAction(), io = useFiles();
  const batches = useMemo(() => { try { return receivedBatches(context); } catch { return []; } }, [context, revision, action.message]);
  const peers = useMemo(() => { try { return exchangeDestinations(context); } catch { return []; } }, [context, revision]);
  const [password, setPassword] = useState(""), [destination, setDestination] = useState<string>(), chosen = destination ?? peers[0]?.id;
  const saved = (ok: boolean | undefined): void => { if (ok !== undefined) action.show({ tone: ok ? "success" : "warning", key: ok ? "fileSaved" : "notSaved" }); };
  return <Screen title={t("confirmations")} onBack={nav.back} footer={action.notice}>
    <Section><Field label={t("filePassword")} value={password} onChange={setPassword} kind="secret" hint={t("exchangePasswordHelp")} /></Section>
    <Section title={t("receivedBatches")}>
      {batches.length === 0 && <EmptyState title={t("noReceivedBatches")} />}
      {batches.map(batch => <ListRow key={batch.batchId} title={formatDate(batch.createdAt, language)} subtitle={t("createImportReceipt")} onPress={() => { void action.runAsync(async () => {
        if (password === "") throw new FormProblem("passwordRequired");
        const doc = await exportReceipt(context, batch.batchId, password, crypto); return doc === undefined ? undefined : io.save(doc);
      }, saved); }} />)}
    </Section>
    {peers.length > 0 && <Section title={t("importReceipt")}>
      <Segmented label={t("destinationDevice")} value={chosen} onChange={setDestination} options={peers.map(peer => ({ id: peer.id, label: peer.label }))} />
      <Button label={t("pickReceiptFile")} variant="secondary" busy={action.busy} disabled={password === "" || chosen === undefined} onPress={() => { void action.runAsync(async () => {
        const text = await io.pick("receipt"); if (text === undefined) return undefined; return importReceipt(context, chosen!, text, password, crypto);
      }, count => { if (count !== undefined) action.show({ tone: "success", key: "receiptsRecorded", values: { count } }); }); }} />
    </Section>}
  </Screen>;
}

/** Pending sends, retry of events waiting on dependencies, and localized diagnostics. */
export function ExchangeStatusScreen(): React.JSX.Element {
  const { t, language } = useText(), s = useStyles(), nav = useNav(), { context } = useSession(), revision = useRevision(["authority", "sales", "inventory"]), action = useAction();
  const state = useMemo(() => { try {
    return { peers: exchangeDestinations(context).map(peer => ({ ...peer, status: exchangeStatus(context, peer.id) })), diagnostics: exchangeDiagnostics(context, language) };
  } catch { return { peers: [], diagnostics: [] }; } }, [context, language, revision, action.message]);
  return <Screen title={t("exchangeHealth")} onBack={nav.back}>
    <Section title={t("pairedDevices")}>{state.peers.length === 0 ? <Text style={s.muted}>{t("noPairedDevices")}</Text>
      : state.peers.map(peer => <Facts key={peer.id} items={[[peer.label, t("pendingEventCount", { count: peer.status["pending"] ?? 0 })]]} />)}</Section>
    {action.notice}
    <Button label={t("retryEvents")} variant="secondary" onPress={() => action.run(() => retryDeferred(context), count => action.show({ tone: "success", key: "eventsApplied", values: { count } }))} />
    <Section title={t("diagnostics")}>{state.diagnostics.length === 0 ? <Text style={s.muted}>{t("noDiagnostics")}</Text>
      : state.diagnostics.map((item, index) => <View key={`${item.eventId}-${index}`} style={{ gap: spacing.xs }}><Text style={[s.body, { fontWeight: "600" }]}>{item.description}</Text>
        <Text style={s.muted}>{item.action}</Text><Text selectable style={s.mono}>{item.eventId} · {item.code}</Text></View>)}</Section>
  </Screen>;
}

/** The owner's recovery key, shown only after the current code. */
export function RecoveryKeyScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { context } = useSession(), action = useAction(), [secret, setSecret] = useState(""), [key, setKey] = useState<string | null>();
  useEffect(() => () => setKey(undefined), []);
  return <Screen title={t("viewRecoveryKey")} onBack={nav.back} footer={<>{action.notice}<Button label={t("showKey")} busy={action.busy} disabled={secret === ""} onPress={() => { void action.runAsync(async () => ownerRecoveryCode(context, secret), value => { setSecret(""); setKey(value ?? null); }); }} /></>}>
    <Section><Field label={t("currentSecret")} value={secret} onChange={setSecret} kind="secret" /></Section>
    {key === null && <Notice tone="warning" text={t("localKeyUnavailable")} />}
    {typeof key === "string" && <Section><Text style={s.body}>{t("recoveryKeyHelp")}</Text><Text selectable style={[s.mono, { fontSize: 18, lineHeight: 30 }]}>{key.match(/.{1,8}/g)?.join("-")}</Text></Section>}
  </Screen>;
}
