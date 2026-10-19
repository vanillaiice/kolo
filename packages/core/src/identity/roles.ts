import type { Queryable } from "../data/database/driver.ts";
import { authorizedOperation, appendLocalAudit, rolePermissions, timestamp } from "./internal-authority.ts";
import { PERMISSIONS, STAFF_ROLES, defaultPermissions, isPermission, isStaffRole, type Permission, type StaffRole } from "./permissions.ts";
import { WorkspaceError, type OperationContext } from "./types.ts";

/** One staff role's permissions as the shop resolves them now (ADR-037). */
export interface RoleView {
  readonly role: StaffRole;
  /** The role's permissions in catalog order: the shop's edited set, or the built-in defaults. */
  readonly permissions: readonly Permission[];
  /** False while the role keeps its built-in defaults. */
  readonly customized: boolean;
  /** How many times the shop has set this role; 0 if never. */
  readonly revision: number;
}

/** The role matrix under users.view: every staff role with its current permissions. The owner always holds all. */
export function listRoles(context: OperationContext): readonly RoleView[] {
  return authorizedOperation(context, ["users.view"], (_database, tx) => STAFF_ROLES.map(role => roleView(tx, context.businessId, role)));
}

/**
 * Owner-only: sets the permissions every member with this role starts from (ADR-037), recorded as a signed
 * `ROLE_PERMISSIONS_SET` that other tills apply. `null`, or a set equal to the built-in defaults, returns the role to
 * those defaults. Members' own grants and revocations still apply on top. Asking for the current set changes nothing.
 */
export function setRolePermissions(context: OperationContext, role: StaffRole, permissions: readonly Permission[] | null): void {
  if (!isStaffRole(role) || (permissions !== null && (!Array.isArray(permissions) || !permissions.every(isPermission)))) throw new WorkspaceError("invalid_input");
  const chosen = permissions === null ? null : PERMISSIONS.filter(permission => permissions.includes(permission));
  const next = chosen !== null && same(chosen, defaultPermissions(role)) ? null : chosen;
  authorizedOperation(context, ["users.manage"], (_database, tx, ports, revision) => {
    requireOwner(tx, context);
    const old = tx.get(`SELECT revision FROM role_permissions WHERE business_id = ? AND role = ?`, [context.businessId, role]);
    const current = rolePermissions(tx, context.businessId, role);
    if (current === null ? next === null : next !== null && same(current, next)) return;
    const roleRevision = Number(old?.["revision"] ?? 0) + 1;
    tx.run(`INSERT INTO role_permissions(business_id,role,permissions,revision) VALUES (?,?,?,?)
      ON CONFLICT(business_id,role) DO UPDATE SET permissions=excluded.permissions,revision=excluded.revision`,
    [context.businessId, role, next === null ? null : JSON.stringify(next), roleRevision]);
    appendLocalAudit(tx, context, ports, revision, "ROLE_PERMISSIONS_SET", context.businessId, { role, permissions: next, revision: roleRevision });
  });
}

/**
 * Owner-only: moves a staff member to another staff role, keeping their own grants and revocations. The owner's role
 * never changes and no member becomes owner. Asking for the current role changes nothing.
 */
export function changeMemberRole(context: OperationContext, userId: string, role: StaffRole): void {
  if (!isStaffRole(role)) throw new WorkspaceError("invalid_input");
  authorizedOperation(context, ["users.manage"], (_database, tx, ports) => {
    requireOwner(tx, context);
    const member = tx.get(`SELECT role,revision FROM local_memberships WHERE business_id = ? AND user_id = ?`, [context.businessId, userId]);
    if (member === undefined) throw new WorkspaceError("scope_mismatch");
    if (member["role"] === "OWNER") throw new WorkspaceError("permission_denied");
    if (member["role"] === role) return;
    const revision = Number(member["revision"]) + 1, at = timestamp(ports);
    tx.run(`UPDATE local_memberships SET role = ?, revision = ? WHERE business_id = ? AND user_id = ?`, [role, revision, context.businessId, userId]);
    tx.run(`UPDATE users SET role = ?, updated_at = max(updated_at, ?) WHERE business_id = ? AND id = ?`, [role, at, context.businessId, userId]);
    appendLocalAudit(tx, context, ports, revision, "MEMBER_ROLE_CHANGED", userId, { role, revision });
  });
}

function roleView(tx: Queryable, businessId: string, role: StaffRole): RoleView {
  const edited = rolePermissions(tx, businessId, role);
  const revision = Number(tx.get(`SELECT revision FROM role_permissions WHERE business_id = ? AND role = ?`, [businessId, role])?.["revision"] ?? 0);
  return Object.freeze({ role, permissions: edited ?? defaultPermissions(role), customized: edited !== null, revision });
}

function same(a: readonly Permission[], b: readonly Permission[]): boolean {
  return a.length === b.length && a.every(permission => b.includes(permission));
}

function requireOwner(tx: Queryable, context: OperationContext): void {
  if (tx.get(`SELECT owner_id FROM local_installation WHERE id = 1`)?.["owner_id"] !== context.userId) throw new WorkspaceError("permission_denied");
}
