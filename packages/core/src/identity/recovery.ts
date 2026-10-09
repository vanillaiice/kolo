import { captureAuthorityFact } from "../data/exchange/authority.ts";
import type { Queryable } from "../data/database/driver.ts";
import { activeMember, appendLocalAudit, authorizedOperation, nextId, timestamp, runtime } from "./internal-authority.ts";
import { lockWorkspace } from "./workspace.ts";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "./types.ts";
import { validateLocalSecret } from "./credentials.ts";

/** Reveals an owner's protected recovery code after both active-context and PIN proof. */
export async function ownerRecoveryCode(context: OperationContext, secret: string): Promise<string | undefined> {
  const { reference, ports } = authorizedOperation(context, ["business.settings"], (_database, tx, ports) => {
    requireOwner(tx, context);
    return { reference: String(tx.get(`SELECT credential_reference FROM local_memberships WHERE business_id = ? AND user_id = ?`, [context.businessId, context.userId])?.["credential_reference"]), ports };
  });
  if (ports.credentials.recoveryCode === undefined) throw new WorkspaceError("credential_unavailable");
  const code = await ports.credentials.recoveryCode(reference, secret);
  authorizedOperation(context, ["business.settings"], (_database, tx) => requireOwner(tx, context));
  return code;
}

/**
 * Restores owner access using a separate 256-bit recovery code, never a shop UUID
 * or expired cloud token. The credential-change intent contains references only.
 * Native failure consumes a durable throttled attempt. Native success is followed
 * by atomic credential-reference/authority/audit update; boot can complete the gap.
 * Ten wrong recovery proofs require external authenticated backup recovery (F3).
 */
export async function recoverOwnerAccess(input: { readonly recoveryCode: string; readonly newSecret: string }, ports: WorkspacePorts): Promise<void> {
  if(runtime(ports.database).replacing===true)throw new WorkspaceError("locked");
  validateLocalSecret(input.newSecret);
  if (ports.credentials.recover === undefined || ports.credentials.hasCredential === undefined) throw new WorkspaceError("credential_unavailable");
  lockWorkspace(ports.database);
  const intent = ports.database.transaction(tx => {
    const installation = tx.get(`SELECT * FROM local_installation WHERE id = 1`);
    if (installation === undefined) throw new WorkspaceError("not_configured");
    const businessId = String(installation["business_id"]), userId = String(installation["owner_id"]);
    const member = tx.get(`SELECT m.* FROM local_memberships m JOIN users u ON u.id = m.user_id AND u.business_id = m.business_id
      JOIN businesses b ON b.id = m.business_id JOIN devices d ON d.id = ? AND d.business_id = m.business_id
      WHERE m.business_id = ? AND m.user_id = ? AND m.active = 1 AND u.active = 1 AND b.active = 1 AND d.active = 1`, [installation["device_id"]!, businessId, userId]);
    if (member === undefined) throw new WorkspaceError("actor_inactive");
    let row = tx.get(`SELECT * FROM local_credential_recovery WHERE id = 1`);
    if (row === undefined) {
      const eventId = nextId(ports);
      tx.run(`INSERT INTO local_credential_recovery (id,business_id,user_id,old_reference,new_reference,event_id,created_at)
        VALUES (1,?,?,?,?,?,?)`, [businessId, userId, member["credential_reference"]!, `kolo.recovery.${eventId}`, eventId, timestamp(ports)]);
      row = tx.get(`SELECT * FROM local_credential_recovery WHERE id = 1`)!;
    }
    return { oldReference: String(row["old_reference"]), newReference: String(row["new_reference"]) };
  });
  // A previously completed native write is recovered before trying the now-old
  // recovery code again. Never silently replace a newly reset credential.
  if (await ports.credentials.hasCredential(intent.newReference)) {
    finishRecovery(ports);
    return;
  }
  if(runtime(ports.database).replacing===true)throw new WorkspaceError("locked");
  ports.database.transaction(tx => {
    const row = tx.get(`SELECT * FROM local_credential_recovery WHERE id = 1`)!;
    const failures = Number(row["failures"]), now = timestamp(ports);
    if (failures >= 10) throw new WorkspaceError("recovery_required");
    const next = row["next_attempt_at"];
    if (typeof next === "string" && now < next) throw new WorkspaceError("retry_later", next);
    tx.run(`UPDATE local_credential_recovery SET failures = failures + 1, next_attempt_at = ? WHERE id = 1`,
      [new Date(Date.parse(now) + Math.min(60, 2 ** failures) * 1000).toISOString()]);
  });
  try { await ports.credentials.recover(intent.oldReference, intent.newReference, input.recoveryCode, input.newSecret); }
  catch (error) { throw new WorkspaceError(error instanceof WorkspaceError && error.code === "invalid_credential" ? "invalid_credential" : "credential_unavailable"); }
  finishRecovery(ports);
}

