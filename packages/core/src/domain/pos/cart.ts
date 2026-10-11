/**
 * The rules of a cart, with no React in them (ADR-004).
 *
 * A cart being filled is **transient UI state**: it belongs in a React reducer
 * on the till screen, not in the database and not in a global store. What does
 * not belong in a component is the *rules* — what a line may be, what the cart
 * comes to, whether it can be completed yet. Those are here, as pure functions
 * from a cart to a cart, so they can be tested under Node without a device and
 * so a second screen cannot grow a second answer to the same question.
 *
 * Nothing here writes. {@link toCart} hands the finished thing to
 * `completeSale`, which owns the fan-out and the transaction (§9, ADR-014).
 *
 * The arithmetic is deliberately **not** reimplemented. {@link view} calls
 * `subtotalOf` from the data layer, the same function the sale itself uses and
 * the same one the applier on another device uses. A running total worked out a
 * second way here is exactly how a screen comes to disagree with the receipt it
 * just printed.
 */

import { QUANTITY_SCALE } from "../../rules/amounts.ts";
import type { Product } from "../../data/products/products.ts";
import type { Cart, CartLine, CartPayment } from "../../data/sales/sales.ts";
import { subtotalOf } from "../../rules/pricing.ts";
import { RuleError, sumAmounts } from "../../rules/amounts.ts";

/** A cart being filled at the till. */
export interface CartState {
  readonly lines: readonly CartLine[];
  readonly payments: readonly CartPayment[];
  /** Whose it is, once a cashier says. An ordinary cash sale names nobody. */
  readonly customerId?: string | undefined;
  /** Taken off the whole sale, after the lines. */
  readonly discountMinor: number;
  readonly note?: string | undefined;
}

/** An empty till. */
export const emptyCart: CartState = { lines: [], payments: [], discountMinor: 0 };

/**
 * Why a cart cannot be completed yet.
 *
 * A code rather than a sentence, because the till speaks French and English
 * (§46) and a message built here would be in whichever one this file was
 * written in. The screen turns these into words.
 */
export type Problem =
  | "EMPTY"
  | "OVERPAID"
  | "DISCOUNT_EXCEEDS_SALE"
  | "CREDIT_NEEDS_CUSTOMER"
  | "LINE_DISCOUNT_EXCEEDS_LINE"
  /**
   * A price, quantity, discount or payment that is not a whole amount at or above
   * zero (above zero for a quantity or payment). `completeSale` refuses these; the
   * screen says so rather than showing a total worked out from them.
   */
  | "INVALID_AMOUNT"
  | "TOO_LARGE";

/** What the till shows while the cart is being filled. */
export interface CartView {
  readonly subtotalMinor: number;
  readonly totalMinor: number;
  readonly paidMinor: number;
  /** What is still owed. Above zero makes this a credit sale (§13). */
  readonly outstandingMinor: number;
  /** How much is in the cart, in thousandths. */
  readonly itemsThousandths: number;
  /**
   * Everything standing between this cart and a completed sale.
   *
   * Reported rather than thrown, because a cart is *supposed* to be invalid
   * while it is being filled — a cashier who has scanned one item and taken no
   * money has an unpaid cart, and a till that threw at them would be unusable.
   * `completeSale` throws; this explains.
   */
  readonly problems: readonly Problem[];
}

/** Whether the cart can be completed as it stands. */
export function isComplete(view: CartView): boolean {
  return view.problems.length === 0;
}

/**
 * Adds a product to the cart, or adds to the line already holding it.
 *
 * Merging rather than appending, because scanning the same tin four times is
 * one line of four in every shop anyone has stood in. A cashier who genuinely
 * wants two lines at different prices changes the price on one, which
 * {@link setLinePrice} makes a different line.
 *
 * The price and name are copied from the product **now**, and stay copied: a
 * receipt reprinted next year has to show what was charged, and the product
 * will have been repriced by then (§41).
 */
