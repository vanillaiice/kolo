import { createHmac, randomUUIDv7, timingSafeEqual } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Entitlement } from "@kolo/contracts/sync";
import type { ServerDatabase } from "./database.js";

/** How this deployment bills: self-hosted servers never expire a shop. */
export interface Edition { readonly edition: "selfhost" | "hosted"; readonly graceDays: number }
/** Payment methods recorded by the operator or a provider. */
export type PaymentMethod = "cash" | "mtn_momo" | "orange_money" | "bank" | "card" | "other";
export const PAYMENT_METHODS: readonly PaymentMethod[] = ["cash", "mtn_momo", "orange_money", "bank", "card", "other"];

/** Stable billing refusal; the code is the whole client-visible explanation. */
export class BillingError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(code); this.name = "BillingError"; this.status = status; this.code = code; }
}

/**
 * Hosted service status for a paid-until date: `active` while paid, `grace` for `graceDays` after, then `inactive`.
 * A shop never paid for is `inactive`. Self-hosted shops are `unlimited`. Local trading never depends on any of it.
 */
export function entitlementOf(edition: Edition, paidUntil: Date | null, now: Date): Entitlement {
  if (edition.edition !== "hosted") return { edition: "selfhost", status: "unlimited", paid_until: null, grace_until: null };
  if (paidUntil === null) return { edition: "hosted", status: "inactive", paid_until: null, grace_until: null };
  const graceUntil = new Date(paidUntil.getTime() + edition.graceDays * 86_400_000);
  return { edition: "hosted", status: now < paidUntil ? "active" : now < graceUntil ? "grace" : "inactive", paid_until: paidUntil.toISOString(), grace_until: graceUntil.toISOString() };
}

/**
 * A payment to record: one plan per shop, so only the paid time matters for service. Manual and webhook payments are
 * whole months; a code payment may also, or only, carry days (a trial, ADR-039).
 */
export interface PaymentInput {
  readonly shopId: string; readonly months: number; readonly days?: number; readonly amountMinor: number; readonly method: PaymentMethod;
  readonly reference?: string | undefined; readonly source: "manual" | "webhook" | "code"; readonly externalId?: string | undefined; readonly recordedBy: string;
}
/** The stored effect of a payment: the paid-until date before and after it. */
export interface RecordedPayment { readonly paymentId: string; readonly paidUntilBefore: string | null; readonly paidUntilAfter: string; readonly duplicate: boolean }

/**
 * Records a payment and moves the shop's paid-until date forward by whole calendar months (then any days), from today
 * if it had lapsed or from its current end otherwise, in the caller's transaction. A repeated `externalId` (a provider retrying
 * its webhook) changes nothing and returns the original payment.
 */
export async function recordPayment(tx: Transaction<ServerDatabase>, input: PaymentInput, now: Date): Promise<RecordedPayment> {
  const days = input.days ?? 0;
  if (!Number.isInteger(days) || days < 0 || days > 90 || days > 0 && input.source !== "code") throw new BillingError(400, "invalid_days");
  if (!Number.isInteger(input.months) || input.months < (days > 0 ? 0 : 1) || input.months > 36) throw new BillingError(400, "invalid_months");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) throw new BillingError(400, "invalid_amount");
  if (!PAYMENT_METHODS.includes(input.method)) throw new BillingError(400, "invalid_method");
  const reference = input.reference?.trim() || null;
  if (reference !== null && reference.length > 120) throw new BillingError(400, "invalid_reference");
  // The shop row is locked before the replay check, so two deliveries of one payment at once are decided one after
  // the other and the second sees the first instead of failing on the unique external ID.
  const shop = await tx.selectFrom("shops").select(["paid_until", "status"]).where("business_id", "=", input.shopId).forUpdate().executeTakeFirst();
  if (input.externalId !== undefined) {
    const old = await tx.selectFrom("payments").selectAll().where("external_id", "=", input.externalId).executeTakeFirst();
    if (old !== undefined) {
      if (old.business_id !== input.shopId || old.months !== input.months) throw new BillingError(409, "payment_conflict");
      return { paymentId: old.payment_id, paidUntilBefore: old.paid_until_before?.toISOString() ?? null, paidUntilAfter: old.paid_until_after.toISOString(), duplicate: true };
    }
  }
  if (shop === undefined || shop.status === "removed") throw new BillingError(404, "not_found");
  const start = shop.paid_until !== null && shop.paid_until > now ? shop.paid_until : now;
  const { after } = (await sql<{ after: Date }>`SELECT (${start}::timestamptz + make_interval(months => ${input.months}::int, days => ${days}::int)) AS after`.execute(tx)).rows[0]!;
  const paymentId = randomUUIDv7();
  await tx.insertInto("payments").values({ payment_id: paymentId, business_id: input.shopId, months: input.months, days, amount_minor: String(input.amountMinor), currency: "XAF",
    method: input.method, reference, source: input.source, external_id: input.externalId ?? null, recorded_by: input.recordedBy.slice(0, 120), paid_until_before: shop.paid_until, paid_until_after: after }).execute();
  await tx.updateTable("shops").set({ paid_until: after }).where("business_id", "=", input.shopId).execute();
  return { paymentId, paidUntilBefore: shop.paid_until?.toISOString() ?? null, paidUntilAfter: new Date(after).toISOString(), duplicate: false };
}

