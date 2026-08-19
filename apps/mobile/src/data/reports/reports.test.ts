import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { recordExpense } from "../expenses/expenses.ts";
import { completeSale, type Cart, type CartLine } from "../sales/sales.ts";
import {
  dashboard,
  lowStock,
  outstandingDebt,
  profitBetween,
  salesByAccount,
  salesByProduct,
  salesBetween,
  salesByUser,
} from "./reports.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const JEAN = "22222222-2222-7222-8222-222222222222";
const ALICE = "23232323-2323-7323-8323-232323232323";
const DEVICE = "33333333-3333-7333-8333-333333333333";
const RICE = "55555555-5555-7555-8555-555555555555";
const SUGAR = "66666666-6666-7666-8666-666666666666";
const TILL = "77777777-7777-7777-8777-777777777777";
const WALLET = "88888888-8888-7888-8888-888888888888";
const CUSTOMER = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const CREATED = "2026-08-01T08:00:00.000Z";

// A day, half-open: sales at either edge prove the boundaries.
const DAY_FROM = "2026-08-14T00:00:00.000Z";
const DAY_TO = "2026-08-15T00:00:00.000Z";
const MORNING = "2026-08-14T09:30:00.000Z";
const RECORDED = "2026-08-14T10:30:00.000Z";

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
    for (const [id, name] of [
      [JEAN, "Jean"],
      [ALICE, "Alice"],
    ] as const) {
      tx.run(
        `INSERT INTO users (id, business_id, name, role, created_at, updated_at)
         VALUES (?, ?, ?, 'CASHIER', ?, ?)`,
        [id, BUSINESS, name, CREATED, CREATED],
      );
    }
    tx.run(
      `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'Till', 'ANDROID', ?, ?, ?)`,
      [DEVICE, BUSINESS, CREATED, CREATED, CREATED],
    );
    for (const [id, name, price, minimum] of [
      [RICE, "Riz parfumé 5kg", 6_500, 5_000],
      [SUGAR, "Sucre 1kg", 900, 0],
    ] as const) {
      tx.run(
        `INSERT INTO products (id, business_id, name, unit, divisible, selling_price_minor,
                               currency, minimum_stock, created_at, updated_at)
         VALUES (?, ?, ?, 'sac', 1, ?, 'XAF', ?, ?, ?)`,
        [id, BUSINESS, name, price, minimum, CREATED, CREATED],
      );
    }
    tx.run(
      `INSERT INTO customers (id, business_id, name, created_at, updated_at)
       VALUES (?, ?, 'Jean Mbarga', ?, ?)`,
      [CUSTOMER, BUSINESS, CREATED, CREATED],
    );
    for (const [id, name, kind] of [
      [TILL, "Caisse", "CASH"],
      [WALLET, "MTN Mobile Money", "MOBILE_MONEY"],
    ] as const) {
      tx.run(
        `INSERT INTO financial_accounts (id, business_id, name, kind, currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'XAF', ?, ?)`,
        [id, BUSINESS, name, kind, CREATED, CREATED],
      );
    }
  });
});

let counter = 0;
function nextId(prefix: string): string {
  counter++;
  return `${prefix}-${counter}`;
}

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    id: nextId("line"),
    movementId: nextId("stock"),
    productId: RICE,
    name: "Riz parfumé 5kg",
    unitPriceMinor: 6_500,
    quantity: 1_000,
    unitCostMinor: 5_000,
    ...overrides,
  };
}

function sell(overrides: Partial<Cart> = {}): Cart {
  const lines = overrides.lines ?? [line()];
  const total = lines.reduce(
    (sum, l) =>
      sum +
      Math.floor((l.unitPriceMinor * l.quantity + 500) / 1000) -
      (l.discountMinor ?? 0),
    0,
  );
  const cart: Cart = {
    id: nextId("sale"),
    businessId: BUSINESS,
    number: nextId("V"),
    lines,
    payments: [{ id: nextId("pay"), accountId: TILL, amountMinor: total }],
    userId: JEAN,
    deviceId: DEVICE,
    occurredAt: MORNING,
    recordedAt: RECORDED,
    eventId: nextId("event"),
    ...overrides,
  };
  completeSale(database, cart);
  return cart;
}

function read<T>(query: (tx: Parameters<typeof salesBetween>[0]) => T): T {
  return database.transaction(query);
}

