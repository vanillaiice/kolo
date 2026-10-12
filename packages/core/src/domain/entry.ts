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

/** Parses a percentage with up to two decimals (comma or dot), 0–100, to basis points exactly: "19,25" is 1925. */
export function rateEntry(value: string): number {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(value.trim().replace(/\s*%$/, ""));
  if (match === null) throw new RuleError("invalid_amount");
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (basisPoints > 10000) throw new RuleError("invalid_amount");
  return basisPoints;
}

/** Exact editable percentage for basis points: 1925 is "19.25", 1000 is "10". */
export function rateInput(basisPoints: number): string {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) throw new RuleError("invalid_amount");
  const whole = Math.trunc(basisPoints / 100), fraction = basisPoints % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}
