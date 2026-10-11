import { randomBytes, randomUUIDv7 } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { canonicalJson } from "@kolo/contracts/canonical";
import { parseEventPayload, type JournalEnvelope, type SignedJournalEvent } from "@kolo/contracts/events";
import { MAX_JOURNAL_BATCH_BYTES, eventSigningMessage, receiptSigningMessage, type PeerReceipt, type SignedPeerReceipt } from "@kolo/contracts/delivery";
import { enrollmentSigningMessage, isClearEventType, sessionSigningMessage, syncBatchSigningMessage, PULL_MAX_LIMIT, type Challenge, type ChallengeRequest, type EnrollmentRequest,
  type PullResponse, type PushResponse, type PushResult, type SealedEvent, type Session, type SessionRequest, type SignedSyncBatch, type SyncBatch, type SyncEvent, type SyncStatus } from "@kolo/contracts/sync";
import type { ServerDatabase } from "../database.js";
import { sha256, verifySignature, type ServerKey } from "../identity.js";
import { entitlementOf, recordPayment, type Edition } from "../billing.js";

/** Stable HTTP failure; the code is the whole client-visible explanation. */
export class RelayError extends Error {
  readonly status: number; readonly code: string; readonly retry: boolean | undefined;
  constructor(status: number, code: string, retry?: boolean) { super(code); this.name = "RelayError"; this.status = status; this.code = code; this.retry = retry; }
}

/** The authenticated network scope. Tenant and device always come from here, never from a request body. */
export interface Scope { readonly businessId: string; readonly deviceId: string; }

/** Shared relay dependencies. */
export interface Relay {
  readonly db: Kysely<ServerDatabase>;
  readonly key: ServerKey;
  readonly sessionTtlSeconds: number;
  readonly now: () => Date;
  /** Self-hosted by default; hosted shops sync while paid (ADR-031). */
  readonly edition?: Edition;
}
const SELF_HOSTED: Edition = { edition: "selfhost", graceDays: 0 };

const CHALLENGE_SECONDS = 120;
const ROSTER_TYPES = new Set(["DEVICE_TRUSTED", "DEVICE_REVOKED"]);

/** Issues a single-use challenge. It reveals nothing about whether the shop or device is known. */
export async function createChallenge(relay: Relay, input: ChallengeRequest): Promise<Challenge> {
  const now = relay.now(), challenge = { challenge_id: randomUUIDv7(), nonce: randomBytes(32).toString("hex"), expires_at: new Date(now.getTime() + CHALLENGE_SECONDS * 1000) };
  await relay.db.deleteFrom("challenges").where("expires_at", "<", now).execute();
  await relay.db.insertInto("challenges").values({ ...challenge, purpose: input.purpose, business_id: input.business_id, device_id: input.device_id, used_at: null }).execute();
  return { challenge_id: challenge.challenge_id, nonce: challenge.nonce, expires_at: challenge.expires_at.toISOString() };
}

async function consumeChallenge(tx: Transaction<ServerDatabase>, relay: Relay, purpose: "enrollment" | "session", claim: { challenge_id: string; nonce: string; server_device_id: string }, businessId: string, deviceId: string): Promise<void> {
  if (claim.server_device_id !== relay.key.deviceId) throw new RelayError(400, "invalid_request", false);
  const used = await tx.updateTable("challenges").set({ used_at: relay.now() })
    .where("challenge_id", "=", claim.challenge_id).where("purpose", "=", purpose).where("nonce", "=", claim.nonce)
    .where("business_id", "=", businessId).where("device_id", "=", deviceId).where("used_at", "is", null).where("expires_at", ">", relay.now())
    .executeTakeFirst();
  if (used.numUpdatedRows !== 1n) throw new RelayError(401, "invalid_challenge", false);
}

/** A suspended or removed shop keeps its data but may not sync; its tills keep trading locally. */
function requireActiveShop(status: string): void {
  if (status === "suspended") throw new RelayError(403, "shop_suspended", false);
  if (status !== "active") throw new RelayError(403, "shop_removed", false);
}

