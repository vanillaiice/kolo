import { createLocalMember, resetLocalMemberCredential, listLocalMembers } from "@kolo/core/identity/members";
import { setMemberActive } from "@kolo/core/identity/recovery";
import { clearPermissionOverride, grantPermission, revokePermission } from "@kolo/core/identity/workspace";
import { changeMemberRole, listRoles as coreRoles, setRolePermissions } from "@kolo/core/identity/roles";
import { PERMISSIONS, isPermission, isStaffRole, resolvePermissions, type Permission, type Role } from "@kolo/core/identity/permissions";
import { WorkspaceError, type OperationContext } from "@kolo/core/identity/types";
import type { RoleView, StaffView } from "../shared/service.js";
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
function staff(host: Host, context: OperationContext): StaffView[] {
  const matrix = roles(context);
  return listLocalMembers(context).map(member => {
    const base = roleBase(matrix, member.role), permissions = permissionsOf(host, context, member.userId, member.role, base);
    return { id: member.userId, name: member.name, role: member.role, active: member.active, isSelf: member.userId === context.userId,
      permissions, exceptions: PERMISSIONS.filter(permission => permissions.includes(permission) !== base.includes(permission)) };
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
  const data = object(input, ["sessionId", "name", "role", "secret"]), context = host.actor(data, ["users.manage"]);
  const name = text(data["name"]), secret = text(data["secret"], 256, false);
  if (!isStaffRole(data["role"])) throw new WorkspaceError("invalid_input");
  if (staff(host, context).some(member => member.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new CommandError("request_conflict");
  const userId = await createLocalMember(context, { name, role: data["role"], secret });
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
/** Owner-only move of another member to a staff role; their exceptions stay. */
export function setStaffRole(host: Host, input: unknown): StaffView {
  const data = object(input, ["sessionId", "userId", "role"]), context = host.actor(data, ["users.manage"]);
  const userId = uuid(data["userId"]);
  if (!isStaffRole(data["role"])) throw new WorkspaceError("invalid_input");
  changeMemberRole(context, userId, data["role"]);
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
