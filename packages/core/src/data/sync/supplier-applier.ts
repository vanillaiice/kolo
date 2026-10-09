/**
 * Applies SUPPLIER_SAVED and SUPPLIER_PAYMENT events from other devices.
 *
 * Two event types in one file because they are two halves of one thing and the
 * contrast is the point. A wholesaler's **details** are state, so one edit wins
 * (ADR-015). What the shop **owes** them is a ledger, so both devices' entries
 * stand and the balance is their sum. Resolving the second the way the first is
 * resolved would silently drop a payment somebody actually made.
 *
 * The payload shapes are the wire contract, matching `SupplierSavedPayload` and
 * `SupplierPaymentPayload` in backend/internal/app/syncing and what
 * `suppliers.ts` sends.
 */

import type { Queryable } from "../database/driver.ts";
import { upsertSupplier, type Supplier } from "../suppliers/suppliers.ts";
import { UnusableEvent, type EventApplier } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";

/** The event type carrying a wholesaler's details. */
export const SUPPLIER_SAVED = "SUPPLIER_SAVED";

/** The event type carrying the shop settling a wholesaler's bill. */
export const SUPPLIER_PAYMENT = "SUPPLIER_PAYMENT";

const CURRENCY = "XAF";

/** Applies supplier edits arriving from other devices. */
export const supplierApplier: EventApplier = {
  types: [SUPPLIER_SAVED],

  apply(tx: Queryable, event: InboxEvent): void {
    const wire = bodyOf(event, "supplier", "a supplier event");

    // The business and the editing device come from the envelope, never the
    // payload — the same rule the server applies (ADR-008, ADR-015).
    const supplier: Supplier = {
      id: required(wire, "supplier", "id"),
      businessId: event.businessId,
      name: required(wire, "supplier", "name"),
      phone: optional(wire, "supplier", "phone"),
      address: optional(wire, "supplier", "address"),
      contact: optional(wire, "supplier", "contact"),
      notes: optional(wire, "supplier", "notes"),
      // Absent means active. A device that never sends the field is not saying
      // the shop has stopped buying from them.
      active: flag(wire, "active", true),
      createdAt: required(wire, "supplier", "created_at"),
      updatedAt: required(wire, "supplier", "updated_at"),
    };

    // The return is deliberately ignored. A losing edit is not a failure: it
    // means this device already holds a later one, and the event is fully
    // handled either way. Treating it as a failure would defer it forever.
    upsertSupplier(tx, supplier, event.deviceId);
  },
};

/**
 * Applies payments to wholesalers arriving from other devices.
 *
 * Appended, never merged: two devices each settling part of a bill is two
 * payments, and both stand. A payment that arrives twice — a pull retried after
 * a lost response, or a device receiving back what it sent — leaves one entry,
 * because the entry's own identifier came from the device that made it (§27).
 */
export const supplierPaymentApplier: EventApplier = {
  types: [SUPPLIER_PAYMENT],

  apply(tx: Queryable, event: InboxEvent): void {
    const wire = bodyOf(event, "payment", "a supplier payment event");
    const amountMinor = wholeNumber(wire, "amount_minor");
    if (amountMinor <= 0) {
      // The sign is applied here, so a payment that increased a bill is
      // something no device can express.
      throw new UnusableEvent(`a payment of ${amountMinor} is not money changing hands`);
    }

    tx.run(
      `INSERT OR IGNORE INTO supplier_transactions
         (id, supplier_id, business_id, branch_id, type, amount_minor, currency, account_id,
          reference_kind, reference_id, reason, user_id, device_id, occurred_at, recorded_at)
       VALUES (?, ?, ?, NULL, 'PAYMENT', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      [
        required(wire, "payment", "id"),
        required(wire, "payment", "supplier_id"),
        // Tenant, user, and device come from the envelope, never the payload.
        event.businessId,
        -amountMinor,
        CURRENCY,
        // Required, and the reason is §18: this is what makes the drawer fall
        // by what was handed over.
        required(wire, "payment", "account_id"),
        optionalOrNull(wire, "note"),
        event.userId,
        event.deviceId,
        optionalOrNull(wire, "occurred_at") ?? event.occurredAt,
        // When this device learned of it, which is now.
        new Date().toISOString(),
      ],
    );
  },
};

type Wire = Record<string, unknown>;

function bodyOf(event: InboxEvent, key: string, what: string): Wire {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new UnusableEvent(`${what}'s payload is not an object`);
  }
  const body = (payload as Record<string, unknown>)[key];
  if (typeof body !== "object" || body === null) {
    throw new UnusableEvent(`${what} carries no ${key}`);
  }
  return body as Wire;
}

function required(wire: Wire, what: string, field: string): string {
  const value = wire[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnusableEvent(`a ${what} needs a ${field}`);
  }
  return value;
}

function optional(wire: Wire, what: string, field: string): string | undefined {
  const value = wire[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`a ${what}'s ${field} must be text`);
  }
  return value;
}

function optionalOrNull(wire: Wire, field: string): string | null {
  const value = wire[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`a supplier payment's ${field} must be text`);
  }
  return value;
}

function flag(wire: Wire, field: string, fallback: boolean): boolean {
  const value = wire[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new UnusableEvent(`a supplier's ${field} must be true or false`);
  }
  return value;
}

function wholeNumber(wire: Wire, field: string): number {
  const value = wire[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new UnusableEvent(`a supplier payment's ${field} must be a whole number`);
  }
  return value;
}
