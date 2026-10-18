import { randomBytes, randomUUIDv7 } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { formatConnectionCode } from "@kolo/contracts/sync";
import type { ServerDatabase } from "../database.js";
import { sha256, type ServerKey } from "../identity.js";
import { AdminError, audit, type Admin } from "./accounts.js";
import { BillingError, entitlementOf, listPayments, recordPayment, type Edition, type PaymentMethod } from "../billing.js";

/** Who performed a change and from where; the CLI acts as `cli`. */
export interface Actor { readonly adminId: string | null; readonly username: string; readonly address: string | null }
/** The CLI's identity in the audit log. */
export const CLI_ACTOR: Actor = { adminId: null, username: "cli", address: null };
/** Days a removed shop is kept, restorable, before its data is purged. */
export const REMOVAL_GRACE_DAYS = 30;

/** A freshly issued connection code. `code` is shown once; only the token's hash is stored. */
export interface IssuedCode { readonly codeId: string; readonly code: string; readonly label: string; readonly expiresAt: string }
/** A connection code as listed, never with its token. */
export interface CodeView { readonly codeId: string; readonly label: string; readonly createdBy: string; readonly createdAt: string; readonly expiresAt: string;
  readonly state: "unused" | "used" | "expired" | "cancelled"; readonly usedAt: string | null; readonly shopId: string | null; readonly shopName: string | null; readonly includedMonths: number;
  /** The shop an owner-recovery code may re-attach a restored owner device to (ADR-036); null for an ordinary code. */
  readonly recoveryShopId: string | null }

/**
 * Issues a single-use connection code for one shop. The string carries the server's public address, its fingerprint
 * and a 128-bit token, so the owner pastes or scans one thing and never retypes a fingerprint (ADR-030).
 * With `recoveryShopId` it is an owner-recovery code (ADR-036): it can only attach a restored owner device to that
 * existing shop after every till was lost, and never creates a shop. Issue one only after confirming the owner.
 */
export async function issueCode(db: Kysely<ServerDatabase>, key: ServerKey, publicUrl: string, actor: Actor, input: { readonly label: string; readonly days: number; readonly now: Date; readonly includedMonths?: number; readonly recoveryShopId?: string }): Promise<IssuedCode> {
  const includedMonths = input.includedMonths ?? 0;
  if (!Number.isInteger(includedMonths) || includedMonths < 0 || includedMonths > 36) throw new AdminError(400, "invalid_months");
  let recovery: { id: string; name: string } | undefined;
  if (input.recoveryShopId !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.recoveryShopId) || includedMonths !== 0) throw new AdminError(400, "invalid_request");
    const shop = await db.selectFrom("shops").select(["business_id", "name", "status"]).where("business_id", "=", input.recoveryShopId).executeTakeFirst();
    if (shop === undefined || shop.status === "removed") throw new AdminError(404, "shop_not_found");
    recovery = { id: shop.business_id, name: shop.name };
  }
  const label = String((input.label ?? "") || (recovery === undefined ? "" : `Recovery: ${recovery.name}`)).trim().slice(0, 120);
  if (label.length < 1 || label.length > 120) throw new AdminError(400, "invalid_label");
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 90) throw new AdminError(400, "invalid_expiry");
  const token = randomBytes(16).toString("hex"), codeId = randomUUIDv7(), expiresAt = new Date(input.now.getTime() + input.days * 86_400_000);
  await db.transaction().execute(async tx => {
    await tx.insertInto("connection_codes").values({ code_id: codeId, token_hash: sha256(token), label, created_by: actor.username, created_at: input.now, expires_at: expiresAt, used_at: null, used_by: null, cancelled_at: null,
      included_months: includedMonths, recovery_business_id: recovery?.id ?? null }).execute();
    await audit(tx, actor, recovery === undefined ? "code.issue" : "code.issue_recovery", codeId, actor.address, { label, days: input.days, included_months: includedMonths, ...(recovery === undefined ? {} : { shop_id: recovery.id }) });
  });
  return { codeId, label, expiresAt: expiresAt.toISOString(), code: formatConnectionCode({ url: publicUrl, fingerprint: key.fingerprint, token }) };
}

