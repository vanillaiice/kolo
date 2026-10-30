import { randomBytes, randomUUIDv7 } from "node:crypto";
import { sql, type Kysely, type RawBuilder } from "kysely";
import { formatConnectionCode } from "@kolo/contracts/sync";
import type { ServerDatabase } from "../database.js";
import { sha256, type ServerKey } from "../identity.js";
import { AdminError, audit, type Admin } from "./accounts.js";
import { BillingError, entitlementOf, listPayments, recordPayment, type Edition, type PaymentMethod } from "../billing.js";
import { releaseHeld } from "../sync/tills.js";

/** Who performed a change and from where; the CLI acts as `cli`. */
export interface Actor { readonly adminId: string | null; readonly username: string; readonly address: string | null }
/** The CLI's identity in the audit log. */
export const CLI_ACTOR: Actor = { adminId: null, username: "cli", address: null };
/** Days a removed shop is kept, restorable, before its data is purged. */
export const REMOVAL_GRACE_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A freshly issued connection code. `code` is shown once; only the token's hash is stored. */
export interface IssuedCode { readonly codeId: string; readonly code: string; readonly label: string; readonly expiresAt: string }
/** A connection code as listed, never with its token. */
export interface CodeView { readonly codeId: string; readonly label: string; readonly createdBy: string; readonly createdAt: string; readonly expiresAt: string;
  readonly state: "unused" | "used" | "expired" | "cancelled"; readonly usedAt: string | null; readonly shopId: string | null; readonly shopName: string | null; readonly includedMonths: number;
  /** Trial or extra paid days (ADR-039) and the till limit the shop starts with; null is unlimited. */
  readonly includedDays: number; readonly maxTills: number | null;
  /** The shop an owner-recovery code may re-attach a restored owner device to (ADR-036); null for an ordinary code. */
  readonly recoveryShopId: string | null }

/**
 * Issues a single-use connection code for one shop. The string carries the server's public address, its fingerprint
 * and a 128-bit token, so the owner pastes or scans one thing and never retypes a fingerprint (ADR-030).
 * With `recoveryShopId` it is an owner-recovery code (ADR-036): it can only attach a restored owner device to that
 * existing shop after every till was lost, and never creates a shop. Issue one only after confirming the owner.
 * An ordinary code may carry paid months and days (a trial) and the shop's till limit (`maxTills`, null unlimited;
 * ADR-039).
 */
export async function issueCode(db: Kysely<ServerDatabase>, key: ServerKey, publicUrl: string, actor: Actor, input: { readonly label: string; readonly days: number; readonly now: Date; readonly includedMonths?: number; readonly includedDays?: number; readonly maxTills?: number | null; readonly recoveryShopId?: string }): Promise<IssuedCode> {
  const includedMonths = input.includedMonths ?? 0;
  if (!Number.isInteger(includedMonths) || includedMonths < 0 || includedMonths > 36) throw new AdminError(400, "invalid_months");
  const includedDays = input.includedDays ?? 0, maxTills = input.maxTills ?? null;
  if (!Number.isInteger(includedDays) || includedDays < 0 || includedDays > 90) throw new AdminError(400, "invalid_trial_days");
  if (maxTills !== null && (!Number.isInteger(maxTills) || maxTills < 1 || maxTills > 1000)) throw new AdminError(400, "invalid_till_limit");
  let recovery: { id: string; name: string } | undefined;
  if (input.recoveryShopId !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.recoveryShopId) || includedMonths !== 0 || includedDays !== 0 || maxTills !== null) throw new AdminError(400, "invalid_request");
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
      included_months: includedMonths, included_days: includedDays, max_tills: maxTills, recovery_business_id: recovery?.id ?? null }).execute();
    await audit(tx, actor, recovery === undefined ? "code.issue" : "code.issue_recovery", codeId, actor.address, { label, days: input.days, included_months: includedMonths,
      ...(recovery === undefined ? { included_days: includedDays, max_tills: maxTills } : { shop_id: recovery.id }) });
  });
  return { codeId, label, expiresAt: expiresAt.toISOString(), code: formatConnectionCode({ url: publicUrl, fingerprint: key.fingerprint, token }) };
}

/** What became of a code. */
export const CODE_STATES = ["unused", "used", "expired", "cancelled"] as const;
export type CodeState = typeof CODE_STATES[number];