/**
 * Attaches an existing local shop, keeping its IDs. The claim must be signed by the device key it names, and a new
 * shop needs an unused, unexpired, uncancelled single-use connection code, which is consumed in the same transaction.
 * Re-enrolling from the same authority device is idempotent and needs no code, so a lost response is harmless; any
 * other device claiming an enrolled shop is a conflict for the owner to resolve.
 */
export async function enroll(relay: Relay, input: EnrollmentRequest): Promise<void> {
  const { claim } = input;
  if (!verifySignature(claim.device.public_key, enrollmentSigningMessage(claim), input.signature)) throw new RelayError(401, "invalid_signature", false);
  await relay.db.transaction().execute(async tx => {
    await consumeChallenge(tx, relay, "enrollment", claim, claim.business.id, claim.device.id);
    const shop = await tx.selectFrom("shops").selectAll().where("business_id", "=", claim.business.id).forUpdate().executeTakeFirst();
    if (shop !== undefined) {
      const device = await tx.selectFrom("shop_devices").selectAll().where("business_id", "=", claim.business.id).where("device_id", "=", claim.device.id).executeTakeFirst();
      if (shop.owner_id !== claim.owner_id || device === undefined || !device.active || !device.authority_allowed || device.public_key !== claim.device.public_key) throw new RelayError(409, "enrollment_conflict", false);
      requireActiveShop(shop.status);
      return;
    }
    if (input.connection_code === undefined) throw new RelayError(403, "invalid_connection_code", false);
    const code = await tx.selectFrom("connection_codes").selectAll().where("token_hash", "=", sha256(input.connection_code)).forUpdate().executeTakeFirst();
    if (code === undefined || code.cancelled_at !== null) throw new RelayError(403, "invalid_connection_code", false);
    if (code.used_at !== null) throw new RelayError(403, "connection_code_used", false);
    if (code.expires_at <= relay.now()) throw new RelayError(403, "connection_code_expired", false);
    await tx.insertInto("shops").values({ business_id: claim.business.id, name: claim.business.name, owner_id: claim.owner_id, enrolled_by: claim.device.id,
      status_changed_at: null, remove_after: null, connection_code_id: code.code_id }).execute();
    await tx.insertInto("shop_devices").values({ business_id: claim.business.id, device_id: claim.device.id, public_key: claim.device.public_key,
      label: claim.device.label, platform: claim.device.platform, authority_allowed: true, active: true, last_seen_at: null }).execute();
    await tx.updateTable("connection_codes").set({ used_at: relay.now(), used_by: claim.business.id }).where("code_id", "=", code.code_id).execute();
    // A code issued after payment carries the paid months, so the shop syncs from its first pass.
    if ((relay.edition ?? SELF_HOSTED).edition === "hosted" && code.included_months > 0)
      await recordPayment(tx, { shopId: claim.business.id, months: code.included_months, amountMinor: 0, method: "other", reference: `code: ${code.label}`, source: "code", recordedBy: code.created_by }, relay.now());
  });
}

/** This shop's hosted service status; available to a signed-in till even when sync is paused, so it can say why. */
export async function entitlement(relay: Relay, scope: Scope) {
  const shop = await relay.db.selectFrom("shops").select("paid_until").where("business_id", "=", scope.businessId).executeTakeFirstOrThrow();
  return entitlementOf(relay.edition ?? SELF_HOSTED, shop.paid_until, relay.now());
}

/**
 * Refuses data transfer for a hosted shop whose paid period and grace have ended. Its facts stay stored, its tills keep
 * trading, and everything waiting flows again once a payment is recorded.
 */
export async function requireService(relay: Relay, scope: Scope): Promise<void> {
  if ((relay.edition ?? SELF_HOSTED).edition !== "hosted") return;
  if ((await entitlement(relay, scope)).status === "inactive") throw new RelayError(403, "hosted_service_inactive", false);
}

