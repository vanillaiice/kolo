import { captureAuthorityFact } from "../data/exchange/authority.ts";
import type { Database, Queryable, Row } from "../data/database/driver.ts";
import { validateLocalSecret } from "./credentials.ts";
import type { AuthTransport } from "../data/auth/login.ts";
import { isPermission, type Permission } from "./permissions.ts";
import { runtime, contexts, authorizedOperation, appendLocalAudit, activeMember, memberPermissions,
  permissionArray, nextId, timestamp } from "./internal-authority.ts";
import {
  WorkspaceError, type CreateWorkspaceInput, type Installation, type InstallationState,
  type OperationContext, type ProvisionedIdentity, type WorkspacePorts,
} from "./types.ts";

interface Intent {
  mode?: "legacy";
  installationId: string;
  businessId: string;
  ownerId: string;
  deviceId: string;
  at: string;
  input: Omit<CreateWorkspaceInput, "secret" | "accounts">;
  accounts: readonly { id: string; name: string; kind: string }[];
  eventId: string;
}

/** Reads boot status without credentials, remote enrollment or side effects. */
export function currentInstallation(database: Database): InstallationState {
  const row = database.get(`SELECT i.*, b.name AS business_name FROM local_installation i
    JOIN businesses b ON b.id = i.business_id WHERE i.id = 1`);
  if (row !== undefined) {
    return {
      state: runtime(database).context === undefined ? "locked" : "unlocked",
      installation: installationFrom(row),
    };
  }
  const intent = pendingIntent(database);
  if (intent !== undefined) return { state: "pending", installationId: intent.installationId };
  return { state: database.get(`SELECT id FROM businesses LIMIT 1`) === undefined ? "empty" : "legacy" };
}

/**
 * Reserves a durable setup intent, provisions native secrets, then atomically
 * commits shop/owner/device/accounts/membership/bootstrap audit and completion.
 * Empty installations only; existing demo/server shops require explicit migration.
 * Failure retains intent for retry/recovery without recording raw secrets. Retrying
 * requires the same public setup fields and reuses ALL previously allocated IDs.
 * Returns configured/locked metadata; unlocking is a separate proof of credential.
 */
export async function createWorkspace(input: CreateWorkspaceInput, ports: WorkspacePorts): Promise<Installation> {
  if (runtime(ports.database).replacing === true || ports.database.get(`SELECT id FROM workspace_enrollment WHERE id=1`) !== undefined) throw new WorkspaceError("setup_pending");
  validateInput(input);
  const intent = ports.database.transaction(tx => {
    if (tx.get(`SELECT id FROM local_installation`) !== undefined) throw new WorkspaceError("already_configured");
    const pending = pendingIntent(tx);
    if (pending !== undefined) {
      if (!matchesInput(pending, input)) throw new WorkspaceError("setup_pending");
      return pending;
    }
    if (tx.get(`SELECT id FROM businesses LIMIT 1`) !== undefined) throw new WorkspaceError("legacy_installation");
    const accounts = input.accounts ?? [{ name: "Caisse", kind: "CASH" }];
    const reserved: Intent = {
      installationId: nextId(ports), businessId: nextId(ports), ownerId: nextId(ports), deviceId: nextId(ports),
      at: timestamp(ports), input: publicInput(input),
      accounts: accounts.map(account => ({ name: account.name.trim(), kind: account.kind, id: nextId(ports) })),
      eventId: nextId(ports),
    };
    const ids = [reserved.installationId, reserved.businessId, reserved.ownerId, reserved.deviceId,
      reserved.eventId, ...reserved.accounts.map(a => a.id)];
    if (new Set(ids).size !== ids.length) throw new WorkspaceError("invalid_input");
    tx.run(`INSERT INTO workspace_setup (id, intent, created_at) VALUES (1, ?, ?)`, [JSON.stringify(reserved), reserved.at]);
    return reserved;
  });

  let identity: ProvisionedIdentity;
  try {
    identity = await ports.credentials.provision({
      installationId: intent.installationId, businessId: intent.businessId, userId: intent.ownerId,
      deviceId: intent.deviceId, secret: input.secret,
    });
  } catch {
    throw new WorkspaceError("credential_unavailable");
  }
  return finishSetup(intent, identity, ports.database);
}

/**
 * Recovers the secret/SQLite crash gap without a password or new IDs. Completes
 * only when the trusted native port confirms fully durable provisioning. Missing
 * material leaves pending setup intact for a same-input createWorkspace retry.
 */
