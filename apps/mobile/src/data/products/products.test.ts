import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { pending } from "../sync/outbox.ts";
import {
  listProducts,
  productByBarcode,
  productOf,
  ProductError,
  saveProduct,
  upsert,
  type SaveProduct,
} from "./products.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL = "33333333-3333-7333-8333-333333333333";
const PHONE = "44444444-4444-7444-8444-444444444444";
const CREATED = "2026-08-01T08:00:00.000Z";
const EARLIER = "2026-08-14T09:00:00.000Z";
const LATER = "2026-08-14T17:00:00.000Z";

let database: Database;

function seed(): void {
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
    for (const [id, label] of [
      [TILL, "Till"],
      [PHONE, "Phone"],
    ]) {
      tx.run(
        `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, 'ANDROID', ?, ?, ?)`,
        [id ?? "", BUSINESS, label ?? "", CREATED, CREATED, CREATED],
      );
    }
  });
}

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
    updatedAt: EARLIER,
    userId: USER,
    deviceId: TILL,
    ...overrides,
  };
}

beforeEach(() => {
  database = openDatabase();
  migrate(database);
  seed();
});

describe("saving a product", () => {
  it("stores it and queues its event together", () => {
    assert.equal(saveProduct(database, aProduct()), true);

    const stored = database.transaction((tx) => productOf(tx, BUSINESS, "product-1"));
    assert.equal(stored?.sellingPriceMinor, 6_500);

    const [queued] = database.transaction((tx) => pending(tx, 10));
    assert.equal(queued?.type, "PRODUCT_SAVED");
  });

  it("queues neither when the write fails", () => {
    // A category that does not exist, which the foreign key refuses.
    assert.throws(() => {
      saveProduct(database, aProduct({ categoryId: "no-such-category" }));
    });

    assert.equal(database.transaction((tx) => pending(tx, 10)).length, 0);
    assert.equal(database.transaction((tx) => productOf(tx, BUSINESS, "product-1")), undefined);
  });

  it("sends the payload the server expects, and nothing more", () => {
    saveProduct(database, aProduct({ barcode: "6001234567890", purchasePriceMinor: 5_000 }));

    const [queued] = database.transaction((tx) => pending(tx, 10));
    const payload = queued?.payload as { product: Record<string, unknown> };

    // The server refuses a field it does not know, so this list is a contract.
    // No business and no device: both come from the envelope.
    assert.deepEqual(Object.keys(payload.product).sort(), [
      "barcode",
      "created_at",
      "id",
      "name",
      "purchase_price_minor",
      "selling_price_minor",
      "unit",
      "updated_at",
    ]);
  });

  it("records an edit, not a second product", () => {
    saveProduct(database, aProduct());
    saveProduct(database, aProduct({ name: "Riz parfumé 10kg", updatedAt: LATER }));

    const all = database.transaction((tx) => listProducts(tx, BUSINESS));
    assert.equal(all.length, 1);
    assert.equal(all[0]?.name, "Riz parfumé 10kg");
  });

  it("refuses a product missing what it cannot exist without", () => {
    for (const field of ["id", "businessId", "name", "unit", "userId", "deviceId"] as const) {
      assert.throws(
        () => saveProduct(database, aProduct({ [field]: "  " })),
        ProductError,
        `expected ${field} to be required`,
      );
    }
  });

  it("refuses a price that is not whole francs at or above zero", () => {
    for (const price of [-1, 1.5, Number.NaN]) {
      assert.throws(() => saveProduct(database, aProduct({ sellingPriceMinor: price })), ProductError);
    }
  });

  it("refuses an edit dated before the product existed", () => {
    assert.throws(
      () => saveProduct(database, aProduct({ updatedAt: "2026-07-01T00:00:00.000Z" })),
      /before it existed/,
    );
  });
});

