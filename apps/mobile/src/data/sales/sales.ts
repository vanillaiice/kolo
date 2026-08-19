/**
 * Completing a sale on the device (§9).
 *
 * This is the fan-out, and the reason the whole architecture is shaped the way
 * it is. One thing happens in the shop — a customer pays for three items — and
 * it becomes a sale, its lines, the stock those lines released, one or more
 * payments, and the event that carries all of it to the server. Every one of
 * those in a single SQLite transaction.
 *
 * Half of it landing would describe something that did not happen: money taken
 * for goods still on the shelf, or stock gone with nobody recorded as paying.
 * A device that could produce that state would produce it eventually, on a
 * cheap phone that ran out of battery mid-write.
 *
 * It completes with no network, always. §23 is not negotiable, and a till that
 * waited for a server would stop the shop when the link went down — which here
 * is most of the time.
 */

import type { Database, Queryable } from "../database/driver.ts";
import { QUANTITY_SCALE, type MovementType } from "../inventory/movements.ts";
import { enqueue } from "../sync/outbox.ts";

/** The event a completed sale queues. */
export const SALE_COMPLETED = "SALE_COMPLETED";

/** Everything is XAF (§46). */
const CURRENCY = "XAF";

/** One line of a cart. */
export interface CartLine {
  readonly id: string;
  /**
   * The identifier for the stock movement this line releases.
   *
   * Supplied rather than derived from the line's, because it travels to the
   * server in the event and has to be an identifier the server can read — the
   * same UUID shape as every other identifier here (ADR-011). It is what makes
   * a resent sale a duplicate rather than a second helping of stock out of the
   * shop (§27).
   */
  readonly movementId: string;
  readonly productId: string;
  /** The product's name as it is now, kept with the line for the receipt. */
  readonly name: string;
  readonly unitPriceMinor: number;
  /** Thousandths, so half a kilo is 500. Must be above zero. */
  readonly quantity: number;
  readonly discountMinor?: number | undefined;
  readonly taxRateBasisPoints?: number | undefined;
  /** What the business paid for one, when it knows (§6). */
  readonly unitCostMinor?: number | undefined;
}

/** One payment tendered against a sale. */
export interface CartPayment {
  readonly id: string;
  /** Which account took the money — never a payment type (§10). */
  readonly accountId: string;
  readonly amountMinor: number;
  /** The provider's transaction number, for Mobile Money. */
  readonly reference?: string | undefined;
  readonly note?: string | undefined;
}

/** A sale about to be completed. */
export interface Cart {
  readonly id: string;
  readonly businessId: string;
  readonly branchId?: string | undefined;
  /** Optional: an ordinary cash sale names nobody (§12). */
  readonly customerId?: string | undefined;
  readonly number: string;
  readonly lines: readonly CartLine[];
  readonly payments: readonly CartPayment[];
  /** Taken off the whole sale, after the lines. */
  readonly discountMinor?: number | undefined;
  readonly note?: string | undefined;
  readonly userId: string;
  readonly deviceId: string;
  /** When the sale happened. */
  readonly occurredAt: string;
  /** When the row is being written. */
  readonly recordedAt: string;
  /** The event identifier, which is what makes a replay a duplicate (§27). */
  readonly eventId: string;
  /**
   * The customer ledger entry for what this sale leaves owing (§13).
   *
   * Required when anything is outstanding and refused when nothing is: a debt
   * needs an entry to carry it, and a settled sale that named one would be
   * claiming a debt its own numbers say does not exist.
   */
  readonly creditTransactionId?: string | undefined;
}

/** Where a completed sale stands. */
export interface SaleTotals {
  readonly subtotalMinor: number;
  readonly totalMinor: number;
  readonly paidMinor: number;
  /** What is still owed. Above zero makes this a credit sale (§13). */
  readonly outstandingMinor: number;
}

/** Raised when a sale cannot be completed. */
export class SaleError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SaleError";
  }
}

/**
 * Completes a sale: writes it, its lines, its stock movements, its payments,
 * and the event that carries them, all in one transaction.
 *
 * Returns the totals, so a till can show what was actually recorded rather than
 * what it worked out separately — two answers to the same arithmetic is how a
 * receipt comes to disagree with a report.
 */
