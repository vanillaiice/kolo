import { canonicalJson } from "@kolo/contracts/canonical";
import { parseJournalEnvelope, type JournalEnvelope } from "@kolo/contracts/events";
import type { Queryable, Row } from "../database/driver.ts";
import { ExchangeError } from "../../exchange/types.ts";
import { eventModel, type EventModel } from "./model.ts";
import { journalContext } from "./internal-context.ts";
import type { NewEvent } from "../sync/outbox.ts";

/** Appends a validated immutable envelope; transaction ownership belongs to the caller. */
export function appendEvent(tx: Queryable, input: JournalEnvelope, provenance: "local" | "received"): void {
  const event = parseJournalEnvelope(input), canonical = canonicalJson(event);
  if (provenance === "local") eventModel(event);
  const existing = tx.get(`SELECT event_id,canonical FROM event_journal WHERE event_id = ? OR
    (business_id = ? AND origin_device_id = ? AND origin_sequence = ?)`, [event.event_id, event.business_id, event.origin_device_id, event.origin_sequence]);
  if (existing !== undefined) {
    if (existing["event_id"] !== event.event_id || existing["canonical"] !== canonical) throw new ExchangeError("conflict");
    return;
  }
  if (tx.get(`SELECT event_id FROM legacy_event_archive WHERE event_id = ?`, [event.event_id]) !== undefined) throw new ExchangeError("conflict");
  tx.run(`INSERT INTO event_journal(event_id,business_id,origin_device_id,actor_id,origin_sequence,event_type,event_version,occurred_at,authority_revision,canonical,provenance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [event.event_id,event.business_id,event.origin_device_id,event.actor_id,event.origin_sequence,event.event_type,event.event_version,event.occurred_at,event.authority_revision,canonical,provenance]);
}

/** @internal Allocates a local origin position under SQLite's write transaction, never a server cursor. */
export function allocateOrigin(tx: Queryable, businessId: string, deviceId: string): number {
  tx.run(`INSERT OR IGNORE INTO journal_origins(business_id,device_id) VALUES (?,?)`, [businessId, deviceId]);
  const next = Number(tx.get(`SELECT next_sequence FROM journal_origins WHERE business_id = ? AND device_id = ?`, [businessId,deviceId])?.["next_sequence"]);
  if (!Number.isSafeInteger(next) || next < 1 || next >= Number.MAX_SAFE_INTEGER) throw new ExchangeError("invalid_event");
  tx.run(`UPDATE journal_origins SET next_sequence = next_sequence + 1 WHERE business_id = ? AND device_id = ?`, [businessId,deviceId]);
  return next;
}

/** @internal Binds immutable financial identities to exactly one event, including after future compaction. */
export function claimEntities(tx: Queryable, event: JournalEnvelope, model: EventModel): void {
  for (const entity of model.entities) {
    if (entity.mutable) continue;
    const old = tx.get(`SELECT event_id FROM journal_entity_claims WHERE table_name = ? AND entity_id = ?`, [entity.table,entity.id]);
    if (old !== undefined && old["event_id"] !== event.event_id) throw new ExchangeError("conflict");
    tx.run(`INSERT OR IGNORE INTO journal_entity_claims(table_name,entity_id,event_id,business_id) VALUES (?,?,?,?)`, [entity.table,entity.id,event.event_id,event.business_id]);
  }
}

/** @internal Captures an authorized command's v2 fact in the same transaction as its v1 compatibility event. */
export function captureOutboxEvent(tx: Queryable, source: NewEvent): void {
  const installation = tx.get(`SELECT business_id,device_id FROM local_installation WHERE id = 1`);
  if (installation === undefined) return; // Unconverted v1 shops retain their existing queue behavior.
  const authority = journalContext(tx);
  if (authority === undefined || authority.businessId !== source.businessId || authority.deviceId !== source.deviceId || authority.userId !== source.userId ||
    installation["business_id"] !== source.businessId || installation["device_id"] !== source.deviceId) throw new ExchangeError("permission_denied");
  const member = tx.get(`SELECT revision FROM local_memberships WHERE business_id = ? AND user_id = ?`, [source.businessId,source.userId]);
  if (member?.["revision"] !== authority.revision) throw new ExchangeError("authority_revision");
  const payload = JSON.parse(JSON.stringify(source.payload)) as JournalEnvelope["payload"];
  // Wire v1 omitted branch; recover it from the just-written scoped business rows.
  const provisional: JournalEnvelope = { event_id: source.eventId, business_id: source.businessId, origin_device_id: source.deviceId,
    actor_id: source.userId, origin_sequence: 1, event_type: source.type, event_version: 2, occurred_at: source.occurredAt,
    branch_id: null, authority_revision: authority.revision, required_permissions: [...authority.permissions], payload };
  const model = eventModel(provisional);
  const branches = new Set<string | null>();
  for (const entity of model.entities) {
    if (["sale_items", "purchase_items", "products", "categories", "product_category_sets", "shop_tax_settings", "product_tax_rules", "payment_terms", "business_return_items", "business_return_refunds", "customers", "suppliers"].includes(entity.table)) continue;
    const row = tx.get(`SELECT branch_id FROM ${entity.table} WHERE id = ? AND business_id = ?`, [entity.id,source.businessId]);
    if (row === undefined) throw new ExchangeError("missing_dependency");
    branches.add(typeof row["branch_id"] === "string" ? row["branch_id"] : null);
  }
  if (branches.size > 1) throw new ExchangeError("invalid_payload");
  const resolvedBranch = branches.values().next().value ?? null;
  if (source.type === "ACCOUNT_SAVED" && resolvedBranch !== null) {
    (payload["account"] as Record<string,unknown>)["branch_id"] = resolvedBranch;
  }
  const event: JournalEnvelope = { ...provisional, branch_id: branches.values().next().value ?? null,
    origin_sequence: allocateOrigin(tx,source.businessId,source.deviceId) };
  appendEvent(tx,event,"local"); claimEntities(tx,event,model);
  tx.run(`INSERT INTO applied_events(event_id,business_id,status,updated_at) VALUES (?,?,'applied',?)`, [event.event_id,event.business_id,source.occurredAt]);
}

/** @internal Decodes the immutable stored event; never changes origin/sequence when forwarding. */
export function envelopeOf(row: Row): JournalEnvelope { return parseJournalEnvelope(JSON.parse(String(row["canonical"]))); }
