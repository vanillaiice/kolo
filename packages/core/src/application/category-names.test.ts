import assert from "node:assert/strict";
import { closeConsistent } from "../data/database/integrity.ts";
import { afterEach, it } from "node:test";
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import type { Database } from "../data/database/driver.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate, MIGRATIONS } from "../data/database/migrations.ts";
import { createWorkspace, unlockWorkspace } from "../identity/workspace.ts";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "../identity/types.ts";
import { categoryLabel } from "../domain/category-names.ts";
import { auditGroupOf, auditTrail } from "./audit.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";
import * as records from "./records.ts";
import * as reports from "./reports.ts";
import { analyticsView, reportView } from "./report-views.ts";

const at = "2026-10-06T09:00:00.000Z", later = "2026-10-06T10:00:00.000Z", secret = "fixture-secret";
const period = { from: "2026-01-01T00:00:00.000Z", until: "2026-12-31T00:00:00.000Z" };
const databases: Database[] = [];
afterEach(() => { closeConsistent(databases.splice(0)); });
const denied = (code: string) => (error: unknown): boolean => error instanceof WorkspaceError && error.code === code;

async function fixture() {
  const db = openDatabase(); databases.push(db); migrate(db);
  const material = { publicKey: generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, now: () => at, newId: randomUUIDv7, credentials: { provision: async () => material, inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "ANDROID", currency: "XAF", secret }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const account = queries.paymentAccounts(context).items[0]!.id;
  const category = (name: string, names?: { fr?: string; en?: string }): string => {
    const id = randomUUIDv7(); assert.equal(commands.saveCategory(context, { id, name, active: true, createdAt: at, updatedAt: at, ...(names === undefined ? {} : { names }) }), true); return id;
  };
  const product = (name: string, categoryId?: string): string => {
    const id = randomUUIDv7(); commands.saveProduct(context, { id, name, unit: "unit", currency: "XAF", sellingPriceMinor: 500, purchasePriceMinor: 100, taxRateBasisPoints: 0, minimumStock: 0, divisible: false, active: true, categoryId, createdAt: at, updatedAt: at }); return id;
  };
  const sell = (productId: string): void => {
    const id = randomUUIDv7();
    commands.completeSale(context, { id, number: id, eventId: randomUUIDv7(), occurredAt: at, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId, name: "Line", unitPriceMinor: 500, quantity: 1000 }],
      payments: [{ id: randomUUIDv7(), accountId: account, amountMinor: 500 }] });
  };
  const cashier = async (): Promise<OperationContext> => {
    const id = randomUUIDv7();
    db.run(`INSERT INTO users(id,business_id,name,role,created_at,updated_at) VALUES (?,?,'Cashier','CASHIER',?,?)`, [id, context.businessId, at, at]);
    db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,'CASHIER')`, [context.businessId, id, id]);
    return unlockWorkspace({ userId: id, secret }, ports);
  };
  const events = (type: string): number => Number(db.get(`SELECT count(*) AS n FROM event_journal WHERE event_type=?`, [type])!["n"]);
  const payloads = (type: string): unknown[] => db.all(`SELECT json_extract(canonical,'$.payload') AS payload FROM event_journal WHERE event_type=? ORDER BY origin_sequence`, [type]).map(row => JSON.parse(String(row["payload"])));
  return { db, context, category, product, sell, cashier, events, payloads };
}

it("a category keeps its main name and gains optional French and English names, signed once", async () => {
  const f = await fixture(), id = f.category("Boissons", { fr: " Boissons fraîches ", en: "Drinks" });
  const stored = queries.category(f.context, id)!;
  assert.equal(stored.name, "Boissons");
  assert.deepEqual(stored.names, { fr: "Boissons fraîches", en: "Drinks" }, "names are trimmed");
  assert.equal(categoryLabel(stored, "fr"), "Boissons fraîches");
  assert.equal(categoryLabel(stored, "en"), "Drinks");
  assert.equal(f.events("CATEGORY_SAVED"), 1);
  assert.deepEqual(f.payloads("CATEGORY_NAMES_SET"), [{ category_id: id, fr: "Boissons fraîches", en: "Drinks", updated_at: at }]);

  const plain = f.category("Savon");
  assert.equal(queries.category(f.context, plain)!.names, undefined, "no names: none stored");
  assert.equal(categoryLabel(queries.category(f.context, plain)!, "en"), "Savon", "an absent name falls back to the main name");
  assert.equal(f.events("CATEGORY_NAMES_SET"), 1, "a category saved without names emits no names event");
  f.category("Riz", { fr: "  ", en: "" });
  assert.equal(f.events("CATEGORY_NAMES_SET"), 1, "blank names are no names");
});

it("names change only when they differ; omitted names are left alone and blank clears one", async () => {
  const f = await fixture(), id = f.category("Boissons", { en: "Drinks" });
  const save = (updatedAt: string, extra: object = {}): boolean => commands.saveCategory(f.context, { id, name: "Boissons", active: true, createdAt: at, updatedAt, ...extra });
  assert.equal(save("2026-10-06T09:01:00.000Z"), true);
  assert.deepEqual(queries.category(f.context, id)!.names, { en: "Drinks" }, "omitted names are unchanged");
  assert.equal(save("2026-10-06T09:02:00.000Z", { names: { en: "Drinks" } }), true);
  assert.equal(f.events("CATEGORY_NAMES_SET"), 1, "identical names are not signed again");
  assert.equal(save("2026-10-06T09:03:00.000Z", { names: { fr: "Boissons", en: "" } }), true);
  assert.deepEqual(queries.category(f.context, id)!.names, { fr: "Boissons" });
  assert.equal(save("2026-10-06T09:04:00.000Z", { names: {} }), true);
  assert.deepEqual(queries.category(f.context, id)!.names, {}, "both cleared");
  assert.deepEqual(f.payloads("CATEGORY_NAMES_SET").at(-1), { category_id: id, updated_at: "2026-10-06T09:04:00.000Z" });
  assert.equal(f.events("CATEGORY_NAMES_SET"), 3);
  // A stale save loses on both records and writes nothing.
  assert.equal(save(at, { names: { en: "Old" } }), false);
  assert.deepEqual(queries.category(f.context, id)!.names, {});
  assert.equal(f.events("CATEGORY_NAMES_SET"), 3);
});

it("invalid names roll back the whole save; authority is checked inside the operation", async () => {
  const f = await fixture(), id = randomUUIDv7();
  assert.throws(() => commands.saveCategory(f.context, { id, name: "Boissons", active: true, createdAt: at, updatedAt: at, names: { en: "x".repeat(121) } }), denied("invalid_input"));
  assert.equal(queries.category(f.context, id), undefined);
  assert.equal(f.events("CATEGORY_SAVED"), 0);
  const cashier = await f.cashier();
  assert.throws(() => commands.saveCategory(cashier, { id, name: "Boissons", active: true, createdAt: at, updatedAt: at, names: { en: "Drinks" } }), denied("permission_denied"));
  assert.equal(f.db.get(`SELECT count(*) AS n FROM category_names`)!["n"], 0);
  assert.throws(() => f.db.run(`INSERT INTO category_names(id,business_id,name_fr,updated_at,updated_by_device) VALUES (?,?,' ',?,'d')`, [id, cashier.businessId, at]), "the schema refuses blank names too");
});

it("search finds a category by any of its names, ignoring accents and case", async () => {
  const f = await fixture(), drinks = f.category("Boissons", { fr: "Rafraîchissements", en: "Drinks" }), soap = f.category("Savon", { en: "Soap" });
  const found = (term: string): string[] => queries.categories(f.context, { term }).items.map(item => item.id);
  assert.deepEqual(found("dri"), [drinks]);
  assert.deepEqual(found("RAFRAICH"), [drinks], "accent-insensitive");
  assert.deepEqual(found("boi"), [drinks], "the main name still matches");
  assert.deepEqual(found("so"), [soap]);
  assert.deepEqual(found("50%"), [], "LIKE wildcards are literal");
  commands.saveCategory(f.context, { id: soap, name: "Savon", active: true, createdAt: at, updatedAt: later, names: { en: "Detergent" } });
  assert.deepEqual(found("soap"), [], "a replaced name stops matching");
  assert.deepEqual(found("deter"), [soap]);
});

it("reports and analytics label categories in the requested language", async () => {
  const f = await fixture(), drinks = f.category("Boissons", { en: "Drinks" }), soap = f.category("Savon");
  f.sell(f.product("Coca", drinks)); f.sell(f.product("Omo", soap)); f.sell(f.product("Loose"));
  const labels = (language?: "fr" | "en"): string[] => reports.salesByCategory(f.context, period.from, period.until, ...(language === undefined ? [] : [language] as const)).map(line => line.label).sort();
  assert.deepEqual(labels(), ["Boissons", "Sans catégorie", "Savon"], "French by default, as before");
  assert.deepEqual(labels("en"), ["Drinks", "No category", "Savon"]);
  const view = reportView(f.context, "salesByCategory", period.from, period.until, { language: "en" });
  assert.ok(view.kind === "salesByCategory" && view.lines.some(line => line.key === drinks && line.label === "Drinks"));
  const analytics = analyticsView(f.context, { from: period.from, until: period.until, offsetMinutes: 60 }, { language: "en" });
  assert.ok(analytics.categories.some(line => line.key === drinks && line.label === "Drinks"));
  assert.throws(() => reportView(f.context, "salesByCategory", period.from, period.until, { language: "de" as "fr" }), denied("invalid_input"));
});

it("a product's other categories carry their names", async () => {
  const f = await fixture(), main = f.category("Épicerie"), other = f.category("Boissons", { en: "Drinks" }), plain = f.category("Savon"), product = f.product("Coca", main);
  commands.setProductCategories(f.context, { productId: product, categoryIds: [other, plain], updatedAt: at });
  const names = Object.fromEntries(records.productCategories(f.context, product).categories.map(item => [item.name, item.names]));
  assert.deepEqual(names, { Boissons: { en: "Drinks" }, Savon: undefined });
});

it("the journal lists names changes under the catalogue", async () => {
  const f = await fixture(), id = f.category("Boissons", { en: "Drinks" });
  assert.equal(auditGroupOf("CATEGORY_NAMES_SET"), "catalogue");
  const entry = auditTrail(f.context, { group: "catalogue" }).items.find(item => item.type === "CATEGORY_NAMES_SET");
  assert.equal(entry?.subject?.id, id);
  assert.equal(entry?.subject?.name, "Boissons", "named by the category's main name");
});

it("migration 31 upgrades a populated schema 30 shop without touching its categories", async () => {
  const db = openDatabase(); databases.push(db);
  db.run(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT`);
  for (const migration of MIGRATIONS.filter(item => item.version <= 30)) db.transaction(tx => { for (const statement of migration.statements) tx.run(statement); tx.run(`INSERT INTO schema_migrations VALUES (?,?,?)`, [migration.version, migration.name, at]); });
  db.run(`INSERT INTO businesses(id,name,currency,created_at,updated_at) VALUES ('b','Shop','XAF',?,?)`, [at, at]);
  db.run(`INSERT INTO categories(id,business_id,name,created_at,updated_at) VALUES ('c','b','Boissons',?,?)`, [at, at]);
  assert.deepEqual(migrate(db).applied.map(item => item.version), [31]);
  assert.equal(db.get(`SELECT name FROM categories`)!["name"], "Boissons");
  assert.equal(db.get(`SELECT count(*) AS n FROM category_names`)!["n"], 0);
  db.run(`INSERT INTO category_names(id,business_id,name_en,updated_at,updated_by_device) VALUES ('c','b','Ça Œuvre',?,'d')`, [at]);
  assert.deepEqual({ ...db.get(`SELECT search_fr, search_en FROM category_names`) }, { search_fr: null, search_en: "ca oeuvre" }, "generated keys use the search folding");
  assert.throws(() => db.run(`INSERT INTO category_names(id,business_id,updated_at,updated_by_device) VALUES ('missing','b',?,'d')`, [at]), "names belong to an existing category");
});

