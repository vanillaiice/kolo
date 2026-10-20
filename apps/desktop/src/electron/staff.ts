import { createLocalMember, resetLocalMemberCredential, listLocalMembers } from "@kolo/core/identity/members";
import { setMemberActive } from "@kolo/core/identity/recovery";
import { clearPermissionOverride, grantPermission, revokePermission } from "@kolo/core/identity/workspace";
import { changeMemberRole, createCustomRole as coreCreateCustomRole, deleteCustomRole as coreDeleteCustomRole, listCustomRoles as coreCustomRoles,
  listRoles as coreRoles, setRolePermissions, updateCustomRole, type CustomRoleView as CoreCustomRole } from "@kolo/core/identity/roles";
import { PERMISSIONS, isPermission, isStaffRole, resolvePermissions, type Permission, type Role } from "@kolo/core/identity/permissions";
import { WorkspaceError, type OperationContext } from "@kolo/core/identity/types";
import type { CustomRoleView, RoleView, StaffView } from "../shared/service.js";
import { object, text, uuid, boolean } from "./validation.ts";
import { CommandError, type Host } from "./host.ts";

function roleBase(roles: readonly RoleView[], role: Role): readonly Permission[] {
  return role === "OWNER" ? PERMISSIONS : roles.find(item => item.role === role)?.permissions ?? [];
}
function permissionsOf(host: Host, context: OperationContext, userId: string, role: Role, base: readonly Permission[]): Permission[] {
  const row = host.ports.database.get(`SELECT granted,revoked FROM local_memberships WHERE business_id=? AND user_id=?`, [context.businessId, userId]);
  const parse = (value: unknown): Permission[] => { const list: unknown = JSON.parse(typeof value === "string" ? value : "[]"); return Array.isArray(list) ? list.filter(isPermission) : []; };
  return [...resolvePermissions(role, parse(row?.["granted"]), parse(row?.["revoked"]), role === "OWNER" ? null : base)];
}
function roles(context: OperationContext): RoleView[] {
  return coreRoles(context).map(view => ({ role: view.role, permissions: view.permissions, customized: view.customized }));
}
function customRoles(context: OperationContext): CustomRoleView[] {
  return coreCustomRoles(context).map(view => ({ id: view.id, name: view.name, baseRole: view.baseRole, permissions: view.permissions, deleted: view.deleted, holders: view.holders }));
}
function staff(host: Host, context: OperationContext): StaffView[] {
  const matrix = roles(context), custom = coreCustomRoles(context);
  return listLocalMembers(context).map(member => {
    const held: CoreCustomRole | undefined = member.customRoleId === undefined ? undefined : custom.find(role => role.id === member.customRoleId);
    if (member.customRoleId !== undefined && held === undefined) throw new WorkspaceError("permission_denied");
    const base = held?.permissions ?? roleBase(matrix, member.role), permissions = permissionsOf(host, context, member.userId, member.role, base);
    return { id: member.userId, name: member.name, role: member.role, active: member.active, isSelf: member.userId === context.userId,
      permissions, exceptions: PERMISSIONS.filter(permission => permissions.includes(permission) !== base.includes(permission)),
      ...(held === undefined ? {} : { customRole: { id: held.id, name: held.name, deleted: held.deleted } }) };
  });
}
function one(host: Host, context: OperationContext, userId: string): StaffView {
  const member = staff(host, context).find(item => item.id === userId);
  if (member === undefined) throw new WorkspaceError("scope_mismatch");
  return member;
}
/** Staff with effective permissions under users.view. */
export function listStaff(host: Host, input: unknown): readonly StaffView[] {
  const data = object(input, ["sessionId"]); return staff(host, host.actor(data));
}
/**
 * Owner-only member creation. Core draws the identities, so a retried creation is recognised by
 * name instead: a member with the same name (any case) is refused rather than duplicated.
 */
