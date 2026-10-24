import { useMemo, useState } from "react";
import { Text } from "react-native";
import { createLocalMember, listLocalMembers, resetLocalMemberCredential, type LocalMember } from "@kolo/core/identity/members";
import { setMemberActive } from "@kolo/core/identity/recovery";
import { clearPermissionOverride, grantPermission, revokePermission } from "@kolo/core/identity/workspace";
import { changeMemberRole, createCustomRole, deleteCustomRole, listCustomRoles, listRoles, setRolePermissions, updateCustomRole, type CustomRoleView, type RoleView } from "@kolo/core/identity/roles";
import { isPermission, PERMISSIONS, resolvePermissions, type Permission, type StaffRole } from "@kolo/core/identity/permissions";
import { useText, type TextKey } from "../../app/i18n.tsx";
import { permissionKeys, roleKeys } from "../../app/strings.ts";
import { useLeaveGuard, useNav, useParams } from "../../app/navigation.tsx";
import { useRevision, useSession } from "../../app/session.tsx";
import { FormProblem, useAction } from "../../components/command.tsx";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { Button, Confirm, EmptyState, Field, ListRow, Notice, RowGroup, Screen, Section, Segmented, Toggle, useStyles } from "../../components/ui.tsx";

const ROLES: readonly StaffRole[] = ["CASHIER", "MANAGER", "INVENTORY", "ACCOUNTANT"];
const GROUPS: readonly (readonly [TextKey, (permission: Permission) => boolean])[] = [
  ["group.products", p => p.startsWith("products.")], ["group.inventory", p => p.startsWith("inventory.")], ["group.sales", p => p.startsWith("sales.")],
  ["group.customers", p => p.startsWith("customers.")], ["group.suppliers", p => p.startsWith("suppliers.") || p.startsWith("purchases.")],
  ["group.money", p => p.startsWith("cash.") || p.startsWith("finance.") || p.startsWith("expenses.")], ["group.reports", p => p.startsWith("reports.")],
  ["group.admin", p => p.startsWith("users.") || p.startsWith("business.") || p.startsWith("audit.") || p.startsWith("data.")],
];

/** The shop's role matrix (ADR-037); empty when it cannot be read. */
function useRoles(): readonly RoleView[] {
  const { context } = useSession(), revision = useRevision(["authority"]);
  return useMemo(() => { try { return listRoles(context); } catch { return []; } }, [context, revision]);
}
/** The shop's own roles, by name; empty when they cannot be read. */
function useCustomRoles(): readonly CustomRoleView[] {
  const { context } = useSession(), revision = useRevision(["authority"]);
  return useMemo(() => { try { return listCustomRoles(context); } catch { return []; } }, [context, revision]);
}
/** Role choices: built-in roles by ID, custom roles as `custom:<id>`; a deleted role shows only while it is held. */
const CUSTOM = "custom:";
type RoleChoice = StaffRole | `custom:${string}`;
function roleChoices(custom: readonly CustomRoleView[], t: (key: TextKey) => string, held?: string): { id: RoleChoice; label: string }[] {
  return [...ROLES.map(id => ({ id: id as RoleChoice, label: t(roleKeys[id]) })),
    ...custom.filter(role => !role.deleted || role.id === held).map(role => ({ id: `${CUSTOM}${role.id}` as RoleChoice, label: role.deleted ? `${role.name} · ${t("roleDeleted")}` : role.name }))];
}
/** A member's role in words: their custom role's name when they hold one. */
function roleName(member: LocalMember, custom: readonly CustomRoleView[], t: (key: TextKey) => string): string {
  return custom.find(role => role.id === member.customRoleId)?.name ?? t(roleKeys[member.role]);
}
/**
 * Effective permissions: the role's permissions in this shop plus grants minus revocations, as the desktop shows
 * them, and the exceptions where the member differs from the role.
 */
