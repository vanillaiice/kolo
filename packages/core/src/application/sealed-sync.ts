import { canonicalJson } from "@kolo/contracts/canonical";
import { signedJournalEventSchema, type SignedJournalEvent } from "@kolo/contracts/events";
import { MAX_JOURNAL_BATCH_BYTES } from "@kolo/contracts/delivery";
import { CLEAR_EVENT_TYPES, isClearEventType, sealedEventAad, sealedKeyAad, signedSyncBatchSchema, syncBatchSigningMessage,
  type SealedEvent, type SignedSyncBatch, type SyncBatch, type SyncEvent } from "@kolo/contracts/sync";
import type { TransferCrypto } from "../backup/types.ts";
import type { OperationContext, WorkspacePorts } from "../identity/types.ts";
import { authorizedOperation, appendLocalAudit, nextId, timestamp } from "../identity/internal-authority.ts";
import { ExchangeError, type VerifiedEvent } from "../exchange/types.ts";
import { pinnedDevice, requireOwner, sealPendingEvents } from "./exchange.ts";
import { checkProof, eventsForDestination, importAuthenticated, recordOffer, signMessage, verifyOrDefer, type ImportOutcome } from "./event-delivery.ts";

/**
 * Native primitives for end-to-end encrypted sync (ADR-030): AES-256-GCM and codecs from the file-transfer
 * crypto, plus X25519 and HKDF-SHA256. Adapters use platform/OpenSSL implementations only.
 */
export interface SealingCrypto extends TransferCrypto {
  /** Generates an ephemeral X25519 key, agrees with the recipient's public key and discards the private half. Returns the ephemeral SPKI PEM and the shared secret as hex. */
  ephemeralAgreement(recipientPublicKey: string): Promise<{ readonly publicKey: string; readonly shared: string }>;
  /** HKDF-SHA256 (RFC 5869) of hex input keying material; returns `bytes` of output as hex. */
  hkdf(ikmHex: string, saltHex: string, info: string, bytes: number): Promise<string>;
  /** HMAC-SHA256 of UTF-8 text under a hex key; returns hex. */
  hmac(keyHex: string, message: string): Promise<string>;
}

/** A shop key this device holds. `key` is 32 bytes of hex and only ever lives in memory. */
export interface ShopKey { readonly keyId: string; readonly epoch: number; readonly key: string }

/** A 32-byte secret sealed to one device's X25519 key. */
export type SealedKey = { readonly ephemeral_public_key: string; readonly nonce: string; readonly ciphertext: string; readonly tag: string };
const KEY_INFO = "kolo.shop-key.v1";

function installation(context: OperationContext): { readonly ports: WorkspacePorts; readonly reference: string } {
  return authorizedOperation(context, [], (_database, tx, ports) => ({ ports, reference: String(tx.get(`SELECT key_reference FROM local_installation WHERE id=1`)!["key_reference"]) }));
}

/**
 * Announces this device's X25519 key once, as a fact signed by this device, so the owner can seal shop keys to it.
 * Returns the public key, or undefined on a platform whose vault cannot hold one.
 */
export async function ensureEncryptionKey(context: OperationContext): Promise<string | undefined> {
  const { ports, reference } = installation(context);
  if (ports.credentials.encryptionKey === undefined || ports.credentials.agree === undefined) return undefined;
  let publicKey: string;
  try { publicKey = await ports.credentials.encryptionKey(reference); } catch { throw new ExchangeError("locked"); }
  authorizedOperation(context, ["business.settings"], (_database, tx, ports, revision) => {
    pinnedDevice(tx, context.businessId, context.deviceId);
    const old = tx.get(`SELECT public_key FROM device_encryption_keys WHERE business_id=? AND device_id=?`, [context.businessId, context.deviceId]);
    if (old !== undefined) { if (old["public_key"] !== publicKey) throw new ExchangeError("conflict"); return; }
    const eventId = appendLocalAudit(tx, context, ports, revision, "DEVICE_ENCRYPTION_KEY", context.deviceId, { device_id: context.deviceId, public_key: publicKey });
    tx.run(`INSERT INTO device_encryption_keys(business_id,device_id,public_key,event_id) VALUES (?,?,?,?)`, [context.businessId, context.deviceId, publicKey, eventId]);
  });
  return publicKey;
}

