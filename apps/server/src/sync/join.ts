import { canonicalJson } from "@kolo/contracts/canonical";
import type { JoinEnrollment, JoinOffer, JoinRequestBody } from "@kolo/contracts/sync";
import { sha256, verifySignature } from "../identity.js";
import { RelayError, type Relay, type Scope } from "./relay.js";
import { hasPlace, tillPlace } from "./tills.js";

/** A full shop refuses a join before the new till is set up (ADR-039); file and local pairing are held instead. */
async function requirePlace(relay: Relay, scope: Scope): Promise<void> {
  if (!hasPlace(await tillPlace(relay.db, scope.businessId))) throw new RelayError(403, "till_limit_reached", false);
}

/** How long a code works, and how long an approved mailbox waits for the new till to fetch its shop. */
const OFFER_MINUTES = 10, ACTIVE_PER_SHOP = 3;
const minutes = (relay: Relay, count: number): Date => new Date(relay.now().getTime() + count * 60_000);
const parsed = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

async function live(relay: Relay, joinId: string) {
  const row = await relay.db.selectFrom("join_sessions").selectAll().where("join_id", "=", joinId).where("expires_at", ">", relay.now()).executeTakeFirst();
  if (row === undefined) throw new RelayError(404, "join_not_found", false);
  return row;
}
async function owned(relay: Relay, scope: Scope, joinId: string) {
  const row = await live(relay, joinId);
  if (row.business_id !== scope.businessId || row.owner_device_id !== scope.deviceId) throw new RelayError(404, "join_not_found", false);
  return row;
}

/**
 * Opens a mailbox for one join code (ADR-032). Only a shop's active authority till may, and the invite must be signed
 * by that till's own key for this shop, so a mailbox can never offer another shop or another till's invitation.
 */
export async function createJoin(relay: Relay, scope: Scope, offer: JoinOffer): Promise<{ expires_at: string }> {
  const device = await relay.db.selectFrom("shop_devices").select(["public_key", "authority_allowed", "active"]).where("business_id", "=", scope.businessId).where("device_id", "=", scope.deviceId).executeTakeFirst();
  if (device === undefined || !device.active || !device.authority_allowed) throw new RelayError(403, "permission_denied", false);
  const invite = offer.invite.invite, message = `kolo.pairing-invite.v1\u0000${canonicalJson(invite)}`;
  if (invite.business_id !== scope.businessId || invite.source_device_id !== scope.deviceId || invite.source_public_key !== device.public_key ||
    sha256(message) !== offer.invite.digest || !verifySignature(device.public_key, message, offer.invite.signature)) throw new RelayError(400, "invalid_request", false);
  await requirePlace(relay, scope);
  const expires = minutes(relay, OFFER_MINUTES);
  await relay.db.transaction().execute(async tx => {
    await tx.deleteFrom("join_sessions").where("expires_at", "<=", relay.now()).execute();
    const active = await tx.selectFrom("join_sessions").select(eb => eb.fn.countAll().as("n")).where("business_id", "=", scope.businessId).executeTakeFirstOrThrow();
    if (Number(active.n) >= ACTIVE_PER_SHOP) throw new RelayError(429, "too_many_joins", true);
    const inserted = await tx.insertInto("join_sessions").values({ join_id: offer.join_id, business_id: scope.businessId, owner_device_id: scope.deviceId, offer: JSON.stringify(offer),
      request: null, enrollment: null, sealed_password: null, expires_at: expires }).onConflict(conflict => conflict.doNothing()).executeTakeFirst();
    if (inserted.numInsertedOrUpdatedRows !== 1n) throw new RelayError(409, "join_conflict", false);
  });
  return { expires_at: expires.toISOString() };
}

/** The offer for a code's hash; anyone may read it, and only someone holding the code can check or use it. */
export async function readJoin(relay: Relay, joinId: string): Promise<JoinOffer> { return parsed<JoinOffer>((await live(relay, joinId)).offer); }

/** Stores the new till's request once; repeating the same request is harmless, a different one is refused. */
export async function requestJoin(relay: Relay, joinId: string, body: JoinRequestBody): Promise<void> {
  const row = await live(relay, joinId), offer = parsed<JoinOffer>(row.offer);
  if (body.request.request.invite.digest !== offer.invite.digest) throw new RelayError(400, "invalid_request", false);
  if (row.request !== null) { if (canonicalJson(parsed(row.request)) !== canonicalJson(body)) throw new RelayError(409, "join_conflict", false); return; }
  const changed = await relay.db.updateTable("join_sessions").set({ request: JSON.stringify(body) }).where("join_id", "=", joinId).where("request", "is", null).executeTakeFirst();
  if (changed.numUpdatedRows !== 1n) throw new RelayError(409, "join_conflict", false);
}

/** The owner's till polls for the request. */
export async function joinRequestOf(relay: Relay, scope: Scope, joinId: string): Promise<JoinRequestBody | null> {
  const row = await owned(relay, scope, joinId);
  return row.request === null ? null : parsed<JoinRequestBody>(row.request);
}

/** The owner's approval: the encrypted shop file and its sealed password. The mailbox then waits ten more minutes. */
export async function enrollJoin(relay: Relay, scope: Scope, joinId: string, body: JoinEnrollment): Promise<void> {
  const row = await owned(relay, scope, joinId);
  if (row.request === null) throw new RelayError(409, "join_not_requested", false);
  if (row.enrollment !== null) { if (row.enrollment !== body.enrollment) throw new RelayError(409, "join_conflict", false); return; }
  await requirePlace(relay, scope);
  await relay.db.updateTable("join_sessions").set({ enrollment: body.enrollment, sealed_password: JSON.stringify({ sealed: body.sealed_password, mac: body.mac }), expires_at: minutes(relay, OFFER_MINUTES) })
    .where("join_id", "=", joinId).execute();
}

/** The new till fetches its shop once approved; null while the owner has not answered. */
export async function joinEnrollmentOf(relay: Relay, joinId: string): Promise<JoinEnrollment | null> {
  const row = await live(relay, joinId);
  if (row.enrollment === null || row.sealed_password === null) return null;
  const sealed = parsed<{ sealed: JoinEnrollment["sealed_password"]; mac: string }>(row.sealed_password);
  return { enrollment: row.enrollment, sealed_password: sealed.sealed, mac: sealed.mac };
}

/** The owner refuses or cancels; the new till then sees the code as gone. */
export async function cancelJoin(relay: Relay, scope: Scope, joinId: string): Promise<void> {
  await owned(relay, scope, joinId);
  await relay.db.deleteFrom("join_sessions").where("join_id", "=", joinId).execute();
}