/** Recent codes, newest first, with what became of each. */
export async function listCodes(db: Kysely<ServerDatabase>, now: Date, limit = 200): Promise<readonly CodeView[]> {
  const rows = await db.selectFrom("connection_codes as c").leftJoin("shops as s", "s.business_id", "c.used_by")
    .select(["c.code_id", "c.label", "c.created_by", "c.created_at", "c.expires_at", "c.used_at", "c.used_by", "c.cancelled_at", "c.included_months", "c.recovery_business_id", "s.name"]).orderBy("c.created_at", "desc").limit(limit).execute();
  return rows.map(row => ({ codeId: row.code_id, label: row.label, createdBy: row.created_by, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    state: row.cancelled_at !== null ? "cancelled" : row.used_at !== null ? "used" : row.expires_at <= now ? "expired" : "unused",
    usedAt: row.used_at?.toISOString() ?? null, shopId: row.used_by, shopName: row.name ?? null, includedMonths: row.included_months, recoveryShopId: row.recovery_business_id }));
}

/** Cancels an unused code. A used code has done its job and cannot be cancelled. */
export async function cancelCode(db: Kysely<ServerDatabase>, actor: Actor, codeId: string, now: Date): Promise<void> {
  await db.transaction().execute(async tx => {
    const changed = await tx.updateTable("connection_codes").set({ cancelled_at: now }).where("code_id", "=", codeId).where("used_at", "is", null).where("cancelled_at", "is", null).executeTakeFirst();
    if (changed.numUpdatedRows !== 1n) throw new AdminError(409, "code_not_cancellable");
    await audit(tx, actor, "code.cancel", codeId, actor.address, null);
  });
}

/** A shop as the operator sees it: identity, status and sync health, never business records. */
export interface ShopView { readonly shopId: string; readonly name: string; readonly status: "active" | "suspended" | "removed"; readonly enrolledAt: string;
  readonly removeAfter: string | null; readonly devices: number; readonly lastSeenAt: string | null; readonly facts: number; readonly bytes: number;
  /** Hosted service: `unlimited` on self-hosted servers. */
  readonly service: "unlimited" | "active" | "grace" | "inactive"; readonly paidUntil: string | null }

/** Shops matching `search` (name or ID prefix), most recently active first. */
export async function listShops(db: Kysely<ServerDatabase>, search = "", limit = 200, edition: Edition = { edition: "selfhost", graceDays: 0 }, now = new Date()): Promise<readonly ShopView[]> {
  let query = db.selectFrom("shops as s").select(["s.business_id", "s.name", "s.status", "s.enrolled_at", "s.remove_after", "s.paid_until",
    eb => eb.selectFrom("shop_devices as d").select(eb.fn.countAll().as("n")).whereRef("d.business_id", "=", "s.business_id").where("d.active", "=", true).where("d.platform", "<>", "SERVER").as("devices"),
    eb => eb.selectFrom("shop_devices as d").select(sql<Date | null>`max(d.last_seen_at)`.as("m")).whereRef("d.business_id", "=", "s.business_id").as("last_seen"),
    eb => eb.selectFrom("journal as j").select(eb.fn.countAll().as("n")).whereRef("j.business_id", "=", "s.business_id").as("facts"),
    eb => eb.selectFrom("journal as j").select(sql<string>`coalesce(sum(octet_length(coalesce(j.canonical,'')) + octet_length(coalesce(j.sealed::text,''))),0)`.as("b")).whereRef("j.business_id", "=", "s.business_id").as("bytes")]);
  const text = search.trim().slice(0, 120);
  if (text !== "") query = query.where(eb => eb.or([eb("s.name", "ilike", `%${text.replace(/[\\%_]/g, "\\$&")}%`), eb(sql`s.business_id::text`, "like", `${text.toLowerCase().replace(/[^0-9a-f-]/g, "")}%`)]));
  const rows = await query.orderBy(sql`(SELECT max(d.last_seen_at) FROM shop_devices d WHERE d.business_id = s.business_id)`, sql`desc nulls last`).limit(limit).execute();
  return rows.map(row => ({ shopId: row.business_id, name: row.name, status: row.status, enrolledAt: row.enrolled_at.toISOString(), removeAfter: row.remove_after?.toISOString() ?? null,
    devices: Number(row.devices ?? 0), lastSeenAt: row.last_seen === null || row.last_seen === undefined ? null : new Date(row.last_seen as unknown as string).toISOString(),
    facts: Number(row.facts ?? 0), bytes: Number(row.bytes ?? 0), service: entitlementOf(edition, row.paid_until, now).status, paidUntil: row.paid_until?.toISOString() ?? null }));
}

/** One shop's devices and delivery health; the key epoch is read from sealed headers, never from content. */
export interface ShopDetail extends ShopView {
  readonly ownerId: string; readonly conflicts: number; readonly keyEpoch: number | null; readonly connectionCode: string | null; readonly graceUntil: string | null;
  readonly payments: Awaited<ReturnType<typeof listPayments>>;
  readonly deviceList: readonly { readonly deviceId: string; readonly label: string; readonly platform: string; readonly active: boolean; readonly authority: boolean; readonly lastSeenAt: string | null; readonly backlog: number }[];
}

