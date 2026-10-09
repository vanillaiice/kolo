import assert from "node:assert/strict";
import { it } from "node:test";
import { moneyEntry, quantityEntry, localDayPeriod, quantityInput } from "./entry.ts";
it("entry parsing preserves integer francs and exact thousandths without coercion or rounding", () => {
  assert.equal(moneyEntry(" 00500 "), 500); assert.equal(quantityEntry("0,125"), 125); assert.equal(quantityEntry("2.001"), 2001); assert.equal(quantityEntry("0"), 0);
  for (const invalid of ["", "1e3", "-1", "1.0", "0x10", "NaN", "9007199254740992"]) assert.throws(() => moneyEntry(invalid));
  for (const invalid of ["", "1e3", "-1", "1.0001", "1.", "1,2.3", "9007199254741"]) assert.throws(() => quantityEntry(invalid));
  assert.throws(() => quantityEntry("1.5", false)); assert.equal(quantityEntry("1.000", false), 1000);
});
it("calendar report boundaries include the entire selected local day and reject date rollover/reversed periods", () => {
  const period = localDayPeriod("2026-10-06", "2026-10-06"), start = new Date(period.from), end = new Date(period.until);
  assert.equal(start.getDate(), 6); assert.equal(start.getHours(), 0); assert.equal(end.getDate(), 7); assert.equal(end.getHours(), 0);
  assert.throws(() => localDayPeriod("2026-02-30", "2026-03-01")); assert.throws(() => localDayPeriod("2026-10-07", "2026-10-06")); assert.throws(() => localDayPeriod("bad", "2026-10-06"));
});

it("editable large quantities round trip exactly at the safe integer boundary",()=>{
  for(const quantity of [0,1,500,1000,2001,Number.MAX_SAFE_INTEGER])assert.equal(quantityEntry(quantityInput(quantity)),quantity);
});
