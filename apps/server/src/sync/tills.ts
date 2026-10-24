import type { Kysely, Transaction } from "kysely";
import type { ServerDatabase } from "../database.js";

type Db = Kysely<ServerDatabase> | Transaction<ServerDatabase>;

/** A shop's till limit and use (ADR-039). `max` null is unlimited. */
export interface TillPlace { readonly max: number | null; readonly used: number }

/** Tills that count against the limit: active, not held, and not the server's own device. */
export async function tillsInUse(db: Db, businessId: string): Promise<number> {
  const row = await db.selectFrom("shop_devices").select(eb => eb.fn.countAll().as("n")).where("business_id", "=", businessId)
    .where("active", "=", true).where("held", "=", false).where("platform", "<>", "SERVER").executeTakeFirstOrThrow();
  return Number(row.n);
}

/**
 * The shop's limit and use. With `lock`, the shop row is locked first, so everything that adds or frees a place in the
 * same transaction sees one consistent count and two tills cannot both take the last place.
 */
export async function tillPlace(db: Db, businessId: string, lock = false): Promise<TillPlace> {
  let query = db.selectFrom("shops").select("max_tills").where("business_id", "=", businessId);
  if (lock) query = query.forUpdate();
  const shop = await query.executeTakeFirstOrThrow();
  return { max: shop.max_tills, used: await tillsInUse(db, businessId) };
}

/** Whether one more till fits. */
export function hasPlace(place: TillPlace): boolean { return place.max === null || place.used < place.max; }

/**
 * Releases held tills, oldest first, into the places now free (after a revocation or a raised limit). The caller holds
 * the shop row lock. Returns the released device IDs.
 */
export async function releaseHeld(tx: Transaction<ServerDatabase>, businessId: string): Promise<readonly string[]> {
  const place = await tillPlace(tx, businessId, true);
  const free = place.max === null ? Number.MAX_SAFE_INTEGER : place.max - place.used;
  if (free <= 0) return [];
  const waiting = await tx.selectFrom("shop_devices").select("device_id").where("business_id", "=", businessId).where("held", "=", true)
    .orderBy("updated_at").orderBy("device_id").limit(Math.min(free, 1000)).execute();
  if (waiting.length === 0) return [];
  const ids = waiting.map(row => row.device_id);
  await tx.updateTable("shop_devices").set({ held: false }).where("business_id", "=", businessId).where("device_id", "in", ids).execute();
  return ids;
}
