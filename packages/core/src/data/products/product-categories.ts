import type { Queryable } from "../database/driver.ts";

/** A product's additional categories as last written, with the version that wrote them. */
export interface ProductCategorySet {
  readonly businessId: string; readonly productId: string; readonly categoryIds: readonly string[];
  readonly updatedAt: string;
}

/**
 * Replaces a product's additional categories under last-write-wins (later `updatedAt`, then the
 * greater device ID), the rule product details use. Returns false when a newer set is already
 * stored, so a losing local or replayed write changes nothing. Inside the caller's transaction.
 */
export function writeProductCategories(tx: Queryable, set: ProductCategorySet, deviceId: string): boolean {
  const old = tx.get(`SELECT updated_at, updated_by_device FROM product_category_sets WHERE id = ?`, [set.productId]);
  if (old !== undefined && !(set.updatedAt > String(old["updated_at"]) || set.updatedAt === old["updated_at"] && deviceId > String(old["updated_by_device"]))) return false;
  tx.run(`INSERT INTO product_category_sets(id, business_id, updated_at, updated_by_device) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, updated_by_device = excluded.updated_by_device`, [set.productId, set.businessId, set.updatedAt, deviceId]);
  tx.run(`DELETE FROM product_categories WHERE business_id = ? AND product_id = ?`, [set.businessId, set.productId]);
  for (const categoryId of set.categoryIds)
    tx.run(`INSERT INTO product_categories(business_id, product_id, category_id) VALUES (?, ?, ?)`, [set.businessId, set.productId, categoryId]);
  return true;
}

/** A product's additional category IDs and their version, or an empty set never written. */
export function productCategorySet(tx: Queryable, businessId: string, productId: string): { categoryIds: string[]; updatedAt?: string } {
  const version = tx.get(`SELECT updated_at FROM product_category_sets WHERE business_id = ? AND id = ?`, [businessId, productId]);
  const categoryIds = tx.all(`SELECT category_id FROM product_categories WHERE business_id = ? AND product_id = ? ORDER BY category_id`, [businessId, productId]).map(row => String(row["category_id"]));
  return version === undefined ? { categoryIds } : { categoryIds, updatedAt: String(version["updated_at"]) };
}