function useEffective(member: LocalMember | undefined): { readonly effective: readonly Permission[]; readonly base: readonly Permission[] } {
  const { database, context } = useSession(), revision = useRevision(["authority"]), roles = useRoles(), custom = useCustomRoles();
  return useMemo(() => {
    if (member === undefined) return { effective: [], base: [] };
    const base = member.role === "OWNER" ? PERMISSIONS : member.customRoleId !== undefined ? custom.find(view => view.id === member.customRoleId)?.permissions ?? []
      : roles.find(view => view.role === member.role)?.permissions ?? [];
    const row = database.get(`SELECT granted,revoked FROM local_memberships WHERE business_id=? AND user_id=?`, [context.businessId, member.userId]);
    const parse = (value: unknown): Permission[] => { try { const list: unknown = JSON.parse(typeof value === "string" ? value : "[]"); return Array.isArray(list) ? list.filter(isPermission) : []; } catch { return []; } };
    return { effective: [...resolvePermissions(member.role, parse(row?.["granted"]), parse(row?.["revoked"]), member.role === "OWNER" ? null : base)], base };
  }, [database, context, member, revision, roles, custom]);
}
function useMembers(): { members: readonly LocalMember[]; failed: boolean } {
  const { context } = useSession(), revision = useRevision(["authority"]);
  return useMemo(() => { try { return { members: listLocalMembers(context), failed: false }; } catch { return { members: [], failed: true }; } }, [context, revision]);
}

/** Staff list; owners add members here. */
export function StaffScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context, canManageStaff, database } = useSession(), { members, failed } = useMembers(), custom = useCustomRoles();
  // Members restored or synced from another device have no code on this one until the owner sets it.
  const remote = new Set(database.all(`SELECT user_id FROM local_memberships WHERE business_id=? AND credential_reference LIKE 'remote.%'`, [context.businessId]).map(row => String(row["user_id"])));
  return <Screen title={t("staff")} onBack={nav.back} actions={canManageStaff ? <Button label={t("new")} variant="ghost" onPress={() => nav.push("staffNew")} /> : undefined}>
    {failed && <Notice tone="error" text={t("loadFailed")} />}
    {!canManageStaff && <Notice text={t("staffReadOnly")} />}
    <RowGroup><ListRow title={t("staffRoles")} subtitle={t("staffRolesHelp")} onPress={() => nav.push("staffRoles")} /></RowGroup>
    <RowGroup>{members.map(member => <ListRow key={member.userId} title={member.name} subtitle={roleName(member, custom, t)}
      tag={!member.active ? t("suspended") : member.userId === context.userId ? t("you") : remote.has(member.userId) ? t("needsNewCode") : undefined} onPress={() => nav.push("staffMember", { userId: member.userId })} />)}</RowGroup>
  </Screen>;
}

/** One member: role, effective permissions by group, grants/revocations, suspension and code replacement. */
export function StaffMemberScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { userId } = useParams("staffMember"), session = useSession(), { context, canManageStaff } = session;
  const { members } = useMembers(), member = members.find(item => item.userId === userId), { effective, base } = useEffective(member), action = useAction(), custom = useCustomRoles();
  const [secret, setSecret] = useState(""), [confirmation, setConfirmation] = useState(""), [suspending, setSuspending] = useState(false);
  if (member === undefined) return <Screen title={t("staff")} onBack={nav.back}><EmptyState title={t("notFound")} /></Screen>;
  const self = member.userId === context.userId, editable = canManageStaff && !self && member.role !== "OWNER";
  // Going back to what the role gives drops the exception rather than recording a matching one.
  const toggle = (permission: Permission, allowed: boolean): void => action.run(() => {
    if (base.includes(permission) === allowed) clearPermissionOverride(context, userId, permission);
    else if (allowed) grantPermission(context, userId, permission); else revokePermission(context, userId, permission);
  });
  const replace = (): void => { void action.runAsync(async () => {
    if (secret !== confirmation) throw new FormProblem("codesMismatch");
    await resetLocalMemberCredential(context, userId, secret);
  }, () => { setSecret(""); setConfirmation(""); }, "memberSecretReplaced"); };
  return <Screen title={member.name} eyebrow={roleName(member, custom, t)} onBack={nav.back}>
    {!member.active && <Notice tone="warning" text={t("memberSuspendedHelp")} />}
    {action.notice}
    {editable && <Section><Segmented<RoleChoice> label={t("role")} value={member.customRoleId === undefined ? member.role as StaffRole : `${CUSTOM}${member.customRoleId}`}
      onChange={choice => action.run(() => changeMemberRole(context, userId, choice.startsWith(CUSTOM) ? { customRoleId: choice.slice(CUSTOM.length) } : choice as StaffRole))}
      options={roleChoices(custom, t, member.customRoleId)} hint={t("memberPermissionsHelp")} /></Section>}
    {GROUPS.map(([label, matches]) => <Section key={label} title={t(label)}>{PERMISSIONS.filter(matches).map(permission => {
      const exception = effective.includes(permission) !== base.includes(permission) ? t("memberException") : undefined;
      return editable
        ? <Toggle key={permission} label={t(permissionKeys[permission])} value={effective.includes(permission)} onChange={allowed => toggle(permission, allowed)} hint={exception ?? null} />
        : <Text key={permission} style={[s.body, !effective.includes(permission) && s.muted]}>{effective.includes(permission) ? "✓ " : "– "}{t(permissionKeys[permission])}{exception === undefined ? "" : ` · ${exception}`}</Text>;
    })}</Section>)}
    {editable && <Section title={t("replaceMemberSecret")}>
      <Text style={s.muted}>{t("selectedMemberSecret")}</Text>
      <Field label={t("newMemberSecret")} value={secret} onChange={setSecret} kind="secret" hint={t("codeRule")} />
      <Field label={t("confirmNewSecret")} value={confirmation} onChange={setConfirmation} kind="secret" hint={t("hint.confirmCode")} />
      <Button label={t("replaceMemberSecret")} variant="secondary" busy={action.busy} disabled={secret === ""} onPress={replace} />
    </Section>}
    {editable && <Button label={t(member.active ? "suspend" : "restore")} variant={member.active ? "danger" : "secondary"} onPress={() => member.active ? setSuspending(true) : action.run(() => setMemberActive(context, userId, true))} />}
    <Confirm visible={suspending} destructive title={t("suspendTitle", { name: member.name })} text={t("suspendText")} confirmLabel={t("suspend")} onCancel={() => setSuspending(false)}
      onConfirm={() => { setSuspending(false); action.run(() => setMemberActive(context, userId, false)); }} />
  </Screen>;
}