export function addProduct(
  state: CartState,
  product: Product,
  ids: { readonly lineId: string; readonly movementId: string },
  quantity = QUANTITY_SCALE,
): CartState {
  const existing = state.lines.find(
    (line) => line.productId === product.id && line.unitPriceMinor === product.sellingPriceMinor,
  );
  if (existing !== undefined) {
    return setQuantity(state, existing.id, existing.quantity + quantity);
  }

  const line: CartLine = {
    id: ids.lineId,
    movementId: ids.movementId,
    productId: product.id,
    name: product.name,
    unitPriceMinor: product.sellingPriceMinor,
    quantity,
    ...(product.purchasePriceMinor === undefined
      ? {}
      : { unitCostMinor: product.purchasePriceMinor }),
    ...(product.taxRateBasisPoints === 0 ? {} : { taxRateBasisPoints: product.taxRateBasisPoints }),
  };
  return { ...state, lines: [...state.lines, line] };
}

/**
 * Sets a line's quantity, removing it at zero or below.
 *
 * Removing rather than keeping a zero line: a cashier holding the minus key
 * means to take the thing off, and a line of nothing on a receipt is a puzzle.
 */
export function setQuantity(state: CartState, lineId: string, quantity: number): CartState {
  if (quantity <= 0) {
    return removeLine(state, lineId);
  }
  return {
    ...state,
    lines: state.lines.map((line) => (line.id === lineId ? { ...line, quantity } : line)),
  };
}

/** Overrides what one line charges, which §41 records as a price change. */
export function setLinePrice(state: CartState, lineId: string, unitPriceMinor: number): CartState {
  return {
    ...state,
    lines: state.lines.map((line) =>
      line.id === lineId ? { ...line, unitPriceMinor } : line,
    ),
  };
}

/** Takes an amount off one line. */
export function setLineDiscount(state: CartState, lineId: string, discountMinor: number): CartState {
  return {
    ...state,
    lines: state.lines.map((line) =>
      line.id === lineId ? { ...line, discountMinor } : line,
    ),
  };
}

export function removeLine(state: CartState, lineId: string): CartState {
  return { ...state, lines: state.lines.filter((line) => line.id !== lineId) };
}

/** Takes an amount off the whole sale, after the lines. */
export function setDiscount(state: CartState, discountMinor: number): CartState {
  return { ...state, discountMinor };
}

/**
 * Tenders a payment against the cart.
 *
 * A sale has *many* payments (split cash and Mobile Money is an ordinary case
 * (§11), so these append rather than replace. Each names an account, never a
 * method, which is what keeps a provider a row rather than a release (§10).
 */
export function addPayment(state: CartState, payment: CartPayment): CartState {
  return { ...state, payments: [...state.payments, payment] };
}

export function removePayment(state: CartState, paymentId: string): CartState {
  return { ...state, payments: state.payments.filter((payment) => payment.id !== paymentId) };
}

/** Names who the sale is for, or nobody. */
export function setCustomer(state: CartState, customerId?: string): CartState {
  return customerId === undefined
    ? { ...state, customerId: undefined }
    : { ...state, customerId };
}

export function setNote(state: CartState, note?: string): CartState {
  return note === undefined ? { ...state, note: undefined } : { ...state, note };
}

/**
 * What the till shows, and everything wrong with the cart so far.
 *
 * Never throws. The arithmetic comes from `subtotalOf`, the data layer's own,
 * so the number on the screen and the number on the receipt are the same
 * number by construction rather than by agreement.
 */
