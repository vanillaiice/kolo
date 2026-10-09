import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { balanceOfAccount } from "../finance/cash.ts";
import { stockOf } from "../inventory/movements.ts";
import { balanceOfSupplier } from "../suppliers/suppliers.ts";
import { pending } from "../sync/outbox.ts";
import {
  PurchaseError,
  recordPurchase,
  totalsOfDelivery,
  type Delivery,
  type DeliveryLine,
} from "./purchases.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL = "33333333-3333-7333-8333-333333333333";
const ACCOUNT = "55555555-5555-7555-8555-555555555555";
const PRODUCT = "66666666-6666-7666-8666-666666666666";
const SUPPLIER = "77777777-7777-7777-8777-777777777777";
const CREATED = "2026-08-01T08:00:00.000Z";
const ARRIVED = "2026-08-14T09:00:00.000Z";
const RECORDED = "2026-08-14T10:00:00.000Z";

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
       VALUES (?, ?, 'Jean', 'CASHIER', ?, ?)`,
      [USER, BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'Till', 'ANDROID', ?, ?, ?)`,
      [TILL, BUSINESS, CREATED, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO financial_accounts (id, business_id, name, kind, currency, created_at, updated_at)
       VALUES (?, ?, 'Caisse', 'CASH', 'XAF', ?, ?)`,
      [ACCOUNT, BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO products
         (id, business_id, name, unit, selling_price_minor, currency, created_at, updated_at)
       VALUES (?, ?, 'Riz 5kg', 'PIECE', 6000, 'XAF', ?, ?)`,
      [PRODUCT, BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO suppliers (id, business_id, name, created_at, updated_at)
       VALUES (?, ?, 'Grossiste Mokolo', ?, ?)`,
      [SUPPLIER, BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO account_movements
         (id, account_id, business_id, type, amount_minor, currency,
          user_id, device_id, occurred_at, recorded_at)
       VALUES ('float', ?, ?, 'OPENING_BALANCE', 200000, 'XAF', ?, ?, ?, ?)`,
      [ACCOUNT, BUSINESS, USER, TILL, ARRIVED, ARRIVED],
    );
  });
});

let counter = 0;
function nextId(prefix: string): string {
  counter++;
  return `${prefix}-${counter}`;
}

/** §15's worked example: 20 crates at 5,000 comes to 100,000. */
function aLine(overrides: Partial<DeliveryLine> = {}): DeliveryLine {
  return {
    id: nextId("line"),
    movementId: nextId("movement"),
    productId: PRODUCT,
    unitCostMinor: 5_000,
    quantity: 20_000,
    ...overrides,
  };
}

function aDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: nextId("purchase"),
    businessId: BUSINESS,
    supplierId: SUPPLIER,
    lines: [aLine()],
    payments: [],
    userId: USER,
    deviceId: TILL,
    occurredAt: ARRIVED,
    recordedAt: RECORDED,
    eventId: nextId("event"),
    ...overrides,
  };
}

function paidInFull(overrides: Partial<Delivery> = {}): Delivery {
  return aDelivery({
    payments: [
      { id: nextId("payment"), accountId: ACCOUNT, amountMinor: 100_000, reason: "payé au livreur" },
    ],
    ...overrides,
  });
}

function stock(): number {
  return database.transaction((tx) => stockOf(tx, BUSINESS, PRODUCT).onHandThousandths);
}

function owed(): number {
  return database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, SUPPLIER).outstandingMinor);
}

function drawer(): number {
  return database.transaction((tx) => balanceOfAccount(tx, BUSINESS, ACCOUNT).onHandMinor);
}