export async function recoverWorkspaceSetup(ports: WorkspacePorts): Promise<InstallationState> {
  const intent = pendingIntent(ports.database);
  if (intent === undefined) return currentInstallation(ports.database);
  let material: ProvisionedIdentity | undefined;
  try { material = await ports.credentials.inspect(intent.installationId); }
  catch { throw new WorkspaceError("credential_unavailable"); }
  if (material !== undefined) finishSetup(intent, material, ports.database);
  return currentInstallation(ports.database);
}

/** Retries an existing fresh/owner-proven legacy provisioning intent without new IDs or renamed data. */
export async function resumeWorkspaceProvisioning(secret: string, ports: WorkspacePorts): Promise<Installation> {
  if (runtime(ports.database).replacing === true) throw new WorkspaceError("locked");
  validateSecret(secret);
  const intent = pendingIntent(ports.database);
  if (intent === undefined) throw new WorkspaceError("not_configured");
  let material: ProvisionedIdentity;
  try { material = await ports.credentials.provision({ installationId: intent.installationId, businessId: intent.businessId,
    userId: intent.ownerId, deviceId: intent.deviceId, secret }); }
  catch { throw new WorkspaceError("credential_unavailable"); }
  return finishSetup(intent, material, ports.database);
}

/** UI display metadata resolved under current local authority; commands still recheck on every use. */
export function unlockedActor(context: OperationContext): { readonly businessName: string; readonly userName: string; readonly branchId: string | undefined; readonly isOwner: boolean } {
  return authorizedOperation(context, [], (_database, tx) => {
    const row = tx.get(`SELECT u.name AS user_name,u.branch_id,b.name AS business_name,i.owner_id
      FROM local_installation i JOIN businesses b ON b.id = i.business_id
      JOIN users u ON u.id = ? AND u.business_id = i.business_id WHERE i.id = 1`, [context.userId])!;
    return { businessName: String(row["business_name"]), userName: String(row["user_name"]),
      branchId: typeof row["branch_id"] === "string" ? row["branch_id"] : undefined, isOwner: row["owner_id"] === context.userId };
  });
}

/**
 * Explicit owner-authenticated conversion of a legacy server/demo installation.
 * The platform authority transport must prove the same shop and existing device,
 * an active OWNER and a fresh session. All existing shop/device/entity/event IDs,
 * financial facts, cloud session and outbox remain untouched. Cached roles/tokens
 * alone are never owner proof. Native PIN provisioning uses recoverable setup intent.
 */
export async function adoptLegacyWorkspace(input: { readonly phone: string; readonly serverPin: string; readonly localSecret: string }, ports: WorkspacePorts, authority: AuthTransport): Promise<Installation> {
  const state = currentInstallation(ports.database);
  if (state.state === "pending") throw new WorkspaceError("setup_pending");
  if (state.state !== "legacy") throw new WorkspaceError("already_configured");
  const businesses = ports.database.all(`SELECT * FROM businesses`);
  const business = businesses[0];
  const device = ports.database.get(`SELECT d.* FROM devices d LEFT JOIN device_session s ON s.device_id = d.id
    ORDER BY (s.id IS NOT NULL) DESC,d.created_at LIMIT 1`);
  if (businesses.length !== 1 || business === undefined || device === undefined || business["currency"] !== "XAF" ||
    business["active"] !== 1 || device["active"] !== 1 || device["business_id"] !== business["id"]) throw new WorkspaceError("scope_mismatch");
  validateLocalSecret(input.localSecret);
  const proof = await authority.login({ businessId: String(business["id"]), phone: input.phone, pin: input.serverPin,
    device: { id: String(device["id"]), label: String(device["label"]), platform: String(device["platform"]) } });
  if (proof.business.id !== business["id"] || proof.business.currency !== "XAF" || proof.device.id !== device["id"] ||
    proof.user.role !== "OWNER" || !proof.user.permissions.includes("users.manage") ||
    !Number.isFinite(Date.parse(proof.session.expiresAt)) || Date.parse(proof.session.expiresAt) <= Date.parse(timestamp(ports))) {
    throw new WorkspaceError("permission_denied");
  }
  validateName(proof.user.name);
  const intent = ports.database.transaction(tx => {
    if (currentInstallation(ports.database).state !== "legacy") throw new WorkspaceError("setup_pending");
    const existingUser = tx.get(`SELECT business_id,active FROM users WHERE id = ?`, [proof.user.id]);
    if (existingUser !== undefined && (existingUser["business_id"] !== business["id"] || existingUser["active"] !== 1)) throw new WorkspaceError("scope_mismatch");
    const intent: Intent = { mode: "legacy", installationId: nextId(ports), businessId: String(business["id"]), ownerId: proof.user.id,
      deviceId: String(device["id"]), at: timestamp(ports), accounts: [], eventId: nextId(ports),
      input: { businessName: String(business["name"]), currency: "XAF", ownerName: proof.user.name,
        deviceLabel: String(device["label"]), platform: device["platform"] as CreateWorkspaceInput["platform"] } };
    tx.run(`INSERT INTO workspace_setup (id,intent,created_at) VALUES (1,?,?)`, [JSON.stringify(intent), intent.at]);
    return intent;
  });
  let material: ProvisionedIdentity;
  try { material = await ports.credentials.provision({ installationId: intent.installationId, businessId: intent.businessId,
    userId: intent.ownerId, deviceId: intent.deviceId, secret: input.localSecret }); }
  catch { throw new WorkspaceError("credential_unavailable"); }
  return finishSetup(intent, material, ports.database);
}

