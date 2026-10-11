import { canonicalJson } from "@kolo/contracts/canonical";
import { signedJournalBatchSchema, signedPeerReceiptSchema, MAX_JOURNAL_BATCH_BYTES, type SignedJournalBatch, type SignedPeerReceipt, type JournalBatch, type PeerReceipt } from "@kolo/contracts/delivery";
import type { SignedJournalEvent } from "@kolo/contracts/events";
import type { OperationContext } from "../identity/types.ts";
import { authorizedOperation, nextId, timestamp } from "../identity/internal-authority.ts";
import { ExchangeError, type ExchangeCrypto, type EventOutcome, type VerifiedEvent } from "../exchange/types.ts";
import { pinnedDevice, sealPendingEvents, verifyEvent } from "./exchange.ts";
import { applyEvent, retryDeferred } from "./event-application.ts";
import { envelopeOf } from "../data/exchange/journal.ts";
import type { Queryable, Row } from "../data/database/driver.ts";

function destination(tx: Queryable, context: OperationContext, id: string): Row {
  const row = tx.get(`SELECT * FROM exchange_destinations WHERE business_id=? AND id=? AND active=1`,[context.businessId,id]);
  if (row === undefined) throw new ExchangeError("invalid_destination");
  pinnedDevice(tx,context.businessId,String(row["receiver_device_id"])); return row;
}
function bound(limit: number): void { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ExchangeError("invalid_event"); }

/** Pending signed facts for exactly one destination, preserving their original immutable envelope/proof. `types` limits the event types returned. */
export function eventsForDestination(context: OperationContext, destinationId: string, limit = 200, types?: readonly string[]): readonly SignedJournalEvent[] {
  bound(limit);
  if (types !== undefined && (types.length === 0 || types.length > 50 || types.some(type => typeof type !== "string" || !/^[A-Z_]{1,80}$/.test(type)))) throw new ExchangeError("invalid_event");
  return authorizedOperation(context,["business.settings"],(_database,tx) => {
    const dest = destination(tx,context,destinationId);
    const only = types === undefined ? "" : ` AND e.event_type IN (${types.map(() => "?").join(",")})`;
    return tx.all(`SELECT e.*,s.digest,s.signature FROM event_journal e JOIN event_signatures s ON s.event_id=e.event_id JOIN applied_events a ON a.event_id=e.event_id LEFT JOIN event_deliveries d ON d.event_id=e.event_id AND d.destination_id=? WHERE e.business_id=? AND e.origin_device_id<>? AND a.status<>'quarantined' AND (d.event_id IS NULL OR d.state='offered')${only} ORDER BY e.origin_sequence,e.event_id LIMIT ?`,[destinationId,context.businessId,dest["receiver_device_id"]!,...(types ?? []),limit]).map(row => ({ envelope:envelopeOf(row),digest:String(row["digest"]),signature:String(row["signature"]) }));
  });
}

/** Counts scoped delivery/application work without changing HTTP v1's independent cloud queue. */
export function exchangeStatus(context: OperationContext, destinationId: string): Readonly<Record<string,number>> {
  return authorizedOperation(context,["business.settings"],(_database,tx) => {
    const dest=destination(tx,context,destinationId), result: Record<string,number> = { pending:0,unsigned:0,offered:0,stored:0,applied:0,deferred:0,unsupported:0,quarantined:0 };
    for (const row of tx.all(`SELECT s.event_id AS signed,a.status,d.state FROM event_journal e LEFT JOIN event_signatures s ON s.event_id=e.event_id JOIN applied_events a ON a.event_id=e.event_id LEFT JOIN event_deliveries d ON d.event_id=e.event_id AND d.destination_id=? WHERE e.business_id=? AND e.origin_device_id<>?`,[destinationId,context.businessId,dest["receiver_device_id"]!])) {
      if (row["status"] === "quarantined") { result["quarantined"]!++; continue; }
      if (row["signed"] === null) result["unsigned"]!++;
      if (row["state"] === null || row["state"] === "offered") result["pending"]!++;
      if (typeof row["state"] === "string") result[row["state"]]!++;
      if (["deferred","unsupported"].includes(String(row["status"])) && row["status"] !== row["state"]) result[String(row["status"])]!++;
    }
    return result;
  });
}