/** Exchanges a signed challenge from an active device key for a short bearer token, stored only as a hash. */
export async function openSession(relay: Relay, input: SessionRequest): Promise<Session> {
  const { claim } = input;
  return relay.db.transaction().execute(async tx => {
    const device = await tx.selectFrom("shop_devices as d").innerJoin("shops as s", "s.business_id", "d.business_id").select(["d.public_key", "d.active", "d.platform", "s.status"])
      .where("d.business_id", "=", claim.business_id).where("d.device_id", "=", claim.device_id).executeTakeFirst();
    // Unknown, revoked and server keys are indistinguishable to the caller.
    if (device === undefined || !device.active || device.platform === "SERVER" || !verifySignature(device.public_key, sessionSigningMessage(claim), input.signature)) throw new RelayError(401, "invalid_session", false);
    requireActiveShop(device.status);
    await consumeChallenge(tx, relay, "session", claim, claim.business_id, claim.device_id);
    await tx.updateTable("shop_devices").set({ last_seen_at: relay.now() }).where("business_id", "=", claim.business_id).where("device_id", "=", claim.device_id).execute();
    const token = randomBytes(32).toString("base64url"), expires = new Date(relay.now().getTime() + relay.sessionTtlSeconds * 1000);
    await tx.deleteFrom("sessions").where("expires_at", "<", relay.now()).execute();
    await tx.insertInto("sessions").values({ token_hash: sha256(token), business_id: claim.business_id, device_id: claim.device_id, expires_at: expires }).execute();
    return { token, expires_at: expires.toISOString(), business_id: claim.business_id, device_id: claim.device_id, server_device_id: relay.key.deviceId };
  });
}

/** Resolves a bearer token to its scope; a revoked device loses access on its next request. */
export async function authenticate(relay: Relay, header: string | undefined): Promise<Scope> {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "");
  if (match === null) throw new RelayError(401, "invalid_session", false);
  const row = await relay.db.selectFrom("sessions as s").innerJoin("shop_devices as d", join => join.onRef("d.business_id", "=", "s.business_id").onRef("d.device_id", "=", "s.device_id"))
    .innerJoin("shops as h", "h.business_id", "s.business_id")
    .select(["s.business_id", "s.device_id", "h.status"]).where("s.token_hash", "=", sha256(match[1]!)).where("s.expires_at", ">", relay.now()).where("d.active", "=", true).executeTakeFirst();
  if (row === undefined) throw new RelayError(401, "invalid_session", false);
  requireActiveShop(row.status); // Suspension takes effect on the next request, like revocation.
  return { businessId: row.business_id, deviceId: row.device_id };
}

/** Ends a network session; idempotent. Local history is untouched. */
export async function endSession(relay: Relay, header: string | undefined): Promise<void> {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "");
  if (match !== null) await relay.db.deleteFrom("sessions").where("token_hash", "=", sha256(match[1]!)).execute();
}

type Pin = { public_key: string; authority_allowed: boolean; active: boolean };
/** The key the shop's roster holds for a device. Callers decide whether a revoked key still counts. */
async function pinOf(db: Kysely<ServerDatabase> | Transaction<ServerDatabase>, scope: Scope | { businessId: string }, deviceId: string, includeRevoked = false): Promise<Pin | undefined> {
  const pin = await db.selectFrom("shop_devices").select(["public_key", "authority_allowed", "active"]).where("business_id", "=", scope.businessId).where("device_id", "=", deviceId).executeTakeFirst();
  return pin !== undefined && (pin.active || includeRevoked) ? pin : undefined;
}

function verifyProof(event: SignedJournalEvent, publicKey: string): boolean {
  let message: string;
  try { message = eventSigningMessage(event.envelope); } catch { return false; }
  return sha256(message) === event.digest && verifySignature(publicKey, message, event.signature);
}