/**
 * Proves an active local actor's credential and issues an opaque local context.
 * Retry reservation is durable BEFORE async native verification: concurrent attempts
 * cannot bypass it. Failures delay 1/2/4/.../60 seconds and ten require owner recovery
 * through separate recovery proof. Restart does not clear retries. Native errors consume an
 * attempt; no secret/error details escape. Membership is rechecked after verification.
 */
export async function unlockWorkspace(input: { readonly userId: string; readonly secret: string }, ports: WorkspacePorts): Promise<OperationContext> {
  const activeRuntime = runtime(ports.database);
  if (activeRuntime.replacing === true) throw new WorkspaceError("locked");
  if (activeRuntime.unlocking) throw new WorkspaceError("retry_later");
  activeRuntime.unlocking = true;
  try { return await unlock(input, ports); }
  finally { activeRuntime.unlocking = false; }
}

async function unlock(input: { readonly userId: string; readonly secret: string }, ports: WorkspacePorts): Promise<OperationContext> {
  validateSecret(input.secret);
  const state = currentInstallation(ports.database);
  if (state.state !== "locked" && state.state !== "unlocked") throw new WorkspaceError("not_configured");
  const install = state.installation;
  const activeRuntime = runtime(ports.database);
  const epoch = activeRuntime.epoch;
  const credential = ports.database.transaction(tx => {
    const member = activeMember(tx, install, input.userId);
    const now = timestamp(ports);
    const failures = Number(member["failures"]);
    if (failures >= 10) throw new WorkspaceError("recovery_required");
    const next = member["next_attempt_at"];
    if (typeof next === "string" && now < next) throw new WorkspaceError("retry_later", next);
    const retryAt = new Date(Date.parse(now) + Math.min(60, 2 ** failures) * 1000).toISOString();
    tx.run(`UPDATE local_memberships SET failures = failures + 1, next_attempt_at = ?
      WHERE business_id = ? AND user_id = ?`, [retryAt, install.businessId, input.userId]);
    return String(member["credential_reference"]);
  });
  let verified: boolean;
  try { verified = await ports.credentials.verify(credential, input.secret); }
  catch { throw new WorkspaceError("credential_unavailable"); }
  if (verified !== true) throw new WorkspaceError("invalid_credential");

  return ports.database.transaction(tx => {
    if (activeRuntime.epoch !== epoch) throw new WorkspaceError("locked");
    const member = activeMember(tx, install, input.userId);
    if (member["credential_reference"] !== credential) throw new WorkspaceError("credential_unavailable");
    memberPermissions(member);
    tx.run(`UPDATE local_memberships SET failures = 0, next_attempt_at = NULL
      WHERE business_id = ? AND user_id = ?`, [install.businessId, input.userId]);
    const context: OperationContext = Object.freeze({ businessId: install.businessId, userId: input.userId, deviceId: install.deviceId });
    activeRuntime.context = context;
    contexts.set(context, { ...ports });
    return context;
  });
}

/** Invalidates the active capability and in-flight unlocks without altering records/cloud sessions. */
export function lockWorkspace(database: Database): void {
  const activeRuntime = runtime(database);
  activeRuntime.epoch += 1;
  delete activeRuntime.context;
}

/** Owner-only permission grant, with authority revision and immutable local event/audit. */
export function grantPermission(context: OperationContext, userId: string, permission: Permission): void {
  changePermission(context, userId, permission, true);
}