/** Bounded signed forwarding batch; offering never acknowledges delivery. Empty queues return undefined. */
export async function createJournalBatch(context: OperationContext, destinationId: string, crypto: ExchangeCrypto, limit=200): Promise<SignedJournalBatch | undefined> {
  bound(limit); await sealPendingEvents(context,crypto,1000);
  const events = [...eventsForDestination(context,destinationId,limit)];
  if (events.length === 0) return undefined;
  const batch = authorizedOperation(context,["business.settings"],(_database,tx,ports): JournalBatch => ({ format:"kolo.events",format_version:2,batch_id:nextId(ports),business_id:context.businessId,sender_device_id:context.deviceId,receiver_device_id:String(destination(tx,context,destinationId)["receiver_device_id"]),created_at:timestamp(ports),events }));
  // Fit complete facts, never split an event or silently discard the remainder.
  for (;;) { try { canonicalJson(batch,MAX_JOURNAL_BATCH_BYTES-256); break; } catch { if (batch.events.length <= 1) throw new ExchangeError("invalid_event"); batch.events.pop(); } }
  const message=`kolo.batch.v2\u0000${canonicalJson(batch,MAX_JOURNAL_BATCH_BYTES)}`, proof=await signMessage(context,crypto,message);
  recordOffer(context,destinationId,{ batchId:batch.batch_id,receiverDeviceId:batch.receiver_device_id,createdAt:batch.created_at,digest:proof.digest },batch.events.map(event => ({ eventId:event.envelope.event_id,digest:event.digest })));
  return { batch,...proof };
}

/**
 * @internal Records a signed offer: which facts (by the digest of their signed content) went to the destination in
 * which batch, so a later receipt can only acknowledge exactly those. Offering never acknowledges delivery.
 */
export function recordOffer(context: OperationContext, destinationId: string, offer: { readonly batchId:string; readonly receiverDeviceId:string; readonly createdAt:string; readonly digest:string }, events: readonly { readonly eventId:string; readonly digest:string }[]): void {
  authorizedOperation(context,["business.settings"],(_database,tx) => {
    if (destination(tx,context,destinationId)["receiver_device_id"] !== offer.receiverDeviceId) throw new ExchangeError("invalid_destination");
    tx.run(`INSERT INTO offered_batches(batch_id,business_id,destination_id,content_digest,created_at) VALUES (?,?,?,?,?)`,[offer.batchId,context.businessId,destinationId,offer.digest,offer.createdAt]);
    for (const event of events) {
      tx.run(`INSERT INTO offered_batch_events(batch_id,event_id,digest) VALUES (?,?,?)`,[offer.batchId,event.eventId,event.digest]);
      tx.run(`INSERT INTO event_deliveries(business_id,destination_id,event_id,offered_at,state) VALUES (?,?,?,?,'offered') ON CONFLICT(destination_id,event_id) DO UPDATE SET offered_at=excluded.offered_at`,[context.businessId,destinationId,event.eventId,offer.createdAt]);
    }
  });
}

/**
 * Read-only authentication of the container and every origin it can currently verify; no receipt or application
 * state is written. Events whose origin is not yet trusted here are returned separately: trust may arrive in the
 * same batch (an owner-signed `DEVICE_TRUSTED`), and they are never stored or acknowledged until verified.
 */
export async function verifyJournalBatch(context:OperationContext,input:unknown,crypto:ExchangeCrypto):Promise<SignedJournalBatch>{
  const { signed,tokens }=await authenticateBatch(context,input,crypto);
  if (tokens.every(token => token === undefined)) throw new ExchangeError("untrusted_device");
  return signed;
}

async function authenticateBatch(context:OperationContext,input:unknown,crypto:ExchangeCrypto):Promise<{ signed:SignedJournalBatch; tokens:(VerifiedEvent | undefined)[] }>{
  try { canonicalJson(input,MAX_JOURNAL_BATCH_BYTES); } catch { throw new ExchangeError("invalid_event"); }
  const parsed=signedJournalBatchSchema.safeParse(input); if (!parsed.success) throw new ExchangeError("invalid_event");
  const signed=parsed.data,batch=signed.batch;
  if (batch.business_id !== context.businessId || batch.receiver_device_id !== context.deviceId) throw new ExchangeError("scope_mismatch");
  await checkProof(context,crypto,batch.sender_device_id,`kolo.batch.v2\u0000${canonicalJson(batch,MAX_JOURNAL_BATCH_BYTES)}`,signed.digest,signed.signature);
  const tokens:(VerifiedEvent | undefined)[]=[];
  for (const event of batch.events) tokens.push(await verifyOrDefer(context,event,crypto));
  return { signed,tokens };
}

