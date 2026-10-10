import { useMemo, useState } from "react";
import { Text } from "react-native";
import { createLocalMember, listLocalMembers, resetLocalMemberCredential, type LocalMember } from "@kolo/core/identity/members";
import { setMemberActive } from "@kolo/core/identity/recovery";
import { grantPermission, revokePermission } from "@kolo/core/identity/workspace";
import { isPermission, PERMISSIONS, resolvePermissions, type Permission, type Role } from "@kolo/core/identity/permissions";
import { useText, type TextKey } from "../../app/i18n.tsx";
import { permissionKeys, roleKeys } from "../../app/strings.ts";
import { useLeaveGuard, useNav, useParams } from "../../app/navigation.tsx";
import { useRevision, useSession } from "../../app/session.tsx";
import { FormProblem, useAction } from "../../components/command.tsx";
import { Button, Confirm, EmptyState, Field, ListRow, Notice, RowGroup, Screen, Section, Segmented, Toggle, useStyles } from "../../components/ui.tsx";

const ROLES: readonly Exclude<Role, "OWNER">[] = ["CASHIER", "MANAGER", "INVENTORY", "ACCOUNTANT"];
const GROUPS: readonly (readonly [TextKey, (permission: Permission) => boolean])[] = [
  ["group.products", p => p.startsWith("products.")], ["group.inventory", p => p.startsWith("inventory.")], ["group.sales", p => p.startsWith("sales.")],
  ["group.customers", p => p.startsWith("customers.")], ["group.suppliers", p => p.startsWith("suppliers.") || p.startsWith("purchases.")],
  ["group.money", p => p.startsWith("cash.") || p.startsWith("finance.") || p.startsWith("expenses.")], ["group.reports", p => p.startsWith("reports.")],
  ["group.admin", p => p.startsWith("users.") || p.startsWith("business.") || p.startsWith("audit.")],
];

/** Effective permissions: role defaults plus grants minus revocations, as the desktop shows them. */
function useEffective(member: LocalMember | undefined): readonly Permission[] {
  const { database, context } = useSession(), revision = useRevision(["authority"]);
  return useMemo(() => {
    if (member === undefined) return [];
    const row = database.get(`SELECT granted,revoked FROM local_memberships WHERE business_id=? AND user_id=?`, [context.businessId, member.userId]);
    const parse = (value: unknown): Permission[] => { try { const list: unknown = JSON.parse(typeof value === "string" ? value : "[]"); return Array.isArray(list) ? list.filter(isPermission) : []; } catch { return []; } };
    return [...resolvePermissions(member.role, parse(row?.["granted"]), parse(row?.["revoked"]))];
  }, [database, context, member, revision]);
}
function useMembers(): { members: readonly LocalMember[]; failed: boolean } {
  const { context } = useSession(), revision = useRevision(["authority"]);
  return useMemo(() => { try { return { members: listLocalMembers(context), failed: false }; } catch { return { members: [], failed: true }; } }, [context, revision]);
}

/** Staff list; owners add members here. */
export function StaffScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context, canManageStaff, database } = useSession(), { members, failed } = useMembers();
  // Members restored or synced from another device have no code on this one until the owner sets it.
  const remote = new Set(database.all(`SELECT user_id FROM local_memberships WHERE business_id=? AND credential_reference LIKE 'remote.%'`, [context.businessId]).map(row => String(row["user_id"])));
  return <Screen title={t("staff")} onBack={nav.back} actions={canManageStaff ? <Button label={t("new")} variant="ghost" onPress={() => nav.push("staffNew")} /> : undefined}>
    {failed && <Notice tone="error" text={t("loadFailed")} />}
    {!canManageStaff && <Notice text={t("staffReadOnly")} />}
    <RowGroup>{members.map(member => <ListRow key={member.userId} title={member.name} subtitle={t(roleKeys[member.role])}
      tag={!member.active ? t("suspended") : member.userId === context.userId ? t("you") : remote.has(member.userId) ? t("needsNewCode") : undefined} onPress={() => nav.push("staffMember", { userId: member.userId })} />)}</RowGroup>
  </Screen>;
}