/** Seals a hex secret to one device's X25519 key: ephemeral agreement, HKDF-SHA256, then AES-256-GCM bound to `aad`. */
export async function sealToDevice(crypto: SealingCrypto, recipientPublicKey: string, keyHex: string, aad: string): Promise<SealedKey> { return wrapKey(crypto, recipientPublicKey, keyHex, aad); }

/** Opens a secret sealed to this installation's X25519 key; the private key stays in the vault. */
export async function openSealedWithVault(ports: WorkspacePorts, keyReference: string, ownPublicKey: string, sealed: SealedKey, aad: string, crypto: SealingCrypto): Promise<string> {
  if (ports.credentials.agree === undefined) throw new ExchangeError("locked");
  const shared = await ports.credentials.agree(keyReference, sealed.ephemeral_public_key);
  const wrapping = await crypto.hkdf(shared, await crypto.sha256(`${sealed.ephemeral_public_key}\u0000${ownPublicKey}`), KEY_INFO, 32);
  const bytes = await crypto.decrypt(wrapping, sealed.nonce, sealed.ciphertext, sealed.tag, aad);
  const secret = crypto.decodeText(bytes); bytes.fill(0);
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new ExchangeError("invalid_payload");
  return secret;
}

async function wrapKey(crypto: SealingCrypto, recipientPublicKey: string, keyHex: string, aad: string): Promise<SealedKey> {
  const { publicKey, shared } = await crypto.ephemeralAgreement(recipientPublicKey);
  const wrapping = await crypto.hkdf(shared, await crypto.sha256(`${publicKey}\u0000${recipientPublicKey}`), KEY_INFO, 32);
  const nonce = crypto.randomHex(12), { ciphertext, tag } = await crypto.encrypt(wrapping, nonce, crypto.encodeText(keyHex), aad);
  return { ephemeral_public_key: publicKey, nonce, ciphertext, tag };
}

/** Every shop key granted to this device that it can open. A grant it cannot open is skipped, never fatal. */
export async function shopKeys(context: OperationContext, crypto: SealingCrypto): Promise<readonly ShopKey[]> {
  const { ports, reference } = installation(context);
  const { rows, own } = authorizedOperation(context, ["business.settings"], (_database, tx) => ({
    rows: tx.all(`SELECT key_id,epoch,sealed FROM shop_key_grants WHERE business_id=? AND device_id=? ORDER BY epoch,key_id`, [context.businessId, context.deviceId]),
    own: tx.get(`SELECT public_key FROM device_encryption_keys WHERE business_id=? AND device_id=?`, [context.businessId, context.deviceId])?.["public_key"] }));
  if (rows.length === 0 || typeof own !== "string" || ports.credentials.agree === undefined) return [];
  const keys: ShopKey[] = [];
  for (const row of rows) {
    const keyId = String(row["key_id"]), epoch = Number(row["epoch"]);
    try {
      const key = await openSealedWithVault(ports, reference, own, JSON.parse(String(row["sealed"])) as SealedKey, sealedKeyAad(context.businessId, keyId, epoch, context.deviceId), crypto);
      keys.push(Object.freeze({ keyId, epoch, key }));
    } catch { /* A grant sealed to an older key of this device, or damaged; other keys still work. */ }
  }
  return keys;
}

/** The key new facts are sealed with: highest epoch, then highest key ID so two owner devices agree. */
export function currentShopKey(keys: readonly ShopKey[]): ShopKey | undefined {
  return [...keys].sort((left, right) => right.epoch - left.epoch || (right.keyId > left.keyId ? 1 : -1))[0];
}