/** Owner-only revocation; takes effect on the target's next local command without re-unlock. */
export function revokePermission(context: OperationContext, userId: string, permission: Permission): void {
  changePermission(context, userId, permission, false);
}

function changePermission(context: OperationContext, userId: string, permission: Permission, grant: boolean): void {
  if (!isPermission(permission)) throw new WorkspaceError("invalid_input");
  authorizedOperation(context, ["users.manage"], (_database, tx, ports) => {
    const installation = tx.get(`SELECT owner_id FROM local_installation WHERE id = 1`);
    if (installation?.["owner_id"] !== context.userId) throw new WorkspaceError("permission_denied");
    const member = tx.get(`SELECT * FROM local_memberships WHERE business_id = ? AND user_id = ?`, [context.businessId, userId]);
    if (member === undefined) throw new WorkspaceError("scope_mismatch");
    if (userId === context.userId && permission === "users.manage" && !grant) throw new WorkspaceError("permission_denied");
    const granted = permissionArray(member["granted"]).filter(p => p !== permission);
    const revoked = permissionArray(member["revoked"]).filter(p => p !== permission);
    (grant ? granted : revoked).push(permission);
    const revision = Number(member["revision"]) + 1;
    tx.run(`UPDATE local_memberships SET granted = ?, revoked = ?, revision = ? WHERE business_id = ? AND user_id = ?`,
      [JSON.stringify(granted), JSON.stringify(revoked), revision, context.businessId, userId]);
    appendLocalAudit(tx, context, ports, revision, grant ? "PERMISSION_GRANTED" : "PERMISSION_REVOKED", userId, { permission, revision });
  });
}

function pendingIntent(tx: Queryable): Intent | undefined {
  const row = tx.get(`SELECT intent FROM workspace_setup WHERE id = 1`);
  return row === undefined ? undefined : JSON.parse(String(row["intent"])) as Intent;
}

