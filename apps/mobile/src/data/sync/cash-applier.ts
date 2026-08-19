/**
 * Applies CASH_MOVED events from other devices.
 *
 * The owner takes cash to the bank from their phone; the till has to know, or
 * the evening count will read 20,000 over and someone will go looking for money
 * that is already in the bank.
 *
 * Movements are appended, never merged: two devices each moving money is two
 * movements and both stand. A transfer arrives as two rows in one event, so it
 * lands whole or not at all.
 *
 * The payload shape is the wire contract, matching `CashMovedPayload` in
 * backend/internal/app/syncing and what `cash.ts` sends.
 */

import type { Queryable } from "../database/driver.ts";
import { UnusableEvent, type EventApplier } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";

/** The event type this applier handles. */
export const CASH_MOVED = "CASH_MOVED";

const CURRENCY = "XAF";

/** Applies money moved on other devices. */
export const cashApplier: EventApplier = {
  types: [CASH_MOVED],

  apply(tx: Queryable, event: InboxEvent): void {
    for (const line of movementsOf(event)) {
      const movement = objectOf(line, "a cash movement");

      // INSERT OR IGNORE on the movement's own identifier: a pull retried after
      // a lost response, or a device receiving back what it sent, must leave
      // one movement rather than two (§27).
      tx.run(
        `INSERT OR IGNORE INTO account_movements
           (id, account_id, business_id, branch_id, type, amount_minor, currency,
            counterpart_id, reason, user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          required(movement, "id"),
          required(movement, "account_id"),
          // Tenant, user, and device come from the envelope, never the payload
          // (ADR-008).
          event.businessId,
          required(movement, "type"),
          wholeNumber(movement, "amount_minor"),
          CURRENCY,
          optional(movement, "counterpart_id"),
          optional(movement, "reason"),
          event.userId,
          event.deviceId,
          optional(movement, "occurred_at") ?? event.occurredAt,
          // When this device learned of it, which is now.
          new Date().toISOString(),
        ],
      );
    }
  },
};

type Wire = Record<string, unknown>;

function movementsOf(event: InboxEvent): unknown[] {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new UnusableEvent("a cash event's payload is not an object");
  }
  const movements = (payload as { movements?: unknown }).movements;
  if (!Array.isArray(movements) || movements.length === 0) {
    throw new UnusableEvent("a cash event that moved no money");
  }
  return movements;
}

function objectOf(value: unknown, what: string): Wire {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnusableEvent(`${what} is not an object`);
  }
  return value as Wire;
}

function required(wire: Wire, field: string): string {
  const value = wire[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnusableEvent(`a cash movement needs a ${field}`);
  }
  return value;
}

function optional(wire: Wire, field: string): string | null {
  const value = wire[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`a cash movement's ${field} must be text`);
  }
  return value;
}

function wholeNumber(wire: Wire, field: string): number {
  const value = wire[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value === 0) {
    throw new UnusableEvent(`a cash movement's ${field} must be a whole amount that is not zero`);
  }
  return value;
}
