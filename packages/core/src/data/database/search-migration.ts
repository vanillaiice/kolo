import type { Migration } from "./migrations.ts";
import { foldedColumn } from "./search.ts";

/** Searchable tables: their `name` gets an accent- and case-folded twin for `LIKE` searches. */
const SEARCHABLE = ["products", "categories", "customers", "suppliers", "financial_accounts"] as const;

/**
 * Forward-only search keys. `search_name` is `name` folded once at write time by the same rules as
 * a typed term (see `search.ts`), so searches compare plain columns instead of folding every row on
 * every keystroke. Triggers keep it current for every writer, including replayed events and restores.
 * The generated SQL is pinned by a digest in the migration tests: changing the fold rules needs a new
 * migration, never an edit here.
 */
export const SEARCH_MIGRATION: Migration = {
  version: 21, name: "accent-insensitive search keys", statements: SEARCHABLE.flatMap(table => {
    const folded = (column: string): string => `lower(${foldedColumn(column)})`;
    return [
      `ALTER TABLE ${table} ADD COLUMN search_name TEXT`,
      `UPDATE ${table} SET search_name=${folded("name")}`,
      `CREATE TRIGGER ${table}_search_insert AFTER INSERT ON ${table} BEGIN UPDATE ${table} SET search_name=${folded("name")} WHERE rowid=NEW.rowid; END`,
      `CREATE TRIGGER ${table}_search_rename AFTER UPDATE OF name ON ${table} BEGIN UPDATE ${table} SET search_name=${folded("name")} WHERE rowid=NEW.rowid; END`,
    ];
  }),
};
