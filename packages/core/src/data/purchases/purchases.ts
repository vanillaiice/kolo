/**
 * Recording a delivery on the device (§15).
 *
 * The fan-out a sale has, upside down. One thing happens in the shop — the
 * wholesaler's van arrives — and it becomes a purchase, its lines, the stock
 * those lines brought in, the money handed over at the door, and what the
 * supplier is still owed. Every one of those in a single SQLite transaction.
 *
 * **A purchase is not an inventory operation.** It raises stock and *either*
 * lowers a financial account or raises what the business owes. Half of it
 * landing describes something that did not happen: stock on the shelf the books
 * never paid for, money gone with no goods to show for it, or a wholesaler owed
 * nothing for a delivery they made.
 *
 * The money handed over is a movement against the account rather than an entry
 * in the supplier's ledger, and that is deliberate: a crate bought at the market
 * names no wholesaler and so has no ledger for it to go in, but the cash still
 * left the drawer and has to be recorded as gone.
 *
 * It completes with no network, always (§23).
 */

import type { Database, Queryable } from "../database/driver.ts";
import { purchaseTotals } from "../../rules/pricing.ts";
import { enqueue } from "../sync/outbox.ts";

/** The event a recorded delivery queues. */
export const PURCHASE_RECORDED = "PURCHASE_RECORDED";

/** Everything is XAF (§46). */
const CURRENCY = "XAF";

/** One line of a delivery. */
export interface DeliveryLine {
  readonly id: string;
  /**
   * The identifier for the stock movement this line brings in.
   *
   * Drawn by the device, never derived from the line's: every identifier in a
   * payload is parsed as a UUID on arrival (ADR-011), and a composed one would
   * have the event rejected with the delivery already recorded on the till.
   */
  readonly movementId: string;
  readonly productId: string;
  /**
   * What one costs. Required, unlike a sale line's price being lookup-able:
   * this is where a cost is learned, and a delivery with no cost tells the shop
   * nothing about what its stock is worth (§8).
   */
  readonly unitCostMinor: number;
  /** Thousandths, so half a sack is 500. Must be above zero. */
  readonly quantity: number;
}

/** Money handed over at the door. */
export interface DoorPayment {
  /**
   * The movement's own identifier, drawn by the device. It is what makes a
   * resent payment a duplicate rather than a second one (§27).
   */
  readonly id: string;
  /** Which account the money came out of — never a payment type (§10). */
  readonly accountId: string;
  /** What was handed over, positive. The movement stores it negative. */
  readonly amountMinor: number;
  /**
   * Why cash left the drawer.
   *
   * Required, because §41 makes taking money out a sensitive operation and the
   * schema refuses a CASH_OUT without one. "It was a purchase" is not an answer
   * an owner reading the day's cash can do anything with.
   */
  readonly reason: string;
}

/** A delivery about to be recorded. */
export interface Delivery {
  readonly id: string;
  readonly businessId: string;
  readonly branchId?: string | undefined;
  /** Optional: a crate bought at the market names nobody (§15). */
  readonly supplierId?: string | undefined;
  /** The supplier's invoice or delivery-note number, when there is one. */
  readonly reference?: string | undefined;
  readonly lines: readonly DeliveryLine[];
  readonly payments: readonly DoorPayment[];
  readonly note?: string | undefined;
  readonly userId: string;
  readonly deviceId: string;
  /** When the stock arrived. */
  readonly occurredAt: string;
  /** When the row is being written. */
  readonly recordedAt: string;
  /** The event identifier, which is what makes a replay a duplicate (§27). */
  readonly eventId: string;
  /**
   * The supplier ledger entry for what this delivery leaves owing (§16).
   *
   * Required when anything is outstanding and refused when nothing is: a debt
   * needs an entry to carry it, and a delivery paid at the door that named one
   * would be claiming a debt its own numbers say does not exist.
   */
  readonly supplierTransactionId?: string | undefined;
}

