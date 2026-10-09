/**
 * What a business spends that is not stock (§19).
 *
 * Rent, electricity, transport, a salary. Money leaves an account and nothing
 * arrives on a shelf — which is what separates an expense from a purchase, and
 * why confusing the two would make the shop's goods look more expensive than
 * they were.
 *
 * An expense is financial history and is never edited. One entered in error is
 * undone by a reversal — a second row, negative, naming the one it undoes — so
 * the day's cash still shows the mistake was made and put right.
 */

import type { Database, Queryable, Row } from "../database/driver.ts";
import { enqueue } from "../sync/outbox.ts";

/** The event an expense queues. */
export const EXPENSE_RECORDED = "EXPENSE_RECORDED";

/** Everything is XAF (§46). */
const CURRENCY = "XAF";

/** What a cost was for (§19). */
export type Category =
  | "RENT"
  | "ELECTRICITY"
  | "WATER"
  | "TRANSPORT"
  | "SALARY"
  | "PACKAGING"
  | "MAINTENANCE"
  | "INTERNET"
  | "MARKETING"
  | "OTHER";

/** Money the business spent. */
export interface Expense {
  readonly id: string;
  readonly businessId: string;
  readonly branchId?: string | undefined;
  readonly category: Category;
  /** Where the money came from. */
  readonly accountId: string;
  /** Positive for a cost, negative for a reversal. */
  readonly amountMinor: number;
  readonly description?: string | undefined;
  /** The receipt or invoice number, when there is one. */
  readonly reference?: string | undefined;
  /** The expense this one undoes, on a reversal. */
  readonly reversesId?: string | undefined;
  readonly userId: string;
  readonly deviceId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  /** The event identifier, which is what makes a replay a duplicate (§27). */
  readonly eventId: string;
}

/** What a period cost, broken down the way §19 asks for. */
export interface CategoryTotal {
  readonly category: Category;
  readonly totalMinor: number;
  /**
   * How many entries the total came from, reversals included: a category with
   * two entries that cancel is not the same as one nobody used.
   */
  readonly count: number;
}

/** Raised when an expense cannot be recorded or read. */
export class ExpenseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExpenseError";
  }
}

const CATEGORIES: readonly Category[] = [
  "RENT",
  "ELECTRICITY",
  "WATER",
  "TRANSPORT",
  "SALARY",
  "PACKAGING",
  "MAINTENANCE",
  "INTERNET",
  "MARKETING",
  "OTHER",
];