function finishSetup(intent: Intent, material: ProvisionedIdentity, database: Database): Installation {
  if (material === null || typeof material !== "object") throw new WorkspaceError("credential_unavailable");
  for (const [value, limit] of [[material.publicKey, 8192], [material.keyReference, 512], [material.credentialReference, 512]] as const) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > limit) throw new WorkspaceError("credential_unavailable");
  }
  database.transaction(tx => {
    const existing = tx.get(`SELECT installation_id FROM local_installation WHERE id = 1`);
    if (existing !== undefined) {
      if (existing["installation_id"] !== intent.installationId) throw new WorkspaceError("already_configured");
      return;
    }
    if (pendingIntent(tx)?.installationId !== intent.installationId) throw new WorkspaceError("setup_pending");
    if (intent.mode === "legacy") {
      const businesses = tx.all(`SELECT id,currency,active FROM businesses`);
      const device = tx.get(`SELECT business_id,active FROM devices WHERE id = ?`, [intent.deviceId]);
      const user = tx.get(`SELECT business_id,active FROM users WHERE id = ?`, [intent.ownerId]);
      if (businesses.length !== 1 || businesses[0]?.["id"] !== intent.businessId || businesses[0]?.["currency"] !== "XAF" || businesses[0]?.["active"] !== 1 ||
        device?.["business_id"] !== intent.businessId || device["active"] !== 1 ||
        (user !== undefined && (user["business_id"] !== intent.businessId || user["active"] !== 1))) throw new WorkspaceError("scope_mismatch");
      if (user === undefined) tx.run(`INSERT INTO users (id,business_id,name,role,created_at,updated_at) VALUES (?,?,?,'OWNER',?,?)`,
        [intent.ownerId, intent.businessId, intent.input.ownerName, intent.at, intent.at]);
    } else {
      if (tx.get(`SELECT id FROM businesses LIMIT 1`) !== undefined) throw new WorkspaceError("legacy_installation");
      tx.run(`INSERT INTO businesses (id, name, currency, created_at, updated_at) VALUES (?, ?, 'XAF', ?, ?)`,
        [intent.businessId, intent.input.businessName, intent.at, intent.at]);
      tx.run(`INSERT INTO users (id, business_id, name, role, created_at, updated_at) VALUES (?, ?, ?, 'OWNER', ?, ?)`,
        [intent.ownerId, intent.businessId, intent.input.ownerName, intent.at, intent.at]);
      tx.run(`INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [intent.deviceId, intent.businessId, intent.input.deviceLabel, intent.input.platform, intent.at, intent.at, intent.at]);
    }
    for (const account of intent.accounts) {
      tx.run(`INSERT INTO financial_accounts (id, business_id, name, kind, currency, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'XAF', ?, ?)`, [account.id, intent.businessId, account.name, account.kind, intent.at, intent.at]);
    }
    tx.run(`INSERT INTO local_memberships (business_id, user_id, credential_reference, role) VALUES (?, ?, ?, 'OWNER')`,
      [intent.businessId, intent.ownerId, material.credentialReference]);
    tx.run(`INSERT INTO local_installation (id, installation_id, business_id, owner_id, device_id, public_key, key_reference, configured_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)`, [intent.installationId, intent.businessId, intent.ownerId, intent.deviceId, material.publicKey, material.keyReference, intent.at]);
    // Bootstrap authority stays local until F2 supplies signed v2 exchange; the
    // old server outbox must not send it as a server-authorized v1 event.
    tx.run(`INSERT INTO local_audit (event_id, business_id, user_id, device_id, action, entity_id, authority_revision, occurred_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [intent.eventId, intent.businessId, intent.ownerId, intent.deviceId, intent.mode === "legacy" ? "LEGACY_WORKSPACE_ADOPTED" : "WORKSPACE_CREATED", intent.installationId, intent.at,
      JSON.stringify({ business: { id: intent.businessId, ...intent.input }, ownerId: intent.ownerId,
        deviceId: intent.deviceId, publicKey: material.publicKey, accounts: intent.accounts, revision: 1 })]);
    captureAuthorityFact(tx, { eventId: intent.eventId, businessId: intent.businessId, userId: intent.ownerId, deviceId: intent.deviceId,
      action: intent.mode === "legacy" ? "LEGACY_WORKSPACE_ADOPTED" : "WORKSPACE_CREATED", entityId: intent.installationId, at: intent.at });
    tx.run(`DELETE FROM workspace_setup WHERE id = 1`);
  });
  const state = currentInstallation(database);
  if (state.state !== "locked" && state.state !== "unlocked") throw new WorkspaceError("not_configured");
  return state.installation;
}

function installationFrom(row: Row): Installation {
  return { installationId: String(row["installation_id"]), businessId: String(row["business_id"]), businessName: String(row["business_name"]),
    ownerId: String(row["owner_id"]), deviceId: String(row["device_id"]), publicKey: String(row["public_key"]), configuredAt: String(row["configured_at"]) };
}

function validateInput(input: CreateWorkspaceInput): void {
  if (input.currency !== "XAF" || !["ANDROID", "IOS", "DESKTOP"].includes(input.platform)) throw new WorkspaceError("invalid_input");
  for (const name of [input.businessName, input.ownerName, input.deviceLabel]) validateName(name);
  validateLocalSecret(input.secret);
  if (input.accounts !== undefined) {
    if (!Array.isArray(input.accounts) || input.accounts.length === 0 || input.accounts.length > 20) throw new WorkspaceError("invalid_input");
    for (const account of input.accounts) {
      validateName(account.name);
      if (!["CASH", "MOBILE_MONEY", "BANK", "CARD", "OTHER"].includes(account.kind)) throw new WorkspaceError("invalid_input");
    }
    // Match the shipped SQLite UNIQUE index's ASCII lower(trim(name)) before
    // reserving intent; invalid input must not strand a permanently pending setup.
    const names = input.accounts.map(account => account.name.trim().replace(/[A-Z]/g, (letter: string) => letter.toLowerCase()));
    if (new Set(names).size !== names.length) throw new WorkspaceError("invalid_input");
  }
}

function validateName(value: string): void {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 120) throw new WorkspaceError("invalid_input");
}

function validateSecret(value: string): void {
  // Format/strength is a native adapter policy; this boundary only bounds input.
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw new WorkspaceError("invalid_input");
}

function publicInput(input: CreateWorkspaceInput): Intent["input"] {
  return { businessName: input.businessName.trim(), currency: input.currency, ownerName: input.ownerName.trim(), deviceLabel: input.deviceLabel.trim(), platform: input.platform };
}

function matchesInput(intent: Intent, input: CreateWorkspaceInput): boolean {
  return JSON.stringify(intent.input) === JSON.stringify(publicInput(input)) &&
    JSON.stringify(intent.accounts.map(({ name, kind }) => ({ name, kind }))) ===
    JSON.stringify((input.accounts ?? [{ name: "Caisse", kind: "CASH" }]).map(a => ({ name: a.name.trim(), kind: a.kind })));
}
