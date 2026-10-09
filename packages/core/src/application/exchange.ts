import { canonicalJson } from "@kolo/contracts/canonical";
import { parseJournalEnvelope, signedJournalEventSchema, type SignedJournalEvent } from "@kolo/contracts/events";
import { authorizedOperation, nextId, timestamp, appendLocalAudit } from "../identity/internal-authority.ts";
import type { OperationContext } from "../identity/types.ts";
import { verifiedEvents } from "../exchange/internal-verification.ts";
import { ExchangeError, type ExchangeCrypto, type VerifiedEvent } from "../exchange/types.ts";
import type { Queryable, Row } from "../data/database/driver.ts";

/** The immutable domain-prefixed UTF-8 bytes hashed and signed for an event. */
export function eventSigningMessage(event: SignedJournalEvent["envelope"]): string { return `kolo.event.v2\u0000${canonicalJson(parseJournalEnvelope(event))}`; }

/** @internal Current scoped trust, independent of transport and a bundle's forwarding sender. */
export function pinnedDevice(tx: Queryable, businessId: string, deviceId: string): Row {
  const row = tx.get(`SELECT t.* FROM trusted_exchange_devices t JOIN devices d ON d.id=t.device_id AND d.business_id=t.business_id
    WHERE t.business_id=? AND t.device_id=? AND t.active=1 AND d.active=1`, [businessId,deviceId]);
  if (row === undefined) throw new ExchangeError("untrusted_device");
  return row;
}

/**
 * Completes signatures for durable local facts. Native crypto runs outside SQL;
 * signature attachment is immutable and recoverable. Lock during signing commits
 * no proof, and the pending fact remains. Historical v1 rows are never signed here.
 */
export async function sealPendingEvents(context: OperationContext, crypto: ExchangeCrypto, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ExchangeError("invalid_event");
  const { rows, ports, reference, key } = authorizedOperation(context, [], (_database, tx, ports) => {
    const install = tx.get(`SELECT key_reference,public_key FROM local_installation WHERE id=1`)!;
    const pin = pinnedDevice(tx,context.businessId,context.deviceId);
    if (pin["public_key"] !== install["public_key"]) throw new ExchangeError("untrusted_device");
    return { rows: tx.all(`SELECT e.canonical FROM event_journal e LEFT JOIN event_signatures s ON s.event_id=e.event_id
      WHERE e.business_id=? AND e.origin_device_id=? AND e.provenance='local' AND s.event_id IS NULL ORDER BY e.origin_sequence LIMIT ?`, [context.businessId,context.deviceId,limit]),
      ports, reference: String(install["key_reference"]), key: String(install["public_key"]) };
  });
  if (ports.credentials.sign === undefined) throw new ExchangeError("invalid_signature");
  let sealed = 0;
  for (const row of rows) {
    const envelope = parseJournalEnvelope(JSON.parse(String(row["canonical"]))), message = eventSigningMessage(envelope);
    let digest: string, signature: string;
    try {
      digest = await crypto.sha256(message); signature = await ports.credentials.sign(reference,message);
      if (!/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{128}$/.test(signature) || !await crypto.verify(key,message,signature)) throw new Error("invalid proof");
    } catch { throw new ExchangeError("invalid_signature"); }
    sealed += authorizedOperation(context, [], (_database, tx) => {
      if (pinnedDevice(tx,context.businessId,context.deviceId)["public_key"] !== key) throw new ExchangeError("untrusted_device");
      return tx.run(`INSERT OR IGNORE INTO event_signatures(event_id,digest,signature,public_key) VALUES (?,?,?,?)`, [envelope.event_id,digest,signature,key]).changes;
    });
  }
  return sealed;
}

/** Verifies exact bounded content under a pinned origin and returns an opaque context-bound capability. */
export async function verifyEvent(context: OperationContext, input: unknown, crypto: ExchangeCrypto): Promise<VerifiedEvent> {
  try { canonicalJson(input,1024*1024+512); } catch { throw new ExchangeError("invalid_event"); }
  const parsed = signedJournalEventSchema.safeParse(input);
  if (!parsed.success) throw new ExchangeError("invalid_event");
  const envelope = parseJournalEnvelope(parsed.data.envelope);
  const event: SignedJournalEvent = { ...parsed.data, envelope: JSON.parse(canonicalJson(envelope)) as typeof envelope };
  const pin = authorizedOperation(context, ["business.settings"], (_database, tx) => {
    if (envelope.business_id !== context.businessId) throw new ExchangeError("scope_mismatch");
    return pinnedDevice(tx,context.businessId,envelope.origin_device_id);
  });
  const key = String(pin["public_key"]), message = eventSigningMessage(event.envelope);
  try {
    if (await crypto.sha256(message) !== event.digest || !await crypto.verify(key,message,event.signature)) throw new Error("invalid proof");
  } catch { throw new ExchangeError("invalid_signature"); }
  authorizedOperation(context, ["business.settings"], (_database, tx) => {
    const current = pinnedDevice(tx,context.businessId,envelope.origin_device_id);
    if (current["public_key"] !== key || current["revision"] !== pin["revision"]) throw new ExchangeError("untrusted_device");
  });
  const token: VerifiedEvent = Object.freeze({ eventId: envelope.event_id, digest: event.digest });
  verifiedEvents.set(token,{ context,event,key,keyRevision: Number(pin["revision"]) });
  return token;
}

