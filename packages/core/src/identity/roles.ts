import type { Queryable } from "../data/database/driver.ts";
import { authorizedOperation, appendLocalAudit, permissionArray, rolePermissions, timestamp } from "./internal-authority.ts";
import { PERMISSIONS, STAFF_ROLES, defaultPermissions, isPermission, isStaffRole, type Permission, type StaffRole } from "./permissions.ts";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "./types.ts";

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

/** A shop-defined role: a named copy of a built-in staff role with its own permissions. */
export interface CustomRoleView {
  readonly id: string;
  readonly name: string;
  /** The built-in role it was copied from; members holding it have this as their role. */
  readonly baseRole: StaffRole;
  /** Its permissions in catalog order. */
  readonly permissions: readonly Permission[];
  /** True once the owner deleted it; listed only while someone still holds it, and no longer assignable. */
  readonly deleted: boolean;
  /** Members, active or suspended, who hold it now. */
  readonly holders: number;
  readonly revision: number;
}

/** Shop-defined roles under users.view, by name: every live role, and deleted ones that members still hold. */
export function listCustomRoles(context: OperationContext): readonly CustomRoleView[] {
  return authorizedOperation(context, ["users.view"], (_database, tx) => tx.all(`SELECT r.*,
      (SELECT count(*) FROM local_memberships m WHERE m.business_id = r.business_id AND m.custom_role_id = r.id) AS holders
    FROM custom_roles r WHERE r.business_id = ? AND (r.deleted = 0 OR holders > 0) ORDER BY r.name COLLATE NOCASE, r.id`, [context.businessId]).map(customView));
}

/**
 * Owner-only: a new role named `name`, starting from the shop's current permissions for `baseRole`. `id` is the
 * caller's request ID: repeating the same creation returns the stored role. Names are unique, ignoring case.
 */
export function createCustomRole(context: OperationContext, input: { readonly id: string; readonly name: string; readonly baseRole: StaffRole }): CustomRoleView {
  const id = roleId(input.id), name = roleName(input.name);
  if (!isStaffRole(input.baseRole)) throw new WorkspaceError("invalid_input");
  return authorizedOperation(context, ["users.manage"], (_database, tx, ports, revision) => {
    requireOwner(tx, context);
    const existing = tx.get(`SELECT * FROM custom_roles WHERE business_id = ? AND id = ?`, [context.businessId, id]);
    if (existing !== undefined) {
      if (existing["name"] !== name || existing["base_role"] !== input.baseRole || existing["deleted"] !== 0) throw new WorkspaceError("invalid_input");
      return customRole(tx, context.businessId, id);
    }
    if (tx.get(`SELECT id FROM custom_roles WHERE id = ?`, [id]) !== undefined) throw new WorkspaceError("scope_mismatch");
    uniqueName(tx, context.businessId, name, id);
    const permissions = rolePermissions(tx, context.businessId, input.baseRole) ?? [...defaultPermissions(input.baseRole)];
    writeCustomRole(tx, context, ports, revision, { id, name, baseRole: input.baseRole, permissions, deleted: false, revision: 1 });
    return customRole(tx, context.businessId, id);
  });
}

/** Owner-only: renames a live custom role or replaces its permissions; it reaches every holder's next command. */
export function updateCustomRole(context: OperationContext, id: string, change: { readonly name?: string; readonly permissions?: readonly Permission[] }): CustomRoleView {
  const name = change.name === undefined ? undefined : roleName(change.name);
  if (change.permissions !== undefined && (!Array.isArray(change.permissions) || !change.permissions.every(isPermission))) throw new WorkspaceError("invalid_input");
  return authorizedOperation(context, ["users.manage"], (_database, tx, ports, revision) => {
    requireOwner(tx, context);
    const stored = liveRole(tx, context.businessId, roleId(id));
    const next = { ...stored, name: name ?? stored.name, permissions: change.permissions === undefined ? stored.permissions : PERMISSIONS.filter(permission => change.permissions!.includes(permission)) };
    if (next.name === stored.name && same(next.permissions, stored.permissions)) return stored;
    if (next.name.toLocaleLowerCase() !== stored.name.toLocaleLowerCase()) uniqueName(tx, context.businessId, next.name, stored.id);
    writeCustomRole(tx, context, ports, revision, { ...next, deleted: false, revision: stored.revision + 1 });
    return customRole(tx, context.businessId, stored.id);
  });
}

