import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exceedsCreditLimit, multiplyRatio, RuleError, sumAmounts } from "./amounts.ts";
import { lineTotal, purchaseTotals, saleTotals, subtotalOf } from "./pricing.ts";

// Independent oracle: compare distances to neighboring signed integers, not the production remainder rule.
function oracle(value: number, multiplier: number, divisor: number): bigint {
  const numerator = BigInt(value) * BigInt(multiplier), denominator = BigInt(divisor);
  const floor = numerator >= 0n ? numerator / denominator : -((-numerator + denominator - 1n) / denominator);
  const ceil = floor + 1n;
  const distanceBelow = numerator - floor * denominator, distanceAbove = ceil * denominator - numerator;
  if (distanceBelow < distanceAbove) return floor;
  if (distanceAbove < distanceBelow) return ceil;
  return numerator < 0n ? floor : ceil;
}
describe("runtime-independent exact financial rules", () => {
  it("matches an independent BigInt oracle for signed ties, odd divisors and high safe values", () => {
    const values = [0, 1, -1, 333, -333, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 9007199254740];
    for (const value of values) for (const multiplier of [1, 3, 500, 999, 1000, 1001, -3]) for (const divisor of [1, 3, 1000, 1001]) {
      const expected = oracle(value, multiplier, divisor);
      if (expected > BigInt(Number.MAX_SAFE_INTEGER) || expected < BigInt(Number.MIN_SAFE_INTEGER)) {
        assert.throws(() => multiplyRatio(value, multiplier, divisor), error => error instanceof RuleError && error.code === "overflow");
      } else assert.equal(multiplyRatio(value, multiplier, divisor), Number(expected));
    }
  });
  it("accepts exact safe results even when the multiplication exceeds double precision", () => {
    assert.equal(lineTotal({ unitPriceMinor: Number.MAX_SAFE_INTEGER, quantity: 1000 }), Number.MAX_SAFE_INTEGER);
    assert.equal(lineTotal({ unitPriceMinor: Number.MAX_SAFE_INTEGER, quantity: 1 }), Number(oracle(Number.MAX_SAFE_INTEGER, 1, 1000)));
    assert.equal(subtotalOf([{ unitPriceMinor: 333, quantity: 1500 }, { unitPriceMinor: 333, quantity: 1500 }]), 1000);
  });
  it("refuses unsafe inputs, aggregate overflow and invalid denominators without rounded acceptance", () => {
    for (const value of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => multiplyRatio(value, 1, 1000), RuleError);
    for (const divisor of [0, -1, 0.5]) assert.throws(() => multiplyRatio(1, 1, divisor), RuleError);
    assert.throws(() => subtotalOf([{ unitPriceMinor: Number.MAX_SAFE_INTEGER, quantity: 1000 }, { unitPriceMinor: 1, quantity: 1000 }]), RuleError);
    assert.throws(() => sumAmounts([Number.MAX_SAFE_INTEGER, 1]), RuleError);
    assert.equal(sumAmounts([Number.MAX_SAFE_INTEGER, 1, -1]), Number.MAX_SAFE_INTEGER);
  });
  it("shares fractional pricing/settlement between sales and purchases and never turns overpayment into change", () => {
    const sale = saleTotals({ lines: [{ unitPriceMinor: 333, quantity: 1500 }], payments: [{ amountMinor: 200 }], customerId: "customer" });
    const purchase = purchaseTotals({ lines: [{ unitCostMinor: 333, quantity: 1500 }], payments: [{ amountMinor: 200 }], supplierId: "supplier" });
    assert.deepEqual(purchase, { totalMinor: sale.totalMinor, paidMinor: sale.paidMinor, outstandingMinor: sale.outstandingMinor });
    assert.equal(sale.outstandingMinor, 300);
    assert.throws(() => saleTotals({ lines: [{ unitPriceMinor: 1, quantity: 1000 }], payments: [{ amountMinor: 2 }] }), error => error instanceof RuleError && error.code === "overpaid");
    assert.throws(() => saleTotals({ lines: [{ unitPriceMinor: 10, quantity: 1000, discountMinor: 11 }], payments: [] }), error => error instanceof RuleError && error.code === "discount");
    assert.throws(() => purchaseTotals({ lines: [{ unitCostMinor: 1, quantity: 1000 }], payments: [] }), error => error instanceof RuleError && error.code === "counterparty");
  });
  it("compares prospective credit exactly at safe boundaries and accounts for credit balances", () => {
    assert.equal(exceedsCreditLimit(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER), true);
    assert.equal(exceedsCreditLimit(-100, 100, 0), false);
    assert.equal(exceedsCreditLimit(100, 100, undefined), false);
    assert.throws(() => exceedsCreditLimit(0, -1, 0), RuleError);
  });
});