/** @internal Unknown or revoked origins are left for a later batch; any other proof failure still refuses the whole batch. */
export async function verifyOrDefer(context:OperationContext,event:unknown,crypto:ExchangeCrypto):Promise<VerifiedEvent | undefined>{
  try { return await verifyEvent(context,event,crypto); }
  catch (error) { if (error instanceof ExchangeError && error.code === "untrusted_device") return undefined; throw error; }
}

/**
 * One imported event's outcome; `untrusted` means its origin was not trusted here and nothing was stored, and
 * `locked` that it arrived sealed with a shop key this device has not been granted yet. Neither is acknowledged.
 */
export type ImportOutcome = EventOutcome | "untrusted" | "locked";

/** Authenticates the forwarding sender and every preserved origin before any import work is stored. */
export async function importJournalBatch(context: OperationContext, input: unknown, crypto: ExchangeCrypto): Promise<readonly { eventId:string; outcome:ImportOutcome }[]> {
  const { signed,tokens }=await authenticateBatch(context,input,crypto),batch=signed.batch;
  return importAuthenticated(context,{ batchId:batch.batch_id,senderDeviceId:batch.sender_device_id,createdAt:batch.created_at,digest:signed.digest },
    batch.events.map(event => ({ eventId:event.envelope.event_id,event })),tokens,crypto);
}

/**
 * @internal Stores and applies the facts of a batch whose container proof was already checked. An entry without
 * an `event` is one the caller could not open (`locked`); `tokens` holds origin verifications already done.
 */
export async function importAuthenticated(context: OperationContext, meta: { readonly batchId:string; readonly senderDeviceId:string; readonly createdAt:string; readonly digest:string },
  entries: readonly { readonly eventId:string; readonly event?:SignedJournalEvent }[], tokens: readonly (VerifiedEvent | undefined)[], crypto: ExchangeCrypto): Promise<readonly { eventId:string; outcome:ImportOutcome }[]> {
  authorizedOperation(context,["business.settings"],(_database,tx,ports) => {
    const old=tx.get(`SELECT content_digest,business_id FROM import_batches WHERE batch_id=?`,[meta.batchId]);
    if (old !== undefined && (old["content_digest"] !== meta.digest || old["business_id"] !== context.businessId)) throw new ExchangeError("conflict");
    tx.run(`INSERT OR IGNORE INTO import_batches(batch_id,business_id,sender_device_id,receiver_device_id,content_digest,status,created_at,updated_at) VALUES (?,?,?,?,?,'processing',?,?)`,[meta.batchId,context.businessId,meta.senderDeviceId,context.deviceId,meta.digest,meta.createdAt,timestamp(ports)]);
  });
  const outcomes: { eventId:string; outcome:ImportOutcome }[]=entries.map(entry => ({ eventId:entry.eventId,outcome:entry.event === undefined ? "locked" : "untrusted" }));
  const record=(index:number,token:VerifiedEvent):boolean => {
    let outcome:EventOutcome;
    try { outcome=applyEvent(context,token); }
    catch (error) { if (error instanceof ExchangeError && error.code === "untrusted_device") return false; throw error; } // trust changed since verification
    const event=entries[index]!.event!;
    outcomes[index]={ eventId:token.eventId,outcome };
    authorizedOperation(context,["business.settings"],(_database,tx) => tx.run(`INSERT INTO import_batch_events(batch_id,event_id,digest,outcome) VALUES (?,?,?,?) ON CONFLICT(batch_id,event_id) DO UPDATE SET outcome=excluded.outcome`,[meta.batchId,token.eventId,event.digest,outcome]));
    return true;
  };
  for (const [index,token] of tokens.entries()) if (token !== undefined) record(index,token);
  // Trust facts applied above may now verify origins that were unknown; repeat while that makes progress.
  for (let progress=true; progress;) {
    progress=false;
    for (const [index,entry] of entries.entries()) {
      if (outcomes[index]!.outcome !== "untrusted" || entry.event === undefined) continue;
      const token=await verifyOrDefer(context,entry.event,crypto);
      if (token !== undefined && record(index,token)) progress=true;
    }
  }
  retryDeferred(context);
  authorizedOperation(context,["business.settings"],(_database,tx,ports) => {
    for (const result of outcomes) {
      if (result.outcome === "untrusted" || result.outcome === "locked") continue;
      const status=tx.get(`SELECT a.status FROM applied_events a JOIN event_signatures s ON s.event_id=a.event_id JOIN import_batch_events b ON b.event_id=a.event_id AND b.digest=s.digest WHERE a.business_id=? AND b.batch_id=? AND a.event_id=?`,[context.businessId,meta.batchId,result.eventId])?.["status"];
      if (["applied","deferred","quarantined","unsupported"].includes(String(status)) && result.outcome !== "duplicate") result.outcome=status as EventOutcome;
      tx.run(`UPDATE import_batch_events SET outcome=? WHERE batch_id=? AND event_id=?`,[result.outcome,meta.batchId,result.eventId]);
    }
    // The forwarding sender already holds these facts; never offer them back to it.
    const back=tx.get(`SELECT id FROM exchange_destinations WHERE business_id=? AND receiver_device_id=? AND active=1`,[context.businessId,meta.senderDeviceId]);
    if (back !== undefined) for (const result of outcomes) {
      if (result.outcome === "untrusted" || result.outcome === "locked" || result.outcome === "quarantined") continue;
      tx.run(`INSERT INTO event_deliveries(business_id,destination_id,event_id,acknowledged_at,state) VALUES (?,?,?,?,'stored') ON CONFLICT(destination_id,event_id) DO UPDATE SET state='stored',acknowledged_at=excluded.acknowledged_at WHERE event_deliveries.state='offered'`,[context.businessId,back["id"]!,result.eventId,timestamp(ports)]);
    }
    tx.run(`UPDATE import_batches SET status='complete',updated_at=? WHERE batch_id=? AND business_id=?`,[timestamp(ports),meta.batchId,context.businessId]);
  });
  return outcomes;
}

