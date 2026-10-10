import type { Queryable } from "./driver.ts";
import type { Migration } from "./migrations.ts";

/** Each searchable table and the text its full-text row indexes. */
const SOURCES = {
  products: ["name", "sku", "barcode", "brand", "description"],
  customers: ["name", "phone"],
  suppliers: ["name", "phone", "contact"],
} as const;

/**
 * Word search (migration 24).
 *
 * An FTS5 index over product, customer and supplier text, folded for case and accents
 * (`unicode61 remove_diacritics 2`), so a word anywhere in the name, brand, description, phone or
 * contact matches, not only the start of the name. Triggers keep it in step with every write,
 * including replayed events and restored backups; the prefix search on `search_name` remains.
 */
export const FULL_TEXT_MIGRATION: Migration = {
  version: 24,
  name: "full-text catalogue and people search",
  statements: [
    `CREATE VIRTUAL TABLE catalogue_search USING fts5(entity UNINDEXED, id UNINDEXED, business_id UNINDEXED, text,
       tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
    ...Object.entries(SOURCES).flatMap(([table, columns]) => {
      const text = (row: string): string => columns.map(column => `coalesce(${row}.${column},'')`).join(` || ' ' || `);
      const insert = (row: string): string => `INSERT INTO catalogue_search(entity, id, business_id, text) VALUES ('${table}', ${row}.id, ${row}.business_id, ${text(row)});`;
      const remove = (row: string): string => `DELETE FROM catalogue_search WHERE entity = '${table}' AND id = ${row}.id;`;
      return [
        `INSERT INTO catalogue_search(entity, id, business_id, text) SELECT '${table}', t.id, t.business_id, ${text("t")} FROM ${table} t`,
        `CREATE TRIGGER ${table}_full_text_insert AFTER INSERT ON ${table} BEGIN ${insert("NEW")} END`,
        `CREATE TRIGGER ${table}_full_text_update AFTER UPDATE OF ${columns.join(", ")} ON ${table} BEGIN ${remove("OLD")} ${insert("NEW")} END`,
        `CREATE TRIGGER ${table}_full_text_delete AFTER DELETE ON ${table} BEGIN ${remove("OLD")} END`,
      ];
    }),
  ],
};

function indexed(table: keyof typeof SOURCES, row: string): string {
  return SOURCES[table].map(column => `coalesce(${row}.${column},'')`).join(` || ' ' || `);
}
/**
 * Rebuilds the word-search index from the tables it covers. Backups leave the index out (it is
 * derived and would only enlarge the file), so restore and pairing rebuild it here.
 */
export function rebuildFullText(tx: Queryable): void {
  if (tx.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalogue_search'`) === undefined) return;
  tx.run(`DELETE FROM catalogue_search`);
  for (const table of Object.keys(SOURCES) as (keyof typeof SOURCES)[])
    tx.run(`INSERT INTO catalogue_search(entity, id, business_id, text) SELECT '${table}', t.id, t.business_id, ${indexed(table, "t")} FROM ${table} t`);
}