/** One member: role, effective permissions by group, grants/revocations, suspension and code replacement. */
export function StaffMemberScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { userId } = useParams("staffMember"), session = useSession(), { context, canManageStaff } = session;
  const { members } = useMembers(), member = members.find(item => item.userId === userId), effective = useEffective(member), action = useAction();
  const [secret, setSecret] = useState(""), [confirmation, setConfirmation] = useState(""), [suspending, setSuspending] = useState(false);
  if (member === undefined) return <Screen title={t("staff")} onBack={nav.back}><EmptyState title={t("notFound")} /></Screen>;
  const self = member.userId === context.userId, editable = canManageStaff && !self && member.role !== "OWNER";
  const toggle = (permission: Permission, allowed: boolean): void => action.run(() => { if (allowed) grantPermission(context, userId, permission); else revokePermission(context, userId, permission); });
  const replace = (): void => { void action.runAsync(async () => {
    if (secret !== confirmation) throw new FormProblem("codesMismatch");
    await resetLocalMemberCredential(context, userId, secret);
  }, () => { setSecret(""); setConfirmation(""); }, "memberSecretReplaced"); };
  return <Screen title={member.name} eyebrow={t(roleKeys[member.role])} onBack={nav.back}>
    {!member.active && <Notice tone="warning" text={t("memberSuspendedHelp")} />}
    {action.notice}
    {GROUPS.map(([label, matches]) => <Section key={label} title={t(label)}>{PERMISSIONS.filter(matches).map(permission => editable
      ? <Toggle key={permission} label={t(permissionKeys[permission])} value={effective.includes(permission)} onChange={allowed => toggle(permission, allowed)} />
      : <Text key={permission} style={[s.body, !effective.includes(permission) && s.muted]}>{effective.includes(permission) ? "✓ " : "– "}{t(permissionKeys[permission])}</Text>)}</Section>)}
    {editable && <Section title={t("replaceMemberSecret")}>
      <Text style={s.muted}>{t("selectedMemberSecret")}</Text>
      <Field label={t("newMemberSecret")} value={secret} onChange={setSecret} kind="secret" hint={t("codeRule")} /><Field label={t("confirmNewSecret")} value={confirmation} onChange={setConfirmation} kind="secret" />
      <Button label={t("replaceMemberSecret")} variant="secondary" busy={action.busy} disabled={secret === ""} onPress={replace} />
    </Section>}
    {editable && <Button label={t(member.active ? "suspend" : "restore")} variant={member.active ? "danger" : "secondary"} onPress={() => member.active ? setSuspending(true) : action.run(() => setMemberActive(context, userId, true))} />}
    <Confirm visible={suspending} destructive title={t("suspendTitle", { name: member.name })} text={t("suspendText")} confirmLabel={t("suspend")} onCancel={() => setSuspending(false)}
      onConfirm={() => { setSuspending(false); action.run(() => setMemberActive(context, userId, false)); }} />
  </Screen>;
}

/** Owner adds a member with a role and an initial local code; a same-name member is refused rather than duplicated. */
export function StaffNewScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context } = useSession(), { members } = useMembers(), action = useAction();
  const [name, setName] = useState(""), [role, setRole] = useState<Exclude<Role, "OWNER">>("CASHIER"), [secret, setSecret] = useState(""), [confirmation, setConfirmation] = useState("");
  useLeaveGuard(name !== "" || secret !== "");
  const save = (): void => { void action.runAsync(async () => {
    if (name.trim() === "") throw new FormProblem("nameRequired");
    if (members.some(member => member.name.trim().toLowerCase() === name.trim().toLowerCase())) throw new FormProblem("memberExists");
    if (secret !== confirmation) throw new FormProblem("codesMismatch");
    return createLocalMember(context, { name: name.trim(), role, secret });
  }, id => { setSecret(""); setConfirmation(""); nav.replace("staffMember", { userId: id }); }); };
  return <Screen title={t("addMember")} onBack={nav.back} footer={<>{action.notice}<Button label={t("addMember")} busy={action.busy} onPress={save} /></>}>
    <Section>
      <Field label={t("newMemberName")} value={name} onChange={setName} autoFocus />
      <Segmented label={t("role")} value={role} onChange={setRole} options={ROLES.map(id => ({ id, label: t(roleKeys[id]) }))} />
      <Field label={t("memberSecret")} value={secret} onChange={setSecret} kind="secret" hint={t("codeRule")} /><Field label={t("confirmNewSecret")} value={confirmation} onChange={setConfirmation} kind="secret" />
    </Section>
  </Screen>;
}
