/**
 * Applies EXPENSE_RECORDED events from other devices.
 *
 * The owner pays the rent from their phone; the till has to know, or the
 * month's takings will read better than they were.
 *
 * Expenses are appended, never merged, and a reversal arrives as its own
 * expense — the cost was recorded on Monday and corrected on Friday, which is
 * two facts and not one.
 *
 * The payload shape is the wire contract, matching `ExpenseRecordedPayload` in
 * backend/internal/app/syncing and what `expenses.ts` sends.
 */

import type { Queryable } from "../database/driver.ts";
import { UnusableEvent, type EventApplier } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";

/** The event type this applier handles. */
export const EXPENSE_RECORDED = "EXPENSE_RECORDED";

const CURRENCY = "XAF";

const CATEGORIES: readonly string[] = [
  "RENT",
  "ELECTRICITY",
  "WATER",
  "TRANSPORT",
  "SALARY",
  "PACKAGING",
  "MAINTENANCE",
  "INTERNET",
  "MARKETING",
  "OTHER",
];

/** Applies expenses recorded on other devices. */
export const expenseApplier: EventApplier = {
  types: [EXPENSE_RECORDED],

  apply(tx: Queryable, event: InboxEvent): void {
    const wire = expenseOf(event);
    const category = required(wire, "category");
    if (!CATEGORIES.includes(category)) {
      throw new UnusableEvent(`${category} is not a category this build knows`);
    }

    // INSERT OR IGNORE on the expense's own identifier: a pull retried after a
    // lost response must leave one cost rather than two (§27).
    tx.run(
      `INSERT OR IGNORE INTO expenses
         (id, business_id, branch_id, category, account_id, amount_minor, currency,
          description, reference, reverses_id, user_id, device_id, occurred_at, recorded_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        required(wire, "id"),
        // Tenant, user, and device come from the envelope (ADR-008).
        event.businessId,
        category,
        required(wire, "account_id"),
        wholeNumber(wire, "amount_minor"),
        CURRENCY,
        optional(wire, "description"),
        optional(wire, "reference"),
        optional(wire, "reverses_id"),
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

function expenseOf(event: InboxEvent): Wire {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new UnusableEvent("an expense event's payload is not an object");
  }
  const expense = (payload as { expense?: unknown }).expense;
  if (typeof expense !== "object" || expense === null) {
    throw new UnusableEvent("an expense event carries no expense");
  }
  return expense as Wire;
}

function required(wire: Wire, field: string): string {
  const value = wire[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnusableEvent(`an expense needs a ${field}`);
  }
  return value;
}

function optional(wire: Wire, field: string): string | null {
  const value = wire[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`an expense's ${field} must be text`);
  }
  return value;
}

function wholeNumber(wire: Wire, field: string): number {
  const value = wire[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value === 0) {
    throw new UnusableEvent(`an expense's ${field} must be a whole amount that is not zero`);
  }
  return value;
}
