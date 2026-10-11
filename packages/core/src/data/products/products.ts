/**
 * Products on the device.
 *
 * A product is state, not an event, which makes it the first thing here that
 * two devices can genuinely conflict over. Two tills can each sell the last bag
 * of rice and both sales stand; they cannot each set a different price and have
 * both prices stand. One edit has to win.
 *
 * The rule is last-write-wins ordered by `(updated_at, updated_by_device)`,
 * written out in {@link WINS} below and matching the server's upsert exactly
 * (ADR-015). It lives on the device as well as the server because a device must
 * resolve a conflict with no network — that is the whole premise of §45.
 */

import type { Database, Queryable, Row, SqlValue } from "../database/driver.ts";
import { enqueue } from "../sync/outbox.ts";
import { likePattern } from "../database/search.ts";

/** The event a product write queues. */
export const PRODUCT_SAVED = "PRODUCT_SAVED";

/** A product as the device holds it. */
export interface Product {
  readonly id: string;
  readonly businessId: string;
  readonly categoryId?: string | undefined;
  readonly name: string;
  readonly sku?: string | undefined;
  readonly barcode?: string | undefined;
  readonly description?: string | undefined;
  readonly brand?: string | undefined;
  readonly unit: string;
  readonly divisible: boolean;
  readonly purchasePriceMinor?: number | undefined;
  readonly sellingPriceMinor: number;
  readonly currency: string;
  readonly taxRateBasisPoints: number;
  readonly minimumStock: number;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The device whose edit is currently in force. */
  readonly updatedByDevice?: string | undefined;
}

/** What a caller supplies when saving a product. */
export interface SaveProduct extends Product {
  /** The user making the edit, recorded on the event for the audit trail. */
  readonly userId: string;
  /** The device making the edit. Breaks a tie between simultaneous edits. */
  readonly deviceId: string;
}

/** Raised when a product cannot be saved or read. */
export class ProductError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProductError";
  }
}

/**
 * The conflict rule, as SQL.
 *
 * Written once and used by both the local save and the applier that takes an
 * edit from another device, so a device cannot resolve its own writes by one
 * rule and other devices' by another.
 */
const WINS = `excluded.updated_at > products.updated_at
   OR (excluded.updated_at = products.updated_at
       AND excluded.updated_by_device > products.updated_by_device)`;

const UPSERT = `
  INSERT INTO products
    (id, business_id, category_id, name, sku, barcode, description, brand, unit,
     divisible, purchase_price_minor, selling_price_minor, currency,
     tax_rate_basis_points, minimum_stock, active, created_at, updated_at,
     updated_by_device)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    category_id           = excluded.category_id,
    name                  = excluded.name,
    sku                   = excluded.sku,
    barcode               = excluded.barcode,
    description           = excluded.description,
    brand                 = excluded.brand,
    unit                  = excluded.unit,
    divisible             = excluded.divisible,
    purchase_price_minor  = excluded.purchase_price_minor,
    selling_price_minor   = excluded.selling_price_minor,
    currency              = excluded.currency,
    tax_rate_basis_points = excluded.tax_rate_basis_points,
    minimum_stock         = excluded.minimum_stock,
    active                = excluded.active,
    updated_at            = excluded.updated_at,
    updated_by_device     = excluded.updated_by_device
  WHERE ${WINS}`;

/**
 * Saves a product and queues the event carrying it to the server.
 *
 * Both in one transaction: a product the shopkeeper can see and the server
 * never will is the loss ADR-014 exists to prevent, and it applies to a price
 * correction as much as to a sale.
 *
 * Returns whether the write took effect. A local save normally does (the
 * shopkeeper is editing what is in front of them), but it can lose to an edit
 * from another device that arrived with a later timestamp, and the caller
 * should show what is actually stored rather than what was typed.
 * Application adapters supply a native UUIDv7 event ID; omitted IDs retain the
 * legacy randomUUID behavior for existing repository callers.
 */