/** Deterministic xorshift generator so fuzz failures reproduce from the printed seed. */
function generator(seed: number): (limit: number) => number { let x = seed >>> 0 || 1; return limit => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % limit; }; }

it("fuzz: whatever names are saved, the label and search agree with the stored, trimmed names", async () => {
  const f = await fixture(), seed = Date.now() % 100_000, next = generator(seed), letters = ["a", "é", "È", "œ", "ç", "Z", " ", "'", "’", "%", "_", "x"];
  const word = (): string => Array.from({ length: next(8) }, () => letters[next(letters.length)]).join("");
  for (let round = 0; round < 60; round++) {
    const id = randomUUIDv7(), names = { fr: word(), en: word() }, main = `M${round}`;
    commands.saveCategory(f.context, { id, name: main, active: true, createdAt: at, updatedAt: at, names });
    const stored = queries.category(f.context, id)!;
    for (const language of ["fr", "en"] as const) {
      const wanted = names[language].trim();
      assert.equal(categoryLabel(stored, language), wanted === "" ? main : wanted, `seed ${seed}, round ${round}`);
      if (wanted !== "") assert.ok(queries.categories(f.context, { term: wanted, limit: 100 }).items.some(item => item.id === id), `seed ${seed}: "${wanted}" finds its category`);
    }
  }
});
