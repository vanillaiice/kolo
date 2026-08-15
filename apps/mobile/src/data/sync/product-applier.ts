/**
 * Applies PRODUCT_SAVED events from other devices.
 *
 * This is what makes the deferred inbox mostly empty rather than mostly full: a
 * movement for a product this device has never seen waits until the product
 * arrives, and this is what makes it arrive.
 *
 * The payload shape is the wire contract, matching `ProductSavedPayload` in
 * backend/internal/app/syncing.
 */

import type { Queryable } from "../database/driver.ts";
import { upsert, type Product } from "../products/products.ts";
import type { EventApplier } from "./engine.ts";
import { UnusableEvent } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";

/** The event type this applier handles. */
export const PRODUCT_SAVED = "PRODUCT_SAVED";

/** Applies product edits arriving from other devices. */
export const productApplier: EventApplier = {
  types: [PRODUCT_SAVED],

  apply(tx: Queryable, event: InboxEvent): void {
    const wire = productOf(event);

    // The business and the editing device come from the envelope, never the
    // payload — the same rule the server applies (ADR-008, ADR-015). Taking the
    // device from the payload would let one nominate itself the winner of a tie
    // by claiming to be another.
    const product: Product = {
      id: required(wire, "id"),
      businessId: event.businessId,
      categoryId: optional(wire, "category_id"),
      name: required(wire, "name"),
      sku: optional(wire, "sku"),
      barcode: optional(wire, "barcode"),
      description: optional(wire, "description"),
      brand: optional(wire, "brand"),
      unit: required(wire, "unit"),
      divisible: flag(wire, "divisible", false),
      purchasePriceMinor: optionalNumber(wire, "purchase_price_minor"),
      sellingPriceMinor: wholeNumber(wire, "selling_price_minor"),
      // Not on the wire: everything is XAF (§46), and a device announcing
      // another currency would be putting two in one price list.
      currency: "XAF",
      taxRateBasisPoints: optionalNumber(wire, "tax_rate_basis_points") ?? 0,
      minimumStock: optionalNumber(wire, "minimum_stock") ?? 0,
      // Absent means active. A device that never sends the field is not saying
      // the product is archived.
      active: flag(wire, "active", true),
      createdAt: required(wire, "created_at"),
      updatedAt: required(wire, "updated_at"),
    };

    // The return is deliberately ignored. A losing edit is not a failure: it
    // means this device already holds a later one, and the event is fully
    // handled either way. Treating it as a failure would defer it forever.
    upsert(tx, product, event.deviceId);
  },
};

type Wire = Record<string, unknown>;

function productOf(event: InboxEvent): Wire {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new UnusableEvent("a product event's payload is not an object");
  }
  const product = (payload as { product?: unknown }).product;
  if (typeof product !== "object" || product === null) {
    throw new UnusableEvent("a product event carries no product");
  }
  return product as Wire;
}

function required(wire: Wire, field: string): string {
  const value = wire[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnusableEvent(`a product needs a ${field}`);
  }
  return value;
}

function optional(wire: Wire, field: string): string | undefined {
  const value = wire[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`a product's ${field} must be text`);
  }
  return value;
}

function wholeNumber(wire: Wire, field: string): number {
  const value = wire[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new UnusableEvent(`a product's ${field} must be a whole number`);
  }
  return value;
}

function optionalNumber(wire: Wire, field: string): number | undefined {
  const value = wire[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new UnusableEvent(`a product's ${field} must be a whole number`);
  }
  return value;
}

function flag(wire: Wire, field: string, fallback: boolean): boolean {
  const value = wire[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new UnusableEvent(`a product's ${field} must be true or false`);
  }
  return value;
}
