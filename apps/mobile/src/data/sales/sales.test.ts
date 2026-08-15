import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { stockOf } from "../inventory/movements.ts";
import { pending } from "../sync/outbox.ts";
import { completeSale, movementIdFor, SaleError, totalsOf, type Cart } from "./sales.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL = "33333333-3333-7333-8333-333333333333";
const RICE = "55555555-5555-7555-8555-555555555555";
const SUGAR = "66666666-6666-7666-8666-666666666666";
const TILL_ACCOUNT = "77777777-7777-7777-8777-777777777777";
const WALLET = "88888888-8888-7888-8888-888888888888";
const CREATED = "2026-08-01T08:00:00.000Z";
const SOLD = "2026-08-14T09:30:00.000Z";
const RECORDED = "2026-08-14T10:30:00.000Z";

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
       VALUES (?, ?, 'Jean', 'CASHIER', ?, ?)`,
      [USER, BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'Till', 'ANDROID', ?, ?, ?)`,
      [TILL, BUSINESS, CREATED, CREATED, CREATED],
    );
    for (const [id, name, price] of [
      [RICE, "Riz parfumé 5kg", 6_500],
      [SUGAR, "Sucre 1kg", 900],
    ] as const) {
      tx.run(
        `INSERT INTO products (id, business_id, name, unit, divisible, selling_price_minor,
                               currency, created_at, updated_at)
         VALUES (?, ?, ?, 'sac', 1, ?, 'XAF', ?, ?)`,
        [id, BUSINESS, name, price, CREATED, CREATED],
      );
    }
  });
}

let counter = 0;
function nextId(prefix: string): string {
  counter++;
  return `${prefix}-${counter}`;
}

function aCart(overrides: Partial<Cart> = {}): Cart {
  const saleId = nextId("sale");
  return {
    id: saleId,
    businessId: BUSINESS,
    number: nextId("V"),
    lines: [
      {
        id: nextId("line"),
        productId: RICE,
        name: "Riz parfumé 5kg",
        unitPriceMinor: 6_500,
        quantity: 2_000,
        unitCostMinor: 5_000,
      },
    ],
    payments: [{ id: nextId("pay"), accountId: TILL_ACCOUNT, amountMinor: 13_000 }],
    userId: USER,
    deviceId: TILL,
    occurredAt: SOLD,
    recordedAt: RECORDED,
    eventId: nextId("event"),
    ...overrides,
  };
}

beforeEach(() => {
  database = openDatabase();
  migrate(database);
  seed();
  counter = 0;
});