describe("§15's two cases", () => {
  it("paid at the door: stock up, cash down, nothing owed", () => {
    const totals = recordPurchase(database, paidInFull());

    assert.equal(totals.totalMinor, 100_000);
    assert.equal(totals.paidMinor, 100_000);
    assert.equal(totals.outstandingMinor, 0);
    assert.equal(stock(), 20_000);
    assert.equal(drawer(), 100_000);
    assert.equal(owed(), 0);
  });

  it("on credit: stock up, cash untouched, the whole bill owed", () => {
    const totals = recordPurchase(
      database,
      aDelivery({ supplierTransactionId: nextId("entry") }),
    );

    assert.equal(totals.outstandingMinor, 100_000);
    assert.equal(stock(), 20_000);
    assert.equal(drawer(), 200_000);
    assert.equal(owed(), 100_000);
  });

  it("partly paid: the wholesaler is owed exactly the rest", () => {
    // The debt is the delivery's own arithmetic, never a figure handed in.
    recordPurchase(
      database,
      aDelivery({
        payments: [
          { id: nextId("payment"), accountId: ACCOUNT, amountMinor: 40_000, reason: "acompte" },
        ],
        supplierTransactionId: nextId("entry"),
      }),
    );

    assert.equal(stock(), 20_000);
    assert.equal(drawer(), 160_000);
    assert.equal(owed(), 60_000);
  });
});

describe("the fan-out", () => {
  it("writes everything or nothing", () => {
    // Half of it landing describes something that did not happen: stock on the
    // shelf the books never paid for, or money gone with no goods to show.
    const delivery = aDelivery({
      // A line naming a product this device does not hold: the foreign key
      // refuses it, and the whole delivery must go with it.
      lines: [aLine(), aLine({ productId: "no-such-product" })],
      supplierTransactionId: nextId("entry"),
    });
    assert.throws(() => recordPurchase(database, delivery));

    assert.equal(stock(), 0);
    assert.equal(owed(), 0);
    assert.equal(drawer(), 200_000);
    const held = database.transaction((tx) =>
      tx.get(`SELECT id FROM purchases WHERE id = ?`, [delivery.id]),
    );
    assert.equal(held, undefined);
    // And no event, so the device does not tell the server about a delivery it
    // did not record (ADR-014).
    assert.equal(database.transaction((tx) => pending(tx, 10)).length, 0);
  });

  it("queues one event carrying the whole delivery", () => {
    const delivery = paidInFull({ reference: "BL-2026-118", note: "livré le matin" });
    recordPurchase(database, delivery);

    const queued = database.transaction((tx) => pending(tx, 10));
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.type, "PURCHASE_RECORDED");

    const body = queued[0]?.payload as {
      purchase: Record<string, unknown>;
      payments: Record<string, unknown>[];
      movements: Record<string, unknown>[];
    };
    assert.equal(body.purchase["id"], delivery.id);
    assert.equal(body.purchase["supplier_id"], SUPPLIER);
    assert.equal(body.purchase["reference"], "BL-2026-118");
    assert.equal(body.purchase["note"], "livré le matin");
    assert.equal(body.payments.length, 1);
    // Signed as it will be stored: money leaving is negative.
    assert.equal(body.payments[0]?.["amount_minor"], -100_000);
    assert.equal(body.movements.length, 1);
    assert.equal(body.movements[0]?.["type"], "PURCHASE");
    assert.equal(body.movements[0]?.["quantity"], 20_000);
    // What is owed is deliberately absent: the server derives it, so a device
    // with a rounding bug cannot put a different number on the account.
    assert.equal(body.purchase["outstanding_minor"], undefined);
  });

  it("sends no field the server does not know", () => {
    // The server refuses a payload carrying an unknown field, so a field added
    // on one side and not the other rejects every event from this client.
    recordPurchase(
      database,
      paidInFull({ reference: "BL-118", note: "n", supplierTransactionId: undefined }),
    );
    const body = database.transaction((tx) => pending(tx, 10))[0]?.payload as {
      purchase: Record<string, unknown>;
      payments: Record<string, unknown>[];
      movements: Record<string, unknown>[];
    };

    assert.deepEqual(Object.keys(body).sort(), ["movements", "payments", "purchase"]);
    assert.deepEqual(Object.keys(body.purchase).sort(), [
      "id",
      "items",
      "note",
      "occurred_at",
      "reference",
      "supplier_id",
    ]);
    assert.deepEqual(Object.keys(body.purchase["items"] as Record<string, unknown>[]).length, 1);
    assert.deepEqual((body.purchase["items"] as Record<string, unknown>[])[0], {
      id: (body.purchase["items"] as Record<string, unknown>[])[0]?.["id"],
      product_id: PRODUCT,
      unit_cost_minor: 5_000,
      quantity: 20_000,
    });
    assert.deepEqual(Object.keys(body.payments[0] ?? {}).sort(), [
      "account_id",
      "amount_minor",
      "id",
      "occurred_at",
      "reason",
    ]);
    assert.deepEqual(Object.keys(body.movements[0] ?? {}).sort(), [
      "id",
      "product_id",
      "quantity",
      "reference_id",
      "reference_kind",
      "type",
      "unit_cost_minor",
    ]);
  });

  it("draws every identifier rather than composing one", () => {
    // Every identifier in a payload is parsed as a UUID on arrival (ADR-011).
    // A derived one — a line's with a suffix — has the event rejected with the
    // delivery already recorded on the till and nothing there to explain it.
    const line = aLine();
    const delivery = paidInFull({ lines: [line] });
    recordPurchase(database, delivery);

    const body = database.transaction((tx) => pending(tx, 10))[0]?.payload as {
      purchase: { items: Record<string, unknown>[] };
      movements: Record<string, unknown>[];
    };
    assert.equal(body.purchase.items[0]?.["id"], line.id);
    assert.equal(body.movements[0]?.["id"], line.movementId);
    assert.notEqual(line.movementId, line.id);
  });

  it("points the stock and the debt back at the delivery", () => {
    // §40: a ledger stays traceable to the business event that caused it.
    const delivery = aDelivery({ supplierTransactionId: nextId("entry") });
    recordPurchase(database, delivery);

    const movement = database.transaction((tx) =>
      tx.get(`SELECT * FROM inventory_movements WHERE reference_id = ?`, [delivery.id]),
    );
    assert.equal(movement?.["reference_kind"], "PURCHASE");
    assert.equal(movement?.["type"], "PURCHASE");
    // The unit cost travels with it, because §8's valuation reads what stock
    // cost from the movements that brought it in.
    assert.equal(movement?.["unit_cost_minor"], 5_000);

    const entry = database.transaction((tx) =>
      tx.get(`SELECT * FROM supplier_transactions WHERE reference_id = ?`, [delivery.id]),
    );
    assert.equal(entry?.["reference_kind"], "PURCHASE");
    assert.equal(entry?.["amount_minor"], 100_000);
  });
});

