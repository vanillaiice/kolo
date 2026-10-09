/**
 * Applies CUSTOMER_SAVED events from other devices.
 *
 * The counterpart of the product applier, and needed for the same reason: a
 * credit sale for a customer this device has never seen waits in the inbox, and
 * this is what makes it arrive. Without it a shop with two tills could sell on
 * credit from one and never see the debt on the other.
 *
 * The payload shape is the wire contract, matching `CustomerSavedPayload` in
 * backend/internal/app/syncing and what `customers.ts` sends.
 */

import { upsertCustomer, type Customer } from "../customers/customers.ts";
import type { Queryable } from "../database/driver.ts";
import { UnusableEvent, type EventApplier } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";

/** The event type this applier handles. */
export const CUSTOMER_SAVED = "CUSTOMER_SAVED";

/** Applies customer edits arriving from other devices. */
export const customerApplier: EventApplier = {
  types: [CUSTOMER_SAVED],

  apply(tx: Queryable, event: InboxEvent): void {
    const wire = customerOf(event);

    // The business and the editing device come from the envelope, never the
    // payload — the same rule the server applies (ADR-008, ADR-015).
    const customer: Customer = {
      id: required(wire, "id"),
      businessId: event.businessId,
      name: required(wire, "name"),
      phone: optional(wire, "phone"),
      address: optional(wire, "address"),
      notes: optional(wire, "notes"),
      // Absent stays absent: no limit means the shopkeeper has not decided,
      // which is not the same as a limit of zero.
      creditLimitMinor: optionalNumber(wire, "credit_limit_minor"),
      // Absent means active. A device that never sends the field is not saying
      // the customer has been closed.
      active: flag(wire, "active", true),
      createdAt: required(wire, "created_at"),
      updatedAt: required(wire, "updated_at"),
    };

    // The return is deliberately ignored. A losing edit is not a failure: it
    // means this device already holds a later one, and the event is fully
    // handled either way. Treating it as a failure would defer it forever.
    upsertCustomer(tx, customer, event.deviceId);
  },
};

type Wire = Record<string, unknown>;

function customerOf(event: InboxEvent): Wire {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new UnusableEvent("a customer event's payload is not an object");
  }
  const customer = (payload as { customer?: unknown }).customer;
  if (typeof customer !== "object" || customer === null) {
    throw new UnusableEvent("a customer event carries no customer");
  }
  return customer as Wire;
}

function required(wire: Wire, field: string): string {
  const value = wire[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnusableEvent(`a customer needs a ${field}`);
  }
  return value;
}

function optional(wire: Wire, field: string): string | undefined {
  const value = wire[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`a customer's ${field} must be text`);
  }
  return value;
}

function optionalNumber(wire: Wire, field: string): number | undefined {
  const value = wire[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new UnusableEvent(`a customer's ${field} must be a whole number`);
  }
  return value;
}

function flag(wire: Wire, field: string, fallback: boolean): boolean {
  const value = wire[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new UnusableEvent(`a customer's ${field} must be true or false`);
  }
  return value;
}
