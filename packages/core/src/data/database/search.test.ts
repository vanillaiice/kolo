import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "./node-sqlite.ts";
import { createHash } from "node:crypto";
import { foldedColumn, foldSearchTerm, likePattern } from "./search.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";
import { SEARCH_MIGRATION } from "./search-migration.ts";
import { searchProducts } from "../products/products.ts";

/** Digest of migration 21 as shipped. */
const SEARCH_MIGRATION_DIGEST = "7711ae033607696276db76e1fe26286cb35ef9bb95e421c8990424a82c5e561f";

const NAMES = ["Café Nescafé 50g", "CAFÉ MOULU", "Crème fraîche", "Œufs (plateau)", "Maïs grillé", "Lait 50% écrémé", "Pâte d’arachide", "Thé Lipton", "Ananas", "Coca-Cola 33cl"];

function search(term: string, anywhere = false): string[] {
  const db = openDatabase({ location: ":memory:" });
  try {
    db.run("CREATE TABLE items (name TEXT NOT NULL)");
    for (const name of NAMES) db.run("INSERT INTO items VALUES (?)", [name]);
    return db.all(`SELECT name FROM items WHERE ${foldedColumn("name")} LIKE ? ESCAPE '\\' ORDER BY name`, [likePattern(term, { anywhere })]).map(row => String(row["name"]));
  } finally { db.close(); }
}

describe("accent- and case-insensitive search", () => {
  it("finds accented names from plain, accented or capitalized terms", () => {
    for (const term of ["cafe", "Cafe", "CAFE", "café", "CAFÉ", "cAfÉ"]) assert.deepEqual(search(term), ["CAFÉ MOULU", "Café Nescafé 50g"], term);
    assert.deepEqual(search("creme"), ["Crème fraîche"]);
    assert.deepEqual(search("mais"), ["Maïs grillé"]);
    assert.deepEqual(search("the"), ["Thé Lipton"]);
  });
  it("folds ligatures and curly apostrophes on both sides", () => {
    assert.deepEqual(search("oeufs"), ["Œufs (plateau)"]);
    assert.deepEqual(search("œufs"), ["Œufs (plateau)"]);
    assert.deepEqual(search("pate d'arachide"), ["Pâte d’arachide"]);
    assert.deepEqual(search("pâte d’ara"), ["Pâte d’arachide"]);
  });
  it("matches anywhere when asked, and keeps LIKE wildcards literal", () => {
    assert.deepEqual(search("nescafe", true), ["Café Nescafé 50g"]);
    assert.deepEqual(search("nescafe"), [], "prefix by default");
    assert.deepEqual(search("50%", true), ["Lait 50% écrémé"]);
    assert.deepEqual(search("_", true), [], "underscore is not a wildcard");
    assert.deepEqual(search("ecreme", true), ["Lait 50% écrémé"]);
  });
  it("SQL and JavaScript folding agree for every mapped character", () => {
    const db = openDatabase({ location: ":memory:" });
    try {
      for (const text of ["àáâãäåÀÁÂÃÄÅ", "èéêëÈÉÊË", "ìíîïÌÍÎÏ", "òóôõöÒÓÔÕÖ", "ùúûüÙÚÛÜ", "ýÿÝŸ", "çÇñÑ", "œŒæÆ", "‘’", "Plain Text 123"]) {
        const sql = String(db.get(`SELECT lower(${foldedColumn("value")}) AS folded FROM (SELECT ? AS value)`, [text])!["folded"]);
        assert.equal(sql, foldSearchTerm(text), text);
      }
    } finally { db.close(); }
  });
  it("refuses a column expression that is not a plain identifier", () => {
    for (const column of ["name; DROP TABLE x", "lower(name)", "", "a.b.c", "Name"]) assert.throws(() => foldedColumn(column), /identifier/);
  });
});

describe("migration 21 search keys", () => {
  const at = "2026-10-09T12:00:00.000Z", shop = "01a12200-0000-7000-8000-000000000001";
  function upgraded(seed?: (db: ReturnType<typeof openDatabase>) => void): ReturnType<typeof openDatabase> {
    const db = openDatabase({ location: ":memory:" });
    db.run(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT`);
    for (const migration of MIGRATIONS.filter(item => item.version <= 20)) db.transaction(tx => { for (const statement of migration.statements) tx.run(statement); tx.run(`INSERT INTO schema_migrations VALUES (?,?,?)`, [migration.version, migration.name, at]); });
    db.run(`INSERT INTO businesses(id,name,currency,created_at,updated_at) VALUES (?,'Boutique','XAF',?,?)`, [shop, at, at]);
    seed?.(db);
    assert.deepEqual(migrate(db).applied.map(item => item.version), [21, 22, 23, 24, 25, 26, 27, 28]);
    return db;
  }
  const product = (db: ReturnType<typeof openDatabase>, id: string, name: string): void => void db.run(
    `INSERT INTO products(id,business_id,name,unit,selling_price_minor,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`, [id, shop, name, "unit", 500, "XAF", at, at]);

  it("backfills names that existed before the upgrade", () => {
    const db = upgraded(seeded => { product(seeded, "01a12200-0000-7000-8000-000000000011", "Café Nescafé"); seeded.run(`INSERT INTO categories(id,business_id,name,created_at,updated_at) VALUES ('01a12200-0000-7000-8000-000000000021',?,'Épicerie',?,?)`, [shop, at, at]); });
    try {
      assert.equal(db.get(`SELECT search_name FROM products`)!["search_name"], "cafe nescafe");
      assert.equal(db.get(`SELECT search_name FROM categories`)!["search_name"], "epicerie");
    } finally { db.close(); }
  });
  it("keeps the key current on insert and rename, and till search finds accented names", () => {
    const db = upgraded();
    try {
      product(db, "01a12200-0000-7000-8000-000000000012", "Crème fraîche");
      product(db, "01a12200-0000-7000-8000-000000000013", "Café moulu");
      assert.equal(db.get(`SELECT search_name FROM products WHERE id=?`, ["01a12200-0000-7000-8000-000000000012"])!["search_name"], "creme fraiche");
      db.run(`UPDATE products SET name='Crème Épaisse' WHERE id=?`, ["01a12200-0000-7000-8000-000000000012"]);
      assert.equal(db.get(`SELECT search_name FROM products WHERE id=?`, ["01a12200-0000-7000-8000-000000000012"])!["search_name"], "creme epaisse");
      assert.deepEqual(searchProducts(db, shop, "cafe").map(item => item.name), ["Café moulu"]);
      assert.deepEqual(searchProducts(db, shop, "EPAISSE").map(item => item.name), ["Crème Épaisse"], "matches inside the name, any case");
      assert.deepEqual(searchProducts(db, shop, "fraiche").map(item => item.name), [], "renamed product no longer matches its old name");
    } finally { db.close(); }
  });
  it("keeps its generated SQL fixed: changing the fold rules needs a new migration", () => {
    assert.equal(createHash("sha256").update(JSON.stringify(SEARCH_MIGRATION.statements)).digest("hex"), SEARCH_MIGRATION_DIGEST);
  });
});
