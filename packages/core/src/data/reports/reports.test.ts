import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { recordCustomerPayment } from "../customers/customers.ts";
import { recordExpense } from "../expenses/expenses.ts";
import { balanceOfAccount } from "../finance/cash.ts";
import { recordPurchase, type Delivery, type DeliveryLine } from "../purchases/purchases.ts";
import { completeSale, type Cart, type CartLine } from "../sales/sales.ts";
import { recordSupplierPayment } from "../suppliers/suppliers.ts";
import {
  cashFlow,
  customerPurchases,
  customerStatement,
  dashboard,
  deadStock,
  fastMoving,
  lowStock,
  inventoryValuation,
  outstandingDebt,
  profitBetween,
  purchasesBetween,
  purchasesBySupplier,
  salesByAccount,
  salesByCategory,
  salesByProduct,
  salesBetween,
  salesByUser,
  slowMoving,
  supplierDebt,
  supplierPaymentsBetween,
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
const GROSSISTE = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const MARCHE = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
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
    for (const [id, name] of [
      [GROSSISTE, "Grossiste Mokolo"],
      [MARCHE, "Marché Mokolo"],
    ] as const) {
      tx.run(
        `INSERT INTO suppliers (id, business_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, BUSINESS, name, CREATED, CREATED],
      );
    }
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

/** One line of a delivery: rice at 5,000 the sack, the cost a sale line pays. */
function deliveryLine(overrides: Partial<DeliveryLine> = {}): DeliveryLine {
  return {
    id: nextId("dline"),
    movementId: nextId("dstock"),
    productId: RICE,
    unitCostMinor: 5_000,
    quantity: 1_000,
    ...overrides,
  };
}

/** Records a delivery, leaving the whole bill owed unless it says otherwise. */
function receive(overrides: Partial<Delivery> = {}): Delivery {
  const lines = overrides.lines ?? [deliveryLine()];
  const payments = overrides.payments ?? [];
  const total = lines.reduce(
    (sum, l) => sum + Math.floor((l.unitCostMinor * l.quantity + 500) / 1000),
    0,
  );
  const paid = payments.reduce((sum, p) => sum + p.amountMinor, 0);
  const delivery: Delivery = {
    id: nextId("purchase"),
    businessId: BUSINESS,
    supplierId: GROSSISTE,
    lines,
    payments,
    userId: JEAN,
    deviceId: DEVICE,
    occurredAt: MORNING,
    recordedAt: RECORDED,
    eventId: nextId("event"),
    ...overrides,
    ...(total - paid > 0 ? { supplierTransactionId: nextId("owed") } : {}),
  };
  recordPurchase(database, delivery);
  return delivery;
}

function payWholesaler(supplierId: string, amountMinor: number): void {
  recordSupplierPayment(database, {
    id: nextId("entry"),
    businessId: BUSINESS,
    supplierId,
    accountId: TILL,
    amountMinor,
    userId: JEAN,
    deviceId: DEVICE,
    occurredAt: MORNING,
    recordedAt: RECORDED,
    eventId: nextId("event"),
  });
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

describe("what the shop owes its wholesalers", () => {
  it("lists them most owed first, and leaves out the ones paid ahead", () => {
    receive({ supplierId: GROSSISTE, lines: [deliveryLine({ quantity: 20_000 })] });
    receive({ supplierId: MARCHE, lines: [deliveryLine({ quantity: 4_000 })] });
    // Paid ahead: not a debt, and a list of debts including it would have to be
    // read twice to be understood.
    payWholesaler(MARCHE, 50_000);

    const owed = read((tx) => supplierDebt(tx, BUSINESS));
    assert.equal(owed.length, 1);
    assert.equal(owed[0]?.key, GROSSISTE);
    assert.equal(owed[0]?.label, "Grossiste Mokolo");
    assert.equal(owed[0]?.totalMinor, 100_000);
  });

  it("is a different figure from what customers owe, never netted", () => {
    // An owner with money out on credit and the same owed to a wholesaler is
    // not square: one arrives when customers choose to pay, the other falls due
    // when the van comes back.
    receive({ supplierId: GROSSISTE, lines: [deliveryLine({ quantity: 20_000 })] });
    sell({ customerId: CUSTOMER, payments: [], creditTransactionId: nextId("credit") });

    const owedToShop = read((tx) => outstandingDebt(tx, BUSINESS));
    const owedByShop = read((tx) => supplierDebt(tx, BUSINESS));
    assert.equal(owedToShop.length, 1);
    assert.equal(owedByShop.length, 1);
    assert.equal(owedByShop[0]?.totalMinor, 100_000);
  });

  it("counts a wholesaler this device has never seen by identifier", () => {
    // A delivery can sync before the supplier that made it. Reporting the debt
    // under a raw identifier is worse than nothing only if it is dropped.
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO supplier_transactions
           (id, supplier_id, business_id, type, amount_minor, currency,
            reference_kind, reference_id, user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'OPENING_BALANCE', 30000, 'XAF', NULL, NULL, ?, ?, ?, ?)`,
        [nextId("entry"), GROSSISTE, BUSINESS, JEAN, DEVICE, MORNING, RECORDED],
      );
    });
    const owed = read((tx) => supplierDebt(tx, BUSINESS));
    assert.equal(owed[0]?.totalMinor, 30_000);
  });
});