describe("completing a sale", () => {
  it("writes the sale, its lines, its stock, its payments, and its event", () => {
    const cart = aCart();

    const totals = completeSale(database, cart);

    assert.equal(totals.totalMinor, 13_000);
    assert.equal(totals.outstandingMinor, 0);

    const counts = database.transaction((tx) => ({
      sales: tx.get(`SELECT count(*) AS n FROM sales`)?.["n"],
      items: tx.get(`SELECT count(*) AS n FROM sale_items`)?.["n"],
      payments: tx.get(`SELECT count(*) AS n FROM sale_payments`)?.["n"],
      movements: tx.get(`SELECT count(*) AS n FROM inventory_movements`)?.["n"],
      queued: pending(tx, 10).length,
    }));
    assert.deepEqual(counts, { sales: 1, items: 1, payments: 1, movements: 1, queued: 1 });

    // Two bags sold, so the shelf is two down.
    assert.equal(stockOf(database, BUSINESS, RICE).onHandThousandths, -2_000);
  });

  it("writes nothing at all when any part of it fails", () => {
    // A product this device does not have, which the foreign key refuses.
    const cart = aCart({
      lines: [
        {
          id: nextId("line"),
          productId: RICE,
          name: "Riz parfumé 5kg",
          unitPriceMinor: 6_500,
          quantity: 1_000,
        },
        {
          id: nextId("line"),
          productId: "99999999-9999-7999-8999-999999999999",
          name: "Inconnu",
          unitPriceMinor: 500,
          quantity: 1_000,
        },
      ],
      payments: [{ id: nextId("pay"), accountId: TILL_ACCOUNT, amountMinor: 7_000 }],
    });

    assert.throws(() => completeSale(database, cart));

    // Not the sale, not the first good line, not its stock, and not the event.
    const counts = database.transaction((tx) => ({
      sales: tx.get(`SELECT count(*) AS n FROM sales`)?.["n"],
      items: tx.get(`SELECT count(*) AS n FROM sale_items`)?.["n"],
      payments: tx.get(`SELECT count(*) AS n FROM sale_payments`)?.["n"],
      movements: tx.get(`SELECT count(*) AS n FROM inventory_movements`)?.["n"],
      queued: pending(tx, 10).length,
    }));
    assert.deepEqual(counts, { sales: 0, items: 0, payments: 0, movements: 0, queued: 0 });
  });

  it("moves every product a multi-line sale touched", () => {
    completeSale(
      database,
      aCart({
        lines: [
          {
            id: nextId("line"),
            productId: RICE,
            name: "Riz parfumé 5kg",
            unitPriceMinor: 6_500,
            quantity: 2_000,
          },
          {
            id: nextId("line"),
            productId: SUGAR,
            name: "Sucre 1kg",
            unitPriceMinor: 900,
            quantity: 3_000,
          },
        ],
        payments: [{ id: nextId("pay"), accountId: TILL_ACCOUNT, amountMinor: 15_700 }],
      }),
    );

    assert.equal(stockOf(database, BUSINESS, RICE).onHandThousandths, -2_000);
    assert.equal(stockOf(database, BUSINESS, SUGAR).onHandThousandths, -3_000);
  });

  it("records the §11 split payment as two payments against one sale", () => {
    const cart = aCart({
      lines: [
        {
          id: nextId("line"),
          productId: RICE,
          name: "Riz parfumé 5kg",
          unitPriceMinor: 18_500,
          quantity: 1_000,
        },
      ],
      payments: [
        { id: nextId("pay"), accountId: TILL_ACCOUNT, amountMinor: 10_000 },
        {
          id: nextId("pay"),
          accountId: WALLET,
          amountMinor: 8_500,
          reference: "MP260814.0930.A12345",
        },
      ],
    });

    const totals = completeSale(database, cart);

    assert.equal(totals.paidMinor, 18_500);
    assert.equal(totals.outstandingMinor, 0);

    // Spread into plain objects: node:sqlite hands back null-prototype rows,
    // which deepStrictEqual distinguishes from object literals.
    const rows = database
      .transaction((tx) =>
        tx.all(`SELECT account_id, amount_minor, reference FROM sale_payments ORDER BY amount_minor`),
      )
      .map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { account_id: WALLET, amount_minor: 8_500, reference: "MP260814.0930.A12345" },
      { account_id: TILL_ACCOUNT, amount_minor: 10_000, reference: null },
    ]);
  });

  it("leaves the balance owing on a credit sale", () => {
    const totals = completeSale(
      database,
      aCart({
        customerId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
        payments: [{ id: nextId("pay"), accountId: TILL_ACCOUNT, amountMinor: 5_000 }],
      }),
    );

    assert.equal(totals.outstandingMinor, 8_000);
  });

  it("completes a sale paid entirely on credit", () => {
    const totals = completeSale(
      database,
      aCart({ customerId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", payments: [] }),
    );

    assert.equal(totals.paidMinor, 0);
    assert.equal(totals.outstandingMinor, 13_000);
  });

  it("keeps the stock movement traceable to the sale that caused it", () => {
    const cart = aCart();
    completeSale(database, cart);

    const movement = database.transaction((tx) => ({
      ...tx.get(`SELECT id, reference_kind, reference_id, type FROM inventory_movements`),
    }));
    assert.deepEqual(movement, {
      id: movementIdFor(cart.lines[0]?.id ?? ""),
      reference_kind: "SALE",
      reference_id: cart.id,
      type: "SALE",
    });
  });
});

