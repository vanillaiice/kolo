/**
 * Applies STOCK_MOVED events from other devices to this device's ledger.
 *
 * This is what makes two tills agree. One sells the last bag of rice, the other
 * receives that movement on its next sync, and both derive the same stock — by
 * summing the same movements, never by copying a number one of them worked out
 * (§29, ADR-009).
 *
 * The payload shape is the wire contract with the server, and matches
 * `StockMovedPayload` in backend/internal/app/syncing. Anything here that is not
 * there, or there and not here, is a bug that only shows up between two builds.
 */

import type { Queryable } from "../database/driver.ts";
import type { EventApplier } from "./engine.ts";
import { UnusableEvent } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";

/** The event type this applier handles. */
export const STOCK_MOVED = "STOCK_MOVED";

/** One movement as it travels. */
interface WireMovement {
  readonly id?: unknown;
  readonly product_id?: unknown;
  readonly type?: unknown;
  readonly quantity?: unknown;
  readonly unit_cost_minor?: unknown;
  readonly reference_kind?: unknown;
  readonly reference_id?: unknown;
  readonly reason?: unknown;
  readonly occurred_at?: unknown;
}

/** Applies stock movements arriving from other devices. */
export const stockApplier: EventApplier = {
  types: [STOCK_MOVED],

  apply(tx: Queryable, event: InboxEvent): void {
    for (const movement of movementsOf(event)) {
      insert(tx, event, movement);
    }
  },
};

function movementsOf(event: InboxEvent): readonly WireMovement[] {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new UnusableEvent("a stock event's payload is not an object");
  }

  const movements = (payload as { movements?: unknown }).movements;
  if (!Array.isArray(movements)) {
    throw new UnusableEvent("a stock event's payload has no list of movements");
  }
  if (movements.length === 0) {
    throw new UnusableEvent("a stock event that moves no stock");
  }
  return movements as readonly WireMovement[];
}

/**
 * Writes one movement, ignoring one already held.
 *
 * `INSERT OR IGNORE` on the identifier is what makes applying idempotent. It
 * matters more than it looks: an event can be applied, the transaction commit
 * can be interrupted after the write but before the inbox row is marked, and
 * the next run will try the same event again. Without this the second attempt
 * would double the stock.
 *
 * A movement this device already recorded itself arrives back the same way,
 * since the identifier travelled with it.
 */
function insert(tx: Queryable, event: InboxEvent, movement: WireMovement): void {
  const id = required(movement.id, "id");
  const productId = required(movement.product_id, "product_id");
  const type = required(movement.type, "type");
  const quantity = wholeNumber(movement.quantity, "quantity");

  tx.run(
    `INSERT OR IGNORE INTO inventory_movements
       (id, business_id, branch_id, product_id, type, quantity,
        unit_cost_minor, unit_cost_currency, reference_kind, reference_id, reason,
        user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      event.businessId,
      productId,
      type,
      quantity,
      optionalNumber(movement.unit_cost_minor, "unit_cost_minor"),
      // The currency is not on the wire. Everything is XAF (§46), and the
      // column is only nullable in step with the amount.
      movement.unit_cost_minor === undefined || movement.unit_cost_minor === null ? null : "XAF",
      optionalText(movement.reference_kind, "reference_kind"),
      optionalText(movement.reference_id, "reference_id"),
      optionalText(movement.reason, "reason"),
      // Who and which device come from the envelope, not the payload — the same
      // rule the server applies, for the same reason (ADR-008).
      event.userId,
      event.deviceId,
      optionalText(movement.occurred_at, "occurred_at") ?? event.occurredAt,
      // When this device wrote the row, which is now, not when the movement
      // happened elsewhere.
      new Date().toISOString(),
    ],
  );
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnusableEvent(`a movement needs a ${field}`);
  }
  return value;
}

function wholeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new UnusableEvent(`a movement's ${field} must be a whole number`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new UnusableEvent(`a movement's ${field} must be a whole number`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`a movement's ${field} must be text`);
  }
  return value;
}
