import type { Queryable } from "../data/database/driver.ts";
import { authorizedOperation, appendLocalAudit, nextId, timestamp } from "./internal-authority.ts";
import { resolvePermissions, type Role } from "./permissions.ts";
import { validateLocalSecret } from "./credentials.ts";
import { WorkspaceError, type OperationContext, type ProvisionedIdentity } from "./types.ts";

interface MemberIntent {
  mode?: "reset";
  oldReference?: string;
  userId: string;
  provisionId: string;
  businessId: string;
  ownerId: string;
  deviceId: string;
  name: string;
  role: Exclude<Role, "OWNER">;
  at: string;
  eventId: string;
}

/** Local staff details, resolved from current memberships instead of cloud role metadata. */
export interface LocalMember {
  readonly userId: string;
  readonly name: string;
  readonly role: Role;
  readonly active: boolean;
  readonly revision: number;
  /** The shop-defined role the member holds, if any; `role` is then that role's base. */
  readonly customRoleId?: string;
}

/** Owner-only staff creation with durable intent around asynchronous native provisioning. */
export async function createLocalMember(context: OperationContext, input: { readonly name: string; readonly role: Exclude<Role, "OWNER">; readonly secret: string }): Promise<string> {
  validateLocalSecret(input.secret);
  if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.trim().length > 120 ||
    !["MANAGER", "CASHIER", "INVENTORY", "ACCOUNTANT"].includes(input.role)) throw new WorkspaceError("invalid_input");
  const { intent, ports } = authorizedOperation(context, ["users.manage"], (_database, tx, ports) => {
    requireOwner(tx, context);
    const row = tx.get(`SELECT intent FROM local_member_setup WHERE business_id = ? AND owner_id = ?`, [context.businessId, context.userId]);
    if (row !== undefined) {
      const intent = JSON.parse(String(row["intent"])) as MemberIntent;
      if (intent.name !== input.name.trim() || intent.role !== input.role) throw new WorkspaceError("setup_pending");
      return { intent, ports };
    }
    const intent: MemberIntent = { userId: nextId(ports), provisionId: nextId(ports), businessId: context.businessId,
      ownerId: context.userId, deviceId: context.deviceId, name: input.name.trim(), role: input.role,
      at: timestamp(ports), eventId: nextId(ports) };
    tx.run(`INSERT INTO local_member_setup (user_id,business_id,owner_id,intent) VALUES (?,?,?,?)`,
      [intent.userId, context.businessId, context.userId, JSON.stringify(intent)]);
    return { intent, ports };
  });
  let material: ProvisionedIdentity;
  try { material = await ports.credentials.provision({ installationId: intent.provisionId,
    businessId: intent.businessId, userId: intent.userId, deviceId: intent.deviceId, secret: input.secret }); }
  catch { throw new WorkspaceError("credential_unavailable"); }
  finishMember(context, intent, material);
  return intent.userId;
}

/** Owner resets a staff credential without changing its user ID, role, grants or attribution. */
export async function resetLocalMemberCredential(context: OperationContext, userId: string, secret: string): Promise<void> {
  validateLocalSecret(secret);
  const { intent, ports } = authorizedOperation(context, ["users.manage"], (_database, tx, ports) => {
    requireOwner(tx, context);
    if (userId === context.userId) throw new WorkspaceError("permission_denied");
    const member = tx.get(`SELECT m.*,u.name FROM local_memberships m JOIN users u
      ON u.id = m.user_id AND u.business_id = m.business_id WHERE m.business_id = ? AND m.user_id = ? AND u.active = 1`, [context.businessId, userId]);
    if (member === undefined) throw new WorkspaceError("scope_mismatch");
    const pending = tx.get(`SELECT intent FROM local_member_setup WHERE user_id = ?`, [userId]);
    if (pending !== undefined) {
      const intent = JSON.parse(String(pending["intent"])) as MemberIntent;
      if (intent.mode !== "reset" || intent.ownerId !== context.userId) throw new WorkspaceError("setup_pending");
      return { intent, ports };
    }
    const intent: MemberIntent = { mode: "reset", oldReference: String(member["credential_reference"]),
      userId, provisionId: nextId(ports), businessId: context.businessId, ownerId: context.userId,
      deviceId: context.deviceId, name: String(member["name"]), role: member["role"] as Exclude<Role, "OWNER">,
      at: timestamp(ports), eventId: nextId(ports) };
    tx.run(`INSERT INTO local_member_setup(user_id,business_id,owner_id,intent) VALUES (?,?,?,?)`,
      [userId, context.businessId, context.userId, JSON.stringify(intent)]);
    return { intent, ports };
  });
  let material: ProvisionedIdentity;
  try { material = await ports.credentials.provision({ installationId: intent.provisionId, businessId: intent.businessId,
    userId, deviceId: intent.deviceId, secret }); }
  catch { throw new WorkspaceError("credential_unavailable"); }
  finishMember(context, intent, material);
}