describe("the arithmetic", () => {
  function totalOf(unitPriceMinor: number, quantity: number): number {
    return totalsOf(
      aCart({
        lines: [{ id: "l", productId: RICE, name: "Riz", unitPriceMinor, quantity }],
        payments: [],
        customerId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).totalMinor;
  }

  it("prices a fractional quantity proportionally", () => {
    assert.equal(totalOf(1_000, 500), 500);
    assert.equal(totalOf(1_000, 250), 250);
    assert.equal(totalOf(1_000, 1_500), 1_500);
    assert.equal(totalOf(1_000, 1), 1);
  });

  it("rounds a half away from zero, as the server does", () => {
    // The same table as the Go tests. A device and a server that rounded
    // differently would disagree by a franc a line, with nobody able to say
    // which was right.
    assert.equal(totalOf(100, 4), 0); // 0.4
    assert.equal(totalOf(100, 5), 1); // 0.5 → 1
    assert.equal(totalOf(100, 6), 1); // 0.6
    assert.equal(totalOf(3, 333), 1); // 0.999
    assert.equal(totalOf(7, 333), 2); // 2.331
    assert.equal(totalOf(999_999, 1), 1_000); // 999.999
  });

  it("takes a line discount off the line and a sale discount off the total", () => {
    const totals = totalsOf(
      aCart({
        lines: [
          {
            id: "l",
            productId: RICE,
            name: "Riz",
            unitPriceMinor: 10_000,
            quantity: 1_000,
            discountMinor: 1_000,
          },
        ],
        discountMinor: 500,
        payments: [{ id: "p", accountId: TILL_ACCOUNT, amountMinor: 8_500 }],
      }),
    );

    assert.equal(totals.subtotalMinor, 9_000);
    assert.equal(totals.totalMinor, 8_500);
  });

  it("refuses arithmetic that would stop being exact", () => {
    assert.throws(
      () => totalOf(Number.MAX_SAFE_INTEGER, 2_000),
      /too large to be exact/,
    );
  });
});

describe("refusing a sale that does not add up", () => {
  it("refuses a discount larger than what it comes off", () => {
    assert.throws(
      () =>
        totalsOf(
          aCart({
            lines: [
              {
                id: "l",
                productId: RICE,
                name: "Riz",
                unitPriceMinor: 1_000,
                quantity: 1_000,
                discountMinor: 1_001,
              },
            ],
            payments: [],
            customerId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
          }),
        ),
      /exceeds the line/,
    );

    assert.throws(
      () => totalsOf(aCart({ discountMinor: 999_999, payments: [] })),
      /exceeds the sale/,
    );
  });

  it("refuses more paid than the sale comes to", () => {
    assert.throws(
      () => totalsOf(aCart({ payments: [{ id: "p", accountId: TILL_ACCOUNT, amountMinor: 13_001 }] })),
      /against a total of/,
    );
  });

  it("refuses a balance with nobody to owe it", () => {
    assert.throws(
      () => totalsOf(aCart({ payments: [{ id: "p", accountId: TILL_ACCOUNT, amountMinor: 1_000 }] })),
      /no customer to owe it/,
    );
  });

  it("refuses a sale with no lines", () => {
    assert.throws(() => totalsOf(aCart({ lines: [], payments: [] })), /at least one line/);
  });

  it("refuses a line that sells nothing or less than nothing", () => {
    for (const quantity of [0, -1_000, 1.5]) {
      assert.throws(
        () =>
          totalsOf(
            aCart({
              lines: [{ id: "l", productId: RICE, name: "Riz", unitPriceMinor: 100, quantity }],
              payments: [],
              customerId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
            }),
          ),
        SaleError,
      );
    }
  });

  it("refuses the same line or payment twice", () => {
    const line = { id: "l", productId: RICE, name: "Riz", unitPriceMinor: 100, quantity: 1_000 };
    assert.throws(
      () => totalsOf(aCart({ lines: [line, line], payments: [] , customerId: "c" })),
      /appears twice/,
    );

    const payment = { id: "p", accountId: TILL_ACCOUNT, amountMinor: 100 };
    assert.throws(() => totalsOf(aCart({ payments: [payment, payment] })), /appears twice/);
  });

  it("refuses a sale recorded before it happened", () => {
    assert.throws(
      () => totalsOf(aCart({ recordedAt: "2026-08-14T09:00:00.000Z" })),
      /before it happened/,
    );
  });

  it("refuses a sale missing what it cannot exist without", () => {
    for (const field of ["id", "businessId", "number", "userId", "deviceId", "eventId"] as const) {
      assert.throws(() => totalsOf(aCart({ [field]: "  " })), SaleError, `expected ${field}`);
    }
  });

  it("leaves the database untouched when the arithmetic is refused", () => {
    assert.throws(() =>
      completeSale(database, aCart({ payments: [{ id: "p", accountId: TILL_ACCOUNT, amountMinor: 99_999 }] })),
    );

    const sales = database.transaction((tx) => tx.get(`SELECT count(*) AS n FROM sales`)?.["n"]);
    assert.equal(sales, 0);
  });
});

describe("the event it queues", () => {
  it("carries the fields the server expects, and no others", () => {
    const cart = aCart();
    completeSale(database, cart);

    const [queued] = database.transaction((tx) => pending(tx, 10));
    assert.equal(queued?.type, "SALE_COMPLETED");

    const payload = queued?.payload as {
      sale: Record<string, unknown>;
      payments: Record<string, unknown>[];
      movements: Record<string, unknown>[];
    };

    // No business, branch, user, device, or currency anywhere: the server takes
    // all of them from the authenticated envelope and refuses a field it does
    // not know.
    assert.deepEqual(Object.keys(payload.sale).sort(), ["id", "items", "number", "occurred_at"]);
    assert.deepEqual(Object.keys(payload.sale["items"] as never).length, 1);
    assert.deepEqual(Object.keys((payload.sale["items"] as Record<string, unknown>[])[0] ?? {}).sort(), [
      "id",
      "name",
      "product_id",
      "quantity",
      "unit_cost_minor",
      "unit_price_minor",
    ]);
    assert.deepEqual(Object.keys(payload.payments[0] ?? {}).sort(), [
      "account_id",
      "amount_minor",
      "id",
    ]);
    assert.deepEqual(Object.keys(payload.movements[0] ?? {}).sort(), [
      "id",
      "product_id",
      "quantity",
      "reference_id",
      "reference_kind",
      "type",
      "unit_cost_minor",
    ]);
  });

  it("sends the movement negative, matching what it wrote locally", () => {
    const cart = aCart();
    completeSale(database, cart);

    const [queued] = database.transaction((tx) => pending(tx, 10));
    const payload = queued?.payload as { movements: { quantity: number; id: string }[] };

    assert.equal(payload.movements[0]?.quantity, -2_000);
    // The same identifier the local ledger holds, so the sale coming back from
    // the server is recognised rather than applied a second time.
    assert.equal(payload.movements[0]?.id, movementIdFor(cart.lines[0]?.id ?? ""));
  });
});

describe("a completed sale is history", () => {
  it("cannot be changed or deleted, even directly", () => {
    const cart = aCart();
    completeSale(database, cart);

    for (const sql of [
      `UPDATE sales SET number = 'V-999' WHERE id = ?`,
      `DELETE FROM sales WHERE id = ?`,
      `UPDATE sale_items SET unit_price_minor = 1 WHERE sale_id = ?`,
      `DELETE FROM sale_items WHERE sale_id = ?`,
      `UPDATE sale_payments SET amount_minor = 1 WHERE sale_id = ?`,
      `DELETE FROM sale_payments WHERE sale_id = ?`,
    ]) {
      assert.throws(
        () => database.transaction((tx) => tx.run(sql, [cart.id])),
        /immutable/,
        sql,
      );
    }
  });

  it("cannot reuse a receipt number within a business", () => {
    const first = aCart({ number: "V-000001" });
    completeSale(database, first);

    assert.throws(() => completeSale(database, aCart({ number: "V-000001" })));
  });
});