/** Codes, newest first, with what became of each; optionally one state, a page at a time. */
export async function listCodes(db: Kysely<ServerDatabase>, now: Date, query: { readonly state?: CodeState; readonly offset?: number; readonly limit?: number } = {}): Promise<{ readonly codes: readonly CodeView[]; readonly total: number }> {
  const filter = query.state === undefined ? sql<boolean>`true` : {
    cancelled: sql<boolean>`c.cancelled_at IS NOT NULL`, used: sql<boolean>`c.cancelled_at IS NULL AND c.used_at IS NOT NULL`,
    expired: sql<boolean>`c.cancelled_at IS NULL AND c.used_at IS NULL AND c.expires_at <= ${now}`, unused: sql<boolean>`c.cancelled_at IS NULL AND c.used_at IS NULL AND c.expires_at > ${now}`,
  }[query.state];
  const [rows, total] = await Promise.all([
    db.selectFrom("connection_codes as c").leftJoin("shops as s", "s.business_id", "c.used_by")
      .select(["c.code_id", "c.label", "c.created_by", "c.created_at", "c.expires_at", "c.used_at", "c.used_by", "c.cancelled_at", "c.included_months", "c.included_days", "c.max_tills", "c.recovery_business_id", "s.name"])
      .where(filter).orderBy("c.created_at", "desc").orderBy("c.code_id", "desc").offset(page(query.offset, 0, 1_000_000)).limit(page(query.limit, 50, 500)).execute(),
    db.selectFrom("connection_codes as c").select(eb => eb.fn.countAll().as("n")).where(filter).executeTakeFirstOrThrow(),
  ]);
  return { total: Number(total.n), codes: rows.map(row => ({ codeId: row.code_id, label: row.label, createdBy: row.created_by, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    state: row.cancelled_at !== null ? "cancelled" : row.used_at !== null ? "used" : row.expires_at <= now ? "expired" : "unused",
    usedAt: row.used_at?.toISOString() ?? null, shopId: row.used_by, shopName: row.name ?? null, includedMonths: row.included_months,
    includedDays: row.included_days, maxTills: row.max_tills, recoveryShopId: row.recovery_business_id })) };
}

/** A whole number within bounds, or the fallback. */
function page(value: number | undefined, fallback: number, max: number): number {
  return value === undefined || !Number.isInteger(value) || value < 0 ? fallback : Math.min(value, max);
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
  readonly service: "unlimited" | "active" | "grace" | "inactive"; readonly paidUntil: string | null;
  /** Till limit (null unlimited) and tills waiting for a place (ADR-039); `devices` counts the tills holding one. */
  readonly maxTills: number | null; readonly heldTills: number }

/** Orders the shop list can take. */
export const SHOP_SORTS = ["lastSeen", "name", "enrolled", "facts", "bytes", "paidUntil"] as const;
export type ShopSort = typeof SHOP_SORTS[number];
/** Filters, order and page for `listShops`. `search` matches the name, or an ID prefix when it looks like one. */
export interface ShopQuery {
  readonly search?: string; readonly shopId?: string; readonly status?: ShopView["status"]; readonly service?: "active" | "grace" | "inactive";
  readonly sort?: ShopSort; readonly dir?: "asc" | "desc"; readonly offset?: number; readonly limit?: number }
const SHOP_ORDER: Readonly<Record<ShopSort, string>> = { lastSeen: "last_seen", name: "lower(s.name)", enrolled: "s.enrolled_at", facts: "facts", bytes: "bytes", paidUntil: "s.paid_until" };

/**
 * The hosted service state as SQL, by the same rule as `entitlementOf`: active before paid-until, grace until the
 * grace days have passed, inactive afterwards or when never paid. A self-hosted server has none of these.
 */
function serviceIs(service: "active" | "grace" | "inactive", edition: Edition, now: Date): RawBuilder<boolean> {
  if (edition.edition !== "hosted") return sql<boolean>`false`;
  const graceEnd = sql`s.paid_until + ${edition.graceDays * 86_400}::int * interval '1 second'`;
  return { active: sql<boolean>`s.paid_until > ${now}`, grace: sql<boolean>`s.paid_until <= ${now} AND ${graceEnd} > ${now}`,
    inactive: sql<boolean>`(s.paid_until IS NULL OR ${graceEnd} <= ${now})` }[service];
}

function shopFilter(query: ShopQuery, edition: Edition, now: Date): RawBuilder<boolean> {
  const conditions: RawBuilder<unknown>[] = [sql`true`], text = (query.search ?? "").trim().slice(0, 120);
  if (text !== "") {
    const name = sql`s.name ILIKE ${`%${text.replace(/[\\%_]/g, "\\$&")}%`}`;
    // Only text that could be an ID is matched as an ID prefix; "akwa" must not match IDs starting with "aa".
    conditions.push(/^[0-9a-f-]+$/i.test(text) ? sql`(${name} OR s.business_id::text LIKE ${`${text.toLowerCase()}%`})` : name);
  }
  if (query.shopId !== undefined) conditions.push(sql`s.business_id::text = ${query.shopId}`);
  if (query.status !== undefined) conditions.push(sql`s.status = ${query.status}`);
  if (query.service !== undefined) conditions.push(serviceIs(query.service, edition, now));
  return sql<boolean>`${sql.join(conditions, sql` AND `)}`;
}