describe("what a period sold", () => {
  it("totals the lines less the discounts, and counts what left the shop", () => {
    sell();
    sell({
      lines: [line({ quantity: 2_000 }), line({ productId: SUGAR, name: "Sucre 1kg", unitPriceMinor: 900, quantity: 1_000, unitCostMinor: 700 })],
    });

    const summary = read((tx) => salesBetween(tx, BUSINESS, DAY_FROM, DAY_TO));
    // 6,500 + (13,000 + 900).
    assert.equal(summary.totalMinor, 20_400);
    assert.equal(summary.transactions, 2);
    assert.equal(summary.itemsSoldThousandths, 4_000);
  });

  it("takes a sale's own discount off the bill, not off the lines", () => {
    sell({
      lines: [line()],
      discountMinor: 500,
      payments: [{ id: nextId("pay"), accountId: TILL, amountMinor: 6_000 }],
    });

    assert.equal(read((tx) => salesBetween(tx, BUSINESS, DAY_FROM, DAY_TO)).totalMinor, 6_000);
  });

  it("rounds a fractional line the way the till and the server do", () => {
    // A half rounds away from zero: the same table the sale arithmetic is
    // tested against, so a report cannot disagree with a receipt.
    sell({ lines: [line({ unitPriceMinor: 100, quantity: 5 })], payments: [] , customerId: CUSTOMER, creditTransactionId: nextId("credit") });

    assert.equal(read((tx) => salesBetween(tx, BUSINESS, DAY_FROM, DAY_TO)).totalMinor, 1);
  });

  it("counts by when business happened, not when it was recorded", () => {
    // A till that syncs on Friday still sold on Monday, and last week's takings
    // must not change because a device was slow.
    sell({ occurredAt: "2026-08-13T23:59:59.000Z", recordedAt: RECORDED });
    sell({ occurredAt: DAY_TO, recordedAt: DAY_TO });
    sell({ occurredAt: DAY_FROM, recordedAt: RECORDED });

    const summary = read((tx) => salesBetween(tx, BUSINESS, DAY_FROM, DAY_TO));
    // Half-open: the sale at midnight on the 14th counts, the one at midnight
    // on the 15th belongs to the next day.
    assert.equal(summary.transactions, 1);
  });

  it("says nothing happened when nothing did", () => {
    assert.deepEqual(read((tx) => salesBetween(tx, BUSINESS, DAY_FROM, DAY_TO)), {
      totalMinor: 0,
      transactions: 0,
      itemsSoldThousandths: 0,
    });
  });
});