/**
 * Owner key management, run in each sync pass (after pulling) on the owner's authority devices and a no-op elsewhere.
 * Creates the first shop key when the shop has none, opens a new epoch when a device that held the current key was revoked, and grants
 * every key this device holds to every trusted device that announced an encryption key. Returns grants added.
 */
export async function maintainShopKeys(context: OperationContext, crypto: SealingCrypto): Promise<number> {
  const state = authorizedOperation(context, ["business.settings"], (_database, tx, ports) => {
    const install = tx.get(`SELECT owner_id FROM local_installation WHERE id=1`)!;
    const own = tx.get(`SELECT authority_allowed FROM trusted_exchange_devices WHERE business_id=? AND device_id=? AND active=1`, [context.businessId, context.deviceId]);
    if (install["owner_id"] !== context.userId || own?.["authority_allowed"] !== 1) return undefined;
    return { ports,
      grants: tx.all(`SELECT key_id,epoch,device_id FROM shop_key_grants WHERE business_id=?`, [context.businessId]).map(row => ({ keyId: String(row["key_id"]), epoch: Number(row["epoch"]), deviceId: String(row["device_id"]) })),
      recipients: tx.all(`SELECT k.device_id,k.public_key FROM device_encryption_keys k
        JOIN trusted_exchange_devices t ON t.business_id=k.business_id AND t.device_id=k.device_id
        JOIN devices d ON d.business_id=k.business_id AND d.id=k.device_id
        WHERE k.business_id=? AND t.active=1 AND d.active=1 AND d.platform<>'SERVER' ORDER BY k.device_id`, [context.businessId]).map(row => ({ deviceId: String(row["device_id"]), publicKey: String(row["public_key"]) })),
      revoked: new Set(tx.all(`SELECT device_id FROM trusted_exchange_devices WHERE business_id=? AND active=0`, [context.businessId]).map(row => String(row["device_id"]))) };
  });
  if (state === undefined || !state.recipients.some(recipient => recipient.deviceId === context.deviceId)) return 0;
  const held = await shopKeys(context, crypto), current = currentShopKey(held);
  const exposed = current !== undefined && state.grants.some(grant => grant.keyId === current.keyId && state.revoked.has(grant.deviceId));
  const keys = [...held];
  // The first key is created only when the shop has none; a till that has not been granted an existing key waits for it.
  if ((current === undefined && state.grants.length === 0) || exposed) {
    const epoch = Math.max(0, ...state.grants.map(grant => grant.epoch)) + 1;
    keys.push({ keyId: nextId(state.ports), epoch, key: crypto.randomHex(32) });
  }
  const granted = new Set(state.grants.map(grant => `${grant.keyId}/${grant.deviceId}`)), pending: { key: ShopKey; deviceId: string; publicKey: string; sealed: SealedKey }[] = [];
  for (const key of keys) for (const recipient of state.recipients) {
    if (granted.has(`${key.keyId}/${recipient.deviceId}`)) continue;
    pending.push({ key, ...recipient, sealed: await wrapKey(crypto, recipient.publicKey, key.key, sealedKeyAad(context.businessId, key.keyId, key.epoch, recipient.deviceId)) });
  }
  if (pending.length === 0) return 0;
  return authorizedOperation(context, ["business.settings", "users.manage"], (_database, tx, ports, revision) => {
    requireOwner(tx, context);
    let added = 0;
    for (const grant of pending) {
      if (tx.get(`SELECT key_id FROM shop_key_grants WHERE business_id=? AND key_id=? AND device_id=?`, [context.businessId, grant.key.keyId, grant.deviceId]) !== undefined) continue;
      // Grant only if the recipient is still trusted under the same encryption key it announced.
      const still = tx.get(`SELECT k.public_key FROM device_encryption_keys k JOIN trusted_exchange_devices t ON t.business_id=k.business_id AND t.device_id=k.device_id
        WHERE k.business_id=? AND k.device_id=? AND t.active=1`, [context.businessId, grant.deviceId]);
      if (still?.["public_key"] !== grant.publicKey) continue;
      const eventId = appendLocalAudit(tx, context, ports, revision, "SHOP_KEY_GRANTED", grant.deviceId, { key_id: grant.key.keyId, epoch: grant.key.epoch, device_id: grant.deviceId, sealed: grant.sealed });
      tx.run(`INSERT INTO shop_key_grants(business_id,key_id,epoch,device_id,sealed,event_id) VALUES (?,?,?,?,?,?)`,
        [context.businessId, grant.key.keyId, grant.key.epoch, grant.deviceId, JSON.stringify(grant.sealed), eventId]);
      added++;
    }
    return added;
  });
}