/** Shops matching `query`, most recently active first by default, with the total that match. */
export async function listShops(db: Kysely<ServerDatabase>, query: ShopQuery = {}, edition: Edition = { edition: "selfhost", graceDays: 0 }, now = new Date()): Promise<{ readonly shops: readonly ShopView[]; readonly total: number }> {
  const filter = shopFilter(query, edition, now), dir = query.dir === "asc" ? "asc" : "desc";
  const [rows, total] = await Promise.all([
    db.selectFrom("shops as s").select(["s.business_id", "s.name", "s.status", "s.enrolled_at", "s.remove_after", "s.paid_until", "s.max_tills",
      eb => eb.selectFrom("shop_devices as d").select(eb.fn.countAll().as("n")).whereRef("d.business_id", "=", "s.business_id").where("d.active", "=", true).where("d.held", "=", false).where("d.platform", "<>", "SERVER").as("devices"),
      eb => eb.selectFrom("shop_devices as d").select(eb.fn.countAll().as("n")).whereRef("d.business_id", "=", "s.business_id").where("d.held", "=", true).as("held"),
      eb => eb.selectFrom("shop_devices as d").select(sql<Date | null>`max(d.last_seen_at)`.as("m")).whereRef("d.business_id", "=", "s.business_id").as("last_seen"),
      eb => eb.selectFrom("journal as j").select(eb.fn.countAll().as("n")).whereRef("j.business_id", "=", "s.business_id").as("facts"),
      eb => eb.selectFrom("journal as j").select(sql<string>`coalesce(sum(octet_length(coalesce(j.canonical,'')) + octet_length(coalesce(j.sealed::text,''))),0)`.as("b")).whereRef("j.business_id", "=", "s.business_id").as("bytes")])
      .where(filter).orderBy(sql.raw(`${SHOP_ORDER[query.sort ?? "lastSeen"] ?? "last_seen"} ${dir} nulls last, s.business_id`)).offset(page(query.offset, 0, 1_000_000)).limit(page(query.limit, 50, 5000)).execute(),
    db.selectFrom("shops as s").select(eb => eb.fn.countAll().as("n")).where(filter).executeTakeFirstOrThrow(),
  ]);
  return { total: Number(total.n), shops: rows.map(row => ({ shopId: row.business_id, name: row.name, status: row.status, enrolledAt: row.enrolled_at.toISOString(), removeAfter: row.remove_after?.toISOString() ?? null,
    devices: Number(row.devices ?? 0), lastSeenAt: row.last_seen === null || row.last_seen === undefined ? null : new Date(row.last_seen as unknown as string).toISOString(),
    facts: Number(row.facts ?? 0), bytes: Number(row.bytes ?? 0), service: entitlementOf(edition, row.paid_until, now).status, paidUntil: row.paid_until?.toISOString() ?? null,
    maxTills: row.max_tills, heldTills: Number(row.held ?? 0) })) };
}

/** One shop's devices and delivery health; the key epoch is read from sealed headers, never from content. */
export interface ShopDetail extends ShopView {
  readonly ownerId: string; readonly conflicts: number; readonly keyEpoch: number | null; readonly connectionCode: string | null; readonly graceUntil: string | null;
  readonly payments: Awaited<ReturnType<typeof listPayments>>;
  /** The latest audit entries that name this shop, newest first. */
  readonly activity: readonly AuditView[];
  readonly deviceList: readonly { readonly deviceId: string; readonly label: string; readonly platform: string; readonly active: boolean; readonly held: boolean; readonly authority: boolean; readonly lastSeenAt: string | null; readonly backlog: number }[];
}