/** The roster subject and revision an owner-signed trust fact carries, or undefined for any other fact. */
function rosterOf(envelope: JournalEnvelope, ownerId: string, origin: Pin): { subject: string; revision: number } | undefined {
  if (!ROSTER_TYPES.has(envelope.event_type) || envelope.actor_id !== ownerId || !origin.active || !origin.authority_allowed || !envelope.required_permissions.includes("users.manage")) return undefined;
  try {
    if (envelope.event_type === "DEVICE_TRUSTED") { const fact = parseEventPayload("DEVICE_TRUSTED", envelope.event_version, envelope.payload); return { subject: fact.device.id, revision: fact.revision }; }
    const fact = parseEventPayload("DEVICE_REVOKED", envelope.event_version, envelope.payload); return { subject: fact.device_id, revision: fact.revision };
  } catch { return undefined; }
}

/**
 * Recomputes one device's trust from every owner-signed roster fact received for it: the highest revision
 * wins regardless of arrival order. A key never changes for a device ID; such a fact is ignored.
 */
async function refreshRoster(tx: Transaction<ServerDatabase>, businessId: string, subject: string): Promise<void> {
  const rows = await tx.selectFrom("journal").select(["event_type", "canonical", "roster_revision"]).where("business_id", "=", businessId).where("subject_device_id", "=", subject)
    .where("canonical", "is not", null).orderBy("roster_revision", "desc").orderBy("seq", "asc").execute();
  const current = await tx.selectFrom("shop_devices").selectAll().where("business_id", "=", businessId).where("device_id", "=", subject).forUpdate().executeTakeFirst();
  const facts = rows.map(row => ({ revision: BigInt(row.roster_revision!), trust: row.event_type === "DEVICE_TRUSTED" ? parseEventPayload("DEVICE_TRUSTED", 2, (JSON.parse(row.canonical!) as JournalEnvelope).payload) : undefined }));
  // A device ID keeps one key: the one already held, else the first one trusted. Facts naming another key are ignored.
  const key = current?.public_key ?? [...facts].reverse().find(fact => fact.trust !== undefined)?.trust!.device.public_key;
  const valid = facts.filter(fact => fact.trust === undefined || fact.trust.device.public_key === key);
  const latest = valid[0], device = valid.find(fact => fact.trust !== undefined)?.trust;
  if (latest === undefined || key === undefined) return;
  if (current === undefined) {
    if (device === undefined) return; // A revocation for a key never seen here changes nothing.
    await tx.insertInto("shop_devices").values({ business_id: businessId, device_id: subject, public_key: key, label: device.device.label, platform: device.device.platform,
      authority_allowed: latest.trust?.authority_allowed ?? false, active: latest.trust !== undefined, roster_revision: String(latest.revision) }).execute();
    return;
  }
  if (latest.revision <= BigInt(current.roster_revision)) return;
  await tx.updateTable("shop_devices").set({ active: latest.trust !== undefined, authority_allowed: latest.trust?.authority_allowed ?? current.authority_allowed,
    roster_revision: String(latest.revision), updated_at: new Date() }).where("business_id", "=", businessId).where("device_id", "=", subject).execute();
}

/**
 * Stores each fact durably and answers per event. Clear facts (trust, keys, server address) are verified against their
 * origin's key; sealed facts are accepted from the authenticated, batch-signing sender for any origin the shop's roster
 * knows, since only tills can open them and check their inner proof (ADR-030). Plain business facts are refused.
 * Unknown origins are retried within the batch, since an owner-signed trust fact may precede them in any order.
 * A signed receipt acknowledges exactly the stored and duplicate digests; nothing is applied to business tables here.
 */
