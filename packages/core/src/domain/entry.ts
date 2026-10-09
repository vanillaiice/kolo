import { RuleError } from "../rules/amounts.ts";

/** Parses whole XAF without coercion, exponent notation, signs or fractional rounding. */
export function moneyEntry(value: string): number {
  const cleaned = value.trim();
  if (!/^\d+$/.test(cleaned)) throw new RuleError("invalid_amount");
  const parsed = Number(cleaned);
  if (!Number.isSafeInteger(parsed)) throw new RuleError("overflow");
  return parsed;
}

/** Parses decimal units to integer thousandths exactly; comma or dot, up to three places. */
export function quantityEntry(value: string, divisible = true): number {
  const match = /^(\d+)(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (match === null) throw new RuleError("invalid_amount");
  const thousandths = BigInt(match[1]!) * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
  if (thousandths > BigInt(Number.MAX_SAFE_INTEGER)) throw new RuleError("overflow");
  if (!divisible && thousandths % 1000n !== 0n) throw new RuleError("invalid_amount");
  return Number(thousandths);
}

/** Local calendar-day report range converted to half-open UTC instants, respecting device timezone/DST. */
export function localDayPeriod(from: string, through: string): { from: string; until: string } {
  const parse = (value: string): Date => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RuleError("invalid_amount");
    const date = new Date(`${value}T00:00:00`);
    if (!Number.isFinite(date.getTime()) || date.getFullYear() !== Number(value.slice(0, 4)) || date.getMonth() + 1 !== Number(value.slice(5, 7)) || date.getDate() !== Number(value.slice(8, 10))) throw new RuleError("invalid_amount");
    return date;
  };
  const start = parse(from), end = parse(through);
  if (end < start) throw new RuleError("invalid_amount");
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), until: end.toISOString() };
}

/** Exact editable decimal quantity; avoids dividing large integer thousandths through a floating-point number. */
export function quantityInput(thousandths: number): string {
  if (!Number.isSafeInteger(thousandths) || thousandths < 0) throw new RuleError("invalid_amount");
  const units = BigInt(thousandths) / 1000n, remainder = BigInt(thousandths) % 1000n;
  return remainder === 0n ? String(units) : `${units}.${String(remainder).padStart(3,"0").replace(/0+$/,"")}`;
}