export async function shopDetail(db: Kysely<ServerDatabase>, shopId: string, edition: Edition = { edition: "selfhost", graceDays: 0 }, now = new Date()): Promise<ShopDetail> {
  if (!/^[0-9a-f-]{36}$/.test(shopId)) throw new AdminError(404, "not_found");
  const [view] = (await listShops(db, shopId, 1, edition, now)).filter(item => item.shopId === shopId);
  if (view === undefined) throw new AdminError(404, "not_found");
  const shop = await db.selectFrom("shops as s").leftJoin("connection_codes as c", "c.code_id", "s.connection_code_id").select(["s.owner_id", "c.label"]).where("s.business_id", "=", shopId).executeTakeFirstOrThrow();
  const devices = await db.selectFrom("shop_devices as d").select(["d.device_id", "d.label", "d.platform", "d.active", "d.authority_allowed", "d.last_seen_at",
    eb => eb.selectFrom("journal as j").select(eb.fn.countAll().as("n")).whereRef("j.business_id", "=", "d.business_id").whereRef("j.origin_device_id", "<>", "d.device_id")
      .where(where => where.not(where.exists(where.selectFrom("deliveries as x").select(sql`1`.as("one")).whereRef("x.business_id", "=", "j.business_id").whereRef("x.event_id", "=", "j.event_id").whereRef("x.device_id", "=", "d.device_id")))).as("backlog")])
    .where("d.business_id", "=", shopId).where("d.platform", "<>", "SERVER").orderBy("d.label").execute();
  const conflicts = await db.selectFrom("journal_conflicts").select(eb => eb.fn.countAll().as("n")).where("business_id", "=", shopId).executeTakeFirstOrThrow();
  const epoch = await db.selectFrom("journal").select(sql<string | null>`max((sealed->>'epoch')::bigint)`.as("e")).where("business_id", "=", shopId).executeTakeFirstOrThrow();
  return { ...view, ownerId: shop.owner_id, conflicts: Number(conflicts.n), keyEpoch: epoch.e === null ? null : Number(epoch.e), connectionCode: shop.label ?? null,
    graceUntil: entitlementOf(edition, view.paidUntil === null ? null : new Date(view.paidUntil), now).grace_until, payments: await listPayments(db, shopId),
    deviceList: devices.map(row => ({ deviceId: row.device_id, label: row.label, platform: row.platform, active: row.active, authority: row.authority_allowed,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null, backlog: Number(row.backlog ?? 0) })) };
}

/**
 * Changes a shop's status. Suspended and removed shops are refused on their next sync request while their tills keep
 * trading; removal is a soft delete restorable for `REMOVAL_GRACE_DAYS`, after which `purgeRemovedShops` deletes it.
 */
export async function setShopStatus(db: Kysely<ServerDatabase>, actor: Actor, shopId: string, action: "suspend" | "resume" | "remove" | "restore", now: Date): Promise<void> {
  type Status = "active" | "suspended" | "removed";
  const from = ({ suspend: ["active"], resume: ["suspended"], remove: ["active", "suspended"], restore: ["removed"] } satisfies Record<string, Status[]>)[action];
  const to = { suspend: "suspended", resume: "active", remove: "removed", restore: "active" }[action] as "active" | "suspended" | "removed";
  await db.transaction().execute(async tx => {
    const changed = await tx.updateTable("shops").set({ status: to, status_changed_at: now, remove_after: to === "removed" ? new Date(now.getTime() + REMOVAL_GRACE_DAYS * 86_400_000) : null })
      .where("business_id", "=", shopId).where("status", "in", from).executeTakeFirst();
    if (changed.numUpdatedRows !== 1n) throw new AdminError(409, "invalid_status_change");
    if (to !== "active") await tx.deleteFrom("sessions").where("business_id", "=", shopId).execute();
    await audit(tx, actor, `shop.${action}`, shopId, actor.address, null);
  });
}

/** Records a payment taken by the operator and moves the shop's paid-until date; audited in the same transaction. */
export async function recordShopPayment(db: Kysely<ServerDatabase>, actor: Actor, input: { readonly shopId: string; readonly months: number; readonly amountMinor: number; readonly method: PaymentMethod; readonly reference?: string }, now: Date) {
  try {
    return await db.transaction().execute(async tx => {
      const recorded = await recordPayment(tx, { ...input, source: "manual", recordedBy: actor.username }, now);
      await audit(tx, actor, "payment.record", input.shopId, actor.address, { months: input.months, amount_minor: input.amountMinor, method: input.method, paid_until: recorded.paidUntilAfter });
      return recorded;
    });
  } catch (error) { if (error instanceof BillingError) throw new AdminError(error.status, error.code); throw error; }
}

