import { amount, integer, multiplyRatio, QUANTITY_SCALE, RuleError, sumAmounts } from "./amounts.ts";

/** Minimal pricing facts; no SQL/framework/actor IDs enter a pure calculation. */
export interface PricedLine {
  readonly unitPriceMinor: number;
  readonly quantity: number;
  readonly discountMinor?: number | undefined;
}
/** A sale's arithmetic, independently usable by the till, importer and server. */
export interface SaleTotals {
  readonly subtotalMinor: number;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly outstandingMinor: number;
}

/** Exact line price in XAF, with positive thousandths and bounded nonnegative discount. */
export function lineTotal(line: PricedLine, index = 0): number {
  if (integer(line.unitPriceMinor) < 0n || integer(line.quantity) <= 0n) throw new RuleError("invalid_amount");
  const gross = multiplyRatio(line.unitPriceMinor, line.quantity, QUANTITY_SCALE);
  const discount = integer(line.discountMinor ?? 0);
  if (discount < 0n) throw new RuleError("invalid_amount");
  if (discount > BigInt(gross)) throw new RuleError("discount", `line ${index}: a discount of ${discount} exceeds the line's ${gross}`);
  return amount(BigInt(gross) - discount);
}

/** Sum of independently rounded lines; aggregate overflow is rejected. */
export function subtotalOf(lines: readonly PricedLine[]): number {
  return sumAmounts(lines.map((line, index) => lineTotal(line, index)));
}

/** Paid amounts are recorded allocations, not cash tendered or change. */
export function settlement(totalMinor: number, payments: readonly { readonly amountMinor: number }[], counterpartyId?: string): { readonly paidMinor: number; readonly outstandingMinor: number } {
  const total = integer(totalMinor);
  if (total < 0n) throw new RuleError("invalid_amount");
  const paidMinor = sumAmounts(payments.map(payment => {
    if (integer(payment.amountMinor) <= 0n) throw new RuleError("invalid_amount");
    return payment.amountMinor;
  }));
  if (BigInt(paidMinor) > total) throw new RuleError("overpaid", `paid ${paidMinor} against a total of ${totalMinor}`);
  const outstandingMinor = amount(total - BigInt(paidMinor));
  if (outstandingMinor > 0 && (counterpartyId ?? "").trim() === "") throw new RuleError("counterparty", `${outstandingMinor} is left owing with no counterparty to owe it`);
  return { paidMinor, outstandingMinor };
}

/** Exact sale subtotal/discount/settlement; callers retain persistence validation. */
export function saleTotals(input: { readonly lines: readonly PricedLine[]; readonly payments: readonly { readonly amountMinor: number }[]; readonly discountMinor?: number | undefined; readonly customerId?: string | undefined }): SaleTotals {
  if (input.lines.length === 0) throw new RuleError("invalid_amount", "a sale needs at least one line");
  const subtotalMinor = subtotalOf(input.lines), discount = integer(input.discountMinor ?? 0);
  if (discount < 0n) throw new RuleError("invalid_amount");
  if (discount > BigInt(subtotalMinor)) throw new RuleError("discount", `a discount of ${discount} exceeds the sale's ${subtotalMinor}`);
  const totalMinor = amount(BigInt(subtotalMinor) - discount);
  try { return { subtotalMinor, totalMinor, ...settlement(totalMinor, input.payments, input.customerId) }; }
  catch (error) { if (error instanceof RuleError && error.code === "counterparty") throw new RuleError("counterparty", error.message.replace("counterparty", "customer")); throw error; }
}

/** Exact delivery pricing using the same line rounding and settlement as sales. */
export function purchaseTotals(input: { readonly lines: readonly { readonly unitCostMinor: number; readonly quantity: number }[]; readonly payments: readonly { readonly amountMinor: number }[]; readonly supplierId?: string | undefined }): Omit<SaleTotals, "subtotalMinor"> {
  if (input.lines.length === 0) throw new RuleError("invalid_amount", "a delivery needs at least one line");
  const totalMinor = subtotalOf(input.lines.map(line => ({ unitPriceMinor: line.unitCostMinor, quantity: line.quantity })));
  try { return { totalMinor, ...settlement(totalMinor, input.payments, input.supplierId) }; }
  catch (error) { if (error instanceof RuleError && error.code === "counterparty") throw new RuleError("counterparty", error.message.replace("counterparty", "supplier")); throw error; }
}
