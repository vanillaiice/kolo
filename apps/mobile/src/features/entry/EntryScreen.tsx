import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import Constants from "expo-constants";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { createWorkspace, adoptLegacyWorkspace, resumeWorkspaceProvisioning, unlockWorkspace } from "@kolo/core/identity/workspace";
import { validateLocalSecret } from "@kolo/core/identity/credentials";
import { ownerRecoveryCode, recoverOwnerAccess } from "@kolo/core/identity/recovery";
import { WorkspaceError, type InstallationState, type OperationContext, type WorkspacePorts } from "@kolo/core/identity/types";
import type { AuthTransport } from "@kolo/core/data/auth/login";
import type { Database } from "@kolo/core/data/database/driver";
import type { SnapshotPort } from "@kolo/core/backup/types";
import { cancelBackupPreview, previewBackup, restoreWorkspace, type BackupPreview } from "@kolo/core/application/backup";
import { acceptPairingInvite, cancelPairing, completePairing, previewPairingInvite } from "@kolo/core/application/pairing";
import { transferCryptoOnDevice as crypto } from "../../data/auth/local-credentials-on-device.ts";
import { pickTransferFile, saveTransferFile } from "../../data/transfer/files-on-device.ts";
import { replaceShop } from "../../data/transfer/replace-shop.ts";
import { transferFileKind } from "../../data/transfer/file-kind.ts";
import type { SlotControl } from "../../data/database/open-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { workspaceErrorText } from "../../app/identity-errors.ts";
import { failureKey, FormProblem } from "../../components/command.tsx";
import { AppearanceControl, LanguageControl } from "../../components/controls.tsx";
import { spacing, useTheme } from "../../components/theme.ts";
import { Button, Confirm, Field, ListRow, nextPaint, Notice, Page, RowGroup, Section, Toggle, useStyles, Working } from "../../components/ui.tsx";

type Step =
  | { readonly name: "welcome" | "unlock" | "recover" | "pending" | "legacy" | "joining" | "import" }
  | { readonly name: "create"; readonly part: 1 | 2 }
  | { readonly name: "recoveryKey"; readonly code: string; readonly context: OperationContext }
  | { readonly name: "backup"; readonly text: string }
  | { readonly name: "restore"; readonly preview: BackupPreview }
  | { readonly name: "invite"; readonly text: string; readonly invite: Awaited<ReturnType<typeof previewPairingInvite>> }
  | { readonly name: "requestReady"; readonly code: string; readonly document: Awaited<ReturnType<typeof acceptPairingInvite>>["document"] };

/** Steps a fresh, locked, interrupted or legacy installation starts from. */
function firstStep(state: InstallationState, database: Database): Step {
  if (state.state === "empty") return { name: database.get(`SELECT id FROM workspace_enrollment WHERE id=1`) === undefined ? "welcome" : "joining" };
  return { name: state.state === "pending" ? "pending" : state.state === "legacy" ? "legacy" : "unlock" };
}
const platform = Platform.OS === "ios" ? "IOS" : "ANDROID";

/**
 * Offline entry: create a shop in two steps (details then owner access) or import a file (backup or
 * pairing invite, recognized from its structure). A shop on this phone offers unlock, owner-code
 * recovery and backup import; replacing it names the current shop and needs typed confirmation,
 * and moves the active slot only when the restore succeeds; the previous shop stays on disk.
 */
