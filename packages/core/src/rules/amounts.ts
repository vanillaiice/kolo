/** Pure exact arithmetic shared by clients and server. Money is integer XAF. */
export const QUANTITY_SCALE = 1000;

/** Stable rule failures, with no platform/database dependency. */
export class RuleError extends Error {
  readonly code: "invalid_amount" | "overflow" | "discount" | "overpaid" | "counterparty";
  constructor(code: RuleError["code"], message: string = code) { super(message); this.name = "RuleError"; this.code = code; }
}

/** Checks the number boundary before conversion to exact BigInt intermediates. */
export function integer(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new RuleError("invalid_amount", "amount must be a safe whole number");
  return BigInt(value);
}

/** Converts only exact safe integer results; never rounds an unsafe number boundary. */
export function amount(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RuleError("overflow", "amount is too large to be exact");
  }
  return Number(value);
}

/** Exact multiply/divide, rounded half away from zero, including negative corrections. */
export function multiplyRatio(value: number, numerator: number, denominator: number): number {
  const divisor = integer(denominator);
  if (divisor <= 0n) throw new RuleError("invalid_amount", "denominator must be positive");
  const product = integer(value) * integer(numerator);
  const absolute = product < 0n ? -product : product;
  const quotient = absolute / divisor;
  const rounded = quotient + (2n * (absolute % divisor) >= divisor ? 1n : 0n);
  return amount(product < 0n ? -rounded : rounded);
}

/** Sums signed safe inputs using exact intermediates and checks the final result. */
export function sumAmounts(values: readonly number[]): number {
  return amount(values.reduce((total, value) => total + integer(value), 0n));
}

/** Credit policy compares exact prospective debt, including an existing credit balance. */
export function exceedsCreditLimit(outstandingMinor: number, furtherMinor: number, limitMinor: number | undefined): boolean {
  const further = integer(furtherMinor), outstanding = integer(outstandingMinor);
  if (further < 0n) throw new RuleError("invalid_amount");
  if (limitMinor === undefined) return false;
  const limit = integer(limitMinor);
  if (limit < 0n) throw new RuleError("invalid_amount");
  return outstanding + further > limit;
}