export async function push(relay: Relay, scope: Scope, signed: SignedSyncBatch): Promise<PushResponse> {
  const { batch } = signed;
  if (batch.business_id !== scope.businessId || batch.sender_device_id !== scope.deviceId) throw new RelayError(403, "permission_denied", false);
  if (batch.receiver_device_id !== relay.key.deviceId) throw new RelayError(400, "invalid_request", false);
  const sender = await pinOf(relay.db, scope, scope.deviceId);
  let message: string;
  try { message = syncBatchSigningMessage(batch); } catch { throw new RelayError(400, "invalid_request", false); }
  if (sender === undefined || sha256(message) !== signed.digest || !verifySignature(sender.public_key, message, signed.signature)) throw new RelayError(401, "invalid_signature", false);
  const previous = await relay.db.selectFrom("push_batches").select("digest").where("business_id", "=", scope.businessId).where("batch_id", "=", batch.batch_id).executeTakeFirst();
  if (previous !== undefined && previous.digest !== signed.digest) throw new RelayError(409, "batch_conflict", false);
  if (previous === undefined) await relay.db.insertInto("push_batches").values({ business_id: scope.businessId, batch_id: batch.batch_id, sender_device_id: scope.deviceId, digest: signed.digest }).onConflict(conflict => conflict.doNothing()).execute();
  const shop = await relay.db.selectFrom("shops").select("owner_id").where("business_id", "=", scope.businessId).executeTakeFirstOrThrow();

  const results = new Map<number, PushResult>();
  for (let progress = true; progress;) {
    progress = false;
    for (const [index, event] of batch.events.entries()) {
      const prior = results.get(index);
      if (prior !== undefined && prior.code !== "untrusted_device") continue;
      const result = await storeEvent(relay, scope, shop.owner_id, event);
      results.set(index, result);
      if (result.code !== "untrusted_device") progress = true;
    }
  }
  const ordered = batch.events.map((_event, index) => results.get(index)!);
  const accepted = batch.events.filter((_event, index) => ordered[index]!.status !== "rejected").map(identityOf);
  let receipt: SignedPeerReceipt | null = null;
  if (accepted.length > 0) {
    const body: PeerReceipt = { format: "kolo.receipt", format_version: 1, receipt_id: randomUUIDv7(), business_id: scope.businessId, sender_device_id: scope.deviceId,
      receiver_device_id: relay.key.deviceId, batch_id: batch.batch_id, created_at: relay.now().toISOString(),
      entries: accepted.map(event => ({ event_id: event.eventId, digest: event.digest, state: "stored" as const })) };
    const signedMessage = receiptSigningMessage(body);
    receipt = { receipt: body, digest: sha256(signedMessage), signature: relay.key.sign(signedMessage) };
  }
  return { results: ordered, receipt };
}

/** Identity and inner digest of a wire fact, whether clear or sealed. */
function identityOf(event: SyncEvent): { eventId: string; originDeviceId: string; originSequence: number; digest: string } {
  if ("clear" in event) { const e = event.clear.envelope; return { eventId: e.event_id, originDeviceId: e.origin_device_id, originSequence: e.origin_sequence, digest: event.clear.digest }; }
  return { eventId: event.sealed.event_id, originDeviceId: event.sealed.origin_device_id, originSequence: event.sealed.origin_sequence, digest: event.sealed.digest };
}

