import assert from "node:assert/strict";
import { it } from "node:test";
import { customerSettlement } from "./customer-settlement.ts";

it("purchases consume customer credit before adding debt, including crossing zero", () => {
  for (const [before, posted, credit, debt, after] of [[-600,350,350,0,-250],[-250,350,250,100,100],[400,350,0,350,750],[0,1000,0,1000,1000],[-600,0,0,0,-600]]) {
    assert.deepEqual(customerSettlement(before!,posted!), { balanceBeforeMinor:before,balanceAfterMinor:after,creditAppliedMinor:credit,debtAddedMinor:debt });
  }
});

it("refuses negative account charges, fractional money and unsafe balances", () => {
  for (const [balance, charge] of [[0,-1],[0,0.5],[NaN,1],[Number.MAX_SAFE_INTEGER,1]]) assert.throws(()=>customerSettlement(balance!,charge!));
});
