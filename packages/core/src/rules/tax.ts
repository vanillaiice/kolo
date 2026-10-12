import { integer, multiplyRatio, RuleError, sumAmounts } from "./amounts.ts";
import { discountedLineTotals, type ReturnPriceLine } from "./returns.ts";

/** Tax rates are basis points: 1925 is 19.25 %, 10000 is 100 %. */
export const TAX_RATE_SCALE = 10000;

/** Checks a rate before it reaches arithmetic or storage. */
export function checkTaxRate(rateBasisPoints: number): number {
  if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > TAX_RATE_SCALE) throw new RuleError("invalid_amount", "a tax rate is 0–10000 basis points");
  return rateBasisPoints;
}

/**
 * The tax contained in a tax-inclusive amount (ADR-033): `amount × rate / (10000 + rate)`, exact and rounded half away
 * from zero. Signed, so a period whose returns exceed its sales yields negative tax.
 */
export function includedTax(amountMinor: number, rateBasisPoints: number): number {
  return multiplyRatio(amountMinor, checkTaxRate(rateBasisPoints), TAX_RATE_SCALE + rateBasisPoints);
}

/** Tax-inclusive amounts at one rate: what the customer paid, the tax inside it and the amount before tax. */
export interface TaxGroup {
  readonly rateBasisPoints: number;
  /** Including tax (TTC). */
  readonly grossMinor: number;
  readonly taxMinor: number;
  /** Excluding tax (HT): gross less tax. */
  readonly netMinor: number;
}

/**
 * Groups signed tax-inclusive amounts by rate and computes each group's tax once, so rounding happens per rate rather
 * than per line. Groups are ordered by rate, highest first; a group whose amounts cancel to zero is kept.
 */
export function taxGroups(amounts: readonly { readonly rateBasisPoints: number; readonly amountMinor: number }[]): readonly TaxGroup[] {
  const byRate = new Map<number, number[]>();
  for (const entry of amounts) {
    checkTaxRate(entry.rateBasisPoints); integer(entry.amountMinor);
    const list = byRate.get(entry.rateBasisPoints) ?? [];
    list.push(entry.amountMinor); byRate.set(entry.rateBasisPoints, list);
  }
  return [...byRate.entries()].sort(([a], [b]) => b - a).map(([rateBasisPoints, values]) => {
    const grossMinor = sumAmounts(values), taxMinor = includedTax(grossMinor, rateBasisPoints);
    return { rateBasisPoints, grossMinor, taxMinor, netMinor: sumAmounts([grossMinor, -taxMinor]) };
  });
}

/** A sale line with the rate frozen on it at the time of sale. */
export interface TaxedLine extends ReturnPriceLine { readonly taxRateBasisPoints: number }

/**
 * A sale's tax by rate. Each line is reduced by its own discount and its deterministic share of the bill discount (the
 * allocation returns use), so the groups' gross amounts add up exactly to the sale total.
 */
export function saleTaxGroups(lines: readonly TaxedLine[], saleDiscountMinor: number): readonly TaxGroup[] {
  const totals = discountedLineTotals(lines, saleDiscountMinor);
  return taxGroups(lines.map(line => ({ rateBasisPoints: line.taxRateBasisPoints, amountMinor: totals.get(line.id)! })));
}