/** A shop's payments, newest first. */
export async function listPayments(db: Kysely<ServerDatabase>, shopId: string) {
  const rows = await db.selectFrom("payments").selectAll().where("business_id", "=", shopId).orderBy("recorded_at", "desc").limit(200).execute();
  return rows.map(row => ({ paymentId: row.payment_id, months: row.months, days: row.days, amountMinor: Number(row.amount_minor), method: row.method, reference: row.reference, source: row.source,
    recordedBy: row.recorded_by, recordedAt: row.recorded_at.toISOString(), paidUntilAfter: row.paid_until_after.toISOString() }));
}

/**
 * A payment provider's webhook, reduced to what kolo needs. Each provider gets one adapter that verifies its own
 * signature scheme and maps its payload; nothing else in the server knows which provider is used.
 */
export interface BillingAdapter {
  readonly name: string;
  /** Returns the verified payment, or throws `BillingError` for a bad signature or payload. */
  verify(rawBody: string, headers: Readonly<Record<string, string | string[] | undefined>>, now: Date): Omit<PaymentInput, "source" | "recordedBy">;
}

/**
 * The provider-neutral adapter: `x-kolo-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` with the
 * shared secret, accepted within five minutes. Body: `{ event_id, shop_id, months, amount_minor, method, reference? }`.
 * A small relay in front of any provider (or the provider itself) can send this.
 */
export function genericWebhookAdapter(secret: string): BillingAdapter {
  return {
    name: "generic",
    verify(rawBody, headers, now) {
      const header = headers["x-kolo-signature"], value = Array.isArray(header) ? header[0] : header;
      const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(value ?? "");
      if (match === null) throw new BillingError(401, "invalid_signature");
      const timestamp = Number(match[1]);
      if (Math.abs(now.getTime() / 1000 - timestamp) > 300) throw new BillingError(401, "stale_signature");
      const expected = createHmac("sha256", secret).update(`${match[1]}.${rawBody}`, "utf8").digest();
      if (!timingSafeEqual(expected, Buffer.from(match[2]!, "hex"))) throw new BillingError(401, "invalid_signature");
      let body: Record<string, unknown>;
      try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { throw new BillingError(400, "invalid_payload"); }
      const text = (key: string, max: number): string | undefined => typeof body[key] === "string" && (body[key] as string).length <= max ? body[key] as string : undefined;
      const eventId = text("event_id", 200), shopId = text("shop_id", 36), method = text("method", 20) as PaymentMethod | undefined;
      if (eventId === undefined || eventId === "" || shopId === undefined || !/^[0-9a-f-]{36}$/.test(shopId) || method === undefined || !PAYMENT_METHODS.includes(method) ||
        !Number.isInteger(body["months"]) || !Number.isSafeInteger(body["amount_minor"])) throw new BillingError(400, "invalid_payload");
      return { shopId, months: body["months"] as number, amountMinor: body["amount_minor"] as number, method, reference: text("reference", 120), externalId: `generic:${eventId}` };
    },
  };
}
