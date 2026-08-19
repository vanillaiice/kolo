/**
 * Applies SALE_COMPLETED events from other devices.
 *
 * A shop with two tills needs each to know what the other sold — for the day's
 * takings, for the stock, and for what a customer still owes. The sale arrives
 * whole, as it was sent, and lands whole or not at all.
 *
 * The payload shape is the wire contract, matching `SaleCompletedPayload` in
 * backend/internal/app/syncing and what `sales.ts` sends.
 */

import type { Queryable } from "../database/driver.ts";
import { subtotalOf } from "../sales/sales.ts";
import { UnusableEvent, type EventApplier } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";

/** The event type this applier handles. */
export const SALE_COMPLETED = "SALE_COMPLETED";

const CURRENCY = "XAF";

/** Applies sales arriving from other devices. */
export const saleApplier: EventApplier = {
  types: [SALE_COMPLETED],

  apply(tx: Queryable, event: InboxEvent): void {
    const body = objectOf(event.payload, "a sale event's payload");
    const sale = objectOf(body["sale"], "a sale event's sale");

    const saleId = required(sale, "id");

    // A sale this device already holds is left exactly as it is. It can arrive
    // twice — a pull retried after a lost response — and financial history is
    // never rewritten (§41). INSERT OR IGNORE is the whole idempotency story
    // here, and it also covers a device receiving back the sale it sent.
    tx.run(
      `INSERT OR IGNORE INTO sales
         (id, business_id, branch_id, customer_id, number, discount_minor, currency,
          note, user_id, device_id, occurred_at, recorded_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        saleId,
        // Tenant, user, and device come from the envelope, never the payload —
        // the same rule the server applies (ADR-008).
        event.businessId,
        optional(sale, "customer_id"),
        required(sale, "number"),
        wholeNumber(sale, "discount_minor") ?? 0,
        CURRENCY,
        optional(sale, "note"),
        event.userId,
        event.deviceId,
        optional(sale, "occurred_at") ?? event.occurredAt,
        // When this device learned of it, which is now.
        new Date().toISOString(),
      ],
    );

    for (const line of listOf(sale["items"], "a sale's items")) {
      const item = objectOf(line, "a sale item");
      tx.run(
        `INSERT OR IGNORE INTO sale_items
           (id, sale_id, business_id, product_id, name, unit_price_minor, quantity,
            discount_minor, tax_rate_basis_points, unit_cost_minor, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          required(item, "id"),
          saleId,
          event.businessId,
          required(item, "product_id"),
          required(item, "name"),
          wholeNumber(item, "unit_price_minor") ?? 0,
          wholeNumber(item, "quantity") ?? 0,
          wholeNumber(item, "discount_minor") ?? 0,
          wholeNumber(item, "tax_rate_basis_points") ?? 0,
          wholeNumber(item, "unit_cost_minor"),
          CURRENCY,
        ],
      );
    }

    for (const line of listOf(body["payments"], "a sale's payments")) {
      const payment = objectOf(line, "a payment");
      tx.run(
        `INSERT OR IGNORE INTO sale_payments
           (id, sale_id, business_id, branch_id, account_id, amount_minor, currency,
            reference, note, user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          required(payment, "id"),
          saleId,
          event.businessId,
          required(payment, "account_id"),
          wholeNumber(payment, "amount_minor") ?? 0,
          CURRENCY,
          optional(payment, "reference"),
          optional(payment, "note"),
          event.userId,
          event.deviceId,
          optional(payment, "occurred_at") ?? event.occurredAt,
          new Date().toISOString(),
        ],
      );
    }

    applyCredit(tx, event, body, sale, saleId);

    for (const line of listOf(body["movements"], "a sale's movements")) {
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
 * Writes what the sale left owing onto the customer's ledger.
 *
 * The debt is worked out here rather than read from the payload, by the same
 * arithmetic the till that sold it used. Trusting a figure on the wire would
 * let a device with a rounding bug — or a garbled resend — put a different
 * number on the customer's account than the receipt in their hand says.
 *
 * INSERT OR IGNORE, as everywhere in this applier: the entry's own identifier
 * came from the device that made the sale, so a sale arriving twice leaves one
 * debt (§27).
 */
function applyCredit(
  tx: Queryable,
  event: InboxEvent,
  body: Wire,
  sale: Wire,
  saleId: string,
): void {
  const lines = listOf(sale["items"], "a sale's items").map((line) => {
    const item = objectOf(line, "a sale item");
    return {
      unitPriceMinor: wholeNumber(item, "unit_price_minor") ?? 0,
      quantity: wholeNumber(item, "quantity") ?? 0,
      discountMinor: wholeNumber(item, "discount_minor") ?? 0,
    };
  });

  let paidMinor = 0;
  for (const line of listOf(body["payments"], "a sale's payments")) {
    paidMinor += wholeNumber(objectOf(line, "a payment"), "amount_minor") ?? 0;
  }

  let outstandingMinor: number;
  try {
    outstandingMinor = subtotalOf(lines) - (wholeNumber(sale, "discount_minor") ?? 0) - paidMinor;
  } catch (cause) {
    // A sale whose arithmetic this device cannot do is unusable rather than
    // deferred: waiting will not make it add up.
    throw new UnusableEvent("a sale's total cannot be worked out", { cause });
  }

  const transactionId = optional(sale, "credit_transaction_id");
  if (outstandingMinor <= 0) {
    if (transactionId !== null) {
      throw new UnusableEvent("a settled sale carries a ledger entry for a debt it does not leave");
    }
    return;
  }
  if (transactionId === null) {
    throw new UnusableEvent(`${outstandingMinor} is left owing with no ledger entry to carry it`);
  }
  const customerId = optional(sale, "customer_id");
  if (customerId === null) {
    throw new UnusableEvent(`${outstandingMinor} is left owing with no customer to owe it`);
  }

  tx.run(
    `INSERT OR IGNORE INTO customer_transactions
       (id, customer_id, business_id, branch_id, type, amount_minor, currency,
        reference_kind, reference_id, reason, user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, NULL, 'CREDIT_SALE', ?, ?, 'SALE', ?, NULL, ?, ?, ?, ?)`,
    [
      transactionId,
      customerId,
      event.businessId,
      outstandingMinor,
      CURRENCY,
      saleId,
      event.userId,
      event.deviceId,
      optional(sale, "occurred_at") ?? event.occurredAt,
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
    throw new UnusableEvent(`a sale needs a ${field}`);
  }
  return value;
}

function optional(wire: Wire, field: string): string | null {
  const value = wire[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`${field} must be text`);
  }
  return value;
}

function wholeNumber(wire: Wire, field: string): number | null {
  const value = wire[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new UnusableEvent(`${field} must be a whole number`);
  }
  return value;
}