/** Where a recorded delivery stands. */
export interface DeliveryTotals {
  readonly totalMinor: number;
  readonly paidMinor: number;
  /** What the wholesaler is still owed. Above zero puts it on their account. */
  readonly outstandingMinor: number;
}

/** Raised when a delivery cannot be recorded. */
export class PurchaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PurchaseError";
  }
}

/**
 * Records a delivery: the purchase, its lines, the stock it brought in, the
 * money handed over, the debt for the rest, and the event carrying all of it.
 *
 * Returns the totals, so a screen can show what was actually recorded rather
 * than what it worked out separately — two answers to the same arithmetic is how
 * a delivery note comes to disagree with a report.
 */
export function recordPurchase(database: Database, delivery: Delivery): DeliveryTotals {
  const totals = totalsOfDelivery(delivery);
  checkCredit(delivery, totals);

  return database.transaction((tx) => {
    insertPurchase(tx, delivery);

    for (const line of delivery.lines) {
      insertItem(tx, delivery, line);
      // The stock a line brought in. Derived here rather than asked for,
      // because a delivery always moves what it delivered and a caller that had
      // to remember would eventually forget (§7).
      insertMovement(tx, delivery, line);
    }

    for (const payment of delivery.payments) {
      insertDoorPayment(tx, delivery, payment);
    }

    // What the delivery left owing goes on the wholesaler's ledger, in this
    // same transaction. §15's fan-out reaches §16 here: goods came in and the
    // shop owes for them, and a delivery recorded without the debt would be
    // stock on the shelf the books show as paid for.
    if (totals.outstandingMinor > 0) {
      insertOwed(tx, delivery, totals.outstandingMinor);
    }

    enqueue(tx, {
      eventId: delivery.eventId,
      businessId: delivery.businessId,
      userId: delivery.userId,
      deviceId: delivery.deviceId,
      type: PURCHASE_RECORDED,
      payload: describe(delivery),
      occurredAt: delivery.occurredAt,
    });

    return totals;
  });
}

/**
 * Checks the delivery carries an entry for what it leaves owing, and none for
 * what it does not.
 *
 * The server applies exactly this pair of rules to the event, so a delivery that
 * fails here would have been rejected there — better to say so at the till,
 * where the numbers are on the screen.
 */
function checkCredit(delivery: Delivery, totals: DeliveryTotals): void {
  if (totals.outstandingMinor > 0 && (delivery.supplierTransactionId ?? "") === "") {
    throw new PurchaseError(
      `${totals.outstandingMinor} is left owing with no ledger entry to carry it`,
    );
  }
  if (totals.outstandingMinor === 0 && delivery.supplierTransactionId !== undefined) {
    throw new PurchaseError(
      "a delivery paid for carries a ledger entry for a debt it does not leave",
    );
  }
}

/**
 * Works out what a delivery comes to, refusing anything that does not add up.
 *
 * Exported because a screen needs the running total before anything is written —
 * and it must be this function, not a second one in the interface. Two
 * implementations of the same arithmetic is how the screen comes to say one
 * number and the delivery note another.
 */
export function totalsOfDelivery(delivery: Delivery): DeliveryTotals {
  validate(delivery);

  try { return purchaseTotals(delivery); }
  catch (cause) { throw new PurchaseError(cause instanceof Error ? cause.message : "invalid pricing", { cause }); }
}

function insertPurchase(tx: Queryable, delivery: Delivery): void {
  tx.run(
    `INSERT INTO purchases
       (id, business_id, branch_id, supplier_id, reference, note,
        user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      delivery.id,
      delivery.businessId,
      delivery.branchId ?? null,
      delivery.supplierId ?? null,
      delivery.reference ?? null,
      delivery.note ?? null,
      delivery.userId,
      delivery.deviceId,
      delivery.occurredAt,
      delivery.recordedAt,
    ],
  );
}

function insertItem(tx: Queryable, delivery: Delivery, line: DeliveryLine): void {
  tx.run(
    `INSERT INTO purchase_items
       (id, purchase_id, business_id, product_id, unit_cost_minor, quantity, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      line.id,
      delivery.id,
      delivery.businessId,
      line.productId,
      line.unitCostMinor,
      line.quantity,
      CURRENCY,
    ],
  );
}