/** Owner-approved peer/server identity; F3 pairing must confirm keys before invoking this operation. */
export function registerExchangeDestination(context: OperationContext, input: { readonly deviceId: string; readonly publicKey: string; readonly label: string; readonly platform: "ANDROID" | "IOS" | "DESKTOP"; readonly kind: "peer" | "server"; readonly authorityAllowed?: boolean }): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.deviceId) ||
    typeof input.publicKey !== "string" || input.publicKey.length > 8192 || !input.publicKey.includes("BEGIN PUBLIC KEY") ||
    typeof input.label !== "string" || input.label.trim().length === 0 || input.label.length > 120 ||
    !["ANDROID","IOS","DESKTOP"].includes(input.platform) || !["peer","server"].includes(input.kind) ||
    (input.authorityAllowed !== undefined && typeof input.authorityAllowed !== "boolean")) throw new ExchangeError("invalid_destination");
  return authorizedOperation(context, ["business.settings"], (_database, tx, ports, revision) => {
    requireOwner(tx,context);
    if (pinnedDevice(tx,context.businessId,context.deviceId)["authority_allowed"] !== 1) throw new ExchangeError("permission_denied");
    if (input.deviceId === context.deviceId) throw new ExchangeError("invalid_destination");
    const old = tx.get(`SELECT business_id FROM devices WHERE id=?`, [input.deviceId]);
    if (old !== undefined && old["business_id"] !== context.businessId) throw new ExchangeError("scope_mismatch");
    const pin = tx.get(`SELECT public_key,authority_allowed FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`, [context.businessId,input.deviceId]);
    if (pin !== undefined && (pin["public_key"] !== input.publicKey || pin["authority_allowed"] !== (input.authorityAllowed === true ? 1 : 0))) throw new ExchangeError("conflict");
    const at = timestamp(ports);
    tx.run(`INSERT OR IGNORE INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES (?,?,?,?,?,?,?)`, [input.deviceId,context.businessId,input.label.trim(),input.platform,at,at,at]);
    tx.run(`INSERT OR IGNORE INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,?,?)`, [context.businessId,input.deviceId,input.publicKey,input.authorityAllowed === true ? 1 : 0,context.userId]);
    const existing = tx.get(`SELECT id FROM exchange_destinations WHERE business_id=? AND receiver_device_id=? AND kind=?`, [context.businessId,input.deviceId,input.kind]);
    if (existing !== undefined) return String(existing["id"]);
    const id = nextId(ports);
    tx.run(`INSERT INTO exchange_destinations(id,business_id,receiver_device_id,kind,label) VALUES (?,?,?,?,?)`, [id,context.businessId,input.deviceId,input.kind,input.label.trim()]);
    appendLocalAudit(tx,context,ports,revision,"EXCHANGE_DESTINATION_REGISTERED",id,{ deviceId: input.deviceId,kind: input.kind,authorityAllowed: input.authorityAllowed === true });
    return id;
  });
}

/** Owner revokes/reinstates trust for another device; imported history stays immutable. */
export function setExchangeDeviceActive(context: OperationContext, deviceId: string, active: boolean): void {
  authorizedOperation(context,["business.settings"],(_database,tx,ports,revision) => {
    requireOwner(tx,context);
    if (deviceId === context.deviceId || typeof active !== "boolean") throw new ExchangeError("permission_denied");
    const result = tx.run(`UPDATE trusted_exchange_devices SET active=?,revision=revision+1 WHERE business_id=? AND device_id=?`, [active ? 1 : 0,context.businessId,deviceId]);
    if (result.changes !== 1) throw new ExchangeError("untrusted_device");
    appendLocalAudit(tx,context,ports,revision,active ? "EXCHANGE_DEVICE_REINSTATED" : "EXCHANGE_DEVICE_REVOKED",deviceId);
  });
}

/** @internal Owner identity is checked separately from a granted management capability. */
export function requireOwner(tx: Queryable, context: OperationContext): void {
  if (tx.get(`SELECT owner_id FROM local_installation WHERE id=1`)?.["owner_id"] !== context.userId) throw new ExchangeError("permission_denied");
}
