import type { Queryable } from "../database/driver.ts";

/** Shop catalogue grouping; details use the same timestamp/device ordering as products. */
export interface Category { readonly id: string; readonly businessId: string; readonly name: string; readonly active: boolean; readonly createdAt: string; readonly updatedAt: string; readonly updatedByDevice?: string | undefined; }
/** Returns a category only within the requested shop. */
export function categoryOf(tx: Queryable, businessId: string, id: string): Category | undefined {
  const row = tx.get(`SELECT * FROM categories WHERE business_id=? AND id=?`, [businessId, id]);
  return row === undefined ? undefined : { id, businessId, name: String(row["name"]), active: row["active"] === 1, createdAt: String(row["created_at"]), updatedAt: String(row["updated_at"]), updatedByDevice: typeof row["updated_by_device"] === "string" ? row["updated_by_device"] : undefined };
}
/** Shared category LWW primitive for authorized writes and verified replay, inside their transaction. */
export function upsertCategory(tx: Queryable, item: Category, deviceId: string): boolean {
  return tx.run(`INSERT INTO categories(id,business_id,name,active,created_at,updated_at,updated_by_device) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=excluded.active,updated_at=excluded.updated_at,updated_by_device=excluded.updated_by_device
    WHERE excluded.updated_at>categories.updated_at OR (excluded.updated_at=categories.updated_at AND excluded.updated_by_device>coalesce(categories.updated_by_device,''))`,
    [item.id, item.businessId, item.name, item.active ? 1 : 0, item.createdAt, item.updatedAt, deviceId]).changes > 0;
}