/** Owner unlock resumes fully durable staff provisioning after a crash; incomplete intent remains retryable. */
export async function resumeMemberProvisioning(context: OperationContext): Promise<void> {
  const { intents, credentials } = authorizedOperation(context, ["users.manage"], (_database, tx, ports) => {
    requireOwner(tx, context);
    return { intents: tx.all(`SELECT intent FROM local_member_setup WHERE business_id = ? AND owner_id = ?`,
      [context.businessId, context.userId]).map(row => JSON.parse(String(row["intent"])) as MemberIntent), credentials: ports.credentials };
  });
  for (const intent of intents) {
    const material = await credentials.inspect(intent.provisionId);
    if (material !== undefined) finishMember(context, intent, material);
  }
}

/** Lists current staff under users.view, without credential references or secrets. */
export function listLocalMembers(context: OperationContext): readonly LocalMember[] {
  return authorizedOperation(context, ["users.view"], (_database, tx) => tx.all(`SELECT m.user_id,u.name,m.role,m.custom_role_id,m.active,m.revision
    FROM local_memberships m JOIN users u ON u.id = m.user_id AND u.business_id = m.business_id
    WHERE m.business_id = ? ORDER BY u.name,m.user_id`, [context.businessId]).map(row => ({ userId: String(row["user_id"]),
    name: String(row["name"]), role: row["role"] as Role, active: row["active"] === 1, revision: Number(row["revision"]),
    ...(typeof row["custom_role_id"] === "string" ? { customRoleId: row["custom_role_id"] } : {}) })));
}

function finishMember(context: OperationContext, intent: MemberIntent, material: ProvisionedIdentity): void {
  if (typeof material.credentialReference !== "string" || material.credentialReference.length === 0 || material.credentialReference.length > 512) {
    throw new WorkspaceError("credential_unavailable");
  }
  authorizedOperation(context, ["users.manage"], (_database, tx, ports, revision) => {
    requireOwner(tx, context);
    if (intent.businessId !== context.businessId || intent.ownerId !== context.userId || intent.deviceId !== context.deviceId) throw new WorkspaceError("scope_mismatch");
    if (tx.get(`SELECT user_id FROM local_member_setup WHERE user_id = ? AND business_id = ?`, [intent.userId, context.businessId]) === undefined) return;
    if (intent.mode === "reset") {
      const changed = tx.run(`UPDATE local_memberships SET credential_reference = ?, failures = 0, next_attempt_at = NULL,
        revision = revision + 1 WHERE business_id = ? AND user_id = ? AND credential_reference = ?`,
        [material.credentialReference, context.businessId, intent.userId, intent.oldReference!]);
      if (changed.changes !== 1) throw new WorkspaceError("scope_mismatch");
      appendLocalAudit(tx, context, { ...ports, newId: () => intent.eventId }, revision, "MEMBER_ACCESS_RESET", intent.userId);
    } else {
      tx.run(`INSERT INTO users (id,business_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
        [intent.userId, context.businessId, intent.name, intent.role, intent.at, intent.at]);
      tx.run(`INSERT INTO local_memberships (business_id,user_id,credential_reference,role) VALUES (?,?,?,?)`,
        [context.businessId, intent.userId, material.credentialReference, intent.role]);
      appendLocalAudit(tx, context, { ...ports, newId: () => intent.eventId }, revision, "MEMBER_CREATED", intent.userId,
        { name: intent.name, role: intent.role, permissions: resolvePermissions(intent.role, [], []), revision: 1 });
    }
    tx.run(`DELETE FROM local_member_setup WHERE user_id = ?`, [intent.userId]);
  });
}

function requireOwner(tx: Queryable, context: OperationContext): void {
  if (tx.get(`SELECT owner_id FROM local_installation WHERE id = 1`)?.["owner_id"] !== context.userId) throw new WorkspaceError("permission_denied");
}
