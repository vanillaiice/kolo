import { amount, integer, multiplyRatio, sumAmounts, RuleError } from "./amounts.ts";
import { lineTotal } from "./pricing.ts";

/** Historical line pricing and IDs used to allocate a sale's whole-bill discount deterministically. */
export interface ReturnPriceLine { readonly id: string; readonly unitPriceMinor: number; readonly quantity: number; readonly discountMinor?: number | undefined; }
/** Allocates whole-bill discount by largest remainder, ties by line ID; exact XAF totals are preserved. */
export function discountedLineTotals(lines: readonly ReturnPriceLine[], discountMinor: number): ReadonlyMap<string, number> {
  if (lines.length === 0 || new Set(lines.map(line => line.id)).size !== lines.length) throw new RuleError("invalid_amount");
  const gross = lines.map(line => ({ id: line.id, total: lineTotal(line) })), subtotal = integer(sumAmounts(gross.map(line => line.total))), discount = integer(discountMinor);
  if (discount < 0n || discount > subtotal) throw new RuleError("discount");
  if (subtotal === 0n) return new Map(gross.map(line => [line.id, 0]));
  const shares = gross.map(line => ({ ...line, allocated: integer(line.total) * discount / subtotal, remainder: integer(line.total) * discount % subtotal }));
  let left = discount - shares.reduce((total, line) => total + line.allocated, 0n);
  for (const line of [...shares].sort((a,b) => a.remainder === b.remainder ? a.id < b.id ? -1 : 1 : a.remainder > b.remainder ? -1 : 1)) {
    if (left === 0n) break; line.allocated++; left--;
  }
  return new Map(shares.map(line => [line.id, amount(integer(line.total) - line.allocated)]));
}
/** Partial refund equals the change in cumulative rounded entitlement; the final return pays every remaining franc. */
export function incrementalReturnMinor(originalNetMinor: number, originalQuantity: number, alreadyReturned: number, returning: number): number {
  if (integer(originalNetMinor) < 0n || integer(originalQuantity) <= 0n || integer(alreadyReturned) < 0n || integer(returning) <= 0n || integer(alreadyReturned) + integer(returning) > integer(originalQuantity)) throw new RuleError("invalid_amount");
  return sumAmounts([multiplyRatio(originalNetMinor, sumAmounts([alreadyReturned, returning]), originalQuantity), -multiplyRatio(originalNetMinor, alreadyReturned, originalQuantity)]);
}
