import { canonicalJson } from "@kolo/contracts/canonical";
import { signedJournalBatchSchema, signedPeerReceiptSchema, MAX_JOURNAL_BATCH_BYTES, type SignedJournalBatch, type SignedPeerReceipt, type JournalBatch, type PeerReceipt } from "@kolo/contracts/delivery";
import type { SignedJournalEvent } from "@kolo/contracts/events";
import type { OperationContext } from "../identity/types.ts";
import { authorizedOperation, nextId, timestamp } from "../identity/internal-authority.ts";
import { ExchangeError, type ExchangeCrypto, type EventOutcome } from "../exchange/types.ts";
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

/** Pending signed facts for exactly one destination, preserving their original immutable envelope/proof. */
export function eventsForDestination(context: OperationContext, destinationId: string, limit = 200): readonly SignedJournalEvent[] {
  bound(limit);
  return authorizedOperation(context,["business.settings"],(_database,tx) => {
    const dest = destination(tx,context,destinationId);
    return tx.all(`SELECT e.*,s.digest,s.signature FROM event_journal e JOIN event_signatures s ON s.event_id=e.event_id JOIN applied_events a ON a.event_id=e.event_id LEFT JOIN event_deliveries d ON d.event_id=e.event_id AND d.destination_id=? WHERE e.business_id=? AND e.origin_device_id<>? AND a.status<>'quarantined' AND (d.event_id IS NULL OR d.state='offered') ORDER BY e.origin_sequence,e.event_id LIMIT ?`,[destinationId,context.businessId,dest["receiver_device_id"]!,limit]).map(row => ({ envelope:envelopeOf(row),digest:String(row["digest"]),signature:String(row["signature"]) }));
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
  authorizedOperation(context,["business.settings"],(_database,tx) => {
    if (destination(tx,context,destinationId)["receiver_device_id"] !== batch.receiver_device_id) throw new ExchangeError("invalid_destination");
    tx.run(`INSERT INTO offered_batches(batch_id,business_id,destination_id,content_digest,created_at) VALUES (?,?,?,?,?)`,[batch.batch_id,context.businessId,destinationId,proof.digest,batch.created_at]);
    for (const event of batch.events) {
      tx.run(`INSERT INTO offered_batch_events(batch_id,event_id,digest) VALUES (?,?,?)`,[batch.batch_id,event.envelope.event_id,event.digest]);
      tx.run(`INSERT INTO event_deliveries(business_id,destination_id,event_id,offered_at,state) VALUES (?,?,?,?,'offered') ON CONFLICT(destination_id,event_id) DO UPDATE SET offered_at=excluded.offered_at`,[context.businessId,destinationId,event.envelope.event_id,batch.created_at]);
    }
  });
  return { batch,...proof };
}

/** Read-only authentication of the container and every origin; no receipt or application state is written. */
export async function verifyJournalBatch(context:OperationContext,input:unknown,crypto:ExchangeCrypto):Promise<SignedJournalBatch>{
  try { canonicalJson(input,MAX_JOURNAL_BATCH_BYTES); } catch { throw new ExchangeError("invalid_event"); }
  const parsed=signedJournalBatchSchema.safeParse(input); if (!parsed.success) throw new ExchangeError("invalid_event");
  const signed=parsed.data,batch=signed.batch;
  if (batch.business_id !== context.businessId || batch.receiver_device_id !== context.deviceId) throw new ExchangeError("scope_mismatch");
  await checkProof(context,crypto,batch.sender_device_id,`kolo.batch.v2\u0000${canonicalJson(batch,MAX_JOURNAL_BATCH_BYTES)}`,signed.digest,signed.signature);
  for (const event of batch.events) await verifyEvent(context,event,crypto);
  return signed;
}

/** Authenticates the forwarding sender and every preserved origin before any import work is stored. */
export async function importJournalBatch(context: OperationContext, input: unknown, crypto: ExchangeCrypto): Promise<readonly { eventId:string; outcome:EventOutcome }[]> {
  const signed=await verifyJournalBatch(context,input,crypto),batch=signed.batch,tokens=[];
  for(const event of batch.events)tokens.push(await verifyEvent(context,event,crypto));
  authorizedOperation(context,["business.settings"],(_database,tx,ports) => {
    const old=tx.get(`SELECT content_digest,business_id FROM import_batches WHERE batch_id=?`,[batch.batch_id]);
    if (old !== undefined && (old["content_digest"] !== signed.digest || old["business_id"] !== context.businessId)) throw new ExchangeError("conflict");
    tx.run(`INSERT OR IGNORE INTO import_batches(batch_id,business_id,sender_device_id,receiver_device_id,content_digest,status,created_at,updated_at) VALUES (?,?,?,?,?,'processing',?,?)`,[batch.batch_id,context.businessId,batch.sender_device_id,context.deviceId,signed.digest,batch.created_at,timestamp(ports)]);
  });
  const outcomes: { eventId:string; outcome:EventOutcome }[]=[];
  for (const [index,token] of tokens.entries()) {
    const outcome=applyEvent(context,token),event=batch.events[index]!;
    outcomes.push({ eventId:token.eventId,outcome });
    authorizedOperation(context,["business.settings"],(_database,tx) => tx.run(`INSERT INTO import_batch_events(batch_id,event_id,digest,outcome) VALUES (?,?,?,?) ON CONFLICT(batch_id,event_id) DO UPDATE SET outcome=excluded.outcome`,[batch.batch_id,token.eventId,event.digest,outcome]));
  }
  retryDeferred(context);
  authorizedOperation(context,["business.settings"],(_database,tx,ports) => {
    for (const result of outcomes) {
      const status=tx.get(`SELECT a.status FROM applied_events a JOIN event_signatures s ON s.event_id=a.event_id JOIN import_batch_events b ON b.event_id=a.event_id AND b.digest=s.digest WHERE a.business_id=? AND b.batch_id=? AND a.event_id=?`,[context.businessId,batch.batch_id,result.eventId])?.["status"];
      if (["applied","deferred","quarantined","unsupported"].includes(String(status)) && result.outcome !== "duplicate") result.outcome=status as EventOutcome;
      tx.run(`UPDATE import_batch_events SET outcome=? WHERE batch_id=? AND event_id=?`,[result.outcome,batch.batch_id,result.eventId]);
    }
    tx.run(`UPDATE import_batches SET status='complete',updated_at=? WHERE batch_id=? AND business_id=?`,[timestamp(ports),batch.batch_id,context.businessId]);
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

async function signMessage(context:OperationContext,crypto:ExchangeCrypto,message:string):Promise<{ digest:string; signature:string }> {
  const { ports,reference,key }=authorizedOperation(context,[],(_database,tx,ports) => { const install=tx.get(`SELECT key_reference,public_key FROM local_installation WHERE id=1`)!; return { ports,reference:String(install["key_reference"]),key:String(install["public_key"]) }; });
  if (ports.credentials.sign === undefined) throw new ExchangeError("invalid_signature");
  let digest:string,signature:string;
  try { digest=await crypto.sha256(message); signature=await ports.credentials.sign(reference,message); if (!/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{128}$/.test(signature) || !await crypto.verify(key,message,signature)) throw new Error(); } catch { throw new ExchangeError("invalid_signature"); }
  authorizedOperation(context,[],(_database,tx) => { if (pinnedDevice(tx,context.businessId,context.deviceId)["public_key"] !== key) throw new ExchangeError("untrusted_device"); });
  return { digest,signature };
}
async function checkProof(context:OperationContext,crypto:ExchangeCrypto,device:string,message:string,digest:string,signature:string):Promise<void> {
  const pin=authorizedOperation(context,["business.settings"],(_database,tx) => pinnedDevice(tx,context.businessId,device)),key=String(pin["public_key"]);
  try { if (await crypto.sha256(message) !== digest || !await crypto.verify(key,message,signature)) throw new Error(); } catch { throw new ExchangeError("invalid_signature"); }
  authorizedOperation(context,["business.settings"],(_database,tx) => { const current=pinnedDevice(tx,context.businessId,device); if (current["public_key"] !== key || current["revision"] !== pin["revision"]) throw new ExchangeError("untrusted_device"); });
}