export function completeSale(database: Database, cart: Cart): SaleTotals {
  const totals = totalsOf(cart);
  checkCredit(cart, totals);

  return database.transaction((tx) => {
    insertSale(tx, cart);

    for (const line of cart.lines) {
      insertItem(tx, cart, line);
      // The stock a line released. Derived here rather than asked for, because
      // a sale always moves what it sold and a caller that had to remember
      // would eventually forget (§7).
      insertMovement(tx, cart, line);
    }

    for (const payment of cart.payments) {
      insertPayment(tx, cart, payment);
    }

    // What the sale left owing goes on the customer's ledger, in this same
    // transaction. §9's fan-out reaches §13 here: goods left the shop and
    // someone owes for them, and a sale recorded without the debt would be
    // stock gone with nobody on the books for it.
    if (totals.outstandingMinor > 0) {
      insertCredit(tx, cart, totals.outstandingMinor);
    }

    enqueue(tx, {
      eventId: cart.eventId,
      businessId: cart.businessId,
      userId: cart.userId,
      deviceId: cart.deviceId,
      type: SALE_COMPLETED,
      payload: describe(cart),
      occurredAt: cart.occurredAt,
    });

    return totals;
  });
}

/**
 * Checks the sale carries an entry for what it leaves owing, and none for what
 * it does not.
 *
 * This is a rule about writing rather than about arithmetic, which is why it is
 * here and not in {@link totalsOf}: a till showing a running total should not
 * fail because the cashier has not yet decided how the balance will be carried.
 *
 * The identifier is the device's to draw, and must be, because it is what makes
 * a resent sale a duplicate rather than a second debt (§27). The server applies
 * exactly this pair of rules to the event, so a cart that fails here would have
 * been rejected there — better to say so at the till, where the numbers are on
 * the screen.
 */
function checkCredit(cart: Cart, totals: SaleTotals): void {
  if (totals.outstandingMinor > 0 && (cart.creditTransactionId ?? "") === "") {
    throw new SaleError(
      `${totals.outstandingMinor} is left owing with no ledger entry to carry it`,
    );
  }
  if (totals.outstandingMinor === 0 && cart.creditTransactionId !== undefined) {
    throw new SaleError(
      "a sale paid in full carries a ledger entry for a debt it does not leave",
    );
  }
}

/**
 * Works out what a sale comes to, refusing anything that does not add up.
 *
 * Exported because a till needs the running total of a cart before anything is
 * written — and it must be this function, not a second one in the interface.
 * Two implementations of the same arithmetic is how the screen comes to say one
 * number and the receipt another.
 */
export function totalsOf(cart: Cart): SaleTotals {
  validate(cart);

  const subtotalMinor = subtotalOf(cart.lines);
  const discountMinor = cart.discountMinor ?? 0;
  if (discountMinor > subtotalMinor) {
    throw new SaleError(
      `a discount of ${discountMinor} exceeds the sale's ${subtotalMinor}`,
    );
  }
  const totalMinor = subtotalMinor - discountMinor;

  let paidMinor = 0;
  for (const payment of cart.payments) {
    paidMinor += payment.amountMinor;
  }

  // Paying more than the bill is not change owed — change comes from the cash
  // tendered, which is a different number from the payment recorded. Accepting
  // it would put money in the accounts the business never took.
  if (paidMinor > totalMinor) {
    throw new SaleError(`paid ${paidMinor} against a total of ${totalMinor}`);
  }

  const outstandingMinor = totalMinor - paidMinor;
  // A debt has to be owed by someone, or it could never be collected (§13).
  if (outstandingMinor > 0 && (cart.customerId ?? "") === "") {
    throw new SaleError(`${outstandingMinor} is left owing with no customer to owe it`);
  }

  return { subtotalMinor, totalMinor, paidMinor, outstandingMinor };
}

/**
 * The sum of the lines, before the sale's own discount.
 *
 * Exported because the applier that receives a sale from another device has to
 * work out what it left owing, and must reach that number by this arithmetic.
 * A second implementation is how one till comes to think a customer owes 8,000
 * and another 8,001.
 */
export function subtotalOf(lines: readonly PricedLine[]): number {
  let subtotalMinor = 0;
  for (const [index, line] of lines.entries()) {
    subtotalMinor += lineTotalOf(line, index);
  }
  return subtotalMinor;
}

/** What is needed to price a line: the rest of a CartLine is for the record. */
export interface PricedLine {
  readonly unitPriceMinor: number;
  readonly quantity: number;
  readonly discountMinor?: number | undefined;
}

/**
 * What one line comes to.
 *
 * Price times quantity divided by the scale, rounded half away from zero. This
 * has to match the server's `MulRatio(..., RoundHalfUp)` exactly: a device and
 * a server that round differently would disagree about a shopkeeper's takings
 * by a franc a line, and nobody would know which was right.
 *
 * `Math.round` is deliberately not used — it rounds −0.5 to −0, breaking ties
 * towards positive infinity rather than away from zero. Quantities here are
 * positive, so it would agree today and diverge the moment a refund line was
 * added.
 */