describe("a delivery from nobody", () => {
  it("still records the money leaving the drawer", () => {
    // A crate bought at the market names no wholesaler, and requiring one would
    // stop the stock being recorded at all — but the cash still went.
    recordPurchase(database, paidInFull({ supplierId: undefined }));

    assert.equal(stock(), 20_000);
    assert.equal(drawer(), 100_000);
  });

  it("cannot be left owing", () => {
    assert.throws(
      () => recordPurchase(database, aDelivery({ supplierId: undefined })),
      PurchaseError,
    );
  });
});

describe("what a delivery comes to", () => {
  it("rounds a part-unit line half away from zero, as the server does", () => {
    // 1,500 thousandths of a 333 sack is 499.5, which rounds to 500 here and in
    // Go. A device and a server that round differently disagree by a franc a
    // line and nobody can say which is right.
    const totals = totalsOfDelivery(
      aDelivery({ lines: [aLine({ unitCostMinor: 333, quantity: 1_500 })], payments: [] }),
    );
    assert.equal(totals.totalMinor, 500);
  });

  it("refuses more paid than the delivery cost", () => {
    // Storing it would take money out of an account never handed over.
    assert.throws(
      () =>
        recordPurchase(
          database,
          aDelivery({
            payments: [
              { id: nextId("payment"), accountId: ACCOUNT, amountMinor: 150_000, reason: "trop" },
            ],
          }),
        ),
      PurchaseError,
    );
  });

  it("refuses a delivery of nothing", () => {
    assert.throws(() => recordPurchase(database, aDelivery({ lines: [] })), PurchaseError);
  });

  it("refuses a line that brought nothing in", () => {
    for (const quantity of [0, -1, 1.5]) {
      assert.throws(
        () => recordPurchase(database, aDelivery({ lines: [aLine({ quantity })] })),
        PurchaseError,
      );
    }
  });

  it("refuses a line costing less than nothing", () => {
    // A cost is required here, unlike a sale line's price: this is where a cost
    // is learned (§8). Zero is allowed — a free sample is a real delivery.
    assert.throws(
      () => recordPurchase(database, aDelivery({ lines: [aLine({ unitCostMinor: -1 })] })),
      PurchaseError,
    );
    assert.doesNotThrow(() =>
      recordPurchase(
        database,
        aDelivery({ lines: [aLine({ unitCostMinor: 0 })], payments: [] }),
      ),
    );
  });

  it("refuses the same line twice", () => {
    const line = aLine();
    assert.throws(
      () => recordPurchase(database, aDelivery({ lines: [line, line] })),
      PurchaseError,
    );
  });

  it("refuses a line total too large to be exact", () => {
    // Beyond a safe integer a cost is no longer exact in a double, and money
    // that is not exact is not money (ADR-010).
    assert.throws(
      () =>
        totalsOfDelivery(
          aDelivery({ lines: [aLine({ unitCostMinor: Number.MAX_SAFE_INTEGER, quantity: 2_000 })] }),
        ),
      PurchaseError,
    );
  });
});

