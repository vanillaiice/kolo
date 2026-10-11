import { z } from "zod";
import { parseJournalEnvelope, signedJournalEventSchema, type SignedJournalEvent } from "./events.ts";
import { canonicalJson, utf8Length } from "./canonical.ts";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const signature = z.string().regex(/^[a-f0-9]{128}$/);
const timestamp = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export const MAX_JOURNAL_BATCH_BYTES = 8 * 1024 * 1024;

/** Authenticated forwarding container. Sender differs from each preserved event origin. */
export const journalBatchSchema = z.strictObject({ format: z.literal("kolo.events"), format_version: z.literal(2),
  batch_id: uuid, business_id: uuid, sender_device_id: uuid, receiver_device_id: uuid, created_at: timestamp,
  events: z.array(signedJournalEventSchema).min(1).max(1000),
}).superRefine((batch, context) => {
  const ids = new Set<string>(), positions = new Set<string>();
  for (const [index, { envelope }] of batch.events.entries()) {
    const position = `${envelope.origin_device_id}:${envelope.origin_sequence}`;
    if (envelope.business_id !== batch.business_id || ids.has(envelope.event_id) || positions.has(position)) {
      context.addIssue({ code: "custom", path: ["events",index], message: "invalid batch identity" });
    }
    ids.add(envelope.event_id); positions.add(position);
  }
});
export const signedJournalBatchSchema = z.strictObject({ batch: journalBatchSchema, digest, signature });

/** A receiver acknowledges exact durably stored digests, independently for each destination. */
export const peerReceiptSchema = z.strictObject({ format: z.literal("kolo.receipt"), format_version: z.literal(1),
  receipt_id: uuid, business_id: uuid, sender_device_id: uuid, receiver_device_id: uuid, batch_id: uuid, created_at: timestamp,
  entries: z.array(z.strictObject({ event_id: uuid, digest, state: z.enum(["stored","applied","deferred","unsupported"]) })).min(1).max(1000),
}).refine(receipt => new Set(receipt.entries.map(entry => entry.event_id)).size === receipt.entries.length);
export const signedPeerReceiptSchema = z.strictObject({ receipt: peerReceiptSchema, digest, signature });
export type JournalBatch = z.infer<typeof journalBatchSchema>;
export type SignedJournalBatch = z.infer<typeof signedJournalBatchSchema>;
export type PeerReceipt = z.infer<typeof peerReceiptSchema>;
export type SignedPeerReceipt = z.infer<typeof signedPeerReceiptSchema>;

/** Bounds raw UTF-8 before decoding; per-event schemas/crypto/trust still run afterward. */
export function decodeSignedJournalBatch(bytes: string): SignedJournalBatch {
  if (bytes.length > MAX_JOURNAL_BATCH_BYTES || utf8Length(bytes) > MAX_JOURNAL_BATCH_BYTES) throw new Error("invalid_batch");
  let value: unknown; try { value = JSON.parse(bytes); } catch { throw new Error("invalid_batch"); }
  try { canonicalJson(value, MAX_JOURNAL_BATCH_BYTES); } catch { throw new Error("invalid_batch"); }
  const result = signedJournalBatchSchema.safeParse(value);
  if (!result.success) throw new Error("invalid_batch");
  canonicalJson(result.data, MAX_JOURNAL_BATCH_BYTES);
  return result.data;
}

/** Domain-separated UTF-8 bytes hashed and signed for one event envelope. */
export function eventSigningMessage(envelope: SignedJournalEvent["envelope"]): string { return `kolo.event.v2\u0000${canonicalJson(parseJournalEnvelope(envelope))}`; }
/** Domain-separated UTF-8 bytes hashed and signed for a forwarding batch. */
export function batchSigningMessage(batch: JournalBatch): string { return `kolo.batch.v2\u0000${canonicalJson(batch, MAX_JOURNAL_BATCH_BYTES)}`; }
/** Domain-separated UTF-8 bytes hashed and signed for a receipt. */
export function receiptSigningMessage(receipt: PeerReceipt): string { return `kolo.receipt.v1\u0000${canonicalJson(receipt, MAX_JOURNAL_BATCH_BYTES)}`; }