function lineTotalOf(line: PricedLine, index: number): number {
  const gross = roundHalfAwayFromZero(line.unitPriceMinor * line.quantity, QUANTITY_SCALE);
  const discount = line.discountMinor ?? 0;
  if (discount > gross) {
    throw new SaleError(`line ${index}: a discount of ${discount} exceeds the line's ${gross}`);
  }
  return gross - discount;
}

function roundHalfAwayFromZero(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator)) {
    // Beyond this, a price is no longer exact in a double, and money that is
    // not exact is not money (ADR-010).
    throw new SaleError(`a line total of ${numerator} is too large to be exact`);
  }
  const sign = numerator < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(numerator) + denominator / 2) / denominator);
}

function insertSale(tx: Queryable, cart: Cart): void {
  tx.run(
    `INSERT INTO sales
       (id, business_id, branch_id, customer_id, number, discount_minor, currency,
        note, user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cart.id,
      cart.businessId,
      cart.branchId ?? null,
      cart.customerId ?? null,
      cart.number,
      cart.discountMinor ?? 0,
      CURRENCY,
      cart.note ?? null,
      cart.userId,
      cart.deviceId,
      cart.occurredAt,
      cart.recordedAt,
    ],
  );
}

function insertItem(tx: Queryable, cart: Cart, line: CartLine): void {
  tx.run(
    `INSERT INTO sale_items
       (id, sale_id, business_id, product_id, name, unit_price_minor, quantity,
        discount_minor, tax_rate_basis_points, unit_cost_minor, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      line.id,
      cart.id,
      cart.businessId,
      line.productId,
      line.name,
      line.unitPriceMinor,
      line.quantity,
      line.discountMinor ?? 0,
      line.taxRateBasisPoints ?? 0,
      line.unitCostMinor ?? null,
      CURRENCY,
    ],
  );
}

/**
 * Writes the movement a line released.
 *
 * Negative, because a sale removes stock. The reference points back at the
 * sale, which is what keeps the ledger traceable to the business event that
 * caused it (§40).
 */
function insertMovement(tx: Queryable, cart: Cart, line: CartLine): void {
  const type: MovementType = "SALE";
  tx.run(
    `INSERT INTO inventory_movements
       (id, business_id, branch_id, product_id, type, quantity,
        unit_cost_minor, unit_cost_currency, reference_kind, reference_id, reason,
        user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SALE', ?, NULL, ?, ?, ?, ?)`,
    [
      line.movementId,
      cart.businessId,
      cart.branchId ?? null,
      line.productId,
      type,
      -line.quantity,
      line.unitCostMinor ?? null,
      line.unitCostMinor === undefined ? null : CURRENCY,
      cart.id,
      cart.userId,
      cart.deviceId,
      cart.occurredAt,
      cart.recordedAt,
    ],
  );
}

/**
 * Writes the ledger entry for what the sale left owing.
 *
 * Positive, because a credit sale adds to what the customer owes, and signed so
 * that summing the ledger is plain addition (§13). The reference points back at
 * the sale, which is how a statement line is traced to what the customer
 * actually took.
 *
 * The amount is this sale's own arithmetic rather than a figure handed in, so
 * the debt cannot disagree with the receipt.
 */
function insertCredit(tx: Queryable, cart: Cart, outstandingMinor: number): void {
  tx.run(
    `INSERT INTO customer_transactions
       (id, customer_id, business_id, branch_id, type, amount_minor, currency,
        reference_kind, reference_id, reason, user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, 'CREDIT_SALE', ?, ?, 'SALE', ?, NULL, ?, ?, ?, ?)`,
    [
      cart.creditTransactionId ?? null,
      cart.customerId ?? null,
      cart.businessId,
      cart.branchId ?? null,
      outstandingMinor,
      CURRENCY,
      cart.id,
      cart.userId,
      cart.deviceId,
      cart.occurredAt,
      cart.recordedAt,
    ],
  );
}

