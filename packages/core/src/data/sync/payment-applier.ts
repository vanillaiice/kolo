/**
 * Applies CUSTOMER_PAYMENT events from other devices.
 *
 * A shop with two tills needs each to know what the other took: a customer who
 * paid 5,000 at the front counter must not be asked for it again at the back.
 *
 * The entry is appended, never merged. Two tills each taking a payment is two
 * payments, and both stand — the opposite of how a customer's *details* are
 * resolved, where one edit has to win.
 *
 * The payload shape is the wire contract, matching `CustomerPaymentPayload` in
 * backend/internal/app/syncing and what `customers.ts` sends.
 */

import type { Queryable } from "../database/driver.ts";
import { UnusableEvent, type EventApplier } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";

/** The event type this applier handles. */
export const CUSTOMER_PAYMENT = "CUSTOMER_PAYMENT";

const CURRENCY = "XAF";

/** Applies payments arriving from other devices. */
export const paymentApplier: EventApplier = {
  types: [CUSTOMER_PAYMENT],

  apply(tx: Queryable, event: InboxEvent): void {
    const wire = paymentOf(event);
    const amountMinor = wholeNumber(wire, "amount_minor");
    if (amountMinor <= 0) {
      // The sign is applied here, so a payment that increased a debt is
      // something no device can express.
      throw new UnusableEvent(`a payment of ${amountMinor} is not money changing hands`);
    }

    // INSERT OR IGNORE on the entry's own identifier: a pull retried after a
    // lost response, or a device receiving back what it sent, must leave one
    // payment rather than two (§27).
    tx.run(
      `INSERT OR IGNORE INTO customer_transactions
         (id, customer_id, business_id, branch_id, type, amount_minor, currency, account_id,
          reference_kind, reference_id, reason, user_id, device_id, occurred_at, recorded_at)
       VALUES (?, ?, ?, NULL, 'PAYMENT', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      [
        required(wire, "id"),
        required(wire, "customer_id"),
        // Tenant, user, and device come from the envelope, never the payload —
        // the same rule the server applies (ADR-008).
        event.businessId,
        -amountMinor,
        CURRENCY,
        required(wire, "account_id"),
        optional(wire, "note"),
        event.userId,
        event.deviceId,
        optional(wire, "occurred_at") ?? event.occurredAt,
        // When this device learned of it, which is now.
        new Date().toISOString(),
      ],
    );
  },
};

type Wire = Record<string, unknown>;

function paymentOf(event: InboxEvent): Wire {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new UnusableEvent("a payment event's payload is not an object");
  }
  const payment = (payload as { payment?: unknown }).payment;
  if (typeof payment !== "object" || payment === null) {
    throw new UnusableEvent("a payment event carries no payment");
  }
  return payment as Wire;
}

function required(wire: Wire, field: string): string {
  const value = wire[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnusableEvent(`a payment needs a ${field}`);
  }
  return value;
}

function optional(wire: Wire, field: string): string | null {
  const value = wire[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`a payment's ${field} must be text`);
  }
  return value;
}

function wholeNumber(wire: Wire, field: string): number {
  const value = wire[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new UnusableEvent(`a payment's ${field} must be a whole number`);
  }
  return value;
}
