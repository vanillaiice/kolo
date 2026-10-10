import type { Migration } from "./migrations.ts";

/**
 * Additional product categories (migration 23).
 *
 * A product keeps one main category on its own row (`products.category_id`), which sales and
 * reports group by so category totals still add up to sales. Further categories are a separate
 * set, used for browsing and filtering only, with its own last-write-wins version so an older
 * till that does not know the set keeps applying ordinary product edits.
 */
export const PRODUCT_CATEGORIES_MIGRATION: Migration = {
  version: 23,
  name: "additional product categories",
  statements: [
    `CREATE TABLE product_category_sets (
       id                TEXT NOT NULL PRIMARY KEY REFERENCES products (id) ON DELETE RESTRICT,
       business_id       TEXT NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
       updated_at        TEXT NOT NULL,
       updated_by_device TEXT NOT NULL
     ) STRICT`,
    `CREATE TABLE product_categories (
       business_id TEXT NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
       product_id  TEXT NOT NULL REFERENCES product_category_sets (id) ON DELETE RESTRICT,
       category_id TEXT NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
       PRIMARY KEY (product_id, category_id)
     ) STRICT`,
    `CREATE INDEX product_categories_by_category ON product_categories(business_id, category_id, product_id)`,
  ],
};
