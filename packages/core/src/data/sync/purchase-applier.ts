/**
 * Applies PURCHASE_RECORDED events from other devices.
 *
 * A shop where the owner records deliveries on their phone needs the till to
 * know what arrived — for the stock, for what the goods cost, and for what the
 * wholesaler is still owed. The delivery arrives whole, as it was sent, and
 * lands whole or not at all.
 *
 * The payload shape is the wire contract, matching `PurchaseRecordedPayload` in
 * backend/internal/app/syncing and what `purchases.ts` sends.
 */

import type { Queryable } from "../database/driver.ts";
import { QUANTITY_SCALE, multiplyRatio, sumAmounts } from "../../rules/amounts.ts";
import { UnusableEvent, type EventApplier } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";

/** The event type this applier handles. */
export const PURCHASE_RECORDED = "PURCHASE_RECORDED";

const CURRENCY = "XAF";

/** Applies deliveries arriving from other devices. */
export const purchaseApplier: EventApplier = {
  types: [PURCHASE_RECORDED],

  apply(tx: Queryable, event: InboxEvent): void {
    const body = objectOf(event.payload, "a delivery event's payload");
    const purchase = objectOf(body["purchase"], "a delivery event's purchase");

    const purchaseId = required(purchase, "id");

    // A delivery this device already holds is left exactly as it is. It can
    // arrive twice — a pull retried after a lost response — and what the shop
    // paid for its stock is never rewritten (§41). INSERT OR IGNORE is the
    // whole idempotency story here, and it also covers a device receiving back
    // the delivery it sent.
    tx.run(
      `INSERT OR IGNORE INTO purchases
         (id, business_id, branch_id, supplier_id, reference, note,
          user_id, device_id, occurred_at, recorded_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        purchaseId,
        // Tenant, user, and device come from the envelope, never the payload —
        // the same rule the server applies (ADR-008).
        event.businessId,
        optional(purchase, "supplier_id"),
        optional(purchase, "reference"),
        optional(purchase, "note"),
        event.userId,
        event.deviceId,
        optional(purchase, "occurred_at") ?? event.occurredAt,
        // When this device learned of it, which is now.
        new Date().toISOString(),
      ],
    );

    for (const line of listOf(purchase["items"], "a delivery's items")) {
      const item = objectOf(line, "a delivery item");
      tx.run(
        `INSERT OR IGNORE INTO purchase_items
           (id, purchase_id, business_id, product_id, unit_cost_minor, quantity, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          required(item, "id"),
          purchaseId,
          event.businessId,
          required(item, "product_id"),
          wholeNumber(item, "unit_cost_minor") ?? 0,
          wholeNumber(item, "quantity") ?? 0,
          CURRENCY,
        ],
      );
    }

    // The money that left the drawer at the door. A movement against the
    // account, because a delivery bought at the market names no wholesaler and
    // so has no ledger for it to go in — but the cash still went.
    for (const line of listOf(body["payments"], "a delivery's payments")) {
      const payment = objectOf(line, "a delivery payment");
      const amountMinor = wholeNumber(payment, "amount_minor") ?? 0;
      if (amountMinor >= 0) {
        throw new UnusableEvent(
          `a door payment of ${amountMinor} did not take money out of an account`,
        );
      }
      tx.run(
        `INSERT OR IGNORE INTO account_movements
           (id, account_id, business_id, branch_id, type, amount_minor, currency,
            counterpart_id, reason, user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, NULL, 'CASH_OUT', ?, ?, NULL, ?, ?, ?, ?, ?)`,
        [
          required(payment, "id"),
          required(payment, "account_id"),
          event.businessId,
          amountMinor,
          CURRENCY,
          // The schema refuses a CASH_OUT with no reason, so an event without
          // one is unusable rather than deferred: waiting will not supply it.
          required(payment, "reason"),
          event.userId,
          event.deviceId,
          optional(payment, "occurred_at") ?? event.occurredAt,
          new Date().toISOString(),
        ],
      );
    }

    applyOwed(tx, event, body, purchase, purchaseId);

    for (const line of listOf(body["movements"], "a delivery's movements")) {
      const movement = objectOf(line, "a movement");
      tx.run(
        `INSERT OR IGNORE INTO inventory_movements
           (id, business_id, branch_id, product_id, type, quantity,
            unit_cost_minor, unit_cost_currency, reference_kind, reference_id, reason,
            user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [
          required(movement, "id"),
          event.businessId,
          required(movement, "product_id"),
          required(movement, "type"),
          wholeNumber(movement, "quantity") ?? 0,
          wholeNumber(movement, "unit_cost_minor"),
          movement["unit_cost_minor"] === undefined ? null : CURRENCY,
          optional(movement, "reference_kind"),
          optional(movement, "reference_id"),
          event.userId,
          event.deviceId,
          optional(movement, "occurred_at") ?? event.occurredAt,
          new Date().toISOString(),
        ],
      );
    }
  },
};

/**
 * Writes what the delivery left owing onto the wholesaler's ledger.
 *
 * The debt is worked out here rather than read from the payload, by the same
 * arithmetic the device that recorded it used. Trusting a figure on the wire
 * would let a device with a rounding bug — or a garbled resend — put a different
 * number on a wholesaler's account than the delivery note says.
 *
 * INSERT OR IGNORE, as everywhere in this applier: the entry's own identifier
 * came from the device that recorded the delivery, so one arriving twice leaves
 * one debt (§27).
 */
function applyOwed(
  tx: Queryable,
  event: InboxEvent,
  body: Wire,
  purchase: Wire,
  purchaseId: string,
): void {
  let outstandingMinor: number;
  try {
    const total = sumAmounts(listOf(purchase["items"], "a delivery's items").map(line => {
      const item = objectOf(line, "a delivery item");
      return multiplyRatio(wholeNumber(item, "unit_cost_minor") ?? 0, wholeNumber(item, "quantity") ?? 0, QUANTITY_SCALE);
    }));
    const paid = sumAmounts(listOf(body["payments"], "a delivery's payments").map(line =>
      Math.abs(wholeNumber(objectOf(line, "a delivery payment"), "amount_minor") ?? 0)));
    outstandingMinor = sumAmounts([total, -paid]);
  } catch (cause) { throw new UnusableEvent("a delivery's total cannot be worked out", { cause }); }
  const transactionId = optional(purchase, "supplier_transaction_id");

  if (outstandingMinor <= 0) {
    if (transactionId !== null) {
      throw new UnusableEvent(
        "a delivery paid for carries a ledger entry for a debt it does not leave",
      );
    }
    return;
  }
  if (transactionId === null) {
    throw new UnusableEvent(`${outstandingMinor} is left owing with no ledger entry to carry it`);
  }
  const supplierId = optional(purchase, "supplier_id");
  if (supplierId === null) {
    throw new UnusableEvent(`${outstandingMinor} is left owing with no supplier to owe it`);
  }

  tx.run(
    `INSERT OR IGNORE INTO supplier_transactions
       (id, supplier_id, business_id, branch_id, type, amount_minor, currency, account_id,
        reference_kind, reference_id, reason, user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, NULL, 'PURCHASE', ?, ?, NULL, 'PURCHASE', ?, NULL, ?, ?, ?, ?)`,
    [
      transactionId,
      supplierId,
      event.businessId,
      outstandingMinor,
      CURRENCY,
      purchaseId,
      event.userId,
      event.deviceId,
      optional(purchase, "occurred_at") ?? event.occurredAt,
      new Date().toISOString(),
    ],
  );
}

type Wire = Record<string, unknown>;

function objectOf(value: unknown, what: string): Wire {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnusableEvent(`${what} is not an object`);
  }
  return value as Wire;
}

function listOf(value: unknown, what: string): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new UnusableEvent(`${what} is not a list`);
  }
  return value;
}

function required(wire: Wire, field: string): string {
  const value = wire[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnusableEvent(`a delivery needs a ${field}`);
  }
  return value;
}

function optional(wire: Wire, field: string): string | null {
  const value = wire[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`a delivery's ${field} must be text`);
  }
  return value;
}

function wholeNumber(wire: Wire, field: string): number | null {
  const value = wire[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new UnusableEvent(`a delivery's ${field} must be a whole number`);
  }
  return value;
}