/**
 * Deletes every row of shops whose removal grace period has passed. This is the only deletion of append-only rows,
 * allowed by a transaction-local setting that names the shop being purged. Returns the purged shop IDs.
 */
export async function purgeRemovedShops(db: Kysely<ServerDatabase>, actor: Actor, now: Date): Promise<readonly string[]> {
  const due = await db.selectFrom("shops").select("business_id").where("status", "=", "removed").where("remove_after", "<=", now).execute();
  const purged: string[] = [];
  for (const { business_id: shopId } of due) {
    await db.transaction().execute(async tx => {
      await sql`SELECT set_config('kolo.purging_shop', ${shopId}, true)`.execute(tx);
      for (const table of ["offered_batch_events", "offered_batches", "deliveries", "receipts", "journal_conflicts", "push_batches", "sessions", "journal", "challenges", "payments", "join_sessions"] as const)
        await tx.deleteFrom(table).where("business_id", "=", shopId).execute();
      await tx.updateTable("connection_codes").set({ used_by: null, used_at: null, cancelled_at: now }).where("used_by", "=", shopId).execute();
      await tx.updateTable("shops").set({ connection_code_id: null }).where("business_id", "=", shopId).execute();
      await tx.deleteFrom("shop_devices").where("business_id", "=", shopId).execute();
      await tx.deleteFrom("shops").where("business_id", "=", shopId).execute();
      await audit(tx, actor, "shop.purge", shopId, actor.address, null);
    });
    purged.push(shopId);
  }
  return purged;
}

/** In-process request counters since start, shared by the public listener and the dashboard. */
export interface Metrics { readonly startedAt: Date; requests: number; clientErrors: number; serverErrors: number; rateLimited: number }
export function createMetrics(now = new Date()): Metrics { return { startedAt: now, requests: 0, clientErrors: 0, serverErrors: 0, rateLimited: 0 }; }

/** Server-wide health for the dashboard. */
export async function serverHealth(db: Kysely<ServerDatabase>, metrics: Metrics, version: string, now: Date, edition: Edition = { edition: "selfhost", graceDays: 0 }) {
  const [size, journal, recent, sessions, shops, migrations] = await Promise.all([
    sql<{ size: string }>`SELECT pg_database_size(current_database())::text AS size`.execute(db),
    db.selectFrom("journal").select(eb => eb.fn.countAll().as("n")).executeTakeFirstOrThrow(),
    db.selectFrom("journal").select(eb => eb.fn.countAll().as("n")).where("received_at", ">", new Date(now.getTime() - 86_400_000)).executeTakeFirstOrThrow(),
    db.selectFrom("sessions").select(eb => eb.fn.countAll().as("n")).where("expires_at", ">", now).executeTakeFirstOrThrow(),
    db.selectFrom("shops").select(["status", eb => eb.fn.countAll().as("n")]).groupBy("status").execute(),
    sql<{ name: string; timestamp: Date }>`SELECT name, timestamp FROM kysely_migration ORDER BY name`.execute(db),
  ]);
  const byStatus = Object.fromEntries(shops.map(row => [row.status, Number(row.n)]));
  return { version, edition: edition.edition, graceDays: edition.graceDays, startedAt: metrics.startedAt.toISOString(), databaseBytes: Number(size.rows[0]?.size ?? 0), facts: Number(journal.n), factsLastDay: Number(recent.n),
    activeSessions: Number(sessions.n), shops: { active: byStatus["active"] ?? 0, suspended: byStatus["suspended"] ?? 0, removed: byStatus["removed"] ?? 0 },
    requests: metrics.requests, clientErrors: metrics.clientErrors, serverErrors: metrics.serverErrors, rateLimited: metrics.rateLimited,
    migrations: migrations.rows.map(row => ({ name: row.name, appliedAt: new Date(row.timestamp).toISOString() })) };
}

/** Audit entries, newest first, optionally before an ID for paging. */
export async function listAudit(db: Kysely<ServerDatabase>, before?: string, limit = 100) {
  let query = db.selectFrom("admin_audit").select(["id", "at", "username", "action", "target", "address", "detail"]).orderBy("id", "desc").limit(Math.min(Math.max(limit, 1), 500));
  if (before !== undefined && /^\d{1,19}$/.test(before)) query = query.where("id", "<", before);
  return (await query.execute()).map(row => ({ id: row.id, at: row.at.toISOString(), username: row.username, action: row.action, target: row.target, address: row.address,
    detail: row.detail === null ? null : (typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail) as Record<string, unknown> }));
}

export type { Admin };