function insertPayment(tx: Queryable, cart: Cart, payment: CartPayment): void {
  tx.run(
    `INSERT INTO sale_payments
       (id, sale_id, business_id, branch_id, account_id, amount_minor, currency,
        reference, note, user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payment.id,
      cart.id,
      cart.businessId,
      cart.branchId ?? null,
      payment.accountId,
      payment.amountMinor,
      CURRENCY,
      payment.reference ?? null,
      payment.note ?? null,
      cart.userId,
      cart.deviceId,
      cart.occurredAt,
      cart.recordedAt,
    ],
  );
}

/**
 * The payload a SALE_COMPLETED event carries.
 *
 * These names are the wire contract with the server's `SaleCompletedPayload`,
 * which refuses a field it does not know. No business, no branch, no user, no
 * device, no currency: identity comes from the authenticated envelope (ADR-008)
 * and everything is XAF.
 */
function describe(cart: Cart): Record<string, unknown> {
  const sale: Record<string, unknown> = {
    id: cart.id,
    number: cart.number,
    occurred_at: cart.occurredAt,
    items: cart.lines.map((line) => {
      const item: Record<string, unknown> = {
        id: line.id,
        product_id: line.productId,
        name: line.name,
        unit_price_minor: line.unitPriceMinor,
        quantity: line.quantity,
      };
      if ((line.discountMinor ?? 0) !== 0) {
        item["discount_minor"] = line.discountMinor;
      }
      if ((line.taxRateBasisPoints ?? 0) !== 0) {
        item["tax_rate_basis_points"] = line.taxRateBasisPoints;
      }
      if (line.unitCostMinor !== undefined) {
        item["unit_cost_minor"] = line.unitCostMinor;
      }
      return item;
    }),
  };
  if (cart.customerId !== undefined) {
    sale["customer_id"] = cart.customerId;
  }
  if (cart.creditTransactionId !== undefined) {
    sale["credit_transaction_id"] = cart.creditTransactionId;
  }
  if ((cart.discountMinor ?? 0) !== 0) {
    sale["discount_minor"] = cart.discountMinor;
  }
  if (cart.note !== undefined) {
    sale["note"] = cart.note;
  }

  return {
    sale,
    payments: cart.payments.map((payment) => {
      const described: Record<string, unknown> = {
        id: payment.id,
        account_id: payment.accountId,
        amount_minor: payment.amountMinor,
      };
      if (payment.reference !== undefined) {
        described["reference"] = payment.reference;
      }
      if (payment.note !== undefined) {
        described["note"] = payment.note;
      }
      return described;
    }),
    // The movements travel with the sale that caused them, so the server
    // applies the whole fan-out as one thing.
    movements: cart.lines.map((line) => ({
      id: line.movementId,
      product_id: line.productId,
      type: "SALE",
      quantity: -line.quantity,
      reference_kind: "SALE",
      reference_id: cart.id,
      ...(line.unitCostMinor === undefined ? {} : { unit_cost_minor: line.unitCostMinor }),
    })),
  };
}

function validate(cart: Cart): void {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["id", cart.id],
    ["businessId", cart.businessId],
    ["number", cart.number],
    ["userId", cart.userId],
    ["deviceId", cart.deviceId],
    ["occurredAt", cart.occurredAt],
    ["recordedAt", cart.recordedAt],
    ["eventId", cart.eventId],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new SaleError(`a sale needs a ${field}`);
    }
  }
  if (cart.recordedAt < cart.occurredAt) {
    throw new SaleError("a sale cannot be recorded before it happened");
  }
  if (cart.lines.length === 0) {
    throw new SaleError("a sale needs at least one line");
  }

  const lineIds = new Set<string>();
  for (const [index, line] of cart.lines.entries()) {
    if (line.id.trim() === "" || line.productId.trim() === "" || line.name.trim() === "") {
      throw new SaleError(`line ${index} is missing an identifier, a product, or a name`);
    }
    if (typeof line.movementId !== "string" || line.movementId.trim() === "") {
      throw new SaleError(`line ${index} is missing the identifier for the stock it releases`);
    }
    if (lineIds.has(line.id)) {
      throw new SaleError(`line ${line.id} appears twice`);
    }
    lineIds.add(line.id);

    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new SaleError(`line ${index} sells ${line.quantity}, which is not a positive amount`);
    }
    if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
      throw new SaleError(`line ${index} has a price of ${line.unitPriceMinor}`);
    }
    if (line.discountMinor !== undefined && (!Number.isInteger(line.discountMinor) || line.discountMinor < 0)) {
      throw new SaleError(`line ${index} has a discount of ${line.discountMinor}`);
    }
  }

  const paymentIds = new Set<string>();
  for (const [index, payment] of cart.payments.entries()) {
    if (payment.id.trim() === "" || payment.accountId.trim() === "") {
      throw new SaleError(`payment ${index} is missing an identifier or an account`);
    }
    if (paymentIds.has(payment.id)) {
      throw new SaleError(`payment ${payment.id} appears twice`);
    }
    paymentIds.add(payment.id);

    if (!Number.isInteger(payment.amountMinor) || payment.amountMinor <= 0) {
      throw new SaleError(`payment ${index} is for ${payment.amountMinor}`);
    }
  }

  if (cart.discountMinor !== undefined && (!Number.isInteger(cart.discountMinor) || cart.discountMinor < 0)) {
    throw new SaleError(`a sale discount of ${cart.discountMinor} is not a whole amount at or above zero`);
  }
}
