import type { Migration } from "./migrations.ts";
import { foldedColumn } from "./search.ts";

/**
 * Forward-only French and English category names (ADR-037). The main `categories.name` stays what older tills,
 * reports and exports show; these optional names are carried by their own signed `CATEGORY_NAMES_SET` event, so an
 * older till keeps that event unapplied instead of rejecting a changed `CATEGORY_SAVED`. The folded search keys are
 * generated from the names by the same rules as `categories.search_name`.
 */
export const CATEGORY_NAMES_MIGRATION: Migration = {
  version: 31, name: "french and english category names", statements: [
    `CREATE TABLE category_names (
       id                TEXT NOT NULL PRIMARY KEY REFERENCES categories (id) ON DELETE RESTRICT,
       business_id       TEXT NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
       name_fr           TEXT CHECK (name_fr IS NULL OR length(trim(name_fr)) BETWEEN 1 AND 120),
       name_en           TEXT CHECK (name_en IS NULL OR length(trim(name_en)) BETWEEN 1 AND 120),
       search_fr         TEXT GENERATED ALWAYS AS (lower(${foldedColumn("name_fr")})) STORED,
       search_en         TEXT GENERATED ALWAYS AS (lower(${foldedColumn("name_en")})) STORED,
       updated_at        TEXT NOT NULL,
       updated_by_device TEXT NOT NULL
     ) STRICT`,
    `CREATE INDEX category_names_by_business ON category_names (business_id)`,
  ],
};