export function saveProduct(database: Database, product: SaveProduct, eventId?: string): boolean {
  validate(product);

  return database.transaction((tx) => {
    const applied = upsert(tx, product, product.deviceId);

    // The event is queued whether or not the local write won. Losing here says
    // only that this device already knows of a later edit; the server and the
    // other devices have to judge for themselves, against what they hold.
    enqueue(tx, {
      eventId: eventId ?? crypto.randomUUID(),
      businessId: product.businessId,
      userId: product.userId,
      deviceId: product.deviceId,
      type: PRODUCT_SAVED,
      payload: { product: describe(product) },
      occurredAt: product.updatedAt,
    });

    return applied;
  });
}

/**
 * Writes a product, keeping whichever edit wins.
 *
 * Shared by a local save and by an edit arriving from another device, so both
 * are resolved by the same comparison.
 */
export function upsert(tx: Queryable, product: Product, deviceId: string): boolean {
  const result = tx.run(UPSERT, [
    product.id,
    product.businessId,
    product.categoryId ?? null,
    product.name,
    product.sku ?? null,
    product.barcode ?? null,
    product.description ?? null,
    product.brand ?? null,
    product.unit,
    product.divisible ? 1 : 0,
    product.purchasePriceMinor ?? null,
    product.sellingPriceMinor,
    product.currency,
    product.taxRateBasisPoints,
    product.minimumStock,
    product.active ? 1 : 0,
    product.createdAt,
    product.updatedAt,
    deviceId,
  ]);
  return result.changes > 0;
}

/** Returns a product, or undefined if this device does not hold it. */
export function productOf(tx: Queryable, businessId: string, id: string): Product | undefined {
  const row = tx.get(`SELECT * FROM products WHERE business_id = ? AND id = ?`, [businessId, id]);
  return row === undefined ? undefined : toProduct(row);
}

/**
 * Finds a product by its barcode, which is the POS path.
 *
 * A code identifies a product within one business, not globally: two shops may
 * each sell the same manufacturer's barcode.
 */
export function productByBarcode(
  tx: Queryable,
  businessId: string,
  barcode: string,
): Product | undefined {
  const row = tx.get(`SELECT * FROM products WHERE business_id = ? AND barcode = ?`, [
    businessId,
    barcode,
  ]);
  return row === undefined ? undefined : toProduct(row);
}

/**
 * Finds products by what a cashier types, best match first (§46).
 *
 * The POS path, and the one §46 names as having to be fast. A cashier types
 * three or four letters between one customer and the next, so this has to be a
 * prefix match an index can serve rather than a scan, and it has to rank,
 * because the first row is the one that gets tapped.
 *
 * The ranking is deliberate and in this order:
 *
 * 1. An exact barcode. A scanner types the whole code and presses enter, and
 *    when that code is a product there is nothing to choose between.
 * 2. An exact SKU, for the shops that use one at the counter.
 * 3. A name starting with the term. "sav" finds Savon before Maggi Savoureux,
 *    because a person typing three letters is spelling the start of a word.
 * 4. A name containing it anywhere, which is what finds "Lait" in "Nido Lait".
 *
 * Archived products are absent: a till offering something the shop no longer
 * sells wastes the one tap the cashier had.
 *
 * `LIKE` with a leading wildcard cannot use an index, and that is accepted for
 * arm 4 only: a shop's catalogue is thousands of rows, not millions, and the
 * arms above it are the ones that answer a scanner. If a catalogue ever grows
 * past what this serves in a keystroke, FTS5 is the next step and this function
 * is where it goes.
 */
export function searchProducts(
  tx: Queryable,
  businessId: string,
  term: string,
  limit = 20,
): Product[] {
  const cleaned = term.trim();
  if (cleaned === "") {
    return [];
  }
  // search_name is the name folded at write time (accents, case); the term is
  // folded and escaped the same way, so "cafe" finds "Café" and "50%" finds the
  // product rather than every product.

  const rows = tx.all(
    `SELECT *,
            CASE WHEN barcode = ?2 THEN 0
                 WHEN sku = ?2 THEN 1
                 WHEN search_name LIKE ?3 ESCAPE '\\' THEN 2
                 ELSE 3 END AS rank
       FROM products
      WHERE business_id = ?1 AND active = 1
        AND (barcode = ?2 OR sku = ?2
             OR search_name LIKE ?4 ESCAPE '\\'
             OR sku LIKE ?3 ESCAPE '\\')
      ORDER BY rank, name
      LIMIT ?5`,
    [businessId, cleaned, likePattern(cleaned), likePattern(cleaned, { anywhere: true }), limit],
  );
  return rows.map(toProduct);
}

