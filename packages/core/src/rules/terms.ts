import { amount, integer, RuleError, sumAmounts } from "./amounts.ts";

/** Terms applied when a shop has stored none (ADR-033). */
export const DEFAULT_TERMS_DAYS = 30;
/** How far ahead an amount counts as "due soon". */
export const DUE_SOON_DAYS = 3;
const DAY_MS = 86_400_000;

/** Checks payment terms in whole days, 0 (due at once) to 3650. */
export function checkTermsDays(days: number): number {
  if (!Number.isSafeInteger(days) || days < 0 || days > 3650) throw new RuleError("invalid_amount", "payment terms are 0–3650 days");
  return days;
}

/** When a debt that occurred at `occurredAt` falls due under `days` of terms (UTC instant). */
export function dueAt(occurredAt: string, days: number): string {
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at)) throw new RuleError("invalid_amount", "a debt needs a valid time");
  return new Date(at + checkTermsDays(days) * DAY_MS).toISOString();
}

/** One signed ledger entry: positive adds to what is owed, negative reduces it. */
export interface LedgerEntry { readonly id: string; readonly amountMinor: number; readonly occurredAt: string }

/** What is owed and when it falls due. Amounts are XAF; times are ISO instants. */
export interface DebtAging {
  readonly balanceMinor: number;
  /** Remaining debt whose due time has passed. */
  readonly overdueMinor: number;
  /** Remaining debt due after now and within the "due soon" window. */
  readonly dueSoonMinor: number;
  /** Due time of the oldest remaining debt, when anything is owed. */
  readonly oldestDueAt?: string | undefined;
  /** The next due time still in the future, when there is one. */
  readonly nextDueAt?: string | undefined;
  /** The most recent due time already passed with debt still unpaid: it changes only when another debt falls due. */
  readonly lastPassedDueAt?: string | undefined;
}

/**
 * Ages an outstanding balance (ADR-033). Payments and other reductions settle the oldest debt first, so what remains
 * is exactly the newest debts that add up to the balance; the oldest of those may be partly settled. `debts` are the
 * positive entries in any order. A balance of zero or less (paid up, or in credit) owes nothing.
 */
export function ageOutstanding(debts: readonly LedgerEntry[], balanceMinor: number, termsDays: number, now: string, soonDays = DUE_SOON_DAYS): DebtAging {
  const balance = integer(balanceMinor), nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new RuleError("invalid_amount", "aging needs a valid time");
  checkTermsDays(termsDays); checkTermsDays(soonDays);
  if (balance <= 0n) return { balanceMinor, overdueMinor: 0, dueSoonMinor: 0 };
  const newestFirst = [...debts].sort((a, b) => a.occurredAt === b.occurredAt ? (a.id < b.id ? 1 : -1) : a.occurredAt < b.occurredAt ? 1 : -1);
  let left = balance, overdue = 0n, soon = 0n, oldestDueAt: string | undefined, nextDueAt: string | undefined, lastPassedDueAt: string | undefined;
  const soonLimit = nowMs + soonDays * DAY_MS;
  for (const debt of newestFirst) {
    const value = integer(debt.amountMinor);
    if (value <= 0n) throw new RuleError("invalid_amount", "a debt is a positive entry");
    if (left === 0n) break;
    const remaining = value < left ? value : left;
    left -= remaining;
    const due = dueAt(debt.occurredAt, termsDays), dueMs = Date.parse(due);
    oldestDueAt = due;
    if (dueMs <= nowMs) { overdue += remaining; if (lastPassedDueAt === undefined || due > lastPassedDueAt) lastPassedDueAt = due; }
    else {
      if (dueMs <= soonLimit) soon += remaining;
      if (nextDueAt === undefined || due < nextDueAt) nextDueAt = due;
    }
  }
  // Only a caller passing fewer debts than the balance needs reaches this; owed with no known date counts as due.
  if (left > 0n) overdue += left;
  return { balanceMinor, overdueMinor: amount(overdue), dueSoonMinor: amount(soon),
    ...(oldestDueAt === undefined ? {} : { oldestDueAt }), ...(nextDueAt === undefined ? {} : { nextDueAt }),
    ...(lastPassedDueAt === undefined ? {} : { lastPassedDueAt }) };
}

/** Ages a whole signed ledger: its sum is the balance and its positive entries are the debts. */
export function ageLedger(entries: readonly LedgerEntry[], termsDays: number, now: string, soonDays = DUE_SOON_DAYS): DebtAging {
  return ageOutstanding(entries.filter(entry => entry.amountMinor > 0), sumAmounts(entries.map(entry => entry.amountMinor)), termsDays, now, soonDays);
}
