/**
 * The seam between the till's cart and the sale it becomes.
 *
 * `cart.test.ts` proves the rules in isolation. This proves the thing that
 * isolation cannot: that what {@link toCart} builds is something `completeSale`
 * will actually accept, and that the numbers the cashier was shown are the
 * numbers that got written. Two layers that each pass their own tests and
 * disagree at the join is the failure this file exists to catch.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../../data/database/driver.ts";
import { migrate } from "../../data/database/migrations.ts";
import { openDatabase } from "../../data/database/node-sqlite.ts";
import { stockOf } from "../../data/inventory/movements.ts";
import { saveProduct, type Product, type SaveProduct } from "../../data/products/products.ts";
import { balanceOf } from "../../data/customers/customers.ts";
import { completeSale, SaleError } from "../../data/sales/sales.ts";
import { pending } from "../../data/sync/outbox.ts";
import { addPayment, addProduct, emptyCart, setCustomer, toCart, view, type CartState } from "./cart.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL = "33333333-3333-7333-8333-333333333333";
const ACCOUNT = "55555555-5555-7555-8555-555555555555";
const CUSTOMER = "66666666-6666-7666-8666-666666666666";
const RICE = "p-rice";
const AT = "2026-08-14T09:30:00.000Z";

let database: Database;
let counter = 0;

function nextId(prefix: string): string {
  counter++;
  return `${prefix}-${counter}`;
}

beforeEach(() => {
  database = openDatabase();
  migrate(database);
  database.transaction((tx) => {
    tx.run(
      `INSERT INTO businesses (id, name, currency, created_at, updated_at)
       VALUES (?, 'Boutique', 'XAF', ?, ?)`,
      [BUSINESS, AT, AT],
    );
    tx.run(
      `INSERT INTO users (id, business_id, name, role, created_at, updated_at)
       VALUES (?, ?, 'Jean', 'CASHIER', ?, ?)`,
      [USER, BUSINESS, AT, AT],
    );
    tx.run(
      `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'Till', 'ANDROID', ?, ?, ?)`,
      [TILL, BUSINESS, AT, AT, AT],
    );
    tx.run(
      `INSERT INTO financial_accounts (id, business_id, name, kind, currency, created_at, updated_at)
       VALUES (?, ?, 'Caisse', 'CASH', 'XAF', ?, ?)`,
      [ACCOUNT, BUSINESS, AT, AT],
    );
    tx.run(
      `INSERT INTO customers (id, business_id, name, created_at, updated_at)
       VALUES (?, ?, 'Jean Mbarga', ?, ?)`,
      [CUSTOMER, BUSINESS, AT, AT],
    );
  });

  const rice: SaveProduct = {
    id: RICE,
    businessId: BUSINESS,
    name: "Riz parfumé 5kg",
    unit: "sac",
    divisible: false,
    sellingPriceMinor: 6_500,
    purchasePriceMinor: 5_000,
    currency: "XAF",
    taxRateBasisPoints: 0,
    minimumStock: 0,
    active: true,
    createdAt: AT,
    updatedAt: AT,
    userId: USER,
    deviceId: TILL,
  };
  saveProduct(database, rice);
});

function product(): Product {
  return database.transaction((tx) => {
    const row = tx.get(`SELECT * FROM products WHERE id = ?`, [RICE]);
    assert.notEqual(row, undefined);
    return {
      id: RICE,
      businessId: BUSINESS,
      name: String(row?.["name"]),
      unit: "sac",
      divisible: false,
      sellingPriceMinor: Number(row?.["selling_price_minor"]),
      purchasePriceMinor: Number(row?.["purchase_price_minor"]),
      currency: "XAF",
      taxRateBasisPoints: 0,
      minimumStock: 0,
      active: true,
      createdAt: AT,
      updatedAt: AT,
    };
  });
}

function scan(state: CartState, quantity?: number): CartState {
  return addProduct(
    state,
    product(),
    { lineId: nextId("line"), movementId: nextId("movement") },
    quantity,
  );
}

function identity() {
  return {
    saleId: nextId("sale"),
    businessId: BUSINESS,
    number: nextId("V"),
    userId: USER,
    deviceId: TILL,
    occurredAt: AT,
    recordedAt: AT,
    eventId: nextId("event"),
    creditTransactionId: nextId("credit"),
  };
}

describe("a cart the till completed", () => {
  it("writes the sale the screen was showing", () => {
    // The numbers the cashier saw are the numbers that got written, because
    // both come from the same arithmetic rather than two agreeing ones.
    let cart = scan(emptyCart, 2_000);
    cart = addPayment(cart, { id: nextId("pay"), accountId: ACCOUNT, amountMinor: 13_000 });

    const shown = view(cart);
    const written = completeSale(database, toCart(cart, identity()));

    assert.equal(written.totalMinor, shown.totalMinor);
    assert.equal(written.paidMinor, shown.paidMinor);
    assert.equal(written.outstandingMinor, shown.outstandingMinor);
    assert.equal(written.totalMinor, 13_000);
  });

  it("releases the stock it sold and queues one event", () => {
    let cart = scan(emptyCart, 2_000);
    cart = addPayment(cart, { id: nextId("pay"), accountId: ACCOUNT, amountMinor: 13_000 });
    completeSale(database, toCart(cart, identity()));

    assert.equal(
      database.transaction((tx) => stockOf(tx, BUSINESS, RICE).onHandThousandths),
      -2_000,
    );
    const queued = database.transaction((tx) => pending(tx, 10));
    assert.equal(queued.filter((event) => event.type === "SALE_COMPLETED").length, 1);
  });

  it("puts what it left owing on the customer's ledger", () => {
    let cart = scan(emptyCart, 2_000);
    cart = setCustomer(cart, CUSTOMER);
    cart = addPayment(cart, { id: nextId("pay"), accountId: ACCOUNT, amountMinor: 3_000 });

    const shown = view(cart);
    completeSale(database, toCart(cart, identity()));

    assert.equal(shown.outstandingMinor, 10_000);
    assert.equal(
      database.transaction((tx) => balanceOf(tx, BUSINESS, CUSTOMER)).outstandingMinor,
      10_000,
    );
  });

  it("carries the cost through, so the margin can be worked out", () => {
    let cart = scan(emptyCart);
    cart = addPayment(cart, { id: nextId("pay"), accountId: ACCOUNT, amountMinor: 6_500 });
    completeSale(database, toCart(cart, identity()));

    const item = database.transaction((tx) =>
      tx.get(`SELECT unit_cost_minor FROM sale_items WHERE product_id = ?`, [RICE]),
    );
    assert.equal(item?.["unit_cost_minor"], 5_000);
  });

  it("is refused by completeSale for exactly what the till reported", () => {
    // The till's problems and completeSale's refusals are the same rules. If
    // they drifted, a cashier would be told a cart was fine and then watch it
    // fail — or worse, be blocked from a sale the data layer would have taken.
    const overpaid = addPayment(scan(emptyCart), {
      id: nextId("pay"),
      accountId: ACCOUNT,
      amountMinor: 10_000,
    });
    assert.equal(view(overpaid).problems.includes("OVERPAID"), true);
    assert.throws(() => completeSale(database, toCart(overpaid, identity())), SaleError);

    const owedByNobody = scan(emptyCart);
    assert.equal(view(owedByNobody).problems.includes("CREDIT_NEEDS_CUSTOMER"), true);
    assert.throws(() => completeSale(database, toCart(owedByNobody, identity())), SaleError);
  });

  it("completes a cart the till called complete", () => {
    // The other direction, and the one that matters more: anything the till is
    // willing to ring up, the data layer must be willing to write.
    const carts: CartState[] = [
      // Paid exactly.
      addPayment(scan(emptyCart, 2_000), {
        id: nextId("pay"),
        accountId: ACCOUNT,
        amountMinor: 13_000,
      }),
      // Split between two accounts (§11).
      addPayment(
        addPayment(scan(emptyCart, 2_000), {
          id: nextId("pay"),
          accountId: ACCOUNT,
          amountMinor: 10_000,
        }),
        { id: nextId("pay"), accountId: ACCOUNT, amountMinor: 3_000 },
      ),
      // Wholly on credit.
      setCustomer(scan(emptyCart, 2_000), CUSTOMER),
      // Part paid, rest on credit.
      addPayment(setCustomer(scan(emptyCart, 2_000), CUSTOMER), {
        id: nextId("pay"),
        accountId: ACCOUNT,
        amountMinor: 5_000,
      }),
    ];

    for (const cart of carts) {
      assert.equal(view(cart).problems.length, 0);
      assert.doesNotThrow(() => completeSale(database, toCart(cart, identity())));
    }
  });
});
