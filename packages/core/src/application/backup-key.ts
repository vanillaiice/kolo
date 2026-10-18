import { authorizedOperation, appendLocalAudit, timestamp } from "../identity/internal-authority.ts";
import type { OperationContext } from "../identity/types.ts";
import type { Queryable } from "../data/database/driver.ts";
import { pinnedDevice, requireOwner } from "./exchange.ts";
import { deriveRecoveryKey, formatRecoveryKey, generateRecoverySecret, recoveryKeyId, type RecoveryRecipient } from "../backup/recovery-key.ts";
import { TransferError, type TransferCrypto } from "../backup/types.ts";

/**
 * A backup recovery key shown to the owner once (ADR-036) and not yet pinned. `text` is the only copy of the secret;
 * `confirm` lists the three 0-based group indices the owner must type back before {@link confirmBackupRecoveryKey}
 * pins the public half. Discarding the object discards the key.
 */
export interface PendingBackupKey { readonly text: string; readonly keyId: string; readonly confirm: readonly number[] }
/** A pinned backup recovery key as the shop sees it: its ID, creation date and whether new backups seal to it. */
export interface BackupKeyView { readonly keyId: string; readonly version: number; readonly createdAt: string; readonly current: boolean }

const pending = new WeakMap<PendingBackupKey, { readonly context: OperationContext; readonly publicKey: Uint8Array; used: boolean }>();
const GROUPS = 14;

/** Owner on an authority-approved device, the same rule as other owner trust facts. */
function requireAuthority(tx: Queryable, context: OperationContext): void {
  requireOwner(tx, context);
  if (pinnedDevice(tx, context.businessId, context.deviceId)["authority_allowed"] !== 1) throw new TransferError("invalid_pairing");
}

/**
 * Creates a backup recovery key after a fresh owner PIN proof and returns it for showing once. Nothing is stored:
 * the secret lives only in the returned text, and the public half is pinned only after confirmation.
 */
export async function prepareBackupRecoveryKey(context: OperationContext, secret: string, crypto: TransferCrypto): Promise<PendingBackupKey> {
  const { ports, reference } = authorizedOperation(context, ["business.settings", "users.manage"], (_database, tx, ports) => {
    requireAuthority(tx, context);
    return { ports, reference: String(tx.get(`SELECT credential_reference FROM local_memberships WHERE business_id=? AND user_id=?`, [context.businessId, context.userId])!["credential_reference"]) };
  });
  if (!await ports.credentials.verify(reference, secret)) throw new TransferError("authentication_failed");
  const raw = generateRecoverySecret(crypto);
  try {
    const pair = await deriveRecoveryKey(raw, crypto), text = await formatRecoveryKey(raw, crypto);
    pair.privateKey.fill(0);
    const confirm: number[] = [];
    const draws = crypto.randomHex(64);
    for (let at = 0; at < draws.length; at += 2) { const byte = parseInt(draws.slice(at, at + 2), 16); // 252 is the largest multiple of 14 below 256: higher bytes are skipped so every group is equally likely.
      const index = byte % GROUPS; if (byte < 252 && !confirm.includes(index)) confirm.push(index); if (confirm.length === 3) break; }
    if (confirm.length !== 3) throw new TransferError("authentication_failed");
    const view: PendingBackupKey = Object.freeze({ text, keyId: pair.keyId, confirm: Object.freeze(confirm.sort((a, b) => a - b)) });
    pending.set(view, { context, publicKey: pair.publicKey, used: false });
    return view;
  } finally { raw.fill(0); }
}

const normalized = (group: string): string => typeof group === "string" ? group.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1") : "";

/**
 * Pins a prepared key once the owner typed back the requested groups: an owner-signed `SHOP_BACKUP_KEY` fact with the
 * next version. New backups then seal to it; earlier keys stay pinned for the backups that need them.
 */
export async function confirmBackupRecoveryKey(context: OperationContext, key: PendingBackupKey, typed: readonly string[], crypto: TransferCrypto): Promise<BackupKeyView> {
  const material = pending.get(key);
  if (material === undefined || material.used || material.context !== context) throw new TransferError("confirmation_required");
  const groups = key.text.split("-");
  if (!Array.isArray(typed) || typed.length !== key.confirm.length || key.confirm.some((index, i) => normalized(typed[i]!) !== groups[index])) throw new TransferError("confirmation_required");
  if (await recoveryKeyId(material.publicKey, crypto) !== key.keyId) throw new TransferError("authentication_failed");
  const publicKey = Array.from(material.publicKey, byte => byte.toString(16).padStart(2, "0")).join("");
  return authorizedOperation(context, ["business.settings", "users.manage"], (_database, tx, ports, revision) => {
    requireAuthority(tx, context);
    if (material.used) throw new TransferError("confirmation_required");
    const version = Number(tx.get(`SELECT coalesce(max(version),0) AS n FROM backup_recovery_keys WHERE business_id=?`, [context.businessId])!["n"]) + 1, at = timestamp(ports);
    const eventId = appendLocalAudit(tx, context, ports, revision, "SHOP_BACKUP_KEY", key.keyId, { key_id: key.keyId, version, public_key: publicKey, created_at: at });
    tx.run(`INSERT INTO backup_recovery_keys(business_id,key_id,version,public_key,created_at,device_id,event_id) VALUES (?,?,?,?,?,?,?)`, [context.businessId, key.keyId, version, publicKey, at, context.deviceId, eventId]);
    material.used = true;
    return Object.freeze({ keyId: key.keyId, version, createdAt: at, current: true });
  });
}

/** The shop's pinned backup recovery keys, newest first; the first is the one new backups seal to. */
export function backupRecoveryKeys(context: OperationContext): readonly BackupKeyView[] {
  return authorizedOperation(context, ["business.settings"], (_database, tx) => listKeys(tx, context.businessId));
}

function listKeys(tx: Queryable, businessId: string): readonly BackupKeyView[] {
  return Object.freeze(tx.all(`SELECT key_id,version,created_at FROM backup_recovery_keys WHERE business_id=? ORDER BY version DESC,key_id DESC`, [businessId])
    .map((row, index) => Object.freeze({ keyId: String(row["key_id"]), version: Number(row["version"]), createdAt: String(row["created_at"]), current: index === 0 })));
}

/**
 * The recipient new backups seal to: the current pinned key, read from this till's own database (never from a file or the
 * network), with its ID checked against its public key so a corrupted row can never redirect encryption.
 */
export async function currentBackupRecipient(context: OperationContext, crypto: Pick<TransferCrypto, "sha256Bytes">): Promise<RecoveryRecipient | undefined> {
  const row = authorizedOperation(context, ["business.settings"], (_database, tx) =>
    tx.get(`SELECT key_id,public_key FROM backup_recovery_keys WHERE business_id=? ORDER BY version DESC,key_id DESC LIMIT 1`, [context.businessId]));
  if (row === undefined) return undefined;
  const hex = String(row["public_key"]), publicKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) publicKey[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  if (await recoveryKeyId(publicKey, crypto) !== row["key_id"]) throw new TransferError("invalid_snapshot");
  return Object.freeze({ keyId: String(row["key_id"]), publicKey });
}
