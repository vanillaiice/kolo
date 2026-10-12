import type { Queryable } from "../database/driver.ts";
import { sqlInteger } from "../database/safe-values.ts";
import { checkTaxRate } from "../../rules/tax.ts";

/**
 * Tax settings and product tax rules (ADR-033). Prices include tax; these records only decide which rate a sale line
 * carries, frozen on the line when it sells. Both are last-write-wins state by `(updated_at, updated_by_device)`.
 */

/** The shop's tax settings. */
export interface TaxSettings {
  readonly enabled: boolean;
  /** Printed name of the tax, e.g. "TVA". */
  readonly label: string;
  /** Basis points: 1925 is 19.25 %. */
  readonly standardRateBasisPoints: number;
  /** Tax registration number (NIU) printed on receipts. */
  readonly registration?: string | undefined;
  /** Version for last-write-wins edits; absent until first saved. */
  readonly updatedAt?: string | undefined;
}

/** What a shop that has never saved its tax settings gets: tax off, Cameroon's standard rate ready to switch on. */
export const DEFAULT_TAX_SETTINGS: TaxSettings = Object.freeze({ enabled: false, label: "TVA", standardRateBasisPoints: 1925 });

/** A product's tax: the shop's standard rate, none, or its own rate. */
export type ProductTaxRule =
  | { readonly rule: "STANDARD" | "EXEMPT"; readonly updatedAt?: string | undefined }
  | { readonly rule: "RATE"; readonly rateBasisPoints: number; readonly updatedAt?: string | undefined };

function wins(old: Record<string, unknown> | undefined, updatedAt: string, deviceId: string): boolean {
  return old === undefined || updatedAt > String(old["updated_at"]) || updatedAt === old["updated_at"] && deviceId > String(old["updated_by_device"]);
}

/** The shop's settings, or the defaults when none were saved. */
export function taxSettings(tx: Queryable, businessId: string): TaxSettings {
  const row = tx.get(`SELECT * FROM shop_tax_settings WHERE id = ? AND business_id = ?`, [businessId, businessId]);
  if (row === undefined) return DEFAULT_TAX_SETTINGS;
  return { enabled: row["enabled"] === 1, label: String(row["label"]), standardRateBasisPoints: sqlInteger(row["standard_rate_basis_points"]),
    ...(typeof row["registration"] === "string" ? { registration: row["registration"] } : {}), updatedAt: String(row["updated_at"]) };
}

/** Writes the settings under last-write-wins inside the caller's transaction; false when a newer version is stored. */
export function writeTaxSettings(tx: Queryable, businessId: string, settings: TaxSettings & { readonly updatedAt: string }, deviceId: string): boolean {
  checkTaxRate(settings.standardRateBasisPoints);
  if (!wins(tx.get(`SELECT updated_at, updated_by_device FROM shop_tax_settings WHERE id = ?`, [businessId]), settings.updatedAt, deviceId)) return false;
  tx.run(`INSERT INTO shop_tax_settings(id, business_id, enabled, label, standard_rate_basis_points, registration, updated_at, updated_by_device)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, label = excluded.label,
    standard_rate_basis_points = excluded.standard_rate_basis_points, registration = excluded.registration,
    updated_at = excluded.updated_at, updated_by_device = excluded.updated_by_device`,
  [businessId, businessId, settings.enabled ? 1 : 0, settings.label, settings.standardRateBasisPoints, settings.registration ?? null, settings.updatedAt, deviceId]);
  return true;
}

/**
 * A product's rule. With none stored it follows the standard rate, except that a non-zero legacy
 * `products.tax_rate_basis_points` (never written by current apps) counts as its own rate.
 */
export function productTaxRule(tx: Queryable, businessId: string, productId: string): ProductTaxRule {
  const row = tx.get(`SELECT rule, rate_basis_points, updated_at FROM product_tax_rules WHERE id = ? AND business_id = ?`, [productId, businessId]);
  if (row !== undefined) {
    const updatedAt = String(row["updated_at"]);
    return row["rule"] === "RATE" ? { rule: "RATE", rateBasisPoints: sqlInteger(row["rate_basis_points"]), updatedAt } : { rule: row["rule"] === "EXEMPT" ? "EXEMPT" : "STANDARD", updatedAt };
  }
  const legacy = sqlInteger(tx.get(`SELECT tax_rate_basis_points AS n FROM products WHERE id = ? AND business_id = ?`, [productId, businessId])?.["n"] ?? 0);
  return legacy > 0 ? { rule: "RATE", rateBasisPoints: legacy } : { rule: "STANDARD" };
}

/** Writes a product's rule under last-write-wins inside the caller's transaction; false when a newer rule is stored. */
export function writeProductTaxRule(tx: Queryable, businessId: string, productId: string, rule: ProductTaxRule & { readonly updatedAt: string }, deviceId: string): boolean {
  const rate = rule.rule === "RATE" ? checkTaxRate(rule.rateBasisPoints) : null;
  if (rate === 0) throw new RangeError("a product's own rate is above zero; use EXEMPT for none");
  if (!wins(tx.get(`SELECT updated_at, updated_by_device FROM product_tax_rules WHERE id = ?`, [productId]), rule.updatedAt, deviceId)) return false;
  tx.run(`INSERT INTO product_tax_rules(id, business_id, rule, rate_basis_points, updated_at, updated_by_device) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET rule = excluded.rule, rate_basis_points = excluded.rate_basis_points,
    updated_at = excluded.updated_at, updated_by_device = excluded.updated_by_device`, [productId, businessId, rule.rule, rate, rule.updatedAt, deviceId]);
  return true;
}

/** The rate a sale line of this product carries now: 0 while tax is off or the product is exempt. */
export function effectiveTaxRate(tx: Queryable, businessId: string, productId: string, settings: TaxSettings = taxSettings(tx, businessId)): number {
  if (!settings.enabled) return 0;
  const rule = productTaxRule(tx, businessId, productId);
  return rule.rule === "EXEMPT" ? 0 : rule.rule === "RATE" ? rule.rateBasisPoints : settings.standardRateBasisPoints;
}