/** Lists the products a business sells, by name. */
export function listProducts(
  tx: Queryable,
  businessId: string,
  options: { readonly includeArchived?: boolean } = {},
): Product[] {
  const rows = tx.all(
    `SELECT * FROM products
      WHERE business_id = ?${options.includeArchived === true ? "" : " AND active = 1"}
      ORDER BY name`,
    [businessId],
  );
  return rows.map(toProduct);
}

/**
 * The payload a PRODUCT_SAVED event carries.
 *
 * These names are the wire contract with the server, which refuses a payload
 * carrying a field it does not know. The business is absent deliberately: the
 * server takes it from the authenticated envelope, and so does the device that
 * receives this (ADR-008). So is the device — that too comes from the envelope,
 * which is what stops a device nominating itself the winner of a tie.
 */
function describe(product: Product): Record<string, unknown> {
  const described: Record<string, unknown> = {
    id: product.id,
    name: product.name,
    unit: product.unit,
    selling_price_minor: product.sellingPriceMinor,
    created_at: product.createdAt,
    updated_at: product.updatedAt,
  };
  const optional: ReadonlyArray<readonly [string, unknown]> = [
    ["category_id", product.categoryId],
    ["sku", product.sku],
    ["barcode", product.barcode],
    ["description", product.description],
    ["brand", product.brand],
    ["purchase_price_minor", product.purchasePriceMinor],
  ];
  for (const [field, value] of optional) {
    if (value !== undefined) {
      described[field] = value;
    }
  }
  // Sent only when true or false-and-meaningful: the server reads an absent
  // divisible as false and an absent active as true, which are the defaults a
  // product is created with.
  if (product.divisible) {
    described["divisible"] = true;
  }
  if (product.taxRateBasisPoints !== 0) {
    described["tax_rate_basis_points"] = product.taxRateBasisPoints;
  }
  if (product.minimumStock !== 0) {
    described["minimum_stock"] = product.minimumStock;
  }
  if (!product.active) {
    described["active"] = false;
  }
  return described;
}

function validate(product: SaveProduct): void {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["id", product.id],
    ["businessId", product.businessId],
    ["name", product.name],
    ["unit", product.unit],
    ["currency", product.currency],
    ["userId", product.userId],
    ["deviceId", product.deviceId],
    ["createdAt", product.createdAt],
    ["updatedAt", product.updatedAt],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ProductError(`a product needs a ${field}`);
    }
  }
  if (!Number.isSafeInteger(product.sellingPriceMinor) || product.sellingPriceMinor < 0) {
    throw new ProductError("a selling price must be a whole number of francs, not below zero");
  }
  if (product.updatedAt < product.createdAt) {
    throw new ProductError("a product cannot have been edited before it existed");
  }
}

function toProduct(row: Row): Product {
  return {
    id: text(row, "id"),
    businessId: text(row, "business_id"),
    categoryId: optionalText(row, "category_id"),
    name: text(row, "name"),
    sku: optionalText(row, "sku"),
    barcode: optionalText(row, "barcode"),
    description: optionalText(row, "description"),
    brand: optionalText(row, "brand"),
    unit: text(row, "unit"),
    divisible: number(row, "divisible") === 1,
    purchasePriceMinor: optionalNumber(row, "purchase_price_minor"),
    sellingPriceMinor: number(row, "selling_price_minor"),
    currency: text(row, "currency"),
    taxRateBasisPoints: number(row, "tax_rate_basis_points"),
    minimumStock: number(row, "minimum_stock"),
    active: number(row, "active") === 1,
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    updatedByDevice: optionalText(row, "updated_by_device"),
  };
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new ProductError(`the product row has no ${column}`);
  }
  return value;
}

function optionalText(row: Row, column: string): string | undefined {
  const value = row[column];
  return typeof value === "string" ? value : undefined;
}

function number(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new ProductError(`the product row has no ${column}`);
  }
  return value;
}

function optionalNumber(row: Row, column: string): number | undefined {
  const value = row[column];
  return typeof value === "number" ? value : undefined;
}

export type { SqlValue };