/** Completes a durable native recovery write after restart, without PIN/recovery code in SQLite. */
export async function resumeOwnerRecovery(ports: WorkspacePorts): Promise<void> {
  const row = ports.database.get(`SELECT new_reference FROM local_credential_recovery WHERE id = 1`);
  if (row !== undefined && ports.credentials.hasCredential !== undefined && await ports.credentials.hasCredential(String(row["new_reference"]))) {
    lockWorkspace(ports.database);
    finishRecovery(ports);
  }
}

function finishRecovery(ports: WorkspacePorts): void {
  if(runtime(ports.database).replacing===true)throw new WorkspaceError("locked");
  ports.database.transaction(tx => {
    const row = tx.get(`SELECT * FROM local_credential_recovery WHERE id = 1`);
    if (row === undefined) return;
    const installation = tx.get(`SELECT * FROM local_installation WHERE id = 1`);
    if (installation === undefined || installation["business_id"] !== row["business_id"] || installation["owner_id"] !== row["user_id"]) throw new WorkspaceError("scope_mismatch");
    activeMember(tx, { businessId: String(row["business_id"]), deviceId: String(installation["device_id"]) }, String(row["user_id"]));
    const authority=tx.get(`SELECT authority_allowed FROM trusted_exchange_devices WHERE business_id=? AND device_id=? AND active=1`,[row["business_id"]!,installation["device_id"]!])?.["authority_allowed"]===1;
    const changed = tx.run(`UPDATE local_memberships SET credential_reference = ?, failures = 0, next_attempt_at = NULL,
      revision = revision + ? WHERE business_id = ? AND user_id = ? AND credential_reference = ? AND active = 1`,
    [row["new_reference"]!, authority?1:0, row["business_id"]!, row["user_id"]!, row["old_reference"]!]);
    if (changed.changes !== 1) throw new WorkspaceError("actor_inactive");
    const revision = tx.get(`SELECT revision FROM local_memberships WHERE business_id = ? AND user_id = ?`, [row["business_id"]!, row["user_id"]!])?.["revision"];
    tx.run(`INSERT INTO local_audit (event_id,business_id,user_id,device_id,action,entity_id,authority_revision,occurred_at,payload)
      VALUES (?,?,?,?,?,?,?,?,'{}')`,
    [row["event_id"]!, row["business_id"]!, row["user_id"]!, installation["device_id"]!, authority?"OWNER_ACCESS_RECOVERED":"OWNER_LOCAL_ACCESS_RECOVERED", row["user_id"]!, revision!, timestamp(ports)]);
    if(authority)captureAuthorityFact(tx, { eventId: String(row["event_id"]), businessId: String(row["business_id"]), userId: String(row["user_id"]),
      deviceId: String(installation["device_id"]), action: "OWNER_ACCESS_RECOVERED", entityId: String(row["user_id"]), at: timestamp(ports), actorRevision: Number(revision) - 1 });
    tx.run(`DELETE FROM local_credential_recovery WHERE id = 1`);
  });
}

/** Owner-only actor suspension/reinstatement; owner cannot suspend themselves. */
export function setMemberActive(context: OperationContext, userId: string, active: boolean): void {
  authorizedOperation(context, ["users.manage"], (_database, tx, ports) => {
    requireOwner(tx, context);
    if (userId === context.userId || typeof active !== "boolean") throw new WorkspaceError("permission_denied");
    const changed = tx.run(`UPDATE local_memberships SET active = ?, revision = revision + 1 WHERE business_id = ? AND user_id = ?`,
      [active ? 1 : 0, context.businessId, userId]);
    if (changed.changes !== 1) throw new WorkspaceError("scope_mismatch");
    const revision = Number(tx.get(`SELECT revision FROM local_memberships WHERE business_id = ? AND user_id = ?`, [context.businessId, userId])?.["revision"]);
    appendLocalAudit(tx, context, ports, revision, active ? "MEMBER_REINSTATED" : "MEMBER_SUSPENDED", userId);
  });
}

function requireOwner(tx: Queryable, context: OperationContext): void {
  if (tx.get(`SELECT owner_id FROM local_installation WHERE id = 1`)?.["owner_id"] !== context.userId) throw new WorkspaceError("permission_denied");
}
