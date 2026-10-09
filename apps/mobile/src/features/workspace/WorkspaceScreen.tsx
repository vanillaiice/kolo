import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createWorkspace, adoptLegacyWorkspace, resumeWorkspaceProvisioning, unlockWorkspace } from "@kolo/core/identity/workspace";
import { validateLocalSecret } from "@kolo/core/identity/credentials";
import { ownerRecoveryCode, recoverOwnerAccess } from "@kolo/core/identity/recovery";
import { WorkspaceError, type InstallationState, type OperationContext, type WorkspacePorts } from "@kolo/core/identity/types";
import type { AuthTransport } from "@kolo/core/data/auth/login";
import { useText, LanguageControl } from "../../app/i18n.tsx";
import { workspaceErrorText } from "../../app/identity-errors.ts";
import { colors, spacing, TOUCH_TARGET, type as typography } from "../../components/theme.ts";

/** Offline setup/unlock and owner access recovery; legacy migration is explicitly owner-authenticated. */
export function WorkspaceScreen({ ports, state, authority, onUnlocked, onChanged, onTransfer }: {
  readonly ports: WorkspacePorts;
  readonly state: InstallationState;
  readonly authority: AuthTransport;
  readonly onUnlocked: (context: OperationContext) => void;
  readonly onChanged: () => void;
  readonly onTransfer:()=>void;
}): React.JSX.Element {
  const { t, language } = useText();
  const [shop, setShop] = useState(""); const [name, setName] = useState("");
  const [secret, setSecret] = useState(""); const [confirmation, setConfirmation] = useState("");
  const [phone, setPhone] = useState(""); const [serverPin, setServerPin] = useState("");
  const [recovering, setRecovering] = useState(false); const [recovery, setRecovery] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  const [recoveryDisplay, setRecoveryDisplay] = useState<{ code: string; context: OperationContext }>();
  const actors = ports.database.all(`SELECT m.user_id,u.name FROM local_memberships m
    JOIN users u ON u.id = m.user_id AND u.business_id = m.business_id
    JOIN local_installation i ON i.business_id = m.business_id WHERE m.active = 1 AND u.active = 1 ORDER BY u.name`);
  const [actorId, setActorId] = useState<string | undefined>(actors[0]?.["user_id"] as string | undefined);
  const setup = state.state === "empty", pending = state.state === "pending", legacy = state.state === "legacy";
  const confirmSecret = setup || pending || legacy || recovering;
  const submit = async (): Promise<void> => {
    if (busy) return; setError(undefined);
    if (confirmSecret) {
      if (secret !== confirmation) { setError("codesMismatch"); return; }
      try { validateLocalSecret(secret); } catch (error) { setError(error); return; }
    }
    setBusy(true);
    try {
      if (recovering) {
        await recoverOwnerAccess({ recoveryCode: recovery, newSecret: secret }, ports);
        setRecovering(false); setSecret(""); setConfirmation(""); setRecovery(""); onChanged(); return;
      }
      let userId = actorId;
      if (setup || legacy || pending) {
        const installation = setup ? await createWorkspace({ businessName: shop, ownerName: name, secret,
          deviceLabel: t("defaultTill"), currency: "XAF", platform: Platform.OS === "ios" ? "IOS" : "ANDROID" }, ports)
          : legacy ? await adoptLegacyWorkspace({ phone, serverPin, localSecret: secret }, ports, authority)
          : await resumeWorkspaceProvisioning(secret, ports);
        userId = installation.ownerId;
      }
      if (userId === undefined) throw new WorkspaceError("actor_inactive");
      const context = await unlockWorkspace({ userId, secret }, ports);
      if (setup || legacy || pending) {
        const code = await ownerRecoveryCode(context, secret);
        if (code !== undefined) { setRecoveryDisplay({ code, context }); setSecret(""); setConfirmation(""); setServerPin(""); return; }
      }
      setSecret(""); onUnlocked(context);
    } catch (error) { setError(error); onChanged(); }
    finally { setBusy(false); }
  };
  if (recoveryDisplay !== undefined) return <SafeAreaView style={styles.screen}><ScrollView contentContainerStyle={styles.content}>
    <LanguageControl disabled={busy} /><Text style={styles.title}>{t("saveRecoveryKey")}</Text>
    <Text style={styles.body}>{t("recoveryKeyHelp")}</Text>
    <Text selectable style={styles.code}>{recoveryDisplay.code.match(/.{1,8}/g)?.join("-")}</Text>
    <Pressable accessibilityRole="button" style={styles.button} onPress={() => onUnlocked(recoveryDisplay.context)}><Text style={styles.buttonText}>{t("recoveryKeySaved")}</Text></Pressable>
  </ScrollView></SafeAreaView>;
  return <SafeAreaView style={styles.screen}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <LanguageControl disabled={busy} /><Text style={styles.title}>{recovering ? t("recoverAccess") : setup ? t("createShop") : legacy ? t("migrateTill") : pending ? t("finishSetup") : t("unlockTill")}</Text>
    {state.state==="empty"||state.state==="locked"?<Pressable accessibilityRole="button" style={styles.button} onPress={onTransfer}><Text style={styles.buttonText}>{t("restoreOrPair")}</Text></Pressable>:null}
    <Text style={styles.body}>{legacy ? t("migrationHelp") : t("standaloneHelp")}</Text>
    {setup ? <><Field label={t("shopName")} value={shop} onChangeText={setShop} /><Field label={t("ownerName")} value={name} onChangeText={setName} /></> : null}
    {legacy ? <><Field label={t("ownerPhone")} value={phone} onChangeText={setPhone} /><Field label={t("oldServerCode")} value={serverPin} onChangeText={setServerPin} secure /></> : null}
    {!setup && !legacy && !pending && !recovering ? actors.map(actor => <Pressable accessibilityRole="button" key={String(actor["user_id"])} onPress={() => setActorId(String(actor["user_id"]))} accessibilityState={{ selected: actorId === actor["user_id"] }} style={[styles.actor, actorId === actor["user_id"] ? styles.selected : undefined]}>
      <Text style={styles.body}>{String(actor["name"])}</Text></Pressable>) : null}
    {recovering ? <Field label={t("ownerRecoveryKey")} value={recovery} onChangeText={setRecovery} secure /> : null}
    <Field label={confirmSecret ? t("newLocalSecret") : t("localSecret")} value={secret} onChangeText={setSecret} secure />
    {confirmSecret ? <Field label={t("confirmNewSecret")} value={confirmation} onChangeText={setConfirmation} secure /> : null}
    {error === undefined ? null : <Text accessibilityRole="alert" style={styles.error}>{error === "codesMismatch" ? t("codesMismatch") : workspaceErrorText(error, language)}</Text>}
    <Pressable accessibilityRole="button" disabled={busy} style={styles.button} onPress={() => { void submit(); }}>{busy ? <ActivityIndicator color={colors.accentText} /> : <Text style={styles.buttonText}>{recovering ? t("restoreAccess") : confirmSecret ? t("continue") : t("unlock")}</Text>}</Pressable>
    {!setup && !legacy && !pending ? <Pressable accessibilityRole="button" disabled={busy} style={styles.actor} onPress={() => { setRecovering(value => !value); setSecret(""); setConfirmation(""); setError(undefined); }}><Text style={styles.body}>{recovering ? t("backToUnlock") : t("forgotCode")}</Text></Pressable> : null}
  </ScrollView></SafeAreaView>;
}

/** Reused local identity form field with explicit accessible label and secret entry. */
export function Field({ label, value, onChangeText, secure = false }: { readonly label: string; readonly value: string; readonly onChangeText: (value: string) => void; readonly secure?: boolean }): React.JSX.Element {
  return <><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} secureTextEntry={secure} autoCapitalize="none" autoCorrect={false} style={styles.input} /></>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, content: { padding: spacing.xl, gap: spacing.md },
  title: { ...typography.title, color: colors.text }, body: { ...typography.body, color: colors.muted },
  label: { ...typography.label, color: colors.text }, input: { minHeight: TOUCH_TARGET, borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: spacing.md, color: colors.text },
  button: { minHeight: TOUCH_TARGET, backgroundColor: colors.accent, padding: spacing.md, borderRadius: 6, alignItems: "center", justifyContent: "center" }, buttonText: { ...typography.label, color: colors.accentText },
  actor: { minHeight: TOUCH_TARGET, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: 6 }, selected: { borderColor: colors.accent },
  error: { ...typography.body, color: colors.warning }, code: { ...typography.mono, color: colors.text, padding: spacing.lg, backgroundColor: colors.surface },
});
