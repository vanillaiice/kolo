import { canonicalJson } from "@kolo/contracts/canonical";
import { EventContractError } from "@kolo/contracts/events";
import { authorizedOperation, timestamp, appendLocalAudit } from "../identity/internal-authority.ts";
import type { OperationContext } from "../identity/types.ts";
import { verifiedEvents } from "../exchange/internal-verification.ts";
import { RuleError } from "../rules/amounts.ts";
import { UnusableEvent } from "../data/sync/engine.ts";
import { ExchangeError, type EventOutcome, type VerifiedEvent } from "../exchange/types.ts";
import { appendEvent, envelopeOf } from "../data/exchange/journal.ts";
import { applyBusinessFact } from "../data/exchange/apply.ts";
import { originDevice, requireOwner } from "./exchange.ts";

/** Stores an origin-verified fact durably, then applies effects and the permanent identity together. */
export function applyEvent(context: OperationContext, token: VerifiedEvent): EventOutcome {
  const material = token !== null && typeof token === "object" ? verifiedEvents.get(token) : undefined;
  if (material === undefined || material.context !== context) throw new ExchangeError("invalid_signature");
  const { event,key,keyRevision } = material, e = event.envelope;
  const stored = authorizedOperation(context,["business.settings"],(_database,tx,ports) => {
    const pin = originDevice(tx,context.businessId,e.origin_device_id);
    if (e.business_id !== context.businessId || pin["public_key"] !== key || pin["revision"] !== keyRevision) throw new ExchangeError("untrusted_device");
    try { appendEvent(tx,e,"received"); }
    catch (error) {
      if (!(error instanceof ExchangeError) || error.code !== "conflict") throw error;
      tx.run(`INSERT OR IGNORE INTO exchange_conflicts(business_id,event_id,digest,canonical,signature,public_key,detected_at) VALUES (?,?,?,?,?,?,?)`,[context.businessId,e.event_id,event.digest,canonicalJson(e),event.signature,key,timestamp(ports)]);
      return false;
    }
    const old = tx.get(`SELECT digest,signature,public_key FROM event_signatures WHERE event_id=?`,[e.event_id]);
    if (old !== undefined && (old["digest"] !== event.digest || old["signature"] !== event.signature || old["public_key"] !== key)) throw new ExchangeError("conflict");
    tx.run(`INSERT OR IGNORE INTO event_signatures(event_id,digest,signature,public_key) VALUES (?,?,?,?)`,[e.event_id,event.digest,event.signature,key]);
    tx.run(`INSERT OR IGNORE INTO applied_events(event_id,business_id,status,updated_at) VALUES (?,?,'stored',?)`,[e.event_id,context.businessId,timestamp(ports)]);
    return true;
  });
  return stored ? applyStored(context,e.event_id) : "quarantined";
}

function applyStored(context: OperationContext, id: string): EventOutcome {
  return authorizedOperation(context,["business.settings"],(_database,tx,ports) => {
    const row = tx.get(`SELECT e.*,s.digest,s.public_key,a.status FROM event_journal e JOIN event_signatures s ON s.event_id=e.event_id JOIN applied_events a ON a.event_id=e.event_id WHERE e.business_id=? AND e.event_id=?`,[context.businessId,id]);
    if (row === undefined) throw new ExchangeError("invalid_event");
    if (row["status"] === "applied") return "duplicate";
    if (row["status"] === "quarantined") return "quarantined";
    const event = envelopeOf(row), at = timestamp(ports);
    // Savepoint also protects callers whose driver joins an outer transaction.
    tx.run("SAVEPOINT apply_journal_fact");
    try {
      const pin = originDevice(tx,context.businessId,event.origin_device_id);
      if (pin["public_key"] !== row["public_key"]) throw new ExchangeError("untrusted_device");
      const exception = (kind: string): boolean => tx.get(`SELECT digest FROM event_exception_reviews WHERE event_id=? AND business_id=? AND kind=?`,[id,context.businessId,kind])?.["digest"] === row["digest"];
      // A revoked device's history up to the owner's cutoff stays accepted; anything later waits for the owner (ADR-040).
      if (pin["trusted"] !== 1 && event.origin_sequence > Number(pin["accepted_through"]) && !exception("device_revoked")) throw new ExchangeError("device_revoked");
      const review = tx.get(`SELECT digest FROM event_reviews WHERE event_id=? AND business_id=?`,[id,context.businessId]);
      applyBusinessFact(tx,event,review?.["digest"] === row["digest"],at,{ returnConflict: exception("return_conflict") });
      tx.run(`UPDATE applied_events SET status='applied',reason=NULL,attempts=attempts+1,updated_at=? WHERE event_id=?`,[at,id]);
      tx.run("RELEASE apply_journal_fact"); return "applied";
    } catch (error) {
      tx.run("ROLLBACK TO apply_journal_fact"); tx.run("RELEASE apply_journal_fact");
      const reason = error instanceof ExchangeError || error instanceof EventContractError ? error.code : error instanceof RuleError || error instanceof UnusableEvent ? "invalid_payload" : "application_failed";
      const state = reason === "unsupported_event" ? "unsupported" : ["missing_dependency","application_failed"].includes(reason) ? "deferred" : "quarantined";
      tx.run(`UPDATE applied_events SET status=?,reason=?,attempts=attempts+1,updated_at=? WHERE event_id=?`,[state,reason,at,id]);
      return state;
    }
  });
}

