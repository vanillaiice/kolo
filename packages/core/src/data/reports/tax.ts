import type { Queryable } from "../database/driver.ts";
import { sqlInteger } from "../database/safe-values.ts";
import { sumAmounts } from "../../rules/amounts.ts";
import { discountedLineTotals } from "../../rules/returns.ts";
import { taxGroups, type TaxGroup } from "../../rules/tax.ts";
import { LINE_TOTAL } from "./reports.ts";

/** A period's tax-inclusive sales by rate (ADR-033), with the totals across rates. */
export interface TaxSummary {
  readonly groups: readonly TaxGroup[];
  readonly grossMinor: number;
  readonly taxMinor: number;
  readonly netMinor: number;
}

/**
 * Tax collected over `[from, to)` by the rate frozen on each sale line, net of sale returns made in the period.
 *
 * Bill discounts are spread over a sale's lines by the deterministic allocation returns use, and returns count at the
 * amount refunded or credited for the line, so the gross column adds up to the period's net sales. Tax is rounded once
 * per rate. Rate 0 (untaxed or exempt) is kept as its own group.
 */
export function taxBetween(tx: Queryable, businessId: string, from: string, to: string): TaxSummary {
  const amounts: { rateBasisPoints: number; amountMinor: number }[] = [];
  // Sales without a bill discount: their lines' totals are already final.
  for (const row of tx.all(`SELECT i.tax_rate_basis_points AS rate, sum(${LINE_TOTAL}) AS total
      FROM sale_items i JOIN sales s ON s.id = i.sale_id
     WHERE s.business_id = ? AND s.occurred_at >= ? AND s.occurred_at < ? AND s.discount_minor = 0
     GROUP BY i.tax_rate_basis_points`, [businessId, from, to]))
    amounts.push({ rateBasisPoints: sqlInteger(row["rate"]), amountMinor: sqlInteger(row["total"]) });
  // Sales with one: allocate it over their lines exactly.
  const discounted = new Map<string, { discount: number; lines: { id: string; unitPriceMinor: number; quantity: number; discountMinor: number; rate: number }[] }>();
  for (const row of tx.all(`SELECT s.id AS sale_id, s.discount_minor AS sale_discount, i.id, i.unit_price_minor, i.quantity, i.discount_minor, i.tax_rate_basis_points
      FROM sale_items i JOIN sales s ON s.id = i.sale_id
     WHERE s.business_id = ? AND s.occurred_at >= ? AND s.occurred_at < ? AND s.discount_minor > 0`, [businessId, from, to])) {
    const id = String(row["sale_id"]);
    let sale = discounted.get(id);
    if (sale === undefined) { sale = { discount: sqlInteger(row["sale_discount"]), lines: [] }; discounted.set(id, sale); }
    sale.lines.push({ id: String(row["id"]), unitPriceMinor: sqlInteger(row["unit_price_minor"]), quantity: sqlInteger(row["quantity"]),
      discountMinor: sqlInteger(row["discount_minor"]), rate: sqlInteger(row["tax_rate_basis_points"]) });
  }
  for (const sale of discounted.values()) {
    const totals = discountedLineTotals(sale.lines, sale.discount);
    for (const line of sale.lines) amounts.push({ rateBasisPoints: line.rate, amountMinor: totals.get(line.id)! });
  }
  // Returns made in the period, at the rate their original line was sold at.
  for (const row of tx.all(`SELECT si.tax_rate_basis_points AS rate, sum(ri.amount_minor) AS total
      FROM business_return_items ri
      JOIN business_returns r ON r.business_id = ri.business_id AND r.id = ri.return_id
      JOIN sale_items si ON si.id = ri.original_item_id
     WHERE r.business_id = ? AND r.kind = 'SALE' AND r.occurred_at >= ? AND r.occurred_at < ?
     GROUP BY si.tax_rate_basis_points`, [businessId, from, to]))
    amounts.push({ rateBasisPoints: sqlInteger(row["rate"]), amountMinor: -sqlInteger(row["total"]) });
  const groups = taxGroups(amounts);
  return { groups, grossMinor: sumAmounts(groups.map(group => group.grossMinor)), taxMinor: sumAmounts(groups.map(group => group.taxMinor)),
    netMinor: sumAmounts(groups.map(group => group.netMinor)) };
}