/**
 * Writes the movement a line brought in.
 *
 * Positive, because a delivery raises stock. The reference points back at the
 * purchase, which is what keeps the ledger traceable to the business event that
 * caused it (§40). The unit cost travels with it, because §8's valuation reads
 * what stock cost from the movements that brought it in.
 */
function insertMovement(tx: Queryable, delivery: Delivery, line: DeliveryLine): void {
  tx.run(
    `INSERT INTO inventory_movements
       (id, business_id, branch_id, product_id, type, quantity,
        unit_cost_minor, unit_cost_currency, reference_kind, reference_id, reason,
        user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, 'PURCHASE', ?, ?, ?, 'PURCHASE', ?, NULL, ?, ?, ?, ?)`,
    [
      line.movementId,
      delivery.businessId,
      delivery.branchId ?? null,
      line.productId,
      line.quantity,
      line.unitCostMinor,
      CURRENCY,
      delivery.id,
      delivery.userId,
      delivery.deviceId,
      delivery.occurredAt,
      delivery.recordedAt,
    ],
  );
}

/**
 * Writes the money handed over at the door.
 *
 * A movement against the account, negative because the cash left. Not an entry
 * in the supplier's ledger: a delivery bought at the market names no wholesaler,
 * and the money still has to be recorded as gone.
 */