describe("what a period earned", () => {
  it("takes the cost of what was sold off the revenue", () => {
    sell({ lines: [line({ quantity: 2_000 })] });

    const profit = read((tx) => profitBetween(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(profit.revenueMinor, 13_000);
    assert.equal(profit.costMinor, 10_000);
    assert.equal(profit.grossProfitMinor, 3_000);
    assert.equal(profit.linesWithoutCost, 0);
  });

  it("counts a line with no cost as an honest gap, not as free stock", () => {
    // Stock inherited from before the system has no cost, and counting it as
    // free would report a profit the shop did not make (§8).
    sell({ lines: [line({ unitCostMinor: undefined })] });

    const profit = read((tx) => profitBetween(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(profit.revenueMinor, 6_500);
    assert.equal(profit.costMinor, 0);
    assert.equal(profit.linesWithoutCost, 1);
  });
});

describe("breakdowns", () => {
  it("ranks products by what they took", () => {
    sell({ lines: [line({ quantity: 2_000 })] });
    sell({
      lines: [line({ productId: SUGAR, name: "Sucre 1kg", unitPriceMinor: 900, quantity: 1_000 })],
    });

    const byProduct = read((tx) => salesByProduct(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.deepEqual(
      byProduct.map((l) => [l.label, l.totalMinor]),
      [
        ["Riz parfumé 5kg", 13_000],
        ["Sucre 1kg", 900],
      ],
    );
  });

  it("ranks accounts by what they took, named rather than typed", () => {
    // §10: which provider took the money is the account's name.
    const cart = sell({ payments: [] , customerId: CUSTOMER, creditTransactionId: nextId("credit") });
    assert.ok(cart);
    sell({
      payments: [
        { id: nextId("pay"), accountId: WALLET, amountMinor: 4_000 },
        { id: nextId("pay"), accountId: TILL, amountMinor: 2_500 },
      ],
    });

    const byAccount = read((tx) => salesByAccount(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.deepEqual(
      byAccount.map((l) => [l.label, l.totalMinor]),
      [
        ["MTN Mobile Money", 4_000],
        ["Caisse", 2_500],
      ],
    );
  });

  it("ranks who sold what", () => {
    sell({ userId: JEAN, lines: [line({ quantity: 2_000 })] });
    sell({ userId: ALICE });

    const byUser = read((tx) => salesByUser(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.deepEqual(
      byUser.map((l) => [l.label, l.totalMinor, l.count]),
      [
        ["Jean", 13_000, 1],
        ["Alice", 6_500, 1],
      ],
    );
  });
});

describe("what customers owe", () => {
  function owe(customerId: string, amountMinor: number, type = "CREDIT_SALE"): void {
    database.transaction((tx) =>
      tx.run(
        `INSERT INTO customer_transactions
           (id, customer_id, business_id, type, amount_minor, currency, account_id,
            reference_kind, reference_id, user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, 'XAF', ?, 'SALE', 'v-1', ?, ?, ?, ?)`,
        [
          nextId("entry"),
          customerId,
          BUSINESS,
          type,
          amountMinor,
          type === "PAYMENT" ? TILL : null,
          JEAN,
          DEVICE,
          MORNING,
          RECORDED,
        ],
      ),
    );
  }

  it("lists the debts largest first and leaves out those in credit", () => {
    const alice = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
    const paid = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
    database.transaction((tx) => {
      for (const [id, name] of [
        [alice, "Alice Ngo"],
        [paid, "Chantal Etoa"],
      ] as const) {
        tx.run(
          `INSERT INTO customers (id, business_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [id, BUSINESS, name, CREATED, CREATED],
        );
      }
    });

    owe(CUSTOMER, 15_000);
    owe(alice, 40_000);
    owe(paid, 8_000);
    owe(paid, -12_000, "PAYMENT");

    const debts = read((tx) => outstandingDebt(tx, BUSINESS));
    assert.deepEqual(
      debts.map((l) => [l.label, l.totalMinor]),
      [
        ["Alice Ngo", 40_000],
        ["Jean Mbarga", 15_000],
      ],
    );
  });
});

describe("what is running out", () => {
  it("lists the products at or below their reorder point", () => {
    // Rice has a reorder point; sugar does not, so it never appears however
    // little of it there is.
    sell({ lines: [line({ quantity: 2_000 })] });

    const running = read((tx) => lowStock(tx, BUSINESS));
    assert.deepEqual(
      running.map((l) => [l.label, l.totalMinor]),
      [["Riz parfumé 5kg", -2_000]],
    );
  });
});

describe("the dashboard", () => {
  it("puts §22's figures together from the records behind them", () => {
    // 2 sacs of rice at 6,500, costing 5,000 each.
    sell({ lines: [line({ quantity: 2_000 })] });
    // And one on credit, so the customer owes it.
    sell({
      lines: [line()],
      payments: [],
      customerId: CUSTOMER,
      creditTransactionId: nextId("credit"),
    });
    recordExpense(database, {
      id: nextId("expense"),
      businessId: BUSINESS,
      category: "TRANSPORT",
      accountId: TILL,
      amountMinor: 2_000,
      userId: JEAN,
      deviceId: DEVICE,
      occurredAt: MORNING,
      recordedAt: RECORDED,
      eventId: nextId("event"),
    });

    const today = read((tx) => dashboard(tx, BUSINESS, DAY_FROM, DAY_TO));

    assert.equal(today.sales.totalMinor, 19_500);
    assert.equal(today.sales.transactions, 2);
    assert.equal(today.sales.itemsSoldThousandths, 3_000);
    assert.equal(today.profit.costMinor, 15_000);
    assert.equal(today.profit.grossProfitMinor, 4_500);
    assert.equal(today.expensesMinor, 2_000);
    assert.equal(today.netResultMinor, 2_500);
    // The credit sale put its balance on the customer's ledger.
    assert.equal(today.customerDebtMinor, 6_500);
    assert.equal(today.lowStock, 1);
  });

  it("reads as an empty day rather than as no answer", () => {
    const today = read((tx) => dashboard(tx, BUSINESS, DAY_FROM, DAY_TO));

    assert.equal(today.sales.transactions, 0);
    assert.equal(today.netResultMinor, 0);
    assert.equal(today.customerDebtMinor, 0);
    // The rice is still low: a product with a reorder point and nothing in
    // stock is exactly what that figure is for, and a quiet day does not make
    // the shelf full.
    assert.equal(today.lowStock, 1);
  });

  it("shows a loss as a loss", () => {
    // A day whose costs beat its takings is a real day, and the honest number
    // is the negative one.
    recordExpense(database, {
      id: nextId("expense"),
      businessId: BUSINESS,
      category: "RENT",
      accountId: TILL,
      amountMinor: 50_000,
      userId: JEAN,
      deviceId: DEVICE,
      occurredAt: MORNING,
      recordedAt: RECORDED,
      eventId: nextId("event"),
    });
    sell();

    const today = read((tx) => dashboard(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(today.netResultMinor, 1_500 - 50_000);
  });
});