/** One shop as the operator sees it, with its tills, payments and recent audit entries. */
export async function shopDetail(db: Kysely<ServerDatabase>, shopId: string, edition: Edition = { edition: "selfhost", graceDays: 0 }, now = new Date()): Promise<ShopDetail> {
  if (!/^[0-9a-f-]{36}$/.test(shopId)) throw new AdminError(404, "not_found");
  const { shops: [view] } = await listShops(db, { shopId, limit: 1 }, edition, now);
  if (view === undefined) throw new AdminError(404, "not_found");
  const shop = await db.selectFrom("shops as s").leftJoin("connection_codes as c", "c.code_id", "s.connection_code_id").select(["s.owner_id", "c.label"]).where("s.business_id", "=", shopId).executeTakeFirstOrThrow();
  const devices = await db.selectFrom("shop_devices as d").select(["d.device_id", "d.label", "d.platform", "d.active", "d.held", "d.authority_allowed", "d.last_seen_at",
    eb => eb.selectFrom("journal as j").select(eb.fn.countAll().as("n")).whereRef("j.business_id", "=", "d.business_id").whereRef("j.origin_device_id", "<>", "d.device_id")
      .where(where => where.not(where.exists(where.selectFrom("deliveries as x").select(sql`1`.as("one")).whereRef("x.business_id", "=", "j.business_id").whereRef("x.event_id", "=", "j.event_id").whereRef("x.device_id", "=", "d.device_id")))).as("backlog")])
    .where("d.business_id", "=", shopId).where("d.platform", "<>", "SERVER").orderBy("d.label").execute();
  const conflicts = await db.selectFrom("journal_conflicts").select(eb => eb.fn.countAll().as("n")).where("business_id", "=", shopId).executeTakeFirstOrThrow();
  const epoch = await db.selectFrom("journal").select(sql<string | null>`max((sealed->>'epoch')::bigint)`.as("e")).where("business_id", "=", shopId).executeTakeFirstOrThrow();
  return { ...view, ownerId: shop.owner_id, conflicts: Number(conflicts.n), keyEpoch: epoch.e === null ? null : Number(epoch.e), connectionCode: shop.label ?? null,
    graceUntil: entitlementOf(edition, view.paidUntil === null ? null : new Date(view.paidUntil), now).grace_until, payments: await listPayments(db, shopId), activity: await listAudit(db, { target: shopId, limit: 50 }),
    deviceList: devices.map(row => ({ deviceId: row.device_id, label: row.label, platform: row.platform, active: row.active, held: row.held, authority: row.authority_allowed,
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

/**
 * Sets a shop's till limit (null for unlimited), audited as `shop.till_limit`. Raising or clearing it releases held
 * tills, oldest first, into the new places; lowering it below current use holds nobody (ADR-039). Returns the
 * released device IDs. With `expected`, the change is refused (`stale`) unless the limit is still that value, so two
 * operators editing at once cannot silently overwrite each other.
 */
export async function setTillLimit(db: Kysely<ServerDatabase>, actor: Actor, shopId: string, maxTills: number | null, expected?: number | null): Promise<readonly string[]> {
  if (maxTills !== null && (!Number.isInteger(maxTills) || maxTills < 1 || maxTills > 1000)) throw new AdminError(400, "invalid_till_limit");
  if (!/^[0-9a-f-]{36}$/.test(shopId)) throw new AdminError(404, "not_found");
  return db.transaction().execute(async tx => {
    const shop = await tx.selectFrom("shops").select(["max_tills", "status"]).where("business_id", "=", shopId).forUpdate().executeTakeFirst();
    if (shop === undefined || shop.status === "removed") throw new AdminError(404, "not_found");
    if (expected !== undefined && shop.max_tills !== expected) throw new AdminError(409, "stale");
    await tx.updateTable("shops").set({ max_tills: maxTills }).where("business_id", "=", shopId).execute();
    const released = await releaseHeld(tx, shopId);
    await audit(tx, actor, "shop.till_limit", shopId, actor.address, { from: shop.max_tills, to: maxTills, released: released.length });
    return released;
  });
}

/**
 * Records a payment taken by the operator and moves the shop's paid-until date; audited in the same transaction.
 * `requestId` (a UUID the form generates once) makes a retried or double-submitted request record the payment once:
 * the replay returns the original and is not audited again.
 */
export async function recordShopPayment(db: Kysely<ServerDatabase>, actor: Actor, input: { readonly shopId: string; readonly months: number; readonly amountMinor: number; readonly method: PaymentMethod; readonly reference?: string; readonly requestId?: string }, now: Date) {
  if (input.requestId !== undefined && !UUID.test(input.requestId)) throw new AdminError(400, "invalid_request");
  const { requestId, ...payment } = input;
  try {
    return await db.transaction().execute(async tx => {
      const recorded = await recordPayment(tx, { ...payment, source: "manual", recordedBy: actor.username, ...(requestId === undefined ? {} : { externalId: `manual:${requestId}` }) }, now);
      if (!recorded.duplicate) await audit(tx, actor, "payment.record", input.shopId, actor.address, { months: input.months, amount_minor: input.amountMinor, method: input.method, paid_until: recorded.paidUntilAfter });
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

/** Server-wide health for the dashboard, with the runtime it runs on. */
export async function serverHealth(db: Kysely<ServerDatabase>, metrics: Metrics, version: string, now: Date, edition: Edition = { edition: "selfhost", graceDays: 0 }) {
  const [size, journal, recent, sessions, shops, migrations, postgres] = await Promise.all([
    sql<{ size: string }>`SELECT pg_database_size(current_database())::text AS size`.execute(db),
    db.selectFrom("journal").select(eb => eb.fn.countAll().as("n")).executeTakeFirstOrThrow(),
    db.selectFrom("journal").select(eb => eb.fn.countAll().as("n")).where("received_at", ">", new Date(now.getTime() - 86_400_000)).executeTakeFirstOrThrow(),
    db.selectFrom("sessions").select(eb => eb.fn.countAll().as("n")).where("expires_at", ">", now).executeTakeFirstOrThrow(),
    db.selectFrom("shops").select(["status", eb => eb.fn.countAll().as("n")]).groupBy("status").execute(),
    sql<{ name: string; timestamp: Date }>`SELECT name, timestamp FROM kysely_migration ORDER BY name`.execute(db),
    sql<{ version: string }>`SELECT current_setting('server_version') AS version`.execute(db),
  ]);
  const byStatus = Object.fromEntries(shops.map(row => [row.status, Number(row.n)]));
  return { version, edition: edition.edition, graceDays: edition.graceDays, startedAt: metrics.startedAt.toISOString(), databaseBytes: Number(size.rows[0]?.size ?? 0), facts: Number(journal.n), factsLastDay: Number(recent.n),
    activeSessions: Number(sessions.n), shops: { active: byStatus["active"] ?? 0, suspended: byStatus["suspended"] ?? 0, removed: byStatus["removed"] ?? 0 },
    requests: metrics.requests, clientErrors: metrics.clientErrors, serverErrors: metrics.serverErrors, rateLimited: metrics.rateLimited,
    migrations: migrations.rows.map(row => ({ name: row.name, appliedAt: new Date(row.timestamp).toISOString() })),
    runtime: { node: process.version, postgres: postgres.rows[0]?.version ?? "", memoryBytes: process.memoryUsage().rss, uptimeSeconds: Math.round((now.getTime() - metrics.startedAt.getTime()) / 1000) } };
}

/** An audit entry as listed; `seq` is its place in the hash chain and `hash` its link (ADR-045). */
export interface AuditView { readonly id: string; readonly seq: string; readonly hash: string; readonly at: string; readonly username: string; readonly action: string; readonly target: string | null; readonly address: string | null; readonly detail: Record<string, unknown> | null }
/** Filters for `listAudit`: `action` is a prefix (`shop.` matches every shop change), the others exact. */
export interface AuditQuery { readonly before?: string; readonly action?: string; readonly username?: string; readonly target?: string; readonly from?: Date; readonly to?: Date; readonly limit?: number }

/** Audit entries, newest first, filtered, optionally before an ID for paging. */
export async function listAudit(db: Kysely<ServerDatabase>, query: AuditQuery = {}): Promise<readonly AuditView[]> {
  let select = db.selectFrom("admin_audit").select(["id", "seq", "hash", "at", "username", "action", "target", "address", "detail"]).orderBy("id", "desc").limit(page(query.limit, 100, 5000) || 1);
  if (query.before !== undefined && /^\d{1,19}$/.test(query.before)) select = select.where("id", "<", query.before);
  if (query.action !== undefined && query.action !== "") select = select.where("action", "like", `${query.action.replace(/[\\%_]/g, "\\$&")}%`);
  if (query.username !== undefined && query.username !== "") select = select.where("username", "=", query.username.trim().toLowerCase());
  if (query.target !== undefined && query.target !== "") select = select.where("target", "=", query.target.trim());
  if (query.from !== undefined) select = select.where("at", ">=", query.from);
  if (query.to !== undefined) select = select.where("at", "<", query.to);
  return (await select.execute()).map(row => ({ id: row.id, seq: String(row.seq), hash: row.hash, at: row.at.toISOString(), username: row.username, action: row.action, target: row.target, address: row.address,
    detail: row.detail === null ? null : (typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail) as Record<string, unknown> }));
}

/** Something the operator should look at, linking to its shop or code. */
export interface AttentionItem {
  readonly kind: "service_inactive" | "service_grace" | "service_expiring" | "held_tills" | "conflicts" | "stale_shop" | "code_expiring" | "purge_soon" | "server_errors" | "integrity";
  readonly target: string | null; readonly label: string; readonly at: string | null; readonly count: number | null }
/** Days without any till contact before an active shop is called stale. */
export const STALE_SHOP_DAYS = 14;

/**
 * The dashboard's first page: counts across the server, facts received per UTC day for the last 14 days, hosted
 * revenue for 30 days, and what needs attention. Reads only; each attention kind is capped at 20 items.
 */
export async function overview(db: Kysely<ServerDatabase>, metrics: Metrics, edition: Edition, now: Date) {
  const day = 86_400_000, hosted = edition.edition === "hosted";
  const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 13 * day);
  const graceEnd = sql`s.paid_until + ${edition.graceDays * 86_400}::int * interval '1 second'`;
  const [statuses, tills, recent, series, revenue, codes, held, conflicts, stale, expiringCodes, purging, service] = await Promise.all([
    db.selectFrom("shops").select(["status", eb => eb.fn.countAll().as("n")]).groupBy("status").execute(),
    sql<{ used: string; held: string }>`SELECT count(*) FILTER (WHERE NOT d.held) AS used, count(*) FILTER (WHERE d.held) AS held FROM shop_devices d JOIN shops s ON s.business_id = d.business_id
      WHERE d.active AND d.platform <> 'SERVER' AND s.status <> 'removed'`.execute(db),
    db.selectFrom("journal").select(eb => eb.fn.countAll().as("n")).where("received_at", ">", new Date(now.getTime() - day)).executeTakeFirstOrThrow(),
    sql<{ day: string; n: string }>`SELECT to_char(date_trunc('day', received_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*) AS n FROM journal WHERE received_at >= ${firstDay} GROUP BY 1`.execute(db),
    hosted ? sql<{ total: string; n: string }>`SELECT coalesce(sum(amount_minor), 0) AS total, count(*) AS n FROM payments WHERE recorded_at > ${new Date(now.getTime() - 30 * day)} AND source <> 'code'`.execute(db) : undefined,
    db.selectFrom("connection_codes").select(eb => eb.fn.countAll().as("n")).where("used_at", "is", null).where("cancelled_at", "is", null).where("expires_at", ">", now).executeTakeFirstOrThrow(),
    sql<{ id: string; name: string; n: string }>`SELECT s.business_id AS id, s.name, count(*) AS n FROM shop_devices d JOIN shops s ON s.business_id = d.business_id
      WHERE d.held AND s.status <> 'removed' GROUP BY s.business_id, s.name ORDER BY n DESC LIMIT 20`.execute(db),
    sql<{ id: string; name: string; n: string }>`SELECT s.business_id AS id, s.name, count(*) AS n FROM journal_conflicts c JOIN shops s ON s.business_id = c.business_id
      WHERE s.status <> 'removed' GROUP BY s.business_id, s.name ORDER BY n DESC LIMIT 20`.execute(db),
    sql<{ id: string; name: string; seen: Date | null }>`SELECT s.business_id AS id, s.name, (SELECT max(d.last_seen_at) FROM shop_devices d WHERE d.business_id = s.business_id) AS seen
      FROM shops s WHERE s.status = 'active' AND coalesce((SELECT max(d.last_seen_at) FROM shop_devices d WHERE d.business_id = s.business_id), s.enrolled_at) < ${new Date(now.getTime() - STALE_SHOP_DAYS * day)}
      ORDER BY seen ASC NULLS FIRST LIMIT 20`.execute(db),
    db.selectFrom("connection_codes").select(["code_id", "label", "expires_at"]).where("used_at", "is", null).where("cancelled_at", "is", null)
      .where("expires_at", ">", now).where("expires_at", "<=", new Date(now.getTime() + day)).orderBy("expires_at").limit(20).execute(),
    db.selectFrom("shops").select(["business_id", "name", "remove_after"]).where("status", "=", "removed").where("remove_after", "<=", new Date(now.getTime() + 3 * day)).orderBy("remove_after").limit(20).execute(),
    hosted ? sql<{ id: string; name: string; paid_until: Date | null; state: "inactive" | "grace" | "expiring" }>`SELECT * FROM (SELECT s.business_id AS id, s.name, s.paid_until,
        CASE WHEN s.paid_until IS NULL OR ${graceEnd} <= ${now} THEN 'inactive' WHEN s.paid_until <= ${now} THEN 'grace' WHEN s.paid_until <= ${new Date(now.getTime() + 7 * day)} THEN 'expiring' END AS state
      FROM shops s WHERE s.status = 'active') x WHERE state IS NOT NULL ORDER BY paid_until ASC NULLS FIRST LIMIT 60`.execute(db) : undefined,
  ]);
  const byStatus = Object.fromEntries(statuses.map(row => [row.status, Number(row.n)]));
  const perDay = new Map(series.rows.map(row => [row.day, Number(row.n)]));
  const attention: AttentionItem[] = [];
  const iso = (value: Date | null | undefined): string | null => value === null || value === undefined ? null : new Date(value).toISOString();
  for (const state of ["inactive", "grace", "expiring"] as const)
    for (const row of (service?.rows ?? []).filter(item => item.state === state).slice(0, 20)) attention.push({ kind: `service_${state}`, target: row.id, label: row.name, at: iso(row.paid_until), count: null });
  for (const row of held.rows) attention.push({ kind: "held_tills", target: row.id, label: row.name, at: null, count: Number(row.n) });
  for (const row of conflicts.rows) attention.push({ kind: "conflicts", target: row.id, label: row.name, at: null, count: Number(row.n) });
  for (const row of stale.rows) attention.push({ kind: "stale_shop", target: row.id, label: row.name, at: iso(row.seen), count: null });
  for (const row of expiringCodes) attention.push({ kind: "code_expiring", target: row.code_id, label: row.label, at: row.expires_at.toISOString(), count: null });
  for (const row of purging) attention.push({ kind: "purge_soon", target: row.business_id, label: row.name, at: iso(row.remove_after), count: null });
  if (metrics.serverErrors > 0) attention.push({ kind: "server_errors", target: null, label: "", at: null, count: metrics.serverErrors });
  const services = { active: 0, grace: 0, inactive: 0 };
  if (hosted) {
    const counts = await sql<{ state: "active" | "grace" | "inactive"; n: string }>`SELECT CASE WHEN s.paid_until > ${now} THEN 'active' WHEN s.paid_until IS NOT NULL AND ${graceEnd} > ${now} THEN 'grace' ELSE 'inactive' END AS state,
      count(*) AS n FROM shops s WHERE s.status = 'active' GROUP BY 1`.execute(db);
    for (const row of counts.rows) services[row.state] = Number(row.n);
  }
  return {
    edition: edition.edition, shops: { active: byStatus["active"] ?? 0, suspended: byStatus["suspended"] ?? 0, removed: byStatus["removed"] ?? 0 }, services: hosted ? services : null,
    tills: { used: Number(tills.rows[0]?.used ?? 0), held: Number(tills.rows[0]?.held ?? 0) }, factsLastDay: Number(recent.n), unusedCodes: Number(codes.n),
    activity: Array.from({ length: 14 }, (_, index) => { const date = new Date(firstDay.getTime() + index * day).toISOString().slice(0, 10); return { day: date, facts: perDay.get(date) ?? 0 }; }),
    revenue: revenue === undefined ? null : { amountMinor: Number(revenue.rows[0]?.total ?? 0), payments: Number(revenue.rows[0]?.n ?? 0), days: 30 },
    attention,
  };
}

/**
 * Hosted billing across shops (ADR-031): payments recorded in [`from`, `to`), newest first and paged, their totals by
 * method and by source, and the subscriptions that end within 30 days or have already lapsed. Refused on self-hosted servers.
 */
export async function billingReport(db: Kysely<ServerDatabase>, edition: Edition, now: Date, query: { readonly from: Date; readonly to: Date; readonly offset?: number; readonly limit?: number }) {
  if (edition.edition !== "hosted") throw new AdminError(409, "not_hosted");
  if (!(query.from < query.to)) throw new AdminError(400, "invalid_period");
  const within = (eb: Kysely<ServerDatabase>) => eb.selectFrom("payments as p").innerJoin("shops as s", "s.business_id", "p.business_id").where("p.recorded_at", ">=", query.from).where("p.recorded_at", "<", query.to);
  const [rows, byMethod, bySource, ending] = await Promise.all([
    within(db).select(["p.payment_id", "p.business_id", "s.name", "p.months", "p.days", "p.amount_minor", "p.method", "p.reference", "p.source", "p.recorded_by", "p.recorded_at", "p.paid_until_after"])
      .orderBy("p.recorded_at", "desc").orderBy("p.payment_id", "desc").offset(page(query.offset, 0, 1_000_000)).limit(page(query.limit, 100, 5000)).execute(),
    within(db).select(["p.method", eb => eb.fn.countAll().as("n"), sql<string>`coalesce(sum(p.amount_minor), 0)`.as("total")]).groupBy("p.method").execute(),
    within(db).select(["p.source", eb => eb.fn.countAll().as("n"), sql<string>`coalesce(sum(p.amount_minor), 0)`.as("total")]).groupBy("p.source").execute(),
    db.selectFrom("shops as s").select(["s.business_id", "s.name", "s.paid_until"]).where("s.status", "=", "active")
      .where(eb => eb.or([eb("s.paid_until", "is", null), eb("s.paid_until", "<=", new Date(now.getTime() + 30 * 86_400_000))])).orderBy(sql`s.paid_until asc nulls first`).limit(200).execute(),
  ]);
  const totals = (list: readonly { n: string | number | bigint; total: string }[], key: (row: never) => string) => list.map(row => ({ key: key(row as never), payments: Number(row.n), amountMinor: Number(row.total) }));
  return {
    from: query.from.toISOString(), to: query.to.toISOString(),
    payments: rows.map(row => ({ paymentId: row.payment_id, shopId: row.business_id, shopName: row.name, months: row.months, days: row.days, amountMinor: Number(row.amount_minor), method: row.method,
      reference: row.reference, source: row.source, recordedBy: row.recorded_by, recordedAt: row.recorded_at.toISOString(), paidUntilAfter: row.paid_until_after.toISOString() })),
    total: { payments: byMethod.reduce((sum, row) => sum + Number(row.n), 0), amountMinor: byMethod.reduce((sum, row) => sum + Number(row.total), 0) },
    byMethod: totals(byMethod, (row: { method: string }) => row.method), bySource: totals(bySource, (row: { source: string }) => row.source),
    ending: ending.map(row => ({ shopId: row.business_id, name: row.name, paidUntil: row.paid_until?.toISOString() ?? null, service: entitlementOf(edition, row.paid_until, now).status })),
  };
}

/** One consistency check: `targets` names what fails it (shop IDs, or the first broken audit `seq`), at most 20. */
export interface IntegrityCheck {
  readonly name: "audit_chain" | "payment_chain" | "paid_until" | "held_with_free_places" | "sessions_on_stopped_shops" | "purge_overdue";
  readonly ok: boolean; readonly targets: readonly string[] }

/**
 * Read-only consistency checks over what the server guarantees by construction (ADR-045): the audit hash chain
 * recomputes and links from the first entry to the head; each shop's payments chain (every payment starts where the
 * previous ended) and its paid-until date is the last one's end; no till waits while a place is free; no sync session
 * outlives a suspension or removal; nothing removed waits more than two hours past its purge date. The audit head is
 * returned so an operator can note it and later notice a rewritten or truncated chain.
 */
export async function integrityReport(db: Kysely<ServerDatabase>, now: Date) {
  const ids = (rows: readonly { id: string }[]): string[] => rows.map(row => String(row.id));
  const [broken, head, paymentChain, paidUntil, held, sessions, purge] = await Promise.all([
    sql<{ id: string }>`SELECT seq::text AS id FROM (SELECT seq, hash = kolo_audit_hash(prev_hash, at, admin_id, username, action, target, address, detail) AS self_ok,
        prev_hash = coalesce(lag(hash) OVER (ORDER BY seq), repeat('0', 64)) AS link_ok, seq = row_number() OVER (ORDER BY seq) AS dense_ok FROM admin_audit) x
      WHERE NOT (self_ok AND link_ok AND dense_ok) ORDER BY seq LIMIT 1`.execute(db),
    sql<{ head: string; hash: string; n: string }>`SELECT a.seq::text AS head, a.hash, (SELECT count(*) FROM admin_audit) AS n FROM admin_audit a ORDER BY a.seq DESC LIMIT 1`.execute(db),
    // Dates pass through JavaScript (milliseconds) between reads and writes, so they are compared to the millisecond.
    sql<{ id: string }>`SELECT DISTINCT business_id::text AS id FROM (SELECT business_id, date_trunc('milliseconds', paid_until_before) AS before,
        date_trunc('milliseconds', lag(paid_until_after) OVER (PARTITION BY business_id ORDER BY paid_until_after, payment_id)) AS previous FROM payments) x WHERE before IS DISTINCT FROM previous LIMIT 20`.execute(db),
    sql<{ id: string }>`SELECT s.business_id::text AS id FROM shops s
      WHERE date_trunc('milliseconds', s.paid_until) IS DISTINCT FROM (SELECT date_trunc('milliseconds', max(p.paid_until_after)) FROM payments p WHERE p.business_id = s.business_id) LIMIT 20`.execute(db),
    sql<{ id: string }>`SELECT s.business_id::text AS id FROM shops s WHERE s.status <> 'removed' AND EXISTS (SELECT 1 FROM shop_devices d WHERE d.business_id = s.business_id AND d.held)
      AND (s.max_tills IS NULL OR s.max_tills > (SELECT count(*) FROM shop_devices d WHERE d.business_id = s.business_id AND d.active AND NOT d.held AND d.platform <> 'SERVER')) LIMIT 20`.execute(db),
    sql<{ id: string }>`SELECT DISTINCT s.business_id::text AS id FROM sessions x JOIN shops s ON s.business_id = x.business_id WHERE s.status <> 'active' AND x.expires_at > ${now} LIMIT 20`.execute(db),
    sql<{ id: string }>`SELECT business_id::text AS id FROM shops WHERE status = 'removed' AND remove_after < ${new Date(now.getTime() - 2 * 3_600_000)} LIMIT 20`.execute(db),
  ]);
  const checks: IntegrityCheck[] = [
    { name: "audit_chain", ok: broken.rows.length === 0, targets: ids(broken.rows) },
    { name: "payment_chain", ok: paymentChain.rows.length === 0, targets: ids(paymentChain.rows) },
    { name: "paid_until", ok: paidUntil.rows.length === 0, targets: ids(paidUntil.rows) },
    { name: "held_with_free_places", ok: held.rows.length === 0, targets: ids(held.rows) },
    { name: "sessions_on_stopped_shops", ok: sessions.rows.length === 0, targets: ids(sessions.rows) },
    { name: "purge_overdue", ok: purge.rows.length === 0, targets: ids(purge.rows) },
  ];
  const last = head.rows[0];
  return { ok: checks.every(check => check.ok), checkedAt: now.toISOString(), checks,
    audit: { entries: Number(last?.n ?? 0), headSeq: last?.head ?? null, headHash: last?.hash ?? null } };
}

export type { Admin };