/** Owner-only: deletes a custom role nobody holds (`role_in_use` otherwise). Deleting a deleted role changes nothing. */
export function deleteCustomRole(context: OperationContext, id: string): void {
  authorizedOperation(context, ["users.manage"], (_database, tx, ports, revision) => {
    requireOwner(tx, context);
    const stored = customRole(tx, context.businessId, roleId(id));
    if (stored.deleted) return;
    if (stored.holders > 0) throw new WorkspaceError("role_in_use");
    writeCustomRole(tx, context, ports, revision, { ...stored, deleted: true, revision: stored.revision + 1 });
  });
}

/**
 * Owner-only: moves a staff member to another staff role or to a live custom role, keeping their own grants and
 * revocations. The owner's role never changes and no member becomes owner. Asking for the current role changes nothing.
 */
export function changeMemberRole(context: OperationContext, userId: string, role: StaffRole | { readonly customRoleId: string }): void {
  if (typeof role === "string" ? !isStaffRole(role) : role === null || typeof role !== "object") throw new WorkspaceError("invalid_input");
  authorizedOperation(context, ["users.manage"], (_database, tx, ports) => {
    requireOwner(tx, context);
    const member = tx.get(`SELECT role,custom_role_id,revision FROM local_memberships WHERE business_id = ? AND user_id = ?`, [context.businessId, userId]);
    if (member === undefined) throw new WorkspaceError("scope_mismatch");
    if (member["role"] === "OWNER") throw new WorkspaceError("permission_denied");
    const custom = typeof role === "string" ? undefined : liveRole(tx, context.businessId, roleId(role.customRoleId));
    const base = custom?.baseRole ?? role as StaffRole, customId = custom?.id ?? null;
    if (member["role"] === base && (member["custom_role_id"] ?? null) === customId) return;
    const revision = Number(member["revision"]) + 1, at = timestamp(ports);
    tx.run(`UPDATE local_memberships SET role = ?, custom_role_id = ?, revision = ? WHERE business_id = ? AND user_id = ?`, [base, customId, revision, context.businessId, userId]);
    tx.run(`UPDATE users SET role = ?, updated_at = max(updated_at, ?) WHERE business_id = ? AND id = ?`, [base, at, context.businessId, userId]);
    appendLocalAudit(tx, context, ports, revision, "MEMBER_ROLE_CHANGED", userId, { role: base, ...(customId === null ? {} : { custom_role_id: customId }), revision });
  });
}

function writeCustomRole(tx: Queryable, context: OperationContext, ports: WorkspacePorts, actorRevision: number,
  role: { readonly id: string; readonly name: string; readonly baseRole: StaffRole; readonly permissions: readonly Permission[]; readonly deleted: boolean; readonly revision: number }): void {
  tx.run(`INSERT INTO custom_roles(business_id,id,name,base_role,permissions,deleted,revision) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(business_id,id) DO UPDATE SET name=excluded.name,permissions=excluded.permissions,deleted=excluded.deleted,revision=excluded.revision`,
  [context.businessId, role.id, role.name, role.baseRole, JSON.stringify(role.permissions), role.deleted ? 1 : 0, role.revision]);
  appendLocalAudit(tx, context, ports, actorRevision, "CUSTOM_ROLE_SET", role.id,
    { role_id: role.id, name: role.name, base_role: role.baseRole, permissions: role.permissions, deleted: role.deleted, revision: role.revision });
}

function customRole(tx: Queryable, businessId: string, id: string): CustomRoleView {
  const row = tx.get(`SELECT r.*, (SELECT count(*) FROM local_memberships m WHERE m.business_id = r.business_id AND m.custom_role_id = r.id) AS holders
    FROM custom_roles r WHERE r.business_id = ? AND r.id = ?`, [businessId, id]);
  if (row === undefined) throw new WorkspaceError("scope_mismatch");
  return customView(row);
}

function liveRole(tx: Queryable, businessId: string, id: string): CustomRoleView {
  const role = customRole(tx, businessId, id);
  if (role.deleted) throw new WorkspaceError("scope_mismatch");
  return role;
}

function customView(row: Record<string, unknown>): CustomRoleView {
  return Object.freeze({ id: String(row["id"]), name: String(row["name"]), baseRole: row["base_role"] as StaffRole, permissions: permissionArray(row["permissions"]),
    deleted: row["deleted"] === 1, holders: Number(row["holders"] ?? 0), revision: Number(row["revision"]) });
}

function uniqueName(tx: Queryable, businessId: string, name: string, id: string): void {
  const taken = tx.all(`SELECT name FROM custom_roles WHERE business_id = ? AND id <> ? AND deleted = 0`, [businessId, id])
    .some(row => String(row["name"]).toLocaleLowerCase() === name.toLocaleLowerCase());
  if (taken) throw new WorkspaceError("duplicate_name");
}

function roleName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 60) throw new WorkspaceError("invalid_input");
  return value.trim();
}

function roleId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new WorkspaceError("invalid_input");
  return value;
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