/** Seals one signed fact with a shop key. The visible header is the AES-GCM additional data. */
export async function sealEvent(crypto: SealingCrypto, businessId: string, key: ShopKey, event: SignedJournalEvent): Promise<SealedEvent> {
  const e = event.envelope, header = { event_id: e.event_id, origin_device_id: e.origin_device_id, origin_sequence: e.origin_sequence, digest: event.digest, key_id: key.keyId, epoch: key.epoch };
  const nonce = crypto.randomHex(12), { ciphertext, tag } = await crypto.encrypt(key.key, nonce, crypto.encodeText(canonicalJson(event, MAX_JOURNAL_BATCH_BYTES)), sealedEventAad(businessId, header));
  return { ...header, nonce, ciphertext, tag };
}

/**
 * Opens a sealed fact, or returns undefined when this device lacks its key or the content does not match its header.
 * Origin proof is still checked afterwards, exactly as for a fact received by file.
 */
export async function openSealedEvent(crypto: SealingCrypto, businessId: string, keys: readonly ShopKey[], sealed: SealedEvent): Promise<SignedJournalEvent | undefined> {
  const key = keys.find(item => item.keyId === sealed.key_id && item.epoch === sealed.epoch);
  if (key === undefined) return undefined;
  try {
    const bytes = await crypto.decrypt(key.key, sealed.nonce, sealed.ciphertext, sealed.tag, sealedEventAad(businessId, sealed));
    const parsed = signedJournalEventSchema.safeParse(JSON.parse(crypto.decodeText(bytes)));
    if (!parsed.success) return undefined;
    const event = parsed.data, e = event.envelope;
    if (e.business_id !== businessId || e.event_id !== sealed.event_id || e.origin_device_id !== sealed.origin_device_id || e.origin_sequence !== sealed.origin_sequence || event.digest !== sealed.digest) return undefined;
    return event;
  } catch { return undefined; }
}

/**
 * Signed server batch of this device's pending facts for one server destination. Trust, encryption-key and
 * server-address facts travel clear; every other fact is sealed with the current shop key. Without a key only clear
 * facts are offered and `waiting` counts the facts held back. Offering never acknowledges delivery.
 */