describe("what a period bought", () => {
  it("totals the deliveries and what arrived", () => {
    receive({ supplierId: GROSSISTE, lines: [deliveryLine({ quantity: 20_000 })] });
    receive({ supplierId: MARCHE, lines: [deliveryLine({ quantity: 4_000 })] });

    const bought = read((tx) => purchasesBetween(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(bought.totalMinor, 120_000);
    assert.equal(bought.deliveries, 2);
    assert.equal(bought.receivedThousandths, 24_000);
  });

  it("is sliced by when the stock arrived, not when it was recorded", () => {
    // A delivery recorded on a phone that synced on Friday still arrived on
    // Monday, and last week's figures must not change because a device was slow.
    receive({
      supplierId: GROSSISTE,
      lines: [deliveryLine({ quantity: 20_000 })],
      occurredAt: "2026-08-13T09:00:00.000Z",
      recordedAt: MORNING,
    });

    assert.equal(read((tx) => purchasesBetween(tx, BUSINESS, DAY_FROM, DAY_TO)).deliveries, 0);
    assert.equal(
      read((tx) =>
        purchasesBetween(tx, BUSINESS, "2026-08-13T00:00:00.000Z", DAY_FROM),
      ).deliveries,
      1,
    );
  });

  it("breaks the period down by wholesaler, most spent first", () => {
    receive({ supplierId: MARCHE, lines: [deliveryLine({ quantity: 4_000 })] });
    receive({ supplierId: GROSSISTE, lines: [deliveryLine({ quantity: 20_000 })] });

    const bySupplier = read((tx) => purchasesBySupplier(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.deepEqual(
      bySupplier.map((row) => [row.label, row.totalMinor]),
      [
        ["Grossiste Mokolo", 100_000],
        ["Marché Mokolo", 20_000],
      ],
    );
  });

  it("keeps a crate bought from nobody rather than dropping it", () => {
    // What the shop spent on stock is the question; leaving those out would
    // answer a different one.
    receive({
      supplierId: undefined,
      lines: [deliveryLine({ quantity: 2_000 })],
      payments: [{ id: nextId("pay"), accountId: TILL, amountMinor: 10_000, reason: "au marché" }],
    });

    const bySupplier = read((tx) => purchasesBySupplier(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(bySupplier.length, 1);
    assert.equal(bySupplier[0]?.key, "");
    assert.equal(bySupplier[0]?.totalMinor, 10_000);
    assert.equal(read((tx) => purchasesBetween(tx, BUSINESS, DAY_FROM, DAY_TO)).totalMinor, 10_000);
  });

  it("says nothing was bought when nothing was", () => {
    const bought = read((tx) => purchasesBetween(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(bought.totalMinor, 0);
    assert.equal(bought.deliveries, 0);
    assert.deepEqual(read((tx) => purchasesBySupplier(tx, BUSINESS, DAY_FROM, DAY_TO)), []);
  });
});

describe("what a period paid its wholesalers", () => {
  it("reports it positive, though the ledger stores it negative", () => {
    // "Paid 50,000" is what an owner is asking. A column of negative numbers
    // under that heading reads as money coming back.
    receive({ supplierId: GROSSISTE, lines: [deliveryLine({ quantity: 20_000 })] });
    payWholesaler(GROSSISTE, 30_000);

    const paid = read((tx) => supplierPaymentsBetween(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(paid.length, 1);
    assert.equal(paid[0]?.label, "Grossiste Mokolo");
    assert.equal(paid[0]?.totalMinor, 30_000);
  });

  it("leaves out money handed over at the door", () => {
    // That is a movement against the till, not a ledger entry, because a
    // delivery from the market has no wholesaler to have a ledger. It shows in
    // the period's purchases instead, where the goods it bought are.
    receive({
      supplierId: GROSSISTE,
      lines: [deliveryLine({ quantity: 20_000 })],
      payments: [
        { id: nextId("pay"), accountId: TILL, amountMinor: 100_000, reason: "payé au livreur" },
      ],
    });

    assert.deepEqual(read((tx) => supplierPaymentsBetween(tx, BUSINESS, DAY_FROM, DAY_TO)), []);
    assert.equal(read((tx) => purchasesBetween(tx, BUSINESS, DAY_FROM, DAY_TO)).totalMinor, 100_000);
  });

  it("leaves out goods going back, which move no money", () => {
    receive({ supplierId: GROSSISTE, lines: [deliveryLine({ quantity: 20_000 })] });
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO supplier_transactions
           (id, supplier_id, business_id, type, amount_minor, currency,
            reference_kind, reference_id, user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'RETURN', -10000, 'XAF', 'PURCHASE', 'p', ?, ?, ?, ?)`,
        [nextId("entry"), GROSSISTE, BUSINESS, JEAN, DEVICE, MORNING, RECORDED],
      );
    });

    assert.deepEqual(read((tx) => supplierPaymentsBetween(tx, BUSINESS, DAY_FROM, DAY_TO)), []);
    // But the bill did fall.
    assert.equal(read((tx) => supplierDebt(tx, BUSINESS))[0]?.totalMinor, 90_000);
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

describe("what the shelves are worth", () => {
  it("values stock at what it last cost to buy", () => {
    // Replacement cost: what it would take to restock today. The second
    // delivery is dearer, and that is the price the shelf is worth at.
    receive({ lines: [deliveryLine({ quantity: 10_000, unitCostMinor: 5_000 })] });
    receive({
      lines: [deliveryLine({ quantity: 10_000, unitCostMinor: 5_200 })],
      occurredAt: "2026-08-14T11:00:00.000Z",
      recordedAt: "2026-08-14T11:00:00.000Z",
    });

    const worth = read((tx) => inventoryValuation(tx, BUSINESS));
    assert.equal(worth.method, "LATEST_PURCHASE");
    assert.equal(worth.products.length, 1);
    assert.equal(worth.products[0]?.unitCostMinor, 5_200);
    assert.equal(worth.products[0]?.onHandThousandths, 20_000);
    assert.equal(worth.products[0]?.valueMinor, 104_000);
    assert.equal(worth.totalMinor, 104_000);
    assert.equal(worth.uncosted, 0);
  });

  it("falls as stock is sold, because quantity is the ledger's sum", () => {
    receive({ lines: [deliveryLine({ quantity: 10_000, unitCostMinor: 5_000 })] });
    sell({ lines: [line({ quantity: 2_000 })] });

    const worth = read((tx) => inventoryValuation(tx, BUSINESS));
    assert.equal(worth.products[0]?.onHandThousandths, 8_000);
    assert.equal(worth.totalMinor, 40_000);
  });

  it("reads the cost from what came in, never from what went out", () => {
    // A sale line carries a cost too, and it is a *later* movement. Taking the
    // most recent movement with a cost rather than the most recent PURCHASE
    // would value the shelf at whatever the last receipt happened to record.
    receive({ lines: [deliveryLine({ quantity: 10_000, unitCostMinor: 5_000 })] });
    sell({
      lines: [line({ quantity: 1_000, unitCostMinor: 9_999 })],
      occurredAt: "2026-08-14T23:00:00.000Z",
      recordedAt: "2026-08-14T23:00:00.000Z",
    });

    const worth = read((tx) => inventoryValuation(tx, BUSINESS));
    assert.equal(worth.products[0]?.unitCostMinor, 5_000);
    assert.equal(worth.totalMinor, 45_000);
  });

  it("reports stock nothing says the cost of as a gap, never as free", () => {
    // Stock from before the system, or received before this device saw the
    // delivery. Valuing it at nothing would report an asset the shop has not.
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO inventory_movements
           (id, business_id, product_id, type, quantity, reason,
            user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'ADJUSTMENT', 12000, 'stock trouvé', ?, ?, ?, ?)`,
        [nextId("stock"), BUSINESS, SUGAR, JEAN, DEVICE, MORNING, RECORDED],
      );
    });
    receive({ lines: [deliveryLine({ quantity: 10_000, unitCostMinor: 5_000 })] });

    const worth = read((tx) => inventoryValuation(tx, BUSINESS));
    assert.equal(worth.uncosted, 1);
    assert.equal(worth.totalMinor, 50_000);
    const sugar = worth.products.find((p) => p.productId === SUGAR);
    assert.equal(sugar?.onHandThousandths, 12_000);
    assert.equal(sugar?.unitCostMinor, undefined);
    assert.equal(sugar?.valueMinor, undefined);
  });

  it("leaves out what the shop holds none of", () => {
    // A shop that has ever sold out of something would otherwise carry it
    // forever in a report about what it owns.
    receive({ lines: [deliveryLine({ quantity: 2_000, unitCostMinor: 5_000 })] });
    sell({ lines: [line({ quantity: 2_000 })] });

    assert.deepEqual(read((tx) => inventoryValuation(tx, BUSINESS)).products, []);
    assert.equal(read((tx) => inventoryValuation(tx, BUSINESS)).totalMinor, 0);
  });

  it("shows stock below zero as a negative value rather than hiding it", () => {
    // Two devices each selling the last unit offline is expected (§29). The
    // honest total is below zero until someone counts the shelf, and hiding it
    // would make the one figure that reveals the problem conceal it.
    receive({ lines: [deliveryLine({ quantity: 1_000, unitCostMinor: 5_000 })] });
    sell({ lines: [line({ quantity: 1_000 })] });
    sell({ lines: [line({ quantity: 1_000 })] });

    const worth = read((tx) => inventoryValuation(tx, BUSINESS));
    assert.equal(worth.products[0]?.onHandThousandths, -1_000);
    assert.equal(worth.products[0]?.valueMinor, -5_000);
    assert.equal(worth.totalMinor, -5_000);
  });

  it("rounds a part-unit holding the same way a sale line does", () => {
    // 1,500 thousandths at 333 is 499.5, which rounds away from zero to 500
    // here, on a sale line, and on the server. A valuation compared against
    // either must not round differently.
    receive({ lines: [deliveryLine({ quantity: 1_500, unitCostMinor: 333 })] });

    assert.equal(read((tx) => inventoryValuation(tx, BUSINESS)).totalMinor, 500);
  });

  it("says nothing is on the shelves rather than giving no answer", () => {
    const worth = read((tx) => inventoryValuation(tx, BUSINESS));
    assert.equal(worth.totalMinor, 0);
    assert.equal(worth.uncosted, 0);
    assert.deepEqual(worth.products, []);
  });

  it("counts only this business's stock", () => {
    receive({ lines: [deliveryLine({ quantity: 10_000, unitCostMinor: 5_000 })] });
    assert.equal(read((tx) => inventoryValuation(tx, "another-business")).totalMinor, 0);
  });
});

describe("what each category sold", () => {
  it("groups through the product, so moving one moves its history", () => {
    // A category copied onto the sale line would leave last month grouping by a
    // shelf the shop no longer has — the opposite of why a line's name and
    // price are copied.
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO categories (id, business_id, name, created_at, updated_at)
         VALUES ('cat-grains', ?, 'Céréales', ?, ?)`,
        [BUSINESS, CREATED, CREATED],
      );
      tx.run(`UPDATE products SET category_id = 'cat-grains' WHERE id = ?`, [RICE]);
    });
    sell({ lines: [line({ quantity: 2_000 })] });

    const byCategory = read((tx) => salesByCategory(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(byCategory.length, 1);
    assert.equal(byCategory[0]?.key, "cat-grains");
    assert.equal(byCategory[0]?.label, "Céréales");
    assert.equal(byCategory[0]?.totalMinor, 13_000);
  });

  it("keeps products in no category rather than dropping them", () => {
    // A breakdown that did not add up to the takings would be worse than an
    // "uncategorised" line.
    sell({ lines: [line({ quantity: 1_000 })] });

    const byCategory = read((tx) => salesByCategory(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(byCategory.length, 1);
    assert.equal(byCategory[0]?.key, "");
    assert.equal(
      byCategory.reduce((sum, row) => sum + row.totalMinor, 0),
      read((tx) => salesBetween(tx, BUSINESS, DAY_FROM, DAY_TO)).totalMinor,
    );
  });
});

describe("what moved through each account", () => {
  it("reports what came in and what went out apart, never netted", () => {
    // "Took 400,000 and paid out 380,000" and "took 20,000" are different days,
    // and only the first is the truth about a busy one.
    sell({ lines: [line({ quantity: 2_000 })] });
    recordExpense(database, {
      id: nextId("expense"),
      businessId: BUSINESS,
      category: "TRANSPORT",
      accountId: TILL,
      amountMinor: 3_000,
      userId: JEAN,
      deviceId: DEVICE,
      occurredAt: MORNING,
      recordedAt: RECORDED,
      eventId: nextId("event"),
    });

    const flow = read((tx) => cashFlow(tx, BUSINESS, DAY_FROM, DAY_TO));
    const till = flow.find((row) => row.accountId === TILL);
    assert.equal(till?.inMinor, 13_000);
    assert.equal(till?.outMinor, 3_000);
    assert.equal(till?.netMinor, 10_000);
  });

  it("counts every source the balance does, and agrees with it", () => {
    // A source in one and not the other would give a report that did not
    // reconcile with the balance beside it, and no way to tell which was wrong.
    sell({ lines: [line({ quantity: 2_000 })] });
    receive({
      lines: [deliveryLine({ quantity: 10_000, unitCostMinor: 5_000 })],
      payments: [{ id: nextId("pay"), accountId: TILL, amountMinor: 20_000, reason: "acompte" }],
    });
    payWholesaler(GROSSISTE, 5_000);
    sell({
      lines: [line({ quantity: 1_000 })],
      payments: [],
      customerId: CUSTOMER,
      creditTransactionId: nextId("credit"),
    });
    recordCustomerPayment(database, {
      id: nextId("entry"),
      businessId: BUSINESS,
      customerId: CUSTOMER,
      accountId: TILL,
      amountMinor: 2_000,
      userId: JEAN,
      deviceId: DEVICE,
      occurredAt: MORNING,
      recordedAt: RECORDED,
      eventId: nextId("event"),
    });

    const till = read((tx) => cashFlow(tx, BUSINESS, DAY_FROM, DAY_TO)).find(
      (row) => row.accountId === TILL,
    );
    const balance = read((tx) => balanceOfAccount(tx, BUSINESS, TILL));
    assert.equal(till?.closingMinor, balance.onHandMinor);
    // 13,000 taken + 2,000 settled, less 20,000 at the door and 5,000 to the
    // wholesaler.
    assert.equal(till?.inMinor, 15_000);
    assert.equal(till?.outMinor, 25_000);
    assert.equal(till?.netMinor, -10_000);
  });

  it("closes on the whole history, not just the period", () => {
    // An owner comparing a report against the drawer is asking what is in it
    // now. A period-only figure would disagree with §18's count invisibly.
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO account_movements
           (id, account_id, business_id, type, amount_minor, currency,
            user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'OPENING_BALANCE', 100000, 'XAF', ?, ?, ?, ?)`,
        [
          nextId("movement"),
          TILL,
          BUSINESS,
          JEAN,
          DEVICE,
          "2026-08-01T08:00:00.000Z",
          "2026-08-01T08:00:00.000Z",
        ],
      );
    });
    sell({ lines: [line({ quantity: 1_000 })] });

    const till = read((tx) => cashFlow(tx, BUSINESS, DAY_FROM, DAY_TO)).find(
      (row) => row.accountId === TILL,
    );
    // Today took 6,500; the float from the first of the month is not today's.
    assert.equal(till?.inMinor, 6_500);
    assert.equal(till?.closingMinor, 106_500);
  });

  it("leaves out an account nothing has ever moved through", () => {
    // A row of zeroes would read as an account that had been emptied.
    sell({ lines: [line({ quantity: 1_000 })] });

    const flow = read((tx) => cashFlow(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.deepEqual(
      flow.map((row) => row.accountId),
      [TILL],
    );
  });

  it("says nothing moved rather than giving no answer", () => {
    assert.deepEqual(read((tx) => cashFlow(tx, BUSINESS, DAY_FROM, DAY_TO)), []);
  });
});

describe("what is and is not shifting", () => {
  it("ranks by quantity, not by takings", () => {
    // A cheap thing that moves every day is fast-moving even though a single
    // expensive one outsells a year of it.
    sell({ lines: [line({ productId: SUGAR, name: "Sucre 1kg", unitPriceMinor: 900, quantity: 20_000 })] });
    sell({ lines: [line({ quantity: 1_000 })] });

    const ranked = read((tx) => fastMoving(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(ranked[0]?.productId, SUGAR);
    assert.equal(ranked[0]?.soldThousandths, 20_000);
    // And the takings are there too, so a caller needs no second query.
    assert.equal(ranked[0]?.revenueMinor, 18_000);
    assert.equal(ranked[1]?.productId, RICE);
    assert.equal(ranked[1]?.revenueMinor, 6_500);
  });

  it("includes what sold nothing at the slow end", () => {
    // The whole point: "these sold least" and "these did not sell" are
    // different questions, and a join from sale lines would answer the wrong one.
    sell({ lines: [line({ quantity: 1_000 })] });

    const slow = read((tx) => slowMoving(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(slow[0]?.productId, SUGAR);
    assert.equal(slow[0]?.soldThousandths, 0);
  });

  it("reads the same ranking from both ends", () => {
    sell({ lines: [line({ quantity: 1_000 })] });

    const fast = read((tx) => fastMoving(tx, BUSINESS, DAY_FROM, DAY_TO));
    const slow = read((tx) => slowMoving(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.deepEqual(
      slow.map((row) => row.productId),
      [...fast].reverse().map((row) => row.productId),
    );
  });

  it("honours the limit at both ends", () => {
    sell({ lines: [line({ quantity: 1_000 })] });

    assert.equal(read((tx) => fastMoving(tx, BUSINESS, DAY_FROM, DAY_TO, 1)).length, 1);
    assert.equal(read((tx) => fastMoving(tx, BUSINESS, DAY_FROM, DAY_TO, 1))[0]?.productId, RICE);
    assert.equal(read((tx) => slowMoving(tx, BUSINESS, DAY_FROM, DAY_TO, 1)).length, 1);
    assert.equal(read((tx) => slowMoving(tx, BUSINESS, DAY_FROM, DAY_TO, 1))[0]?.productId, SUGAR);
    assert.deepEqual(read((tx) => fastMoving(tx, BUSINESS, DAY_FROM, DAY_TO, 0)), []);
  });

  it("is sliced by when the sale happened, not when it synced", () => {
    sell({
      lines: [line({ quantity: 1_000 })],
      occurredAt: "2026-08-13T09:00:00.000Z",
      recordedAt: MORNING,
    });

    const today = read((tx) => fastMoving(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(today[0]?.soldThousandths, 0);
  });
});

describe("stock that is not moving", () => {
  it("lists what is on the shelf and has sold nothing since", () => {
    receive({ lines: [deliveryLine({ quantity: 10_000, unitCostMinor: 5_000 })] });

    const dead = read((tx) => deadStock(tx, BUSINESS, DAY_FROM));
    assert.equal(dead.length, 1);
    assert.equal(dead[0]?.productId, RICE);
    assert.equal(dead[0]?.onHandThousandths, 10_000);
    // The actionable number: what the shelf has tied up.
    assert.equal(dead[0]?.valueMinor, 50_000);
    assert.equal(dead[0]?.lastSoldAt, undefined);
  });

  it("leaves out what has sold since", () => {
    receive({ lines: [deliveryLine({ quantity: 10_000, unitCostMinor: 5_000 })] });
    sell({ lines: [line({ quantity: 1_000 })] });

    assert.deepEqual(read((tx) => deadStock(tx, BUSINESS, DAY_FROM)), []);
  });

  it("says when it last sold, for stock that has gone quiet", () => {
    // Sold last week, nothing since: the difference between dead and never
    // stocked is exactly this date.
    receive({
      lines: [deliveryLine({ quantity: 10_000, unitCostMinor: 5_000 })],
      occurredAt: "2026-08-01T09:00:00.000Z",
      recordedAt: "2026-08-01T09:00:00.000Z",
    });
    sell({
      lines: [line({ quantity: 1_000 })],
      occurredAt: "2026-08-02T09:00:00.000Z",
      recordedAt: "2026-08-02T09:00:00.000Z",
    });

    const dead = read((tx) => deadStock(tx, BUSINESS, DAY_FROM));
    assert.equal(dead.length, 1);
    assert.equal(dead[0]?.lastSoldAt, "2026-08-02T09:00:00.000Z");
  });

  it("leaves out what the shop holds none of", () => {
    // A product that sold out is finished, not dead, and one nobody stocks is
    // not dead either. Neither is money sitting on a shelf.
    assert.deepEqual(read((tx) => deadStock(tx, BUSINESS, DAY_FROM)), []);

    receive({ lines: [deliveryLine({ quantity: 1_000, unitCostMinor: 5_000 })] });
    sell({
      lines: [line({ quantity: 1_000 })],
      occurredAt: "2026-08-02T09:00:00.000Z",
      recordedAt: "2026-08-02T09:00:00.000Z",
    });
    assert.deepEqual(read((tx) => deadStock(tx, BUSINESS, DAY_FROM)), []);
  });

  it("reports stock nothing says the cost of without a value", () => {
    // A zero would make dead stock look free to keep, which is the opposite of
    // what this report is for.
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO inventory_movements
           (id, business_id, product_id, type, quantity, reason,
            user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'ADJUSTMENT', 12000, 'stock trouvé', ?, ?, ?, ?)`,
        [nextId("stock"), BUSINESS, SUGAR, JEAN, DEVICE, MORNING, RECORDED],
      );
    });

    const dead = read((tx) => deadStock(tx, BUSINESS, DAY_FROM));
    assert.equal(dead.length, 1);
    assert.equal(dead[0]?.productId, SUGAR);
    assert.equal(dead[0]?.valueMinor, undefined);
  });
});

describe("a customer's statement", () => {
  it("runs the balance down in the order things happened", () => {
    // What makes it a document a customer can be shown and follow, rather than
    // a list of amounts they have to add up themselves.
    sell({
      lines: [line({ quantity: 2_000 })],
      payments: [],
      customerId: CUSTOMER,
      creditTransactionId: nextId("credit"),
    });
    recordCustomerPayment(database, {
      id: nextId("entry"),
      businessId: BUSINESS,
      customerId: CUSTOMER,
      accountId: TILL,
      amountMinor: 5_000,
      note: "acompte",
      userId: JEAN,
      deviceId: DEVICE,
      occurredAt: "2026-08-14T14:00:00.000Z",
      recordedAt: "2026-08-14T14:00:00.000Z",
      eventId: nextId("event"),
    });

    const statement = read((tx) => customerStatement(tx, BUSINESS, CUSTOMER));
    assert.equal(statement.length, 2);
    assert.equal(statement[0]?.type, "CREDIT_SALE");
    assert.equal(statement[0]?.amountMinor, 13_000);
    assert.equal(statement[0]?.balanceMinor, 13_000);
    assert.equal(statement[1]?.type, "PAYMENT");
    assert.equal(statement[1]?.amountMinor, -5_000);
    assert.equal(statement[1]?.balanceMinor, 8_000);
  });

  it("traces a debt back to the sale that caused it", () => {
    const cart = sell({
      lines: [line()],
      payments: [],
      customerId: CUSTOMER,
      creditTransactionId: nextId("credit"),
    });

    const statement = read((tx) => customerStatement(tx, BUSINESS, CUSTOMER));
    assert.equal(statement[0]?.reference, `SALE:${cart.id}`);
  });

  it("places an entry synced late where it happened", () => {
    // The running balance must read as the customer experienced it, not as the
    // tills happened to sync.
    recordCustomerPayment(database, {
      id: nextId("entry"),
      businessId: BUSINESS,
      customerId: CUSTOMER,
      accountId: TILL,
      amountMinor: 5_000,
      userId: JEAN,
      deviceId: DEVICE,
      occurredAt: "2026-08-14T14:00:00.000Z",
      recordedAt: "2026-08-14T14:00:00.000Z",
      eventId: nextId("event"),
    });
    // Recorded second, but it happened first.
    sell({
      lines: [line({ quantity: 2_000 })],
      payments: [],
      customerId: CUSTOMER,
      creditTransactionId: nextId("credit"),
      occurredAt: "2026-08-14T09:00:00.000Z",
      recordedAt: "2026-08-14T15:00:00.000Z",
    });

    const statement = read((tx) => customerStatement(tx, BUSINESS, CUSTOMER));
    assert.deepEqual(
      statement.map((entry) => [entry.type, entry.balanceMinor]),
      [
        ["CREDIT_SALE", 13_000],
        ["PAYMENT", 8_000],
      ],
    );
  });

  it("ends on what the ledger says is owed", () => {
    sell({
      lines: [line({ quantity: 2_000 })],
      payments: [],
      customerId: CUSTOMER,
      creditTransactionId: nextId("credit"),
    });

    const statement = read((tx) => customerStatement(tx, BUSINESS, CUSTOMER));
    const owed = read((tx) => outstandingDebt(tx, BUSINESS));
    assert.equal(statement.at(-1)?.balanceMinor, owed[0]?.totalMinor);
  });

  it("is empty for someone who has never bought on credit", () => {
    assert.deepEqual(read((tx) => customerStatement(tx, BUSINESS, CUSTOMER)), []);
  });
});

describe("what a customer buys", () => {
  it("counts every sale to them, not only the ones on credit", () => {
    // "What does this person buy" is a question about a regular. Answering it
    // from the credit ledger alone would describe only the days they were short.
    sell({ lines: [line({ quantity: 2_000 })], customerId: CUSTOMER });
    sell({
      lines: [line({ productId: SUGAR, name: "Sucre 1kg", unitPriceMinor: 900, quantity: 1_000 })],
      payments: [],
      customerId: CUSTOMER,
      creditTransactionId: nextId("credit"),
    });

    const bought = read((tx) => customerPurchases(tx, BUSINESS, CUSTOMER, DAY_FROM, DAY_TO));
    assert.deepEqual(
      bought.map((row) => [row.label, row.totalMinor]),
      [
        ["Riz parfumé 5kg", 13_000],
        ["Sucre 1kg", 900],
      ],
    );
  });

  it("counts nobody else's", () => {
    sell({ lines: [line()], customerId: CUSTOMER });
    sell({ lines: [line()] });

    const bought = read((tx) => customerPurchases(tx, BUSINESS, CUSTOMER, DAY_FROM, DAY_TO));
    assert.equal(bought.length, 1);
    assert.equal(bought[0]?.count, 1);
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

  it("shows what the shop owes beside what is owed to it, never netted", () => {
    // An owner with 6,500 out on credit and 100,000 owed to a wholesaler is not
    // 93,500 behind: one arrives when customers choose to pay, and the other
    // falls due when the van comes back. Two figures, deliberately.
    sell({
      lines: [line()],
      payments: [],
      customerId: CUSTOMER,
      creditTransactionId: nextId("credit"),
    });
    receive({ supplierId: GROSSISTE, lines: [deliveryLine({ quantity: 20_000 })] });

    const today = read((tx) => dashboard(tx, BUSINESS, DAY_FROM, DAY_TO));
    assert.equal(today.customerDebtMinor, 6_500);
    assert.equal(today.supplierDebtMinor, 100_000);
  });

  it("does not count a delivery paid at the door as owed", () => {
    receive({
      supplierId: GROSSISTE,
      lines: [deliveryLine({ quantity: 20_000 })],
      payments: [
        { id: nextId("pay"), accountId: TILL, amountMinor: 100_000, reason: "payé au livreur" },
      ],
    });

    assert.equal(read((tx) => dashboard(tx, BUSINESS, DAY_FROM, DAY_TO)).supplierDebtMinor, 0);
  });

  it("reads as an empty day rather than as no answer", () => {
    const today = read((tx) => dashboard(tx, BUSINESS, DAY_FROM, DAY_TO));

    assert.equal(today.sales.transactions, 0);
    assert.equal(today.netResultMinor, 0);
    assert.equal(today.customerDebtMinor, 0);
    assert.equal(today.supplierDebtMinor, 0);
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