describe("the debt and its ledger entry", () => {
  it("refuses a delivery left owing with no entry to carry it", () => {
    assert.throws(
      () => recordPurchase(database, aDelivery({ supplierTransactionId: undefined })),
      PurchaseError,
    );
  });

  it("refuses an entry on a delivery that owes nothing", () => {
    assert.throws(
      () => recordPurchase(database, paidInFull({ supplierTransactionId: nextId("entry") })),
      PurchaseError,
    );
  });
});

describe("a delivery that cannot be recorded", () => {
  it("refuses one missing what it needs", () => {
    for (const overrides of [
      { id: "" },
      { businessId: "" },
      { userId: "" },
      { deviceId: "" },
      { occurredAt: "" },
      { recordedAt: "" },
      { eventId: "" },
    ] as Partial<Delivery>[]) {
      assert.throws(() => recordPurchase(database, paidInFull(overrides)), PurchaseError);
    }
  });

  it("refuses one recorded before it arrived", () => {
    assert.throws(
      () => recordPurchase(database, paidInFull({ occurredAt: RECORDED, recordedAt: ARRIVED })),
      PurchaseError,
    );
  });

  it("refuses a door payment with no reason for the cash leaving", () => {
    // §41 makes taking money out sensitive, and the schema refuses a CASH_OUT
    // without one.
    assert.throws(
      () =>
        recordPurchase(
          database,
          aDelivery({
            payments: [
              { id: nextId("payment"), accountId: ACCOUNT, amountMinor: 100_000, reason: "  " },
            ],
          }),
        ),
      PurchaseError,
    );
  });

  it("refuses a door payment that is not money changing hands", () => {
    for (const amountMinor of [0, -1]) {
      assert.throws(
        () =>
          recordPurchase(
            database,
            aDelivery({
              payments: [{ id: nextId("payment"), accountId: ACCOUNT, amountMinor, reason: "r" }],
            }),
          ),
        PurchaseError,
      );
    }
  });
});

describe("a delivery already recorded", () => {
  it("cannot be edited or deleted, because a return is its own transaction", () => {
    const delivery = paidInFull();
    recordPurchase(database, delivery);

    assert.throws(() =>
      database.transaction((tx) => {
        tx.run(`UPDATE purchases SET reference = 'changed' WHERE id = ?`, [delivery.id]);
      }),
    );
    assert.throws(() =>
      database.transaction((tx) => {
        tx.run(`DELETE FROM purchases WHERE id = ?`, [delivery.id]);
      }),
    );
    assert.throws(() =>
      database.transaction((tx) => {
        tx.run(`UPDATE purchase_items SET quantity = 1 WHERE purchase_id = ?`, [delivery.id]);
      }),
    );
  });

  it("refuses a second one under the same identifier", () => {
    const delivery = paidInFull();
    recordPurchase(database, delivery);
    assert.throws(() => recordPurchase(database, paidInFull({ id: delivery.id })));
  });
});