export async function createSyncBatch(context: OperationContext, destinationId: string, crypto: SealingCrypto, keys: readonly ShopKey[], limit = 200): Promise<{ readonly signed?: SignedSyncBatch; readonly waiting: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ExchangeError("invalid_event");
  await sealPendingEvents(context, crypto, 1000);
  const key = currentShopKey(keys);
  const events = [...eventsForDestination(context, destinationId, limit, key === undefined ? CLEAR_EVENT_TYPES : undefined)];
  const waiting = key === undefined ? eventsForDestination(context, destinationId, 1000).filter(event => !isClearEventType(event.envelope.event_type)).length : 0;
  if (events.length === 0) return { waiting };
  const meta = authorizedOperation(context, ["business.settings"], (_database, tx, ports) => {
    const row = tx.get(`SELECT receiver_device_id FROM exchange_destinations WHERE business_id=? AND id=? AND kind='server' AND active=1`, [context.businessId, destinationId]);
    if (row === undefined) throw new ExchangeError("invalid_destination");
    return { receiver: String(row["receiver_device_id"]), batchId: nextId(ports), createdAt: timestamp(ports) };
  });
  const wire: SyncEvent[] = [];
  for (const event of events) wire.push(isClearEventType(event.envelope.event_type) ? { clear: event } : { sealed: await sealEvent(crypto, context.businessId, key!, event) });
  const batch: SyncBatch = { format: "kolo.sync-batch", format_version: 1, batch_id: meta.batchId, business_id: context.businessId, sender_device_id: context.deviceId,
    receiver_device_id: meta.receiver, created_at: meta.createdAt, events: wire };
  // Fit complete facts, never split one or silently discard the remainder: it stays pending for the next page.
  for (;;) { try { canonicalJson(batch, MAX_JOURNAL_BATCH_BYTES - 256); break; } catch { if (batch.events.length <= 1) throw new ExchangeError("invalid_event"); batch.events.pop(); } }
  const proof = await signMessage(context, crypto, syncBatchSigningMessage(batch));
  recordOffer(context, destinationId, { batchId: batch.batch_id, receiverDeviceId: meta.receiver, createdAt: meta.createdAt, digest: proof.digest },
    batch.events.map(item => "clear" in item ? { eventId: item.clear.envelope.event_id, digest: item.clear.digest } : { eventId: item.sealed.event_id, digest: item.sealed.digest }));
  return { signed: { batch, ...proof }, waiting };
}

/**
 * Authenticates a server-signed batch, opens the sealed facts this device has keys for and imports them with the
 * shared verification and application path. Facts it cannot open, or whose inner proof fails, are `locked`: nothing
 * is stored or acknowledged for them, so they are offered again later.
 */
export async function importSyncBatch(context: OperationContext, input: unknown, crypto: SealingCrypto, keys: readonly ShopKey[]): Promise<readonly { eventId: string; outcome: ImportOutcome }[]> {
  try { canonicalJson(input, MAX_JOURNAL_BATCH_BYTES + 4096); } catch { throw new ExchangeError("invalid_event"); }
  const parsed = signedSyncBatchSchema.safeParse(input);
  if (!parsed.success) throw new ExchangeError("invalid_event");
  const signed = parsed.data, batch = signed.batch;
  if (batch.business_id !== context.businessId || batch.receiver_device_id !== context.deviceId) throw new ExchangeError("scope_mismatch");
  await checkProof(context, crypto, batch.sender_device_id, syncBatchSigningMessage(batch), signed.digest, signed.signature);
  const entries: { eventId: string; event?: SignedJournalEvent }[] = [], tokens: (VerifiedEvent | undefined)[] = [];
  for (const item of batch.events) {
    if ("clear" in item) { entries.push({ eventId: item.clear.envelope.event_id, event: item.clear }); tokens.push(await verifyOrDefer(context, item.clear, crypto)); continue; }
    const event = await openSealedEvent(crypto, context.businessId, keys, item.sealed);
    let token: VerifiedEvent | undefined;
    // One forged sealed fact from a trusted device must not block everyone else's facts in the same server page.
    try { token = event === undefined ? undefined : await verifyOrDefer(context, event, crypto); }
    catch (error) { if (!(error instanceof ExchangeError) || !["invalid_signature", "invalid_event", "scope_mismatch"].includes(error.code)) throw error; entries.push({ eventId: item.sealed.event_id }); tokens.push(undefined); continue; }
    entries.push(event === undefined ? { eventId: item.sealed.event_id } : { eventId: item.sealed.event_id, event }); tokens.push(token);
  }
  return importAuthenticated(context, { batchId: batch.batch_id, senderDeviceId: batch.sender_device_id, createdAt: batch.created_at, digest: signed.digest }, entries, tokens, crypto);
}