export function view(state: CartState): CartView {
  const problems: Problem[] = [];
  const whole = (value: number | undefined, above = false): boolean =>
    value === undefined || (Number.isSafeInteger(value) && (above ? value > 0 : value >= 0));
  const invalid =
    !whole(state.discountMinor) ||
    state.lines.some(line => !whole(line.unitPriceMinor) || !whole(line.quantity, true) || !whole(line.discountMinor)) ||
    state.payments.some(payment => !whole(payment.amountMinor, true));
  if (invalid) {
    // Arithmetic on these would show a figure the sale could never be recorded
    // at — a negative discount reads as a larger total — so none is shown.
    problems.push("INVALID_AMOUNT");
  }

  let subtotalMinor = 0;
  try {
    if (!invalid) subtotalMinor = subtotalOf(state.lines);
  } catch (error) {
    // Either a line discount larger than its line, or arithmetic too big to be
    // exact. Both are real and neither should stop the screen drawing.
    subtotalMinor = 0;
    problems.push(error instanceof RuleError && error.code === "discount" ? "LINE_DISCOUNT_EXCEEDS_LINE" : "TOO_LARGE");
  }

  const discountMinor = invalid ? 0 : state.discountMinor;
  if (discountMinor > subtotalMinor) {
    problems.push("DISCOUNT_EXCEEDS_SALE");
  }
  const totalMinor = Math.max(0, subtotalMinor - discountMinor);

  let paidMinor = 0;
  try { if (!invalid) paidMinor = sumAmounts(state.payments.map(payment => payment.amountMinor)); }
  catch { problems.push("TOO_LARGE"); }
  // Paying more than the bill is not change owed — change comes from the cash
  // tendered, which is a different number from the payment recorded.
  if (paidMinor > totalMinor) {
    problems.push("OVERPAID");
  }

  const outstandingMinor = Math.max(0, totalMinor - paidMinor);
  if (outstandingMinor > 0 && (state.customerId ?? "") === "") {
    // A debt has to be owed by someone, or it could never be collected (§13).
    problems.push("CREDIT_NEEDS_CUSTOMER");
  }

  if (state.lines.length === 0) {
    problems.push("EMPTY");
  }

  let itemsThousandths = 0;
  try { if (!invalid) itemsThousandths = sumAmounts(state.lines.map(line => line.quantity)); }
  catch { problems.push("TOO_LARGE"); }

  return { subtotalMinor, totalMinor, paidMinor, outstandingMinor, itemsThousandths, problems };
}

/**
 * Turns a filled cart into the thing `completeSale` takes.
 *
 * The identifiers are supplied rather than drawn here, because a screen that
 * re-rendered would otherwise draw new ones and a retried tap would write a
 * second sale. Drawing them once, where the tap is handled, is what makes the
 * write idempotent (§27, ADR-011).
 *
 * The credit entry identifier is required exactly when the cart leaves
 * something owing, which is the rule `completeSale` enforces and the server
 * enforces again. Deciding it here means a cashier is told at the till rather
 * than after the sale is on the wire.
 */
export function toCart(
  state: CartState,
  identity: {
    readonly saleId: string;
    readonly businessId: string;
    readonly branchId?: string | undefined;
    readonly number: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly occurredAt: string;
    readonly recordedAt: string;
    readonly eventId: string;
    /** Drawn by the caller, and used only if the sale leaves a balance. */
    readonly creditTransactionId: string;
  },
): Cart {
  const totals = view(state);
  return {
    id: identity.saleId,
    businessId: identity.businessId,
    ...(identity.branchId === undefined ? {} : { branchId: identity.branchId }),
    ...(state.customerId === undefined ? {} : { customerId: state.customerId }),
    number: identity.number,
    lines: state.lines,
    payments: state.payments,
    ...(state.discountMinor === 0 ? {} : { discountMinor: state.discountMinor }),
    ...(state.note === undefined ? {} : { note: state.note }),
    userId: identity.userId,
    deviceId: identity.deviceId,
    occurredAt: identity.occurredAt,
    recordedAt: identity.recordedAt,
    eventId: identity.eventId,
    ...(totals.outstandingMinor > 0
      ? { creditTransactionId: identity.creditTransactionId }
      : {}),
  };
}
