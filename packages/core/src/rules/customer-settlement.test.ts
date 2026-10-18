import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { customerSettlement, keepableChange } from "./customer-settlement.ts";

it("purchases consume customer credit before adding debt, including crossing zero", () => {
  for (const [before, posted, credit, debt, after] of [[-600,350,350,0,-250],[-250,350,250,100,100],[400,350,0,350,750],[0,1000,0,1000,1000],[-600,0,0,0,-600]]) {
    assert.deepEqual(customerSettlement(before!,posted!), { balanceBeforeMinor:before,balanceAfterMinor:after,creditAppliedMinor:credit,debtAddedMinor:debt });
  }
});

it("refuses negative account charges, fractional money and unsafe balances", () => {
  for (const [balance, charge] of [[0,-1],[0,0.5],[NaN,1],[Number.MAX_SAFE_INTEGER,1]]) assert.throws(()=>customerSettlement(balance!,charge!));
});

describe("keepableChange", () => {
  const base = { hasCustomer: true, cashDueMinor: 700, tenderedMinor: 1000, outstandingMinor: 0 };
  it("is the cash handed over beyond the cash due", () => {
    assert.equal(keepableChange(base), 300);
    assert.equal(keepableChange({ ...base, tenderedMinor: 701 }), 1);
  });
  it("is zero with no customer, no or short tender, nothing paid in cash, or a sale left on account", () => {
    for (const changed of [{ hasCustomer: false }, { tenderedMinor: undefined }, { tenderedMinor: 700 }, { tenderedMinor: 500 }, { cashDueMinor: 0 }, { outstandingMinor: 200 }, { outstandingMinor: -1 }])
      assert.equal(keepableChange({ ...base, ...changed }), 0, JSON.stringify(changed));
  });
  it("refuses amounts that are not whole francs", () => {
    for (const changed of [{ cashDueMinor: 0.5 }, { tenderedMinor: Number.NaN }, { outstandingMinor: Number.MAX_SAFE_INTEGER + 1 }])
      assert.throws(() => keepableChange({ ...base, ...changed }), JSON.stringify(changed));
  });
  it("never exceeds what was handed over, whatever the amounts", () => {
    for (let seed = 1; seed < 500; seed++) {
      const due = (seed * 7919) % 50_000, tendered = (seed * 104_729) % 60_000, kept = keepableChange({ ...base, cashDueMinor: due, tenderedMinor: tendered });
      assert.ok(kept >= 0 && kept <= tendered && (kept === 0 || kept + due === tendered), `${due} ${tendered} ${kept}`);
    }
  });
});