describe("resolving a conflict", () => {
  /** Applies an edit as if it came from the given device. */
  function edit(price: number, at: string, device: string): boolean {
    return database.transaction((tx) =>
      upsert(tx, { ...aProduct(), sellingPriceMinor: price, updatedAt: at }, device),
    );
  }

  function price(): number | undefined {
    return database.transaction((tx) => productOf(tx, BUSINESS, "product-1"))?.sellingPriceMinor;
  }

  it("keeps the newer edit", () => {
    edit(6_500, EARLIER, TILL);
    assert.equal(edit(7_000, LATER, PHONE), true);
    assert.equal(price(), 7_000);
  });

  it("keeps the newer edit even when the older one arrives last", () => {
    edit(7_000, LATER, PHONE);
    // This is the property the ordering exists for: a device that syncs weekly
    // sees events in a different order from one that syncs hourly, and the two
    // must still agree.
    assert.equal(edit(6_500, EARLIER, TILL), false);
    assert.equal(price(), 7_000);
  });

  it("breaks a tie the same way whichever edit arrives first", () => {
    const [low, high] = [TILL, PHONE].sort();

    edit(6_500, EARLIER, low ?? "");
    edit(7_000, EARLIER, high ?? "");
    const forwards = price();

    // The same two edits, applied to a fresh database the other way round.
    database = openDatabase();
    migrate(database);
    seed();
    edit(7_000, EARLIER, high ?? "");
    edit(6_500, EARLIER, low ?? "");
    const backwards = price();

    assert.equal(
      forwards,
      backwards,
      "the same two edits gave different answers depending on order, so devices diverge",
    );
  });

  it("reports a losing edit rather than throwing", () => {
    edit(7_000, LATER, PHONE);
    assert.equal(edit(6_500, EARLIER, TILL), false);
  });

  it("is unchanged by applying the same edit twice", () => {
    edit(6_500, EARLIER, TILL);
    edit(6_500, EARLIER, TILL);
    edit(7_000, LATER, PHONE);
    edit(6_500, EARLIER, TILL);

    assert.equal(price(), 7_000);
  });

  it("queues the event even when the local write lost", () => {
    edit(7_000, LATER, PHONE);

    // The server and the other devices judge against what they hold, so an edit
    // that lost here still has to travel.
    assert.equal(saveProduct(database, aProduct({ updatedAt: EARLIER })), false);
    assert.equal(database.transaction((tx) => pending(tx, 10)).length, 1);
  });
});

describe("reading products", () => {
  it("finds one by barcode, which is the POS path", () => {
    saveProduct(database, aProduct({ barcode: "6001234567890" }));

    const found = database.transaction((tx) => productByBarcode(tx, BUSINESS, "6001234567890"));
    assert.equal(found?.id, "product-1");
  });

  it("does not find another business's product", () => {
    saveProduct(database, aProduct({ barcode: "6001234567890" }));

    const found = database.transaction((tx) =>
      productByBarcode(tx, "99999999-9999-7999-8999-999999999999", "6001234567890"),
    );
    assert.equal(found, undefined);
  });

  it("leaves archived products out of the list unless asked", () => {
    saveProduct(database, aProduct());
    saveProduct(database, aProduct({ id: "product-2", name: "Sucre", active: false }));

    assert.equal(database.transaction((tx) => listProducts(tx, BUSINESS)).length, 1);
    assert.equal(
      database.transaction((tx) => listProducts(tx, BUSINESS, { includeArchived: true })).length,
      2,
    );
  });

  it("round-trips every optional field", () => {
    saveProduct(
      database,
      aProduct({
        sku: "RIZ-5KG",
        barcode: "6001234567890",
        description: "Riz parfumé importé.",
        brand: "Uncle Sam",
        divisible: true,
        purchasePriceMinor: 5_000,
        taxRateBasisPoints: 1_925,
        minimumStock: 10_000,
      }),
    );

    const stored = database.transaction((tx) => productOf(tx, BUSINESS, "product-1"));
    assert.deepEqual(
      {
        sku: stored?.sku,
        barcode: stored?.barcode,
        description: stored?.description,
        brand: stored?.brand,
        divisible: stored?.divisible,
        purchasePriceMinor: stored?.purchasePriceMinor,
        taxRateBasisPoints: stored?.taxRateBasisPoints,
        minimumStock: stored?.minimumStock,
        updatedByDevice: stored?.updatedByDevice,
      },
      {
        sku: "RIZ-5KG",
        barcode: "6001234567890",
        description: "Riz parfumé importé.",
        brand: "Uncle Sam",
        divisible: true,
        purchasePriceMinor: 5_000,
        taxRateBasisPoints: 1_925,
        minimumStock: 10_000,
        updatedByDevice: TILL,
      },
    );
  });
});
