import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Product } from "../../data/products/products.ts";
import type { CartPayment } from "../../data/sales/sales.ts";
import {
  addPayment,
  addProduct,
  emptyCart,
  isComplete,
  removeLine,
  removePayment,
  setCustomer,
  setDiscount,
  setLineDiscount,
  setLinePrice,
  setNote,
  setQuantity,
  toCart,
  view,
  type CartState,
} from "./cart.ts";

const ACCOUNT = "55555555-5555-7555-8555-555555555555";
const CUSTOMER = "66666666-6666-7666-8666-666666666666";
const AT = "2026-08-14T09:30:00.000Z";

let counter = 0;
function nextId(prefix: string): string {
  counter++;
  return `${prefix}-${counter}`;
}

function aProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "p-rice",
    businessId: "b",
    name: "Riz parfumé 5kg",
    unit: "sac",
    divisible: false,
    sellingPriceMinor: 6_500,
    currency: "XAF",
    taxRateBasisPoints: 0,
    minimumStock: 0,
    active: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** Adds a product with fresh identifiers, as a tap on the till would. */
function scan(state: CartState, product: Product, quantity?: number): CartState {
  return addProduct(
    state,
    product,
    { lineId: nextId("line"), movementId: nextId("movement") },
    quantity,
  );
}

function paidWith(amountMinor: number, overrides: Partial<CartPayment> = {}): CartPayment {
  return { id: nextId("pay"), accountId: ACCOUNT, amountMinor, ...overrides };
}

describe("filling a cart", () => {
  it("copies the price and name as they are now", () => {
    // A receipt reprinted next year has to show what was charged, and the
    // product will have been repriced by then (§41).
    const cart = scan(emptyCart, aProduct());
    assert.equal(cart.lines[0]?.name, "Riz parfumé 5kg");
    assert.equal(cart.lines[0]?.unitPriceMinor, 6_500);
    assert.equal(view(cart).totalMinor, 6_500);
  });

  it("merges a product scanned twice into one line", () => {
    // Scanning the same tin four times is one line of four in every shop
    // anyone has stood in.
    const product = aProduct();
    const cart = scan(scan(emptyCart, product), product);

    assert.equal(cart.lines.length, 1);
    assert.equal(cart.lines[0]?.quantity, 2_000);
    assert.equal(view(cart).totalMinor, 13_000);
  });

  it("keeps a repriced line separate from the same product at list price", () => {
    // A cashier who changed the price meant to, and merging would undo it.
    const product = aProduct();
    let cart = scan(emptyCart, product);
    const first = cart.lines[0]?.id ?? "";
    cart = setLinePrice(cart, first, 6_000);
    cart = scan(cart, product);

    assert.equal(cart.lines.length, 2);
    assert.equal(view(cart).totalMinor, 12_500);
  });

  it("carries the cost across when the product knows one", () => {
    // What §8's margin is worked out from. A product with no purchase price
    // carries none rather than a zero that would report a profit it did not make.
    const known = scan(emptyCart, aProduct({ purchasePriceMinor: 5_000 }));
    assert.equal(known.lines[0]?.unitCostMinor, 5_000);

    const unknown = scan(emptyCart, aProduct());
    assert.equal(unknown.lines[0]?.unitCostMinor, undefined);
  });

  it("takes a line off when its quantity reaches zero", () => {
    // A cashier holding the minus key means to take the thing off, and a line
    // of nothing on a receipt is a puzzle.
    let cart = scan(emptyCart, aProduct());
    const line = cart.lines[0]?.id ?? "";

    cart = setQuantity(cart, line, 0);
    assert.deepEqual(cart.lines, []);
  });

  it("removes a line and a payment by identifier", () => {
    let cart = scan(emptyCart, aProduct());
    const line = cart.lines[0]?.id ?? "";
    const payment = paidWith(6_500);
    cart = addPayment(cart, payment);

    assert.deepEqual(removeLine(cart, line).lines, []);
    assert.deepEqual(removePayment(cart, payment.id).payments, []);
  });

  it("leaves the cart it was given alone", () => {
    // Pure functions, so a React reducer can hold one of these safely.
    const before = scan(emptyCart, aProduct());
    const snapshot = JSON.stringify(before);
    scan(before, aProduct({ id: "p-other" }));
    setQuantity(before, before.lines[0]?.id ?? "", 9_000);
    setDiscount(before, 500);

    assert.equal(JSON.stringify(before), snapshot);
  });
});

describe("what the till shows", () => {
  it("uses the data layer's arithmetic, so the screen cannot disagree", () => {
    // 1,500 thousandths at 333 is 499.5, rounded away from zero to 500 here,
    // in completeSale, and on the server.
    const cart = scan(emptyCart, aProduct({ sellingPriceMinor: 333 }), 1_500);
    assert.equal(view(cart).totalMinor, 500);
  });

  it("takes the sale's discount off after the lines", () => {
    let cart = scan(emptyCart, aProduct(), 2_000);
    cart = setDiscount(cart, 1_000);

    const shown = view(cart);
    assert.equal(shown.subtotalMinor, 13_000);
    assert.equal(shown.totalMinor, 12_000);
  });

  it("counts split payments together", () => {
    // Cash and Mobile Money in one sale is ordinary (§11).
    let cart = scan(emptyCart, aProduct(), 2_000);
    cart = addPayment(cart, paidWith(10_000));
    cart = addPayment(cart, paidWith(3_000, { accountId: "wallet" }));

    const shown = view(cart);
    assert.equal(shown.paidMinor, 13_000);
    assert.equal(shown.outstandingMinor, 0);
    assert.equal(isComplete(shown), true);
  });

  it("reports how much is in the cart", () => {
    let cart = scan(emptyCart, aProduct(), 2_000);
    cart = scan(cart, aProduct({ id: "p-sugar" }), 500);
    assert.equal(view(cart).itemsThousandths, 2_500);
  });
});

