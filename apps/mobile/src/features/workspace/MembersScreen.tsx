import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createLocalMember, listLocalMembers, resetLocalMemberCredential } from "@kolo/core/identity/members";
import { ownerRecoveryCode, setMemberActive } from "@kolo/core/identity/recovery";
import { grantPermission, revokePermission } from "@kolo/core/identity/workspace";
import { PERMISSIONS, type Permission, type Role } from "@kolo/core/identity/permissions";
import type { OperationContext } from "@kolo/core/identity/types";
import { Field } from "./WorkspaceScreen.tsx";
import { useText, LanguageControl } from "../../app/i18n.tsx";
import { roleKeys, permissionKeys, type LocalizedMessage } from "../../app/strings.ts";
import { workspaceErrorText } from "../../app/identity-errors.ts";
import { colors, spacing, TOUCH_TARGET } from "../../components/theme.ts";

/** Owner controls for local staff, granular grants/suspension and protected recovery code. */
export function MembersScreen({ context, onBack }: { readonly context: OperationContext; readonly onBack: () => void }): React.JSX.Element {
  const { t, language } = useText();
  const [name, setName] = useState(""); const [secret, setSecret] = useState("");
  const [role, setRole] = useState<Exclude<Role, "OWNER">>("CASHIER");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<LocalizedMessage>();
  const [failure, setFailure] = useState<unknown>();
  const [members, setMembers] = useState(() => listLocalMembers(context));
  const [target, setTarget] = useState<string>(); const [permission, setPermission] = useState<Permission>("sales.create");
  const refresh = (): void => setMembers(listLocalMembers(context));
  const perform = (work: () => void): void => { setMessage(undefined); setFailure(undefined); try { work(); refresh(); setMessage({ key: "saved" }); } catch (error) { setFailure(error); } };
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
    <LanguageControl disabled={busy} /><Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }} onPress={onBack}><Text>{t("backToTill")}</Text></Pressable><Text style={{ fontSize: 20 }}>{t("staffTitle")}</Text>
    {members.map(member => <View key={member.userId} style={{ gap: spacing.sm }}><Pressable accessibilityRole="radio" accessibilityState={{ selected: target === member.userId, disabled: busy }} disabled={busy} style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }} onPress={() => setTarget(member.userId)}><Text>{target === member.userId ? "✓ " : ""}{member.name} — {t(roleKeys[member.role])} — {member.active ? t("active") : t("suspended")}</Text></Pressable>
      {member.userId === context.userId ? null : <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }} onPress={() => perform(() => setMemberActive(context, member.userId, !member.active))}><Text>{member.active ? t("suspend") : t("restore")}</Text></Pressable>}</View>)}
    <Field label={t("newMemberName")} value={name} onChangeText={setName} />
    <Field label={t("memberSecret")} value={secret} onChangeText={setSecret} secure />
    {(["CASHIER", "MANAGER", "INVENTORY", "ACCOUNTANT"] as const).map(value => <Pressable accessibilityRole="radio" accessibilityState={{ selected: role === value, disabled: busy }} disabled={busy} style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }} key={value} onPress={() => setRole(value)}><Text>{role === value ? "✓ " : ""}{t(roleKeys[value])}</Text></Pressable>)}
    <Pressable accessibilityRole="button" style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }} disabled={busy} onPress={() => { setBusy(true); setMessage(undefined); setFailure(undefined); void createLocalMember(context, { name, secret, role }).then(() => { setName(""); setSecret(""); refresh(); setMessage({ key: "memberSaved" }); }).catch(error => setFailure(error)).finally(() => setBusy(false)); }}><Text>{busy ? t("saving") : t("addMember")}</Text></Pressable>
    {target === undefined ? null : <><Text>{t("selectedMemberSecret")}</Text><Field label={t("newMemberSecret")} value={secret} onChangeText={setSecret} secure />
      <Pressable accessibilityRole="button" style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }} disabled={busy || target === context.userId} onPress={() => { setBusy(true); setMessage(undefined); setFailure(undefined); void resetLocalMemberCredential(context, target, secret).then(() => { setSecret(""); refresh(); setMessage({ key: "memberSecretReplaced" }); }).catch(error => setFailure(error)).finally(() => setBusy(false)); }}><Text>{t("replaceMemberSecret")}</Text></Pressable><Text>{t("selectedPermission")}</Text>{PERMISSIONS.map(value => <Pressable accessibilityRole="radio" accessibilityState={{ selected: permission === value, disabled: busy }} disabled={busy} style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }} key={value} onPress={() => setPermission(value)}><Text>{permission === value ? "✓ " : ""}{t(permissionKeys[value])}</Text></Pressable>)}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }} onPress={() => perform(() => grantPermission(context, target, permission))}><Text>{t("grant")}</Text></Pressable><Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }} onPress={() => perform(() => revokePermission(context, target, permission))}><Text>{t("revoke")}</Text></Pressable></>}
    <Text>{t("ownerRecoveryKey")}</Text><Field label={t("currentSecret")} value={secret} onChangeText={setSecret} secure />
    <Pressable accessibilityRole="button" style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }} disabled={busy} onPress={() => { setBusy(true); setMessage(undefined); setFailure(undefined); void ownerRecoveryCode(context, secret).then(code => { setSecret(""); setMessage(code === undefined ? { key: "keyUnavailable" } : { key: "keepRecoveryKey", values: { key: code.match(/.{1,8}/g)?.join("-") ?? code } }); }).catch(error => setFailure(error)).finally(() => setBusy(false)); }}><Text>{t("viewRecoveryKey")}</Text></Pressable>
    <Text selectable accessibilityRole="alert">{failure !== undefined ? workspaceErrorText(failure, language) : message === undefined ? "" : t(message.key, message.values)}</Text>
  </ScrollView></SafeAreaView>;
}
