import { createLocalMember, resetLocalMemberCredential, listLocalMembers } from "@kolo/core/identity/members";
import { setMemberActive } from "@kolo/core/identity/recovery";
import { grantPermission, revokePermission } from "@kolo/core/identity/workspace";
import { isPermission, resolvePermissions, type Permission, type Role } from "@kolo/core/identity/permissions";
import { WorkspaceError, type OperationContext } from "@kolo/core/identity/types";
import type { StaffView } from "../shared/service.js";
import { object, text, uuid, boolean } from "./validation.ts";
import { CommandError, type Host } from "./host.ts";

const roles: readonly Exclude<Role, "OWNER">[] = ["MANAGER", "CASHIER", "INVENTORY", "ACCOUNTANT"];
function permissionsOf(host: Host, context: OperationContext, userId: string, role: Role): Permission[] {
  const row = host.ports.database.get(`SELECT granted,revoked FROM local_memberships WHERE business_id=? AND user_id=?`, [context.businessId, userId]);
  const parse = (value: unknown): Permission[] => { const list: unknown = JSON.parse(typeof value === "string" ? value : "[]"); return Array.isArray(list) ? list.filter(isPermission) : []; };
  return [...resolvePermissions(role, parse(row?.["granted"]), parse(row?.["revoked"]))];
}
function staff(host: Host, context: OperationContext): StaffView[] {
  return listLocalMembers(context).map(member => ({ id: member.userId, name: member.name, role: member.role, active: member.active, isSelf: member.userId === context.userId,
    permissions: permissionsOf(host, context, member.userId, member.role) }));
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
  if (!roles.includes(data["role"] as Exclude<Role, "OWNER">)) throw new WorkspaceError("invalid_input");
  if (staff(host, context).some(member => member.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new CommandError("request_conflict");
  const userId = await createLocalMember(context, { name, role: data["role"] as Exclude<Role, "OWNER">, secret });
  return one(host, context, userId);
}
/** Owner-only grant/revoke; a request for the current effective state changes nothing. */
export function setStaffPermission(host: Host, input: unknown): StaffView {
  const data = object(input, ["sessionId", "userId", "permission", "allowed"]), context = host.actor(data, ["users.manage"]);
  const userId = uuid(data["userId"]), allowed = boolean(data["allowed"]);
  if (!isPermission(data["permission"])) throw new WorkspaceError("invalid_input");
  const permission = data["permission"], current = one(host, context, userId);
  if (current.permissions.includes(permission) !== allowed) (allowed ? grantPermission : revokePermission)(context, userId, permission);
  return one(host, context, userId);
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
