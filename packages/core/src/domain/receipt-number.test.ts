import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { shortReceiptNumber } from "./receipt-number.ts";

it("desktop and mobile numbers for the same sale shorten to the same reference", () => {
  const id = "3696a4a3-d260-4389-a4cc-a008d05f0fa9";
  assert.equal(shortReceiptNumber(`V-${id}`), "V-D05F0FA9");
  assert.equal(shortReceiptNumber(`V-20261011-${id.replace(/-/g, "").slice(-12)}`), "V-D05F0FA9");
  assert.equal(shortReceiptNumber(`V-${id.toUpperCase()}`), "V-D05F0FA9");
  for (let i = 0; i < 200; i++) {
    const sale = randomUUID(), suffix = sale.slice(-8).toUpperCase();
    assert.equal(shortReceiptNumber(`V-${sale}`), `V-${suffix}`);
    assert.equal(shortReceiptNumber(`V-20261231-${sale.replace(/-/g, "").slice(-12)}`), `V-${suffix}`);
  }
});

it("numbers in any other shape are shown unchanged", () => {
  for (const number of ["", "V-", "V-D05F0FA9", "A-3696a4a3-d260-4389-a4cc-a008d05f0fa9", "V-3696a4a3-d260-4389-a4cc-a008d05f0fa", "V-3696a4a3-d260-4389-a4cc-a008d05f0fa9x",
    "V-3696a4a3d2604389a4cca008d05f0fa9", "V-2026101-a008d05f0fa9", "V-20261011-a008d05f0fa", "V-20261011-a008d05f0fag", "V-2026-10-11-a008d05f0fa9", " V-20261011-a008d05f0fa9", "FAC-0042"])
    assert.equal(shortReceiptNumber(number), number);
});
