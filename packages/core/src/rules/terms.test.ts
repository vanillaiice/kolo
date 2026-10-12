import assert from "node:assert/strict";
import { it } from "node:test";
import { RuleError } from "./amounts.ts";
import { ageLedger, ageOutstanding, checkTermsDays, dueAt, DEFAULT_TERMS_DAYS, type LedgerEntry } from "./terms.ts";

const DAY = 86_400_000, start = Date.parse("2026-01-01T00:00:00.000Z");
const time = (days: number): string => new Date(start + days * DAY).toISOString();
function random(seed: number): () => number { let state = seed >>> 0; return () => { state = (state * 1103515245 + 12345) >>> 0; return state / 2 ** 32; }; }

/** Independent oracle: walk the ledger in time order, paying the oldest open debt first with every reduction. */
function fifo(entries: readonly LedgerEntry[], terms: number, now: string, soon: number) {
  const open: { amount: number; due: number }[] = [];
  let credit = 0;
  for (const entry of [...entries].sort((a, b) => a.occurredAt === b.occurredAt ? (a.id < b.id ? -1 : 1) : a.occurredAt < b.occurredAt ? -1 : 1)) {
    if (entry.amountMinor > 0) open.push({ amount: entry.amountMinor, due: Date.parse(entry.occurredAt) + terms * DAY });
    else credit -= entry.amountMinor;
  }
  // Reductions recorded before a debt (a deposit) also settle it: apply all credit to the oldest debts.
  for (const debt of open) { const used = Math.min(credit, debt.amount); debt.amount -= used; credit -= used; }
  const nowMs = Date.parse(now), remaining = open.filter(debt => debt.amount > 0);
  return {
    overdue: remaining.filter(debt => debt.due <= nowMs).reduce((sum, debt) => sum + debt.amount, 0),
    soon: remaining.filter(debt => debt.due > nowMs && debt.due <= nowMs + soon * DAY).reduce((sum, debt) => sum + debt.amount, 0),
    oldest: remaining.length === 0 ? undefined : new Date(Math.min(...remaining.map(debt => debt.due))).toISOString(),
  };
}

it("aging matches an oldest-first payment oracle over random ledgers, terms and times (property)", () => {
  const next = random(11);
  for (let run = 0; run < 3000; run++) {
    const entries: LedgerEntry[] = Array.from({ length: Math.floor(next() * 12) }, (_, index) => ({
      id: `e${String(index).padStart(2, "0")}`, occurredAt: time(Math.floor(next() * 120)),
      amountMinor: (next() < 0.6 ? 1 : -1) * (1 + Math.floor(next() * 100_000)),
    }));
    const terms = [0, 1, 7, 30, 90][Math.floor(next() * 5)]!, now = time(Math.floor(next() * 200)), soon = Math.floor(next() * 5);
    const result = ageLedger(entries, terms, now, soon), expected = fifo(entries, terms, now, soon);
    const balance = entries.reduce((sum, entry) => sum + entry.amountMinor, 0);
    assert.equal(result.balanceMinor, balance);
    assert.equal(result.overdueMinor, balance > 0 ? expected.overdue : 0);
    assert.equal(result.dueSoonMinor, balance > 0 ? expected.soon : 0);
    assert.equal(result.oldestDueAt, balance > 0 ? expected.oldest : undefined);
    assert.ok(result.overdueMinor + result.dueSoonMinor <= Math.max(balance, 0));
  }
});

it("a debt is overdue at the exact instant it falls due, and due soon up to the window's end", () => {
  const debt = [{ id: "a", amountMinor: 1000, occurredAt: time(0) }];
  assert.equal(ageLedger(debt, 30, new Date(start + 30 * DAY - 1).toISOString()).overdueMinor, 0);
  assert.equal(ageLedger(debt, 30, time(30)).overdueMinor, 1000);
  assert.equal(ageLedger(debt, 30, time(27)).dueSoonMinor, 1000);
  assert.equal(ageLedger(debt, 30, new Date(start + 27 * DAY - 1).toISOString()).dueSoonMinor, 0);
  assert.equal(ageLedger(debt, 0, time(0)).overdueMinor, 1000, "zero terms: due at once");
  const aged = ageLedger([...debt, { id: "b", amountMinor: 500, occurredAt: time(10) }, { id: "c", amountMinor: 200, occurredAt: time(20) }], 30, time(45));
  assert.deepEqual(aged, { balanceMinor: 1700, overdueMinor: 1500, dueSoonMinor: 0, oldestDueAt: time(30), nextDueAt: time(50), lastPassedDueAt: time(40) });
});

it("payments settle the oldest debt first, partially; credit balances and settled ledgers owe nothing", () => {
  const ledger = [{ id: "a", amountMinor: 1000, occurredAt: time(0) }, { id: "b", amountMinor: 1000, occurredAt: time(10) }, { id: "p", amountMinor: -1500, occurredAt: time(12) }];
  const aged = ageLedger(ledger, 30, time(41));
  assert.equal(aged.balanceMinor, 500); assert.equal(aged.overdueMinor, 500); assert.equal(aged.oldestDueAt, time(40), "the first debt is paid; half the second remains");
  assert.deepEqual(ageLedger([...ledger, { id: "q", amountMinor: -600, occurredAt: time(13) }], 30, time(90)), { balanceMinor: -100, overdueMinor: 0, dueSoonMinor: 0 });
  assert.deepEqual(ageLedger([], DEFAULT_TERMS_DAYS, time(0)), { balanceMinor: 0, overdueMinor: 0, dueSoonMinor: 0 });
  // A deposit taken before the debt still settles it.
  assert.equal(ageLedger([{ id: "d", amountMinor: -300, occurredAt: time(0) }, { id: "e", amountMinor: 1000, occurredAt: time(5) }], 0, time(6)).overdueMinor, 700);
  // A caller supplying fewer debts than the balance: the unexplained remainder is owed now.
  assert.equal(ageOutstanding([{ id: "a", amountMinor: 100, occurredAt: time(0) }], 250, 30, time(1)).overdueMinor, 150);
  // Equal times order by ID, deterministically.
  const tied = ageLedger([{ id: "b", amountMinor: 100, occurredAt: time(0) }, { id: "a", amountMinor: 100, occurredAt: time(0) }, { id: "p", amountMinor: -100, occurredAt: time(1) }], 1, time(1));
  assert.equal(tied.overdueMinor, 100);
});

it("refuses invalid terms, times and non-positive debts; due dates add whole days in UTC", () => {
  for (const days of [-1, 3651, 1.5, Number.NaN]) assert.throws(() => checkTermsDays(days), RuleError);
  assert.throws(() => ageLedger([], 30, "not a time"), RuleError);
  assert.throws(() => dueAt("never", 30), RuleError);
  assert.throws(() => ageOutstanding([{ id: "a", amountMinor: 0, occurredAt: time(0) }], 10, 30, time(0)), RuleError);
  assert.throws(() => ageOutstanding([], Number.MAX_SAFE_INTEGER + 1, 30, time(0)), RuleError);
  assert.equal(dueAt("2026-02-27T23:30:00.000Z", 2), "2026-03-01T23:30:00.000Z");
  assert.equal(dueAt(time(0), 3650), new Date(start + 3650 * DAY).toISOString());
});