async function storeEvent(relay: Relay, scope: Scope, ownerId: string, item: SyncEvent): Promise<PushResult> {
  const id = identityOf(item), eventId = id.eventId;
  let row: { canonical: string | null; signature: string | null; sealed: string | null; event_type: string | null; event_version: number | null };
  let roster: { subject: string; revision: number } | undefined;
  // A revoked key still proves what it signed: each till decides whether it accepts that history.
  const origin = await pinOf(relay.db, scope, id.originDeviceId, true);
  if ("clear" in item) {
    const event = item.clear, e = event.envelope;
    if (!isClearEventType(e.event_type)) return { event_id: eventId, status: "rejected", code: "plaintext_refused", retry: false };
    if (e.business_id !== scope.businessId) return { event_id: eventId, status: "rejected", code: "scope_mismatch", retry: false };
    if (origin === undefined) return { event_id: eventId, status: "rejected", code: "untrusted_device", retry: true };
    if (!verifyProof(event, origin.public_key)) return { event_id: eventId, status: "rejected", code: "invalid_signature", retry: false };
    row = { canonical: canonicalJson(e), signature: event.signature, sealed: null, event_type: e.event_type, event_version: e.event_version };
    roster = rosterOf(e, ownerId, origin);
  } else {
    if (origin === undefined) return { event_id: eventId, status: "rejected", code: "untrusted_device", retry: true };
    row = { canonical: null, signature: null, sealed: JSON.stringify(item.sealed), event_type: null, event_version: null };
  }
  return relay.db.transaction().execute(async tx => {
    const inserted = await tx.insertInto("journal").values({ business_id: scope.businessId, event_id: eventId, origin_device_id: id.originDeviceId,
      origin_sequence: String(id.originSequence), ...row, digest: id.digest,
      subject_device_id: roster?.subject ?? null, roster_revision: roster === undefined ? null : String(roster.revision), received_from: scope.deviceId })
      .onConflict(conflict => conflict.doNothing()).executeTakeFirst();
    if (inserted.numInsertedOrUpdatedRows !== 1n) {
      const existing = await tx.selectFrom("journal").select(["event_id", "digest"]).where("business_id", "=", scope.businessId)
        .where(where => where.or([where("event_id", "=", eventId), where.and([where("origin_device_id", "=", id.originDeviceId), where("origin_sequence", "=", String(id.originSequence))])]))
        .executeTakeFirst();
      // The same signed fact sealed again (another key or nonce) is still the same fact.
      if (existing !== undefined && existing.event_id === eventId && existing.digest === id.digest) {
        await markDelivered(tx, scope, eventId);
        return { event_id: eventId, status: "duplicate" } satisfies PushResult;
      }
      // Same identity with different content: keep both, overwrite nothing, and make it visible.
      await tx.insertInto("journal_conflicts").values({ business_id: scope.businessId, event_id: eventId, digest: id.digest, canonical: row.canonical, signature: row.signature, sealed: row.sealed, received_from: scope.deviceId })
        .onConflict(conflict => conflict.doNothing()).execute();
      return { event_id: eventId, status: "rejected", code: "event_identity_conflict", retry: false } satisfies PushResult;
    }
    await markDelivered(tx, scope, eventId);
    if (roster !== undefined) await refreshRoster(tx, scope.businessId, roster.subject);
    return { event_id: eventId, status: "stored" } satisfies PushResult;
  });
}

/** jsonb comes back parsed from the driver; accept either form. */
function sealedOf(value: unknown): SealedEvent { return (typeof value === "string" ? JSON.parse(value) : value) as SealedEvent; }

// The device that handed us a fact already has it; never echo it back on pull.
async function markDelivered(tx: Transaction<ServerDatabase>, scope: Scope, eventId: string): Promise<void> {
  await tx.insertInto("deliveries").values({ business_id: scope.businessId, device_id: scope.deviceId, event_id: eventId, state: "stored" }).onConflict(conflict => conflict.doNothing()).execute();
}

function encodeCursor(scope: Scope, seq: string): string { return Buffer.from(`${scope.deviceId}:${seq}`, "utf8").toString("base64url"); }
function decodeCursor(scope: Scope, cursor: string | undefined): string {
  if (cursor === undefined) return "0";
  const text = /^[A-Za-z0-9_-]{1,200}$/.test(cursor) ? Buffer.from(cursor, "base64url").toString("utf8") : "";
  const match = /^([0-9a-f-]{36}):(\d{1,19})$/.exec(text);
  if (match === null || match[1] !== scope.deviceId) throw new RelayError(400, "invalid_cursor", false);
  return match[2]!;
}

/**
 * A bounded, server-signed page of facts this device has not acknowledged, oldest first, with every
 * original proof intact. The cursor only pages within one pass; unacknowledged facts are offered again
 * on the next pass from the start, so a fact skipped by the device is never lost behind a cursor.
 */