/** Signs only exact durable, non-quarantined imports; this can be regenerated after a lost receipt. */
export async function createPeerReceipt(context: OperationContext, batchId:string, crypto:ExchangeCrypto): Promise<SignedPeerReceipt | undefined> {
  const receipt=authorizedOperation(context,["business.settings"],(_database,tx,ports): PeerReceipt | undefined => {
    const batch=tx.get(`SELECT sender_device_id FROM import_batches WHERE batch_id=? AND business_id=? AND receiver_device_id=? AND status='complete'`,[batchId,context.businessId,context.deviceId]);
    if (batch === undefined) throw new ExchangeError("invalid_receipt");
    const entries=tx.all(`SELECT b.event_id,b.digest,a.status FROM import_batch_events b JOIN event_signatures s ON s.event_id=b.event_id AND s.digest=b.digest JOIN applied_events a ON a.event_id=b.event_id WHERE b.batch_id=? AND a.business_id=? AND a.status<>'quarantined'`,[batchId,context.businessId]).map(row => ({ event_id:String(row["event_id"]),digest:String(row["digest"]),state:String(row["status"]) as PeerReceipt["entries"][number]["state"] }));
    if (entries.length === 0) return undefined;
    pinnedDevice(tx,context.businessId,String(batch["sender_device_id"]));
    return { format:"kolo.receipt",format_version:1,receipt_id:nextId(ports),business_id:context.businessId,sender_device_id:String(batch["sender_device_id"]),receiver_device_id:context.deviceId,batch_id:batchId,created_at:timestamp(ports),entries };
  });
  if (receipt === undefined) return undefined;
  const proof=await signMessage(context,crypto,`kolo.receipt.v1\u0000${canonicalJson(receipt,MAX_JOURNAL_BATCH_BYTES)}`);
  return { receipt,...proof };
}

