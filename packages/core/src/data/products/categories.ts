import type { Queryable } from "../database/driver.ts";

/** A category's optional French and English names (ADR-037); an absent one falls back to the main name. */
export interface CategoryNames { readonly fr?: string | undefined; readonly en?: string | undefined; }
/** Shop catalogue grouping; details use the same timestamp/device ordering as products. `names` is read-only here. */
export interface Category { readonly id: string; readonly businessId: string; readonly name: string; readonly active: boolean; readonly createdAt: string; readonly updatedAt: string; readonly updatedByDevice?: string | undefined; readonly names?: CategoryNames | undefined; }
/** Returns a category only within the requested shop, with its French/English names when any are set. */
export function categoryOf(tx: Queryable, businessId: string, id: string): Category | undefined {
  const row = tx.get(`SELECT * FROM categories WHERE business_id=? AND id=?`, [businessId, id]);
  if (row === undefined) return undefined;
  const names = categoryNamesOf(tx, businessId, id);
  return { id, businessId, name: String(row["name"]), active: row["active"] === 1, createdAt: String(row["created_at"]), updatedAt: String(row["updated_at"]),
    updatedByDevice: typeof row["updated_by_device"] === "string" ? row["updated_by_device"] : undefined, ...(names === undefined ? {} : { names: { ...(names.fr === undefined ? {} : { fr: names.fr }), ...(names.en === undefined ? {} : { en: names.en }) } }) };
}
/** Shared category LWW primitive for authorized writes and verified replay, inside their transaction. */
export function upsertCategory(tx: Queryable, item: Category, deviceId: string): boolean {
  return tx.run(`INSERT INTO categories(id,business_id,name,active,created_at,updated_at,updated_by_device) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=excluded.active,updated_at=excluded.updated_at,updated_by_device=excluded.updated_by_device
    WHERE excluded.updated_at>categories.updated_at OR (excluded.updated_at=categories.updated_at AND excluded.updated_by_device>coalesce(categories.updated_by_device,''))`,
    [item.id, item.businessId, item.name, item.active ? 1 : 0, item.createdAt, item.updatedAt, deviceId]).changes > 0;
}
/** A category's stored French/English names and their version, or undefined when never written. */
export function categoryNamesOf(tx: Queryable, businessId: string, categoryId: string): (CategoryNames & { readonly updatedAt: string }) | undefined {
  const row = tx.get(`SELECT name_fr, name_en, updated_at FROM category_names WHERE business_id=? AND id=?`, [businessId, categoryId]);
  if (row === undefined) return undefined;
  const fr = row["name_fr"], en = row["name_en"];
  return { ...(typeof fr === "string" ? { fr } : {}), ...(typeof en === "string" ? { en } : {}), updatedAt: String(row["updated_at"]) };
}
/**
 * Writes a category's French/English names under last-write-wins (later `updatedAt`, then the higher device ID)
 * inside the caller's transaction; an absent name clears it. False when a newer version is stored.
 */
export function writeCategoryNames(tx: Queryable, businessId: string, categoryId: string, names: CategoryNames & { readonly updatedAt: string }, deviceId: string): boolean {
  return tx.run(`INSERT INTO category_names(id,business_id,name_fr,name_en,updated_at,updated_by_device) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name_fr=excluded.name_fr,name_en=excluded.name_en,updated_at=excluded.updated_at,updated_by_device=excluded.updated_by_device
    WHERE excluded.updated_at>category_names.updated_at OR (excluded.updated_at=category_names.updated_at AND excluded.updated_by_device>category_names.updated_by_device)`,
    [categoryId, businessId, names.fr ?? null, names.en ?? null, names.updatedAt, deviceId]).changes > 0;
}