/**
 * The role matrix, one role at a time: owners change what each staff role allows and can reset it, and create,
 * rename and delete the shop's own roles. A role somebody holds cannot be deleted.
 */
export function StaffRolesScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { context, canManageStaff } = useSession(), roles = useRoles(), custom = useCustomRoles(), action = useAction();
  const [choice, setChoice] = useState<RoleChoice>("CASHIER"), [resetting, setResetting] = useState(false), [deleting, setDeleting] = useState(false);
  const [drafting, setDrafting] = useState(false), [name, setName] = useState(""), [base, setBase] = useState<StaffRole>("CASHIER"), [renaming, setRenaming] = useState<string>();
  const own = choice.startsWith(CUSTOM) ? custom.find(item => `${CUSTOM}${item.id}` === choice) : undefined;
  const view = own === undefined ? roles.find(item => item.role === choice) : undefined, held = own?.permissions ?? view?.permissions ?? [];
  const editable = canManageStaff && own?.deleted !== true;
  const toggle = (permission: Permission, allowed: boolean): void => action.run(() => {
    const next = allowed ? [...held, permission] : held.filter(item => item !== permission);
    if (own === undefined) setRolePermissions(context, choice as StaffRole, next); else updateCustomRole(context, own.id, { permissions: next });
  });
  const create = (): void => action.run(() => createCustomRole(context, { id: newIdOnDevice(), name, baseRole: base }),
    role => { setDrafting(false); setName(""); setChoice(`${CUSTOM}${role.id}`); });
  return <Screen title={t("staffRoles")} onBack={nav.back}>
    <Notice text={canManageStaff ? t("staffRolesHelp") : t("staffReadOnly")} />
    {action.notice}
    <Section><Segmented<RoleChoice> label={t("role")} value={own === undefined && view === undefined ? undefined : choice} onChange={next => { setChoice(next); setRenaming(undefined); }}
      options={roleChoices(custom, t, own?.id)} hint={t("hint.roleChoose")} />
      {view?.customized === true && <Text style={s.muted}>{t("roleCustomized")}</Text>}
      {own !== undefined && <Text style={s.muted}>{`${t("copiedFrom")} ${t(roleKeys[own.baseRole])}`}</Text>}
      {canManageStaff && !drafting && <Button label={t("newRole")} variant="secondary" onPress={() => setDrafting(true)} />}</Section>
    {drafting && <Section title={t("newRole")}>
      <Text style={s.muted}>{t("newRoleHelp")}</Text>
      <Field label={t("roleName")} value={name} onChange={setName} autoFocus hint={t("hint.roleName")} />
      <Segmented<StaffRole> label={t("copiedFrom")} hint={t("hint.roleBase")} value={base} onChange={setBase} options={ROLES.map(id => ({ id, label: t(roleKeys[id]) }))} />
      <Button label={t("createRole")} onPress={create} /><Button label={t("cancel")} variant="ghost" onPress={() => { setDrafting(false); setName(""); }} />
    </Section>}
    {own !== undefined && editable && <Section>
      {renaming === undefined ? <Button label={t("renameRole")} variant="secondary" onPress={() => setRenaming(own.name)} />
        : <><Field label={t("roleName")} value={renaming} onChange={setRenaming} hint={t("hint.roleName")} />
          <Button label={t("save")} onPress={() => action.run(() => updateCustomRole(context, own.id, { name: renaming }), () => setRenaming(undefined))} /></>}
    </Section>}
    {GROUPS.map(([label, matches]) => <Section key={label} title={t(label)}>{PERMISSIONS.filter(matches).map(permission => editable
      ? <Toggle key={permission} label={t(permissionKeys[permission])} value={held.includes(permission)} onChange={allowed => toggle(permission, allowed)} hint={null} />
      : <Text key={permission} style={[s.body, !held.includes(permission) && s.muted]}>{held.includes(permission) ? "✓ " : "– "}{t(permissionKeys[permission])}</Text>)}</Section>)}
    {canManageStaff && view?.customized === true && <Button label={t("resetRole")} variant="secondary" onPress={() => setResetting(true)} />}
    {editable && own !== undefined && <Button label={t("deleteRole")} variant="danger" onPress={() => own.holders > 0 ? action.run(() => { throw new FormProblem("roleInUse"); }) : setDeleting(true)} />}
    <Confirm visible={resetting} title={t("resetRoleTitle")} text={t("resetRoleText")} confirmLabel={t("resetRole")} onCancel={() => setResetting(false)}
      onConfirm={() => { setResetting(false); action.run(() => setRolePermissions(context, choice as StaffRole, null)); }} />
    <Confirm visible={deleting} destructive title={t("deleteRoleTitle")} text={t("deleteRoleText")} confirmLabel={t("deleteRole")} onCancel={() => setDeleting(false)}
      onConfirm={() => { setDeleting(false); if (own !== undefined) action.run(() => deleteCustomRole(context, own.id), () => setChoice("CASHIER")); }} />
  </Screen>;
}

