import { captureAuthorityFact } from "../data/exchange/authority.ts";
import { withinJournalContext } from "../data/exchange/internal-context.ts";
// Package-private capability registry and transactional orchestration.
import type { Database, Queryable, Row } from "../data/database/driver.ts";
import { isPermission, resolvePermissions, type Permission, type Role } from "./permissions.ts";
import { WorkspaceError, type OperationContext, type WorkspacePorts, type Installation } from "./types.ts";

/** @internal In-memory lifecycle shared by workspace commands. */
export interface Runtime {
  epoch: number;
  unlocking: boolean;
  replacing?: boolean;
  context?: OperationContext;
}
const runtimes = new WeakMap<Database, Runtime>();
/** @internal Capability registration; never exposed to application adapters. */
export const contexts = new WeakMap<OperationContext, WorkspacePorts>();

/** @internal Returns process-local state for a database handle. */
export function runtime(database: Database): Runtime {
  let value = runtimes.get(database);
  if (value === undefined) {
    value = { epoch: 0, unlocking: false };
    runtimes.set(database, value);
  }
  return value;
}

/**
 * @internal
 * Runs an application command under current authority in the SAME SQLite transaction
 * as effects/events. Only registered contexts work. Membership, shop, device and
 * granular grants are re-read on every command, so cached authority cannot outlive
 * local suspension/revocation. Lower-level repository functions remain primitives.
 * Callback exceptions roll back effects, outbox and command audit together.
 */
export function authorizedOperation<T>(context: OperationContext, permissions: readonly Permission[], work: (database: Database, tx: Queryable, ports: WorkspacePorts, revision: number) => T): T {
  if (context === null || typeof context !== "object") throw new WorkspaceError("locked");
  const ports = contexts.get(context);
  if (ports === undefined || runtime(ports.database).context !== context || runtime(ports.database).replacing === true) throw new WorkspaceError("locked");
  return ports.database.transaction(tx => {
    const installation = tx.get(`SELECT business_id, device_id FROM local_installation WHERE id = 1`);
    if (installation?.["business_id"] !== context.businessId || installation["device_id"] !== context.deviceId) {
      throw new WorkspaceError("scope_mismatch");
    }
    const member = activeMember(tx, context, context.userId);
    const effective = memberPermissions(tx, member);
    if (!permissions.every(p => isPermission(p) && effective.includes(p))) throw new WorkspaceError("permission_denied");
    if (permissions.includes("users.manage") && tx.get(`SELECT authority_allowed FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`, [context.businessId, context.deviceId])?.["authority_allowed"] !== 1) throw new WorkspaceError("permission_denied");
    const revision = Number(member["revision"]);
    const result = withinJournalContext(tx, { ...context, revision, permissions }, () => work(ports.database, tx, ports, revision));
    if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
      throw new WorkspaceError("invalid_input");
    }
    return result;
  });
}

/** @internal Appends an immutable local audit fact inside the caller's transaction and returns its event ID. No secret payloads. */
export function appendLocalAudit(tx: Queryable, context: OperationContext, ports: WorkspacePorts, revision: number, action: string, entityId: string, payload: Record<string, unknown> = {}): string {
  const eventId = nextId(ports), at = timestamp(ports);
  tx.run(`INSERT INTO local_audit (event_id, business_id, user_id, device_id, action,
    entity_id, authority_revision, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [eventId, context.businessId, context.userId, context.deviceId, action, entityId, revision, at, JSON.stringify(payload)]);
  captureAuthorityFact(tx, { eventId, ...context, action, entityId, at, payload });
  return eventId;
}

/** @internal Reads current scoped active authority. */
export function activeMember(tx: Queryable, install: Pick<Installation, "businessId" | "deviceId">, userId: string): Row {
  const member = tx.get(`SELECT m.* FROM local_memberships m
    JOIN users u ON u.id = m.user_id AND u.business_id = m.business_id
    JOIN businesses b ON b.id = m.business_id
    JOIN devices d ON d.id = ? AND d.business_id = m.business_id
    WHERE m.business_id = ? AND m.user_id = ? AND m.active = 1 AND u.active = 1 AND b.active = 1 AND d.active = 1`,
  [install.deviceId, install.businessId, userId]);
  if (member === undefined) throw new WorkspaceError("actor_inactive");
  return member;
}

/**
 * @internal Resolves current authority through the shop's role matrix, or the member's custom role when they hold
 * one, failing closed on corrupt storage or a custom role this till does not know.
 */
export function memberPermissions(tx: Queryable, member: Row): readonly Permission[] {
  try {
    const businessId = String(member["business_id"]), custom = member["custom_role_id"];
    return resolvePermissions(member["role"] as Role, permissionArray(member["granted"]), permissionArray(member["revoked"]),
      typeof custom === "string" ? customRolePermissions(tx, businessId, custom) : rolePermissions(tx, businessId, member["role"] as Role));
  } catch { throw new WorkspaceError("permission_denied"); }
}

/** @internal A custom role's permissions; a deleted role keeps its last set for anyone still holding it. */
export function customRolePermissions(tx: Queryable, businessId: string, roleId: string): Permission[] {
  const row = tx.get(`SELECT permissions FROM custom_roles WHERE business_id = ? AND id = ?`, [businessId, roleId]);
  if (row === undefined) throw new WorkspaceError("permission_denied");
  return permissionArray(row["permissions"]);
}

/** @internal The shop's edited permissions for a role (ADR-037), or null when it keeps the built-in defaults. */
export function rolePermissions(tx: Queryable, businessId: string, role: Role): Permission[] | null {
  if (role === "OWNER") return null;
  const value = tx.get(`SELECT permissions FROM role_permissions WHERE business_id = ? AND role = ?`, [businessId, role])?.["permissions"];
  return value === undefined || value === null ? null : permissionArray(value);
}

/** @internal Decodes persisted permissions. */
export function permissionArray(value: unknown): Permission[] {
  if (typeof value !== "string") throw new WorkspaceError("permission_denied");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(isPermission)) throw new WorkspaceError("permission_denied");
  return parsed;
}

/** @internal Checks IDs returned by trusted platform ports. */
export function nextId(ports: WorkspacePorts): string {
  const id = ports.newId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new WorkspaceError("invalid_input");
  return id.toLowerCase();
}

/** @internal Checks timestamps returned by trusted platform ports. */
export function timestamp(ports: WorkspacePorts): string {
  const now = ports.now();
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new WorkspaceError("invalid_input");
  return now;
}
