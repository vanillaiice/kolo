import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { saveProduct, searchProducts, type SaveProduct } from "./products.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL = "33333333-3333-7333-8333-333333333333";
const CREATED = "2026-08-01T08:00:00.000Z";

let database: Database;

beforeEach(() => {
  database = openDatabase();
  migrate(database);
  database.transaction((tx) => {
    tx.run(
      `INSERT INTO businesses (id, name, currency, created_at, updated_at)
       VALUES (?, 'Boutique', 'XAF', ?, ?)`,
      [BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO users (id, business_id, name, role, created_at, updated_at)
       VALUES (?, ?, 'Jean', 'OWNER', ?, ?)`,
      [USER, BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'Till', 'ANDROID', ?, ?, ?)`,
      [TILL, BUSINESS, CREATED, CREATED, CREATED],
    );
  });
});

function aProduct(overrides: Partial<SaveProduct> = {}): SaveProduct {
  return {
    id: "product-1",
    businessId: BUSINESS,
    name: "Riz parfumé 5kg",
    unit: "sac",
    divisible: false,
    sellingPriceMinor: 6_500,
    currency: "XAF",
    taxRateBasisPoints: 0,
    minimumStock: 0,
    active: true,
    createdAt: CREATED,
    updatedAt: CREATED,
    userId: USER,
    deviceId: TILL,
    ...overrides,
  };
}

/** Stocks the shelf with things whose names overlap the way real ones do. */
function stock(): void {
  saveProduct(database, aProduct({ id: "p-savon", name: "Savon de Marseille" }));
  saveProduct(database, aProduct({ id: "p-gros", name: "Gros Savon Bleu" }));
  saveProduct(
    database,
    aProduct({ id: "p-lait", name: "Nido Lait 400g", barcode: "6001234567890", sku: "LAIT-400" }),
  );
  saveProduct(database, aProduct({ id: "p-old", name: "Savon ancien", active: false }));
}

function found(term: string, limit?: number): string[] {
  return database
    .transaction((tx) => searchProducts(tx, BUSINESS, term, limit))
    .map((product) => product.id);
}

describe("finding a product at the till", () => {
  it("puts a scanned barcode first, because there is nothing to choose", () => {
    // A scanner types the whole code and presses enter. §46 calls this the POS
    // path, and it has to be the fast one.
    stock();
    assert.deepEqual(found("6001234567890"), ["p-lait"]);
  });

  it("finds a product by its SKU", () => {
    stock();
    assert.deepEqual(found("LAIT-400"), ["p-lait"]);
  });

  it("ranks a name that starts with the term above one that merely contains it", () => {
    // Someone typing three letters is spelling the start of a word, and the
    // first row is the one that gets tapped.
    stock();
    assert.deepEqual(found("Savon"), ["p-savon", "p-gros"]);
  });

  it("still finds a word in the middle of a name", () => {
    stock();
    assert.deepEqual(found("Lait"), ["p-lait"]);
  });

  it("leaves out what the shop no longer sells", () => {
    // A till offering it wastes the one tap the cashier had.
    stock();
    assert.equal(found("Savon").includes("p-old"), false);
  });

  it("treats a wildcard as text, not as a wildcard", () => {
    // A shopkeeper searching for "50%" wants the product, not every product.
    saveProduct(database, aProduct({ id: "p-off", name: "Lessive 50% gratuit" }));
    saveProduct(database, aProduct({ id: "p-other", name: "Savon ordinaire" }));

    assert.deepEqual(found("50%"), ["p-off"]);
    // A bare "%" searches for the character, so it finds the one name that has
    // one — not the whole catalogue, which is what an unescaped wildcard would
    // have returned.
    assert.deepEqual(found("%"), ["p-off"]);
    assert.deepEqual(found("_"), []);
  });

  it("finds nothing for an empty term rather than everything", () => {
    // The state a till is in before anyone types, which must not become a full
    // catalogue scan on every keystroke.
    stock();
    assert.deepEqual(found(""), []);
    assert.deepEqual(found("   "), []);
  });

  it("honours the limit, so one keystroke cannot pull the whole catalogue", () => {
    stock();
    assert.equal(found("Savon", 1).length, 1);
  });

  it("finds nothing belonging to another business", () => {
    stock();
    assert.deepEqual(
      database
        .transaction((tx) => searchProducts(tx, "another-business", "Savon"))
        .map((product) => product.id),
      [],
    );
  });
});