const INSERT = `
  INSERT INTO expenses
    (id, business_id, branch_id, category, account_id, amount_minor, currency,
     description, reference, reverses_id, user_id, device_id, occurred_at, recorded_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Records an expense and queues the event carrying it.
 *
 * Both in one transaction (ADR-014): a cost the shopkeeper can see and the
 * server never will would make the month's takings look better than they were.
 */
export function recordExpense(database: Database, expense: Expense): void {
  validate(expense);

  database.transaction((tx) => {
    tx.run(INSERT, [
      expense.id,
      expense.businessId,
      expense.branchId ?? null,
      expense.category,
      expense.accountId,
      expense.amountMinor,
      CURRENCY,
      expense.description ?? null,
      expense.reference ?? null,
      expense.reversesId ?? null,
      expense.userId,
      expense.deviceId,
      expense.occurredAt,
      expense.recordedAt,
    ]);

    enqueue(tx, {
      eventId: expense.eventId,
      businessId: expense.businessId,
      userId: expense.userId,
      deviceId: expense.deviceId,
      type: EXPENSE_RECORDED,
      payload: { expense: describe(expense) },
      occurredAt: expense.occurredAt,
    });
  });
}

/**
 * Builds the expense that undoes another.
 *
 * It keeps the original's category and account, because it has to land back
 * where the money came from to be worth anything, and inherits what the original
 * said so a report reads as a pair.
 */
export function reverseExpense(
  original: Expense,
  correction: Pick<Expense, "id" | "userId" | "deviceId" | "recordedAt" | "eventId"> &
    Partial<Pick<Expense, "description" | "occurredAt">>,
): Expense {
  if (original.reversesId !== undefined) {
    throw new ExpenseError(`${original.id} is itself a reversal`);
  }
  if (original.amountMinor <= 0) {
    throw new ExpenseError(`${original.amountMinor} is not a cost that can be undone`);
  }

  return {
    ...correction,
    businessId: original.businessId,
    ...(original.branchId === undefined ? {} : { branchId: original.branchId }),
    category: original.category,
    accountId: original.accountId,
    amountMinor: -original.amountMinor,
    description: correction.description ?? original.description,
    reversesId: original.id,
    occurredAt: correction.occurredAt ?? original.occurredAt,
  };
}

/** The expenses of a period, by when the money was spent. */
export function expensesBetween(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): Expense[] {
  const rows = tx.all(
    `SELECT * FROM expenses
      WHERE business_id = ? AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at, id`,
    [businessId, from, to],
  );
  return rows.map(toExpense);
}

/**
 * What a period cost, by category, largest first.
 *
 * Reversals are negative and cancel what they undo by plain addition, so a cost
 * entered twice and corrected does not show as spending that happened.
 */
export function totalsByCategory(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): CategoryTotal[] {
  const rows = tx.all(
    `SELECT category, sum(amount_minor) AS total, count(*) AS entries
       FROM expenses
      WHERE business_id = ? AND occurred_at >= ? AND occurred_at < ?
      GROUP BY category
      ORDER BY total DESC, category`,
    [businessId, from, to],
  );
  return rows.map((row) => ({
    category: String(row["category"]) as Category,
    totalMinor: Number(row["total"]),
    count: Number(row["entries"]),
  }));
}

/**
 * The payload an EXPENSE_RECORDED event carries.
 *
 * These names are the wire contract with `ExpenseRecordedPayload` on the server,
 * which refuses a field it does not know. No business, branch, user, device, or
 * currency: identity comes from the envelope (ADR-008) and everything is XAF.
 */
function describe(expense: Expense): Record<string, unknown> {
  const described: Record<string, unknown> = {
    id: expense.id,
    category: expense.category,
    account_id: expense.accountId,
    amount_minor: expense.amountMinor,
    occurred_at: expense.occurredAt,
  };
  if (expense.description !== undefined) {
    described["description"] = expense.description;
  }
  if (expense.reference !== undefined) {
    described["reference"] = expense.reference;
  }
  if (expense.reversesId !== undefined) {
    described["reverses_id"] = expense.reversesId;
  }
  return described;
}

function toExpense(row: Row): Expense {
  const expense: Expense = {
    id: String(row["id"]),
    businessId: String(row["business_id"]),
    category: String(row["category"]) as Category,
    accountId: String(row["account_id"]),
    amountMinor: Number(row["amount_minor"]),
    userId: String(row["user_id"]),
    deviceId: String(row["device_id"]),
    occurredAt: String(row["occurred_at"]),
    recordedAt: String(row["recorded_at"]),
    // Not stored: the event that carried it is the outbox's business, and a row
    // read back is not about to be sent again.
    eventId: "",
  };
  return {
    ...expense,
    ...(row["branch_id"] === null ? {} : { branchId: String(row["branch_id"]) }),
    ...(row["description"] === null ? {} : { description: String(row["description"]) }),
    ...(row["reference"] === null ? {} : { reference: String(row["reference"]) }),
    ...(row["reverses_id"] === null ? {} : { reversesId: String(row["reverses_id"]) }),
  };
}

function validate(expense: Expense): void {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["id", expense.id],
    ["businessId", expense.businessId],
    ["accountId", expense.accountId],
    ["userId", expense.userId],
    ["deviceId", expense.deviceId],
    ["occurredAt", expense.occurredAt],
    ["recordedAt", expense.recordedAt],
    ["eventId", expense.eventId],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ExpenseError(`an expense needs a ${field}`);
    }
  }
  if (!CATEGORIES.includes(expense.category)) {
    throw new ExpenseError(`${expense.category} is not a category this build knows`);
  }
  if (!Number.isSafeInteger(expense.amountMinor) || expense.amountMinor === 0) {
    throw new ExpenseError(`an expense of ${expense.amountMinor} is nothing`);
  }
  // Money appearing in the accounts with no explanation is the shape of a
  // mistake nobody can trace.
  if (expense.amountMinor < 0 && (expense.reversesId ?? "") === "") {
    throw new ExpenseError(`${expense.amountMinor} undoes nothing`);
  }
  if (expense.amountMinor > 0 && expense.reversesId !== undefined) {
    throw new ExpenseError("a cost cannot also be a reversal");
  }
  if (expense.reversesId === expense.id) {
    throw new ExpenseError("an expense cannot reverse itself");
  }
  if (expense.category === "OTHER" && (expense.description ?? "").trim() === "") {
    throw new ExpenseError("OTHER needs to say what the money went on");
  }
  if (expense.recordedAt < expense.occurredAt) {
    throw new ExpenseError("an expense cannot be recorded before it happened");
  }
}