/** Bounded dependency passes; no network, re-signing or rewriting of applied identities. */
export function retryDeferred(context: OperationContext, limit = 200, maxPasses = 4): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 10) throw new ExchangeError("invalid_event");
  let total = 0;
  for (let pass=0;pass<maxPasses;pass++) {
    const ids = authorizedOperation(context,["business.settings"],(_database,tx) => tx.all(`SELECT a.event_id FROM applied_events a JOIN event_journal e ON e.event_id=a.event_id WHERE a.business_id=? AND a.status IN ('stored','deferred','unsupported') ORDER BY a.attempts,e.origin_sequence,e.event_id LIMIT ?`,[context.businessId,limit]));
    let applied = 0;
    for (const row of ids) if (applyStored(context,String(row["event_id"])) === "applied") applied++;
    total += applied; if (applied === 0) break;
  }
  return total;
}

/** Reasons an owner may approve a held-back fact for; anything else (malformed, forged, conflicting identity) stays refused. */
export const REVIEWABLE_REASONS = ["permission_denied", "authority_revision", "device_revoked", "return_conflict"] as const;

const AUTHORITY_TYPES = /^(WORKSPACE|LEGACY_|MEMBER_|OWNER_|PERMISSION_|ROLE_|CUSTOM_ROLE_|DEVICE_|SHOP_KEY_|SHOP_BACKUP_|SERVER_ENDPOINT_)/;

/** A fact from another till held back for a reason the owner may approve, as the review list shows it. */
export interface HeldBackFact {
  readonly eventId: string; readonly digest: string; readonly type: string; readonly reason: (typeof REVIEWABLE_REASONS)[number];
  readonly deviceId: string; readonly deviceLabel: string | null; readonly actorName: string | null; readonly occurredAt: string;
}

/** Owner only: the facts waiting for approval, oldest first (at most 200). Authority changes are never listed. */
export function heldBackFacts(context: OperationContext): readonly HeldBackFact[] {
  return authorizedOperation(context,["business.settings","users.manage"],(_database,tx) => {
    requireOwner(tx,context);
    return tx.all(`SELECT e.event_id,e.event_type,e.origin_device_id,e.occurred_at,s.digest,a.reason,d.label,u.name FROM applied_events a JOIN event_journal e ON e.event_id=a.event_id
      JOIN event_signatures s ON s.event_id=e.event_id LEFT JOIN devices d ON d.id=e.origin_device_id AND d.business_id=e.business_id LEFT JOIN users u ON u.id=e.actor_id AND u.business_id=e.business_id
      WHERE a.business_id=? AND a.status='quarantined' AND a.reason IN (${REVIEWABLE_REASONS.map(() => "?").join(",")}) ORDER BY e.occurred_at,e.event_id LIMIT 400`,[context.businessId,...REVIEWABLE_REASONS])
      .filter(row => !AUTHORITY_TYPES.test(String(row["event_type"]))).slice(0,200)
      .map(row => ({ eventId: String(row["event_id"]), digest: String(row["digest"]), type: String(row["event_type"]), reason: row["reason"] as HeldBackFact["reason"],
        deviceId: String(row["origin_device_id"]), deviceLabel: typeof row["label"] === "string" ? row["label"] : null, actorName: typeof row["name"] === "string" ? row["name"] : null, occurredAt: String(row["occurred_at"]) }));
  });
}

/**
 * Owner explicitly approves the exact signed business fact held back for stale/revoked authority, a revoked device's
 * late history (ADR-040) or a return that raced another (ADR-041). Each approval covers only its reason, so a fact may
 * need another one for the next check; every other strict check still applies and malformed data still fails.
 */
export function reviewQuarantinedEvent(context: OperationContext, eventId: string, digest: string): EventOutcome {
  authorizedOperation(context,["business.settings","users.manage"],(_database,tx,ports,revision) => {
    requireOwner(tx,context);
    const row = tx.get(`SELECT e.event_type,s.digest,a.status,a.reason FROM event_journal e JOIN event_signatures s ON s.event_id=e.event_id JOIN applied_events a ON a.event_id=e.event_id WHERE e.business_id=? AND e.event_id=?`,[context.businessId,eventId]);
    const reason = String(row?.["reason"]);
    if (row === undefined || row["digest"] !== digest || row["status"] !== "quarantined" || !(REVIEWABLE_REASONS as readonly string[]).includes(reason) || AUTHORITY_TYPES.test(String(row["event_type"]))) throw new ExchangeError("permission_denied");
    if (reason === "device_revoked" || reason === "return_conflict") tx.run(`INSERT INTO event_exception_reviews(event_id,kind,business_id,reviewer_id,digest,reviewed_at) VALUES (?,?,?,?,?,?)`,[eventId,reason,context.businessId,context.userId,digest,timestamp(ports)]);
    else tx.run(`INSERT INTO event_reviews(event_id,reviewer_id,business_id,digest,reviewed_at) VALUES (?,?,?,?,?)`,[eventId,context.userId,context.businessId,digest,timestamp(ports)]);
    tx.run(`UPDATE applied_events SET status='stored',reason=NULL WHERE event_id=?`,[eventId]);
    appendLocalAudit(tx,context,ports,revision,"EXCHANGE_EVENT_REVIEWED",eventId,{ digest, reason });
  });
  return applyStored(context,eventId);
}