/** Owner adds a member with a role and an initial local code; a same-name member is refused rather than duplicated. */
export function StaffNewScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context } = useSession(), { members } = useMembers(), action = useAction(), custom = useCustomRoles();
  const [name, setName] = useState(""), [role, setRole] = useState<RoleChoice>("CASHIER"), [secret, setSecret] = useState(""), [confirmation, setConfirmation] = useState("");
  useLeaveGuard(name !== "" || secret !== "");
  const save = (): void => { void action.runAsync(async () => {
    if (name.trim() === "") throw new FormProblem("nameRequired");
    if (members.some(member => member.name.trim().toLowerCase() === name.trim().toLowerCase())) throw new FormProblem("memberExists");
    if (secret !== confirmation) throw new FormProblem("codesMismatch");
    const own = role.startsWith(CUSTOM) ? custom.find(item => `${CUSTOM}${item.id}` === role) : undefined;
    const id = await createLocalMember(context, { name: name.trim(), role: own?.baseRole ?? role as StaffRole, secret });
    // A separate owner fact; if it fails the member keeps the base role and can be moved from their page.
    if (own !== undefined) changeMemberRole(context, id, { customRoleId: own.id });
    return id;
  }, id => { setSecret(""); setConfirmation(""); nav.replace("staffMember", { userId: id }); }); };
  return <Screen title={t("addMember")} onBack={nav.back} footer={<>{action.notice}<Button label={t("addMember")} busy={action.busy} onPress={save} /></>}>
    <Section>
      <Field label={t("newMemberName")} value={name} onChange={setName} autoFocus hint={t("hint.memberName")} />
      <Segmented<RoleChoice> label={t("role")} hint={t("hint.memberRole")} value={role} onChange={setRole} options={roleChoices(custom, t)} />
      <Field label={t("memberSecret")} value={secret} onChange={setSecret} kind="secret" hint={t("codeRule")} />
      <Field label={t("confirmNewSecret")} value={confirmation} onChange={setConfirmation} kind="secret" hint={t("hint.confirmCode")} />
    </Section>
  </Screen>;
}