/** Authenticated, exact batch-bound acknowledgment updates this destination only; duplicates are harmless. */
export async function acknowledgeDelivery(context:OperationContext,destinationId:string,input:unknown,crypto:ExchangeCrypto): Promise<number> {
  try { canonicalJson(input,MAX_JOURNAL_BATCH_BYTES); } catch { throw new ExchangeError("invalid_receipt"); }
  const parsed=signedPeerReceiptSchema.safeParse(input); if (!parsed.success) throw new ExchangeError("invalid_receipt");
  const { receipt,digest,signature }=parsed.data, canonical=canonicalJson(receipt,MAX_JOURNAL_BATCH_BYTES);
  const dest=authorizedOperation(context,["business.settings"],(_database,tx) => destination(tx,context,destinationId));
  if (receipt.business_id !== context.businessId || receipt.sender_device_id !== context.deviceId || receipt.receiver_device_id !== dest["receiver_device_id"]) throw new ExchangeError("scope_mismatch");
  await checkProof(context,crypto,receipt.receiver_device_id,`kolo.receipt.v1\u0000${canonical}`,digest,signature);
  return authorizedOperation(context,["business.settings"],(_database,tx,ports) => {
    destination(tx,context,destinationId);
    const old=tx.get(`SELECT digest,canonical,signature FROM peer_receipts WHERE receipt_id=?`,[receipt.receipt_id]);
    if (old !== undefined) { if (old["digest"] !== digest || old["canonical"] !== canonical || old["signature"] !== signature) throw new ExchangeError("conflict"); return 0; }
    const batch=tx.get(`SELECT batch_id FROM offered_batches WHERE batch_id=? AND business_id=? AND destination_id=?`,[receipt.batch_id,context.businessId,destinationId]);
    if (batch === undefined) throw new ExchangeError("invalid_receipt");
    for (const entry of receipt.entries) {
      if (tx.get(`SELECT event_id FROM offered_batch_events WHERE batch_id=? AND event_id=? AND digest=?`,[receipt.batch_id,entry.event_id,entry.digest]) === undefined) throw new ExchangeError("invalid_receipt");
    }
    const at=timestamp(ports);
    tx.run(`INSERT INTO peer_receipts(receipt_id,business_id,destination_id,digest,canonical,signature,received_at) VALUES (?,?,?,?,?,?,?)`,[receipt.receipt_id,context.businessId,destinationId,digest,canonical,signature,at]);
    let changed=0;
    for (const entry of receipt.entries) changed+=tx.run(`UPDATE event_deliveries SET acknowledged_at=?,state=?,receipt_id=? WHERE destination_id=? AND business_id=? AND event_id=? AND state<>'applied'`,[at,entry.state,receipt.receipt_id,destinationId,context.businessId,entry.event_id]).changes;
    return changed;
  });
}

/** @internal Signs domain-prefixed bytes with this installation's protected key and self-verifies the proof. */
export async function signMessage(context:OperationContext,crypto:ExchangeCrypto,message:string):Promise<{ digest:string; signature:string }> {
  const { ports,reference,key }=authorizedOperation(context,[],(_database,tx,ports) => { const install=tx.get(`SELECT key_reference,public_key FROM local_installation WHERE id=1`)!; return { ports,reference:String(install["key_reference"]),key:String(install["public_key"]) }; });
  if (ports.credentials.sign === undefined) throw new ExchangeError("invalid_signature");
  let digest:string,signature:string;
  try { digest=await crypto.sha256(message); signature=await ports.credentials.sign(reference,message); if (!/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{128}$/.test(signature) || !await crypto.verify(key,message,signature)) throw new Error(); } catch { throw new ExchangeError("invalid_signature"); }
  authorizedOperation(context,[],(_database,tx) => { if (pinnedDevice(tx,context.businessId,context.deviceId)["public_key"] !== key) throw new ExchangeError("untrusted_device"); });
  return { digest,signature };
}
/** @internal Checks a detached proof by a pinned device, failing if its trust changed during the check. */
export async function checkProof(context:OperationContext,crypto:ExchangeCrypto,device:string,message:string,digest:string,signature:string):Promise<void> {
  const pin=authorizedOperation(context,["business.settings"],(_database,tx) => pinnedDevice(tx,context.businessId,device)),key=String(pin["public_key"]);
  try { if (await crypto.sha256(message) !== digest || !await crypto.verify(key,message,signature)) throw new Error(); } catch { throw new ExchangeError("invalid_signature"); }
  authorizedOperation(context,["business.settings"],(_database,tx) => { const current=pinnedDevice(tx,context.businessId,device); if (current["public_key"] !== key || current["revision"] !== pin["revision"]) throw new ExchangeError("untrusted_device"); });
}
