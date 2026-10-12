import assert from "node:assert/strict";
import { it } from "node:test";
import { RuleError } from "./amounts.ts";
import { saleTotals } from "./pricing.ts";
import { checkTaxRate, includedTax, saleTaxGroups, taxGroups } from "./tax.ts";

// Independent oracle: round(|a|·r / (10000 + r)) half away from zero, sign restored.
function oracle(amount: bigint, rate: bigint): bigint {
  const negative = amount < 0n, absolute = negative ? -amount : amount, numerator = absolute * rate, denominator = 10000n + rate;
  const rounded = numerator / denominator + (2n * (numerator % denominator) >= denominator ? 1n : 0n);
  return negative ? -rounded : rounded;
}
function random(seed: number): () => number { let state = seed >>> 0; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; }; }

it("included tax matches an exact BigInt oracle over boundaries and random amounts, signs and rates", () => {
  const amounts = [0, 1, -1, 2, 99, 100, 1925, 11925, 1_000_000, -11925, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];
  const rates = [0, 1, 550, 1000, 1925, 5000, 9999, 10000];
  for (const amount of amounts) for (const rate of rates) assert.equal(BigInt(includedTax(amount, rate)), oracle(BigInt(amount), BigInt(rate)), `${amount} at ${rate}`);
  const next = random(33);
  for (let i = 0; i < 5000; i++) {
    const amount = Math.floor((next() - 0.5) * 2 * 10 ** (1 + Math.floor(next() * 14))), rate = Math.floor(next() * 10001);
    assert.equal(BigInt(includedTax(amount, rate)), oracle(BigInt(amount), BigInt(rate)));
  }
  // 19.25 % inside 11 925 is exactly 1 925; half-francs round away from zero both ways.
  assert.equal(includedTax(11925, 1925), 1925);
  assert.equal(includedTax(3, 10000), 2); assert.equal(includedTax(-3, 10000), -2);
  assert.equal(includedTax(0, 1925), 0);
});

it("refuses rates outside 0–10000 basis points and unsafe amounts", () => {
  for (const rate of [-1, 10001, 1.5, Number.NaN, Infinity]) {
    assert.throws(() => includedTax(100, rate), RuleError); assert.throws(() => checkTaxRate(rate), RuleError);
  }
  assert.throws(() => includedTax(Number.MAX_SAFE_INTEGER + 1, 1925), RuleError);
  assert.throws(() => taxGroups([{ rateBasisPoints: 1925, amountMinor: 1.5 }]), RuleError);
});

it("groups round once per rate, highest rate first, and gross always equals net plus tax", () => {
  const groups = taxGroups([{ rateBasisPoints: 1925, amountMinor: 1 }, { rateBasisPoints: 0, amountMinor: 500 }, { rateBasisPoints: 1925, amountMinor: 1 }, { rateBasisPoints: 1925, amountMinor: 1 }]);
  assert.deepEqual(groups.map(group => group.rateBasisPoints), [1925, 0]);
  // Three 1-franc lines: per line each rounds to 0; per group 3 × 0.1614 rounds to 0 as well, and 6 francs would round to 1.
  assert.deepEqual(groups[0], { rateBasisPoints: 1925, grossMinor: 3, taxMinor: 0, netMinor: 3 });
  assert.equal(taxGroups([{ rateBasisPoints: 1925, amountMinor: 6 }])[0]!.taxMinor, 1);
  assert.deepEqual(groups[1], { rateBasisPoints: 0, grossMinor: 500, taxMinor: 0, netMinor: 500 });
  assert.deepEqual(taxGroups([]), []);
  const cancelled = taxGroups([{ rateBasisPoints: 1925, amountMinor: 11925 }, { rateBasisPoints: 1925, amountMinor: -11925 }]);
  assert.deepEqual(cancelled, [{ rateBasisPoints: 1925, grossMinor: 0, taxMinor: 0, netMinor: 0 }], "a period whose returns cancel its sales keeps a zero group");
});

it("a sale's groups add up to its total under any bill discount and mix of rates (property)", () => {
  const next = random(7);
  for (let run = 0; run < 2000; run++) {
    const lines = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, index) => {
      const unitPriceMinor = Math.floor(next() * 50_000), quantity = 1 + Math.floor(next() * 5000);
      const gross = Math.floor((unitPriceMinor * quantity + 500) / 1000);
      return { id: `line-${index}`, unitPriceMinor, quantity, discountMinor: Math.floor(next() * (gross + 1)), taxRateBasisPoints: [0, 550, 1925, 1925, 10000][Math.floor(next() * 5)]! };
    });
    const subtotal = saleTotals({ lines, payments: [], customerId: "c" }).subtotalMinor, discountMinor = Math.floor(next() * (subtotal + 1));
    const groups = saleTaxGroups(lines, discountMinor), total = saleTotals({ lines, payments: [], discountMinor, customerId: "c" }).totalMinor;
    assert.equal(groups.reduce((sum, group) => sum + group.grossMinor, 0), total);
    for (const group of groups) {
      assert.equal(group.grossMinor, group.netMinor + group.taxMinor);
      assert.equal(BigInt(group.taxMinor), oracle(BigInt(group.grossMinor), BigInt(group.rateBasisPoints)));
      assert.ok(group.taxMinor >= 0 && group.taxMinor <= group.grossMinor);
    }
    assert.equal(new Set(groups.map(group => group.rateBasisPoints)).size, groups.length);
  }
  assert.throws(() => saleTaxGroups([{ id: "a", unitPriceMinor: 100, quantity: 1000, taxRateBasisPoints: 1925 }], 101), RuleError);
});