function insertDoorPayment(tx: Queryable, delivery: Delivery, payment: DoorPayment): void {
  tx.run(
    `INSERT INTO account_movements
       (id, account_id, business_id, branch_id, type, amount_minor, currency,
        counterpart_id, reason, user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, 'CASH_OUT', ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [
      payment.id,
      payment.accountId,
      delivery.businessId,
      delivery.branchId ?? null,
      -payment.amountMinor,
      CURRENCY,
      payment.reason,
      delivery.userId,
      delivery.deviceId,
      delivery.occurredAt,
      delivery.recordedAt,
    ],
  );
}

/**
 * Writes the ledger entry for what the delivery left owing.
 *
 * Positive, because a delivery adds to what the shop owes, and signed so that
 * summing the ledger is plain addition (§16). The reference points back at the
 * purchase, which is how a statement line is traced to the delivery note it came
 * from.
 *
 * The amount is this delivery's own arithmetic rather than a figure handed in,
 * so the debt cannot disagree with the delivery note.
 */
function insertOwed(tx: Queryable, delivery: Delivery, outstandingMinor: number): void {
  tx.run(
    `INSERT INTO supplier_transactions
       (id, supplier_id, business_id, branch_id, type, amount_minor, currency, account_id,
        reference_kind, reference_id, reason, user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, 'PURCHASE', ?, ?, NULL, 'PURCHASE', ?, NULL, ?, ?, ?, ?)`,
    [
      delivery.supplierTransactionId ?? null,
      delivery.supplierId ?? null,
      delivery.businessId,
      delivery.branchId ?? null,
      outstandingMinor,
      CURRENCY,
      delivery.id,
      delivery.userId,
      delivery.deviceId,
      delivery.occurredAt,
      delivery.recordedAt,
    ],
  );
}

/**
 * The payload a PURCHASE_RECORDED event carries.
 *
 * These names are the wire contract with the server's `PurchaseRecordedPayload`,
 * which refuses a field it does not know. No business, no branch, no user, no
 * device, no currency: identity comes from the authenticated envelope (ADR-008)
 * and everything is XAF.
 *
 * What is owed is deliberately absent. The server derives it from the same
 * arithmetic this file used, so a device with a rounding bug cannot put a
 * different number on a wholesaler's account than the delivery note says.
 */
function describe(delivery: Delivery): Record<string, unknown> {
  const purchase: Record<string, unknown> = {
    id: delivery.id,
    occurred_at: delivery.occurredAt,
    items: delivery.lines.map((line) => ({
      id: line.id,
      product_id: line.productId,
      unit_cost_minor: line.unitCostMinor,
      quantity: line.quantity,
    })),
  };
  if (delivery.supplierId !== undefined) {
    purchase["supplier_id"] = delivery.supplierId;
  }
  if (delivery.reference !== undefined) {
    purchase["reference"] = delivery.reference;
  }
  if (delivery.supplierTransactionId !== undefined) {
    purchase["supplier_transaction_id"] = delivery.supplierTransactionId;
  }
  if (delivery.note !== undefined) {
    purchase["note"] = delivery.note;
  }

  return {
    purchase,
    payments: delivery.payments.map((payment) => ({
      id: payment.id,
      account_id: payment.accountId,
      // Signed as it will be stored: negative, because this is money leaving.
      amount_minor: -payment.amountMinor,
      reason: payment.reason,
      occurred_at: delivery.occurredAt,
    })),
    movements: delivery.lines.map((line) => ({
      id: line.movementId,
      product_id: line.productId,
      type: "PURCHASE",
      quantity: line.quantity,
      unit_cost_minor: line.unitCostMinor,
      reference_kind: "PURCHASE",
      reference_id: delivery.id,
    })),
  };
}

/**
 * Checks a delivery before it reaches the database.
 *
 * The schema checks these too. Doing it here as well means the message names the
 * field rather than a constraint, which is what a person reading an error on a
 * till needs.
 */
function validate(delivery: Delivery): void {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["id", delivery.id],
    ["businessId", delivery.businessId],
    ["userId", delivery.userId],
    ["deviceId", delivery.deviceId],
    ["occurredAt", delivery.occurredAt],
    ["recordedAt", delivery.recordedAt],
    ["eventId", delivery.eventId],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new PurchaseError(`a delivery needs a ${field}`);
    }
  }
  if (delivery.recordedAt < delivery.occurredAt) {
    throw new PurchaseError("a delivery cannot be recorded before it arrived");
  }
  if (delivery.lines.length === 0) {
    throw new PurchaseError("a delivery needs at least one line");
  }

  const seen = new Set<string>();
  for (const [index, line] of delivery.lines.entries()) {
    for (const [field, value] of [
      ["id", line.id],
      ["movementId", line.movementId],
      ["productId", line.productId],
    ] as ReadonlyArray<readonly [string, string]>) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new PurchaseError(`line ${index} needs a ${field}`);
      }
    }
    if (seen.has(line.id)) {
      throw new PurchaseError(`line ${line.id} appears twice`);
    }
    seen.add(line.id);

    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new PurchaseError(`line ${index}: a quantity of ${line.quantity} brought nothing in`);
    }
    if (!Number.isSafeInteger(line.unitCostMinor) || line.unitCostMinor < 0) {
      throw new PurchaseError(
        `line ${index}: a unit cost of ${line.unitCostMinor} is not a whole amount at or above zero`,
      );
    }
  }

  for (const [index, payment] of delivery.payments.entries()) {
    for (const [field, value] of [
      ["id", payment.id],
      ["accountId", payment.accountId],
      // §41: taking money out is sensitive, and an owner reading the day's cash
      // needs to know what it was for.
      ["reason", payment.reason],
    ] as ReadonlyArray<readonly [string, string]>) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new PurchaseError(`payment ${index} needs a ${field}`);
      }
    }
    if (!Number.isSafeInteger(payment.amountMinor) || payment.amountMinor <= 0) {
      throw new PurchaseError(
        `payment ${index}: ${payment.amountMinor} is not money changing hands`,
      );
    }
  }
}