describe("what stands between a cart and a sale", () => {
  it("says an empty till is empty rather than throwing at the cashier", () => {
    // A cart is supposed to be invalid while it is being filled.
    const shown = view(emptyCart);
    assert.deepEqual(shown.problems, ["EMPTY"]);
    assert.equal(isComplete(shown), false);
  });

  it("refuses more paid than the bill", () => {
    // Change comes from the cash tendered, which is a different number from
    // the payment recorded.
    let cart = scan(emptyCart, aProduct());
    cart = addPayment(cart, paidWith(10_000));

    assert.equal(view(cart).problems.includes("OVERPAID"), true);
  });

  it("refuses a discount larger than the sale", () => {
    let cart = scan(emptyCart, aProduct());
    cart = setDiscount(cart, 10_000);

    assert.equal(view(cart).problems.includes("DISCOUNT_EXCEEDS_SALE"), true);
  });

  it("wants somebody to owe an unpaid balance", () => {
    // A debt has to be owed by someone, or it could never be collected (§13).
    let cart = scan(emptyCart, aProduct());
    assert.equal(view(cart).problems.includes("CREDIT_NEEDS_CUSTOMER"), true);

    cart = setCustomer(cart, CUSTOMER);
    assert.equal(isComplete(view(cart)), true);
    assert.equal(view(cart).outstandingMinor, 6_500);
  });

  it("reports a line discount bigger than its line", () => {
    let cart = scan(emptyCart, aProduct());
    cart = setLineDiscount(cart, cart.lines[0]?.id ?? "", 10_000);

    const shown = view(cart);
    assert.equal(shown.problems.includes("LINE_DISCOUNT_EXCEEDS_LINE"), true);
    // And still draws a screen rather than throwing.
    assert.equal(shown.totalMinor, 0);
  });

  it("reports amounts the sale could never be recorded at, and shows no total from them", () => {
    const cart = scan(emptyCart, aProduct());
    const line = cart.lines[0]?.id ?? "";
    for (const bad of [
      setDiscount(cart, -500),
      setDiscount(cart, 0.5),
      setLineDiscount(cart, line, -1),
      setLinePrice(cart, line, -6_500),
      setLinePrice(cart, line, 99.5),
      setQuantity(cart, line, 0.5),
      addPayment(cart, paidWith(-100)),
      addPayment(cart, paidWith(0)),
      addPayment(cart, paidWith(Number.NaN)),
    ]) {
      const shown = view(bad);
      assert.deepEqual([shown.problems.includes("INVALID_AMOUNT"), isComplete(shown), shown.totalMinor, shown.paidMinor], [true, false, 0, 0]);
    }
    // A negative bill discount used to raise the total it was taken off.
    assert.equal(view(setDiscount(cart, -500)).totalMinor <= 6_500, true);
  });

  it("reports arithmetic too large to be exact", () => {
    // Beyond a safe integer money stops being exact (ADR-010).
    const cart = scan(emptyCart, aProduct({ sellingPriceMinor: Number.MAX_SAFE_INTEGER }), 2_000);
    assert.equal(view(cart).problems.includes("TOO_LARGE"), true);
  });

  it("clears a customer again", () => {
    let cart = scan(emptyCart, aProduct());
    cart = setCustomer(cart, CUSTOMER);
    cart = setCustomer(cart, undefined);

    assert.equal(cart.customerId, undefined);
    assert.equal(view(cart).problems.includes("CREDIT_NEEDS_CUSTOMER"), true);
  });
});

describe("handing the cart over", () => {
  const identity = {
    saleId: "sale-1",
    businessId: "b",
    number: "V-001",
    userId: "u",
    deviceId: "d",
    occurredAt: AT,
    recordedAt: AT,
    eventId: "e",
    creditTransactionId: "credit-1",
  };

  it("carries a credit entry exactly when something is left owing", () => {
    // The rule completeSale enforces and the server enforces again. Deciding it
    // here means the cashier is told at the till, not after it is on the wire.
    let cart = scan(emptyCart, aProduct());
    cart = setCustomer(cart, CUSTOMER);
    assert.equal(toCart(cart, identity).creditTransactionId, "credit-1");

    cart = addPayment(cart, paidWith(6_500));
    assert.equal(toCart(cart, identity).creditTransactionId, undefined);
  });

  it("leaves out what the shop did not set rather than sending zeroes", () => {
    let cart = scan(emptyCart, aProduct());
    cart = addPayment(cart, paidWith(6_500));

    const handed = toCart(cart, identity);
    assert.equal(handed.discountMinor, undefined);
    assert.equal(handed.note, undefined);
    assert.equal(handed.customerId, undefined);
    assert.equal(handed.branchId, undefined);
  });

  it("carries what the shop did set", () => {
    let cart = scan(emptyCart, aProduct(), 2_000);
    cart = setDiscount(cart, 1_000);
    cart = setNote(cart, "livraison");
    cart = setCustomer(cart, CUSTOMER);
    cart = addPayment(cart, paidWith(12_000));

    const handed = toCart(cart, { ...identity, branchId: "branch-1" });
    assert.equal(handed.discountMinor, 1_000);
    assert.equal(handed.note, "livraison");
    assert.equal(handed.customerId, CUSTOMER);
    assert.equal(handed.branchId, "branch-1");
    assert.equal(handed.lines.length, 1);
    assert.equal(handed.payments.length, 1);
  });
});