export async function pull(relay: Relay, scope: Scope, cursor: string | undefined, limit: number): Promise<PullResponse> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PULL_MAX_LIMIT) throw new RelayError(400, "invalid_request", false);
  const after = decodeCursor(scope, cursor);
  const rows = await relay.db.selectFrom("journal as j").select(["j.seq", "j.event_id", "j.canonical", "j.digest", "j.signature", "j.sealed"])
    .innerJoin("shop_devices as o", join => join.onRef("o.business_id", "=", "j.business_id").onRef("o.device_id", "=", "j.origin_device_id"))
    .where("j.business_id", "=", scope.businessId).where("j.origin_device_id", "<>", scope.deviceId).where("j.seq", ">", after).where("o.active", "=", true)
    .where(where => where.not(where.exists(where.selectFrom("deliveries as d").select(sql`1`.as("one"))
      .whereRef("d.business_id", "=", "j.business_id").whereRef("d.event_id", "=", "j.event_id").where("d.device_id", "=", scope.deviceId))))
    .orderBy("j.seq").limit(limit + 1).execute();
  const page = rows.slice(0, limit), events: SyncEvent[] = page.map(row => row.sealed !== null ? { sealed: sealedOf(row.sealed) }
    : { clear: { envelope: JSON.parse(row.canonical!) as JournalEnvelope, digest: row.digest, signature: row.signature! } });
  if (events.length === 0) return { batch: null, cursor: null, has_more: false };
  const batch: SyncBatch = { format: "kolo.sync-batch", format_version: 1, batch_id: randomUUIDv7(), business_id: scope.businessId, sender_device_id: relay.key.deviceId,
    receiver_device_id: scope.deviceId, created_at: relay.now().toISOString(), events };
  // Fit complete facts under the container limit; the remainder comes on the next page.
  for (;;) { try { canonicalJson(batch, MAX_JOURNAL_BATCH_BYTES - 256); break; } catch { if (batch.events.length <= 1) throw new RelayError(500, "internal"); batch.events.pop(); } }
  const last = page[batch.events.length - 1]!.seq, message = syncBatchSigningMessage(batch);
  await relay.db.transaction().execute(async tx => {
    await tx.insertInto("offered_batches").values({ business_id: scope.businessId, batch_id: batch.batch_id, device_id: scope.deviceId, created_at: relay.now() }).execute();
    await tx.insertInto("offered_batch_events").values(page.slice(0, batch.events.length).map(row => ({ business_id: scope.businessId, batch_id: batch.batch_id, event_id: row.event_id, digest: row.digest }))).execute();
  });
  return { batch: { batch, digest: sha256(message), signature: relay.key.sign(message) }, cursor: encodeCursor(scope, last), has_more: rows.length > batch.events.length };
}

/** Owner-signed trust facts, so a device can trust the server's key before verifying a server-signed page. */
export async function bootstrap(relay: Relay, scope: Scope): Promise<{ events: SignedJournalEvent[] }> {
  const rows = await relay.db.selectFrom("journal").select(["canonical", "digest", "signature"]).where("business_id", "=", scope.businessId)
    .where("subject_device_id", "is not", null).orderBy("seq").limit(1000).execute();
  return { events: rows.map(row => ({ envelope: JSON.parse(row.canonical!) as JournalEnvelope, digest: row.digest, signature: row.signature! })) };
}