export function EntryScreen({ ports, files, slots, state, authority, onUnlocked, onChanged, onActivated, systemUi }: {
  readonly ports: WorkspacePorts; readonly files: SnapshotPort; readonly slots: SlotControl; readonly state: InstallationState; readonly authority: AuthTransport;
  readonly onUnlocked: (context: OperationContext) => void; readonly onChanged: () => void; readonly onActivated: (database: Database) => void;
  readonly systemUi: <T>(task: () => Promise<T>) => Promise<T>;
}): React.JSX.Element {
  const { t, language } = useText(), s = useStyles(), { colors } = useTheme();
  const [step, setStep] = useState<Step>(() => firstStep(state, ports.database));
  const [shop, setShop] = useState(""), [owner, setOwner] = useState(""), [customize, setCustomize] = useState(false);
  const [till, setTill] = useState(() => t("defaultTill")), [cash, setCash] = useState(() => t("defaultCash"));
  const [secret, setSecret] = useState(""), [confirmation, setConfirmation] = useState(""), [recovery, setRecovery] = useState("");
  const [phone, setPhone] = useState(""), [serverPin, setServerPin] = useState(""), [password, setPassword] = useState(""), [typedName, setTypedName] = useState(""), [fingerprint, setFingerprint] = useState("");
  const [pairingCode, setPairingCode] = useState(""), [acknowledged, setAcknowledged] = useState(false), [replacing, setReplacing] = useState(false);
  const [working, setWorking] = useState<"workingReadFile" | "workingCheckBackup" | "workingRestore">();
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<unknown>(), [notice, setNotice] = useState<"recovered" | "joinCancelled">();
  const staged = useRef<BackupPreview | undefined>(undefined), mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; if (staged.current !== undefined) void cancelBackupPreview(staged.current); }, []);
  const configured = state.state === "locked" || state.state === "unlocked";
  const shopName = state.state === "locked" || state.state === "unlocked" ? state.installation.businessName : undefined;
  const allActors = state.state === "locked" ? ports.database.all(`SELECT m.user_id, m.credential_reference, u.name FROM local_memberships m
    JOIN users u ON u.id = m.user_id AND u.business_id = m.business_id JOIN local_installation i ON i.business_id = m.business_id
    WHERE m.active = 1 AND u.active = 1 ORDER BY u.name`).map(row => ({ id: String(row["user_id"]), name: String(row["name"]), here: !String(row["credential_reference"]).startsWith("remote.") })) : [];
  // After a restore or joining, staff codes belong to the other device; only the owner can give them new ones here.
  const waiting = allActors.filter(actor => !actor.here).length, actors = allActors.filter(actor => actor.here);
  const [actorId, setActorId] = useState(actors[0]?.id);

  const go = (next: Step): void => { setFailure(undefined); setNotice(undefined); setStep(next); };
  const clearSecrets = (): void => { setSecret(""); setConfirmation(""); setRecovery(""); setServerPin(""); setPassword(""); };
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return; setBusy(true); setFailure(undefined); setNotice(undefined);
    try { await work(); } catch (error) { if (mounted.current) { setFailure(error); onChanged(); } }
    finally { if (mounted.current) { setBusy(false); setWorking(undefined); } }
  };
  /** Shows what a long step is doing, on screen before its synchronous work starts. */
  const showing = async (key: "workingReadFile" | "workingCheckBackup" | "workingRestore"): Promise<void> => { setWorking(key); await nextPaint(); };
  const checkNewSecret = (): void => { if (secret !== confirmation) throw new FormProblem("codesMismatch"); validateLocalSecret(secret); };
  /** Unlock after setup/migration/resume and show the recovery key once before opening the shop. */
  const openWithKey = async (ownerId: string): Promise<void> => {
    const context = await unlockWorkspace({ userId: ownerId, secret }, ports);
    const code = await ownerRecoveryCode(context, secret);
    clearSecrets();
    if (code === undefined) onUnlocked(context); else go({ name: "recoveryKey", code, context });
  };
  const pick = async (): Promise<string | undefined> => systemUi(() => pickTransferFile());
  const discardPreview = async (): Promise<void> => { if (staged.current !== undefined) { const preview = staged.current; staged.current = undefined; await cancelBackupPreview(preview); } };

  const message = failure === undefined ? undefined : failure instanceof WorkspaceError && !["locked", "permission_denied"].includes(failure.code) ? workspaceErrorText(failure, language) : t(failureKey(failure));
  const status = <>{working !== undefined && <Working text={t(working)} />}{message !== undefined && <Notice tone="error" text={message} />}{notice !== undefined && <Notice tone="success" text={t(notice)} />}</>;
  const secrets = (fresh: boolean): ReactNode => <>
    <Field label={fresh ? t("newLocalSecret") : t("localSecret")} value={secret} onChange={setSecret} kind="secret" hint={fresh ? t("codeRule") : undefined} />
    {fresh && <Field label={t("confirmNewSecret")} value={confirmation} onChange={setConfirmation} kind="secret" />}
  </>;
  const frame = (title: string, body: ReactNode, options: { back?: () => void; intro?: string; preferences?: boolean } = {}): React.JSX.Element =>
    <Page><KeyboardAwareScrollView bottomOffset={spacing.xl} contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: spacing.xs }}><Text style={{ fontSize: 26, fontWeight: "800", letterSpacing: 2, color: colors.brand }}>KOLO</Text>
        {options.back !== undefined && <Button label={t("back")} variant="ghost" onPress={options.back} disabled={busy} style={{ alignSelf: "flex-start", paddingHorizontal: 0 }} />}
        <Text accessibilityRole="header" style={s.title}>{title}</Text>{options.intro !== undefined && <Text style={s.muted}>{options.intro}</Text>}</View>
      {body}{status}
      {options.preferences === true && <Section><LanguageControl /><AppearanceControl /></Section>}
      <Text style={[s.muted, { textAlign: "center" }]}>{t("offlineLine")}</Text>
      <Text style={[s.muted, { textAlign: "center", fontSize: 12 }]}>kolo {Constants.expoConfig?.version ?? "0.0.0"} · made by hblabs</Text>
    </KeyboardAwareScrollView></Page>;

  switch (step.name) {
    case "welcome": return frame(t("welcomeTitle"), <>
      <Section title={t("createShop")}><Text style={s.body}>{t("createShopHelp")}</Text><Button label={t("createShop")} onPress={() => go({ name: "create", part: 1 })} /></Section>
      <Section title={t("importFile")}><Text style={s.body}>{t("importFileHelp")}</Text><Button label={t("importFile")} variant="secondary" onPress={() => go({ name: "import" })} /></Section>
    </>, { intro: t("standaloneHelp"), preferences: true });

    case "create": return step.part === 1 ? frame(t("createShop"), <Section title={t("stepShop")}>
      <Field label={t("shopName")} value={shop} onChange={setShop} autoFocus /><Field label={t("ownerName")} value={owner} onChange={setOwner} />
      <Toggle label={t("customizeNames")} value={customize} onChange={setCustomize} hint={t("customizeNamesHelp")} />
      {customize && <><Field label={t("deviceName")} value={till} onChange={setTill} /><Field label={t("cashAccountName")} value={cash} onChange={setCash} /></>}
      <Button label={t("continue")} disabled={shop.trim() === "" || owner.trim() === "" || till.trim() === "" || cash.trim() === ""} onPress={() => go({ name: "create", part: 2 })} />
    </Section>, { back: () => go({ name: "welcome" }), intro: t("stepOneOfTwo") })
      : frame(t("createShop"), <Section title={t("stepAccess")}>
        <Text style={s.body}>{t("ownerAccessHelp", { owner: owner.trim(), shop: shop.trim() })}</Text>{secrets(true)}
        <Button label={t("createShop")} busy={busy} onPress={() => { void run(async () => {
          checkNewSecret();
          const installation = await createWorkspace({ businessName: shop.trim(), ownerName: owner.trim(), secret, deviceLabel: till.trim(), currency: "XAF", platform,
            ...(customize ? { accounts: [{ name: cash.trim(), kind: "CASH" as const }] } : {}) }, ports);
          await openWithKey(installation.ownerId);
        }); }} />
      </Section>, { back: () => { setSecret(""); setConfirmation(""); go({ name: "create", part: 1 }); }, intro: t("stepTwoOfTwo") });

    case "recoveryKey": return frame(t("saveRecoveryKey"), <Section>
      <Text style={s.body}>{t("recoveryKeyHelp")}</Text>
      <Text selectable accessibilityLabel={step.code.split("").join(" ")} style={[s.mono, { fontSize: 18, lineHeight: 30, padding: spacing.lg, backgroundColor: colors.surfaceSoft, borderRadius: 8, borderWidth: 1, borderStyle: "dashed", borderColor: colors.controlBorder }]}>
        {step.code.match(/.{1,8}/g)?.join("-")}</Text>
      <Toggle label={t("recoveryKeyWritten")} value={acknowledged} onChange={setAcknowledged} />
      <Button label={t("recoveryKeySaved")} disabled={!acknowledged} onPress={() => onUnlocked(step.context)} />
    </Section>);

    case "unlock": return frame(shopName ?? t("unlockTill"), <>
      <Section title={t("unlockTill")}>
        {actors.length > 1 && <View accessibilityRole="radiogroup" accessibilityLabel={t("whoIsSelling")}><RowGroup>
          {actors.map(actor => <ListRow key={actor.id} title={actor.name} tag={actor.id === actorId ? t("selected") : undefined} onPress={() => setActorId(actor.id)} />)}</RowGroup></View>}
        {actors.length === 1 && <Text style={s.body}>{actors[0]!.name}</Text>}
        {waiting > 0 && <Text style={s.muted}>{t("staffNeedCodes", { count: waiting })}</Text>}
        {secrets(false)}
        <Button label={t("unlock")} busy={busy} disabled={actorId === undefined || secret === ""} onPress={() => { void run(async () => {
          const context = await unlockWorkspace({ userId: actorId!, secret }, ports); clearSecrets(); onUnlocked(context);
        }); }} />
      </Section>
      <Button label={t("forgotCode")} variant="ghost" onPress={() => { clearSecrets(); go({ name: "recover" }); }} />
      <Button label={t("importBackup")} variant="secondary" onPress={() => go({ name: "import" })} />
    </>, { preferences: true });

    case "recover": return frame(t("recoverAccess"), <Section>
      <Text style={s.body}>{t("recoverHelp")}</Text>
      <Field label={t("ownerRecoveryKey")} value={recovery} onChange={setRecovery} kind="code" />{secrets(true)}
      <Button label={t("restoreAccess")} busy={busy} onPress={() => { void run(async () => {
        checkNewSecret(); await recoverOwnerAccess({ recoveryCode: recovery, newSecret: secret }, ports); clearSecrets(); setStep({ name: "unlock" }); setNotice("recovered"); onChanged();
      }); }} />
    </Section>, { back: () => { clearSecrets(); go({ name: "unlock" }); } });

    case "pending": return frame(t("finishSetup"), <Section>
      <Text style={s.body}>{t("pendingSetupHelp")}</Text>{secrets(true)}
      <Button label={t("finishSetup")} busy={busy} onPress={() => { void run(async () => { checkNewSecret(); const installation = await resumeWorkspaceProvisioning(secret, ports); await openWithKey(installation.ownerId); }); }} />
    </Section>, { preferences: true });

    case "legacy": return frame(t("migrateTill"), <>
      <Section><Text style={s.body}>{t("migrationHelp")}</Text>
        <Field label={t("ownerPhone")} value={phone} onChange={setPhone} kind="phone" /><Field label={t("oldServerCode")} value={serverPin} onChange={setServerPin} kind="secret" />{secrets(true)}
        <Button label={t("migrateTill")} busy={busy} onPress={() => { void run(async () => {
          checkNewSecret(); const installation = await adoptLegacyWorkspace({ phone, serverPin, localSecret: secret }, ports, authority); await openWithKey(installation.ownerId);
        }); }} /></Section>
      <Button label={t("importBackup")} variant="secondary" onPress={() => go({ name: "import" })} />
    </>, { preferences: true });

    case "import": return frame(configured ? t("importBackup") : t("importFile"), <Section>
      <Text style={s.body}>{configured || state.state === "legacy" ? t("importBackupHelp") : t("importFileHelp")}</Text>
      <Text style={s.muted}>{t("importLimitsHelp")}</Text>
      <Button label={t("pickFile")} busy={busy} onPress={() => { void run(async () => {
        await showing("workingReadFile"); const text = await pick(); if (text === undefined) return;
        const kind = transferFileKind(text);
        if (kind === "backup") go({ name: "backup", text });
        else if (kind === "invite") { if (state.state !== "empty") throw new FormProblem("inviteNeedsEmpty"); go({ name: "invite", text, invite: await previewPairingInvite(text, crypto) }); }
        else throw new FormProblem("unrecognizedFile");
      }); }} />
    </Section>, { back: () => go(firstStep(state, ports.database)) });

    case "backup": return frame(t("importBackup"), <Section>
      <Text style={s.body}>{t("backupPasswordHelp")}</Text><Field label={t("filePassword")} value={password} onChange={setPassword} kind="secret" />
      <Button label={t("checkBackup")} busy={busy} disabled={password === ""} onPress={() => { void run(async () => {
        await showing("workingCheckBackup"); await discardPreview(); const preview = await previewBackup(step.text, password, files, crypto); setPassword("");
        if (!mounted.current) { await cancelBackupPreview(preview); return; }
        staged.current = preview; go({ name: "restore", preview });
      }); }} />
    </Section>, { back: () => { setPassword(""); go({ name: "import" }); } });

    case "restore": {
      const preview = step.preview;
      const restore = async (): Promise<void> => {
        checkNewSecret();
        if (typedName.trim() !== preview.businessName) throw new FormProblem("typeShopName");
        await showing("workingRestore");
        const request = { confirmedBusinessId: preview.businessId, deviceLabel: till.trim() || t("defaultTill"), platform, secret } as const;
        if (!configured && state.state !== "legacy") {
          const result = await restoreWorkspace(preview, request, ports); staged.current = undefined; clearSecrets(); onActivated(result.database); return;
        }
        const database = await replaceShop(preview, request, ports, files, slots);
        staged.current = undefined; clearSecrets(); onActivated(database);
      };
      return frame(t("restoreShop"), <>
        <Section title={preview.businessName}>
          <Text style={s.body}>{t("backupSummary", { owner: preview.ownerName, date: new Date(preview.createdAt).toLocaleString(language === "fr" ? "fr-FR" : "en-GB"), count: preview.appliedEvents })}</Text>
          <Field label={t("confirmShopName")} value={typedName} onChange={setTypedName} hint={t("typeShopNameHelp", { name: preview.businessName })} />
          <Field label={t("deviceName")} value={till} onChange={setTill} />{secrets(true)}
          {configured || state.state === "legacy" ? <Notice tone="warning" text={t("replaceWarning", { current: shopName ?? "KOLO" })} /> : null}
          <Button label={configured || state.state === "legacy" ? t("replaceShop") : t("confirmRestore")} variant={configured || state.state === "legacy" ? "danger" : "primary"} busy={busy}
            disabled={typedName.trim() !== preview.businessName || secret === ""}
            onPress={() => { if (configured || state.state === "legacy") setReplacing(true); else void run(restore); }} />
        </Section>
        <Confirm visible={replacing} destructive title={t("replaceTitle")} text={t("replaceText", { current: shopName ?? "KOLO", next: preview.businessName })} confirmLabel={t("replaceShop")}
          typed={{ label: t("typeCurrentShop", { name: shopName ?? "KOLO" }), expected: shopName ?? "KOLO" }}
          onCancel={() => setReplacing(false)} onConfirm={() => { setReplacing(false); void run(restore); }} />
      </>, { back: () => { void discardPreview(); clearSecrets(); go({ name: "import" }); } });
    }

    case "invite": return frame(t("joinShop"), <Section title={step.invite.businessName}>
      <Text style={s.body}>{t("inviteSummary", { owner: step.invite.ownerName })}</Text>
      <Text selectable style={[s.mono, { fontSize: 16 }]}>{t("fingerprintValue", { fingerprint: step.invite.fingerprint })}</Text>
      <Field label={t("ownerFingerprint")} value={fingerprint} onChange={setFingerprint} kind="code" hint={t("fingerprintHelp")} />
      <Field label={t("deviceName")} value={till} onChange={setTill} />{secrets(true)}
      <Button label={t("acceptInvite")} busy={busy} disabled={fingerprint.trim() === "" || secret === ""} onPress={() => { void run(async () => {
        checkNewSecret();
        const result = await acceptPairingInvite(step.text, { confirmedFingerprint: fingerprint.trim(), label: till.trim() || t("defaultSecondTill"), platform, secret }, ports, crypto);
        clearSecrets(); go({ name: "requestReady", code: result.verificationCode, document: result.document });
      }); }} />
    </Section>, { back: () => go({ name: "import" }) });

    case "requestReady": return frame(t("joinShop"), <Section>
      <Text style={s.body}>{t("requestReadyHelp")}</Text>
      <Text selectable style={[s.total, { textAlign: "center" }]}>{step.code}</Text>
      <Button label={t("saveRequestFile")} busy={busy} onPress={() => { void run(async () => { await systemUi(() => saveTransferFile(step.document)); setNotice(undefined); }); }} />
      <Button label={t("haveOwnerFile")} variant="secondary" onPress={() => { setPairingCode(step.code); go({ name: "joining" }); }} />
    </Section>);

    case "joining": return frame(t("finishJoining"), <>
      <Section><Text style={s.body}>{t("finishJoiningHelp")}</Text>
        <Field label={t("filePassword")} value={password} onChange={setPassword} kind="secret" />
        <Field label={t("savedPairingCode")} value={pairingCode} onChange={setPairingCode} kind="code" />
        <Button label={t("pickOwnerFile")} busy={busy} disabled={password === "" || pairingCode.trim() === ""} onPress={() => { void run(async () => {
          const text = await pick(); if (text === undefined) return;
          if (transferFileKind(text) !== "enrollment") throw new FormProblem("unrecognizedFile");
          const result = await completePairing(text, password, pairingCode.trim(), ports, files, crypto);
          clearSecrets(); onActivated(result.database);
        }); }} /></Section>
      <Button label={t("cancelPairing")} variant="danger" disabled={busy} onPress={() => { void run(async () => { cancelPairing(ports); setPairingCode(""); go({ name: "welcome" }); setNotice("joinCancelled"); onChanged(); }); }} />
    </>, { preferences: true });
  }
}