export async function createStaff(host: Host, input: unknown): Promise<StaffView> {
  const data = object(input, ["sessionId", "name", "role", "secret", "customRoleId"]), context = host.actor(data, ["users.manage"]);
  const name = text(data["name"]), secret = text(data["secret"], 256, false);
  const custom = data["customRoleId"] === undefined ? undefined : coreCustomRoles(context).find(role => role.id === uuid(data["customRoleId"]) && !role.deleted);
  if (data["customRoleId"] !== undefined && custom === undefined) throw new WorkspaceError("scope_mismatch");
  const role = custom?.baseRole ?? data["role"];
  if (!isStaffRole(role)) throw new WorkspaceError("invalid_input");
  if (staff(host, context).some(member => member.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new CommandError("request_conflict");
  const userId = await createLocalMember(context, { name, role, secret });
  // A separate owner fact: if it fails, the member exists with the role's base and can be moved from their page.
  if (custom !== undefined) changeMemberRole(context, userId, { customRoleId: custom.id });
  return one(host, context, userId);
}
/**
 * Owner-only grant/revoke. Asking for what the role gives clears the member's exception rather than recording one,
 * and a request for the current effective state changes nothing.
 */
export function setStaffPermission(host: Host, input: unknown): StaffView {
  const data = object(input, ["sessionId", "userId", "permission", "allowed"]), context = host.actor(data, ["users.manage"]);
  const userId = uuid(data["userId"]), allowed = boolean(data["allowed"]);
  if (!isPermission(data["permission"])) throw new WorkspaceError("invalid_input");
  const permission = data["permission"], current = one(host, context, userId);
  if (current.permissions.includes(permission) === allowed) return current;
  if (current.exceptions.includes(permission)) clearPermissionOverride(context, userId, permission);
  else (allowed ? grantPermission : revokePermission)(context, userId, permission);
  return one(host, context, userId);
}
/** Owner-only move of another member to a staff role or a live custom role; their exceptions stay. */
export function setStaffRole(host: Host, input: unknown): StaffView {
  const data = object(input, ["sessionId", "userId", "role", "customRoleId"]), context = host.actor(data, ["users.manage"]);
  const userId = uuid(data["userId"]);
  if ((data["role"] === undefined) === (data["customRoleId"] === undefined)) throw new WorkspaceError("invalid_input");
  if (data["customRoleId"] !== undefined) changeMemberRole(context, userId, { customRoleId: uuid(data["customRoleId"]) });
  else if (isStaffRole(data["role"])) changeMemberRole(context, userId, data["role"]);
  else throw new WorkspaceError("invalid_input");
  return one(host, context, userId);
}
/** The role matrix under users.view. */
export function listRoles(host: Host, input: unknown): readonly RoleView[] {
  const data = object(input, ["sessionId"]); return roles(host.actor(data));
}
/** Owner-only: one cell of the role matrix; the current state changes nothing. */
export function setRolePermission(host: Host, input: unknown): readonly RoleView[] {
  const data = object(input, ["sessionId", "role", "permission", "allowed"]), context = host.actor(data, ["users.manage"]), allowed = boolean(data["allowed"]);
  if (!isStaffRole(data["role"]) || !isPermission(data["permission"])) throw new WorkspaceError("invalid_input");
  const role = data["role"], permission = data["permission"], current = roleBase(roles(context), role);
  if (current.includes(permission) !== allowed) setRolePermissions(context, role, allowed ? [...current, permission] : current.filter(item => item !== permission));
  return roles(context);
}
/** Owner-only: a role back to its built-in defaults. */
export function resetRole(host: Host, input: unknown): readonly RoleView[] {
  const data = object(input, ["sessionId", "role"]), context = host.actor(data, ["users.manage"]);
  if (!isStaffRole(data["role"])) throw new WorkspaceError("invalid_input");
  setRolePermissions(context, data["role"], null);
  return roles(context);
}
/** Shop-defined roles under users.view. */
export function listCustomRoles(host: Host, input: unknown): readonly CustomRoleView[] {
  const data = object(input, ["sessionId"]); return customRoles(host.actor(data));
}
/** Owner-only: a new custom role copied from a staff role; an identical retry of the request returns it. */
export function createCustomRole(host: Host, input: unknown): readonly CustomRoleView[] {
  const data = object(input, ["sessionId", "requestId", "name", "baseRole"]), context = host.actor(data, ["users.manage"]);
  if (!isStaffRole(data["baseRole"])) throw new WorkspaceError("invalid_input");
  coreCreateCustomRole(context, { id: uuid(data["requestId"]), name: text(data["name"], 60), baseRole: data["baseRole"] });
  return customRoles(context);
}
/** Owner-only: renames a live custom role. */
export function renameCustomRole(host: Host, input: unknown): readonly CustomRoleView[] {
  const data = object(input, ["sessionId", "roleId", "name"]), context = host.actor(data, ["users.manage"]);
  updateCustomRole(context, uuid(data["roleId"]), { name: text(data["name"], 60) });
  return customRoles(context);
}
/** Owner-only: one permission of a live custom role; the current state changes nothing. */
export function setCustomRolePermission(host: Host, input: unknown): readonly CustomRoleView[] {
  const data = object(input, ["sessionId", "roleId", "permission", "allowed"]), context = host.actor(data, ["users.manage"]), allowed = boolean(data["allowed"]);
  if (!isPermission(data["permission"])) throw new WorkspaceError("invalid_input");
  const roleId = uuid(data["roleId"]), permission = data["permission"], current = coreCustomRoles(context).find(role => role.id === roleId && !role.deleted);
  if (current === undefined) throw new WorkspaceError("scope_mismatch");
  if (current.permissions.includes(permission) !== allowed) updateCustomRole(context, roleId, { permissions: allowed ? [...current.permissions, permission] : current.permissions.filter(item => item !== permission) });
  return customRoles(context);
}
/** Owner-only: deletes a custom role nobody holds. */
export function deleteCustomRole(host: Host, input: unknown): readonly CustomRoleView[] {
  const data = object(input, ["sessionId", "roleId"]), context = host.actor(data, ["users.manage"]);
  coreDeleteCustomRole(context, uuid(data["roleId"]));
  return customRoles(context);
}
/** Owner-only suspension/reinstatement of another member; the current state is a no-op. */
export function setStaffActive(host: Host, input: unknown): StaffView {
  const data = object(input, ["sessionId", "userId", "active"]), context = host.actor(data, ["users.manage"]);
  const userId = uuid(data["userId"]), active = boolean(data["active"]);
  if (one(host, context, userId).active !== active) setMemberActive(context, userId, active);
  return one(host, context, userId);
}
/** Owner-only code replacement for another member, through the native credential vault. */
export async function resetStaffSecret(host: Host, input: unknown): Promise<StaffView> {
  const data = object(input, ["sessionId", "userId", "secret"]), context = host.actor(data, ["users.manage"]);
  const userId = uuid(data["userId"]);
  if (userId === context.userId) throw new WorkspaceError("permission_denied");
  await resetLocalMemberCredential(context, userId, text(data["secret"], 256, false));
  return one(host, context, userId);
}