/** Records a device's signed acknowledgment of one offered page; applied never downgrades. Idempotent per receipt. */
export async function acceptReceipt(relay: Relay, scope: Scope, signed: SignedPeerReceipt): Promise<number> {
  const { receipt } = signed;
  if (receipt.business_id !== scope.businessId || receipt.receiver_device_id !== scope.deviceId || receipt.sender_device_id !== relay.key.deviceId) throw new RelayError(403, "permission_denied", false);
  const device = await pinOf(relay.db, scope, scope.deviceId), canonical = canonicalJson(receipt, MAX_JOURNAL_BATCH_BYTES), message = receiptSigningMessage(receipt);
  if (device === undefined || sha256(message) !== signed.digest || !verifySignature(device.public_key, message, signed.signature)) throw new RelayError(401, "invalid_signature", false);
  return relay.db.transaction().execute(async tx => {
    const old = await tx.selectFrom("receipts").select(["digest", "canonical", "signature"]).where("business_id", "=", scope.businessId).where("receipt_id", "=", receipt.receipt_id).executeTakeFirst();
    if (old !== undefined) { if (old.digest !== signed.digest || old.canonical !== canonical || old.signature !== signed.signature) throw new RelayError(409, "receipt_conflict", false); return 0; }
    const offered = await tx.selectFrom("offered_batches").select("batch_id").where("business_id", "=", scope.businessId).where("batch_id", "=", receipt.batch_id).where("device_id", "=", scope.deviceId).executeTakeFirst();
    if (offered === undefined) throw new RelayError(400, "invalid_receipt", false);
    const covered = await tx.selectFrom("offered_batch_events").select(["event_id", "digest"]).where("business_id", "=", scope.businessId).where("batch_id", "=", receipt.batch_id).execute();
    const digests = new Map(covered.map(row => [row.event_id, row.digest]));
    if (!receipt.entries.every(entry => digests.get(entry.event_id) === entry.digest)) throw new RelayError(400, "invalid_receipt", false);
    await tx.insertInto("receipts").values({ business_id: scope.businessId, receipt_id: receipt.receipt_id, device_id: scope.deviceId, digest: signed.digest, canonical, signature: signed.signature }).execute();
    let changed = 0;
    for (const entry of receipt.entries) {
      const result = await tx.insertInto("deliveries").values({ business_id: scope.businessId, device_id: scope.deviceId, event_id: entry.event_id, state: entry.state })
        .onConflict(conflict => conflict.columns(["business_id", "device_id", "event_id"]).doUpdateSet({ state: entry.state, updated_at: relay.now() }).where("deliveries.state", "<>", "applied"))
        .executeTakeFirst();
      changed += Number(result.numInsertedOrUpdatedRows ?? 0n);
    }
    return changed;
  });
}

/** This device's backlog and the shop's visible conflicts. */
export async function status(relay: Relay, scope: Scope): Promise<SyncStatus> {
  const count = (value: unknown): number => Number(value);
  const [pending, delivered, conflicts, devices] = await Promise.all([
    relay.db.selectFrom("journal as j").innerJoin("shop_devices as o", join => join.onRef("o.business_id", "=", "j.business_id").onRef("o.device_id", "=", "j.origin_device_id"))
      .select(eb => eb.fn.countAll().as("n")).where("j.business_id", "=", scope.businessId).where("j.origin_device_id", "<>", scope.deviceId).where("o.active", "=", true)
      .where(where => where.not(where.exists(where.selectFrom("deliveries as d").select(sql`1`.as("one")).whereRef("d.business_id", "=", "j.business_id").whereRef("d.event_id", "=", "j.event_id").where("d.device_id", "=", scope.deviceId))))
      .executeTakeFirstOrThrow(),
    relay.db.selectFrom("deliveries").select(eb => eb.fn.countAll().as("n")).where("business_id", "=", scope.businessId).where("device_id", "=", scope.deviceId).executeTakeFirstOrThrow(),
    relay.db.selectFrom("journal_conflicts").select(eb => eb.fn.countAll().as("n")).where("business_id", "=", scope.businessId).executeTakeFirstOrThrow(),
    relay.db.selectFrom("shop_devices").select(eb => eb.fn.countAll().as("n")).where("business_id", "=", scope.businessId).where("active", "=", true).executeTakeFirstOrThrow(),
  ]);
  return { pending: count(pending.n), delivered: count(delivered.n), conflicts: count(conflicts.n), devices: count(devices.n) };
}
