import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { balanceOfAccount, moveCash, type CashMovement } from "../finance/cash.ts";
import { pending } from "../sync/outbox.ts";
import {
  expensesBetween,
  ExpenseError,
  recordExpense,
  reverseExpense,
  totalsByCategory,
  type Expense,
} from "./expenses.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const DEVICE = "33333333-3333-7333-8333-333333333333";
const TILL = "77777777-7777-7777-8777-777777777777";
const CREATED = "2026-08-01T08:00:00.000Z";
const SPENT = "2026-08-14T09:30:00.000Z";
const RECORDED = "2026-08-14T10:30:00.000Z";

let database: Database;

beforeEach(() => {
  database = openDatabase();
  migrate(database);
  database.transaction((tx) => {
    tx.run(
      `INSERT INTO businesses (id, name, currency, created_at, updated_at)
       VALUES (?, 'Boutique', 'XAF', ?, ?)`,
      [BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO users (id, business_id, name, role, created_at, updated_at)
       VALUES (?, ?, 'Jean', 'CASHIER', ?, ?)`,
      [USER, BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'Till', 'ANDROID', ?, ?, ?)`,
      [DEVICE, BUSINESS, CREATED, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO financial_accounts (id, business_id, name, kind, currency, created_at, updated_at)
       VALUES (?, ?, 'Caisse', 'CASH', 'XAF', ?, ?)`,
      [TILL, BUSINESS, CREATED, CREATED],
    );
  });
});

let counter = 0;
function nextId(prefix: string): string {
  counter++;
  return `${prefix}-${counter}`;
}

function anExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: nextId("expense"),
    businessId: BUSINESS,
    category: "RENT",
    accountId: TILL,
    amountMinor: 50_000,
    userId: USER,
    deviceId: DEVICE,
    occurredAt: SPENT,
    recordedAt: RECORDED,
    eventId: nextId("event"),
    ...overrides,
  };
}

function float(amountMinor: number): void {
  const movement: CashMovement = {
    id: nextId("movement"),
    accountId: TILL,
    businessId: BUSINESS,
    type: "OPENING_BALANCE",
    amountMinor,
    userId: USER,
    deviceId: DEVICE,
    occurredAt: SPENT,
    recordedAt: RECORDED,
  };
  moveCash(database, { movements: [movement], eventId: nextId("event") });
}

function onHand(): number {
  return database.transaction((tx) => balanceOfAccount(tx, BUSINESS, TILL)).onHandMinor;
}

describe("recording an expense", () => {
  it("takes the money out of its account and queues the event", () => {
    float(100_000);
    const expense = anExpense({ description: "loyer d'août", reference: "REC-0012" });
    recordExpense(database, expense);

    // The fourth arm of the balance: money spent is money the account no longer
    // holds.
    assert.equal(onHand(), 50_000);

    const queued = database.transaction((tx) => pending(tx, 10));
    const event = queued.at(-1);
    assert.equal(event?.type, "EXPENSE_RECORDED");
    const payload = event?.payload as { expense: Record<string, unknown> };
    assert.deepEqual(payload.expense, {
      id: expense.id,
      category: "RENT",
      account_id: TILL,
      amount_minor: 50_000,
      description: "loyer d'août",
      reference: "REC-0012",
      occurred_at: SPENT,
    });
  });

  it("makes OTHER say what the money went on", () => {
    // "OTHER, 15,000" is the line an owner stares at in a month's report with
    // no way to find out what it was.
    assert.throws(
      () => recordExpense(database, anExpense({ category: "OTHER", amountMinor: 15_000 })),
      /say what the money went on/,
    );
    recordExpense(
      database,
      anExpense({ category: "OTHER", amountMinor: 15_000, description: "réparation" }),
    );
  });

  it("refuses a category this build does not know", () => {
    assert.throws(
      () => recordExpense(database, anExpense({ category: "BRIBE" as never })),
      ExpenseError,
    );
  });

  it("refuses an expense that undoes nothing", () => {
    // Money appearing in the accounts with no explanation is the shape of a
    // mistake nobody can trace.
    assert.throws(() => recordExpense(database, anExpense({ amountMinor: -50_000 })), /undoes nothing/);
    assert.throws(
      () => recordExpense(database, anExpense({ reversesId: nextId("expense") })),
      /cannot also be a reversal/,
    );
  });

  it("refuses an expense missing what it cannot exist without", () => {
    for (const missing of ["id", "businessId", "accountId", "userId", "eventId"] as const) {
      assert.throws(() => recordExpense(database, anExpense({ [missing]: " " })), ExpenseError);
    }
  });

  it("writes nothing when the expense is refused", () => {
    assert.throws(() => recordExpense(database, anExpense({ amountMinor: 0 })));

    assert.equal(onHand(), 0);
    assert.equal(database.transaction((tx) => pending(tx, 10)).length, 0);
  });

  it("keeps expenses append-only", () => {
    recordExpense(database, anExpense());

    for (const statement of [`UPDATE expenses SET amount_minor = 1`, `DELETE FROM expenses`]) {
      assert.throws(() => database.transaction((tx) => tx.run(statement)), /immutable/);
    }
  });
});

describe("undoing an expense", () => {
  it("puts the money back and leaves both rows", () => {
    float(100_000);
    const original = anExpense({ category: "TRANSPORT", amountMinor: 15_000 });
    recordExpense(database, original);

    const reversal = reverseExpense(original, {
      id: nextId("expense"),
      userId: USER,
      deviceId: DEVICE,
      recordedAt: "2026-08-14T12:00:00.000Z",
      eventId: nextId("event"),
    });
    recordExpense(database, reversal);

    assert.equal(onHand(), 100_000);

    // Both rows are still there, which is what shows the mistake happened.
    const spent = database.transaction((tx) =>
      expensesBetween(tx, BUSINESS, "2026-08-14T00:00:00.000Z", "2026-08-15T00:00:00.000Z"),
    );
    assert.equal(spent.length, 2);
    assert.equal(spent[1]?.reversesId, original.id);
    // It lands back where the money came from.
    assert.equal(spent[1]?.accountId, original.accountId);
    assert.equal(spent[1]?.category, original.category);
  });

  it("undoes an expense only once", () => {
    const original = anExpense();
    recordExpense(database, original);

    const first = reverseExpense(original, {
      id: nextId("expense"),
      userId: USER,
      deviceId: DEVICE,
      recordedAt: RECORDED,
      eventId: nextId("event"),
    });
    recordExpense(database, first);

    const second = reverseExpense(original, {
      id: nextId("expense"),
      userId: USER,
      deviceId: DEVICE,
      recordedAt: RECORDED,
      eventId: nextId("event"),
    });
    // A second reversal would take the money off the books twice.
    assert.throws(() => recordExpense(database, second));
  });

  it("refuses to undo a reversal", () => {
    const original = anExpense();
    const reversal = reverseExpense(original, {
      id: nextId("expense"),
      userId: USER,
      deviceId: DEVICE,
      recordedAt: RECORDED,
      eventId: nextId("event"),
    });

    assert.throws(
      () =>
        reverseExpense(reversal, {
          id: nextId("expense"),
          userId: USER,
          deviceId: DEVICE,
          recordedAt: RECORDED,
          eventId: nextId("event"),
        }),
      /itself a reversal/,
    );
  });
});

describe("what a period cost", () => {
  it("groups by category, largest first, with reversals cancelling", () => {
    recordExpense(database, anExpense({ category: "RENT", amountMinor: 50_000 }));
    recordExpense(database, anExpense({ category: "TRANSPORT", amountMinor: 15_000 }));
    recordExpense(database, anExpense({ category: "TRANSPORT", amountMinor: 5_000 }));

    const mistake = anExpense({ category: "MARKETING", amountMinor: 30_000 });
    recordExpense(database, mistake);
    recordExpense(
      database,
      reverseExpense(mistake, {
        id: nextId("expense"),
        userId: USER,
        deviceId: DEVICE,
        recordedAt: RECORDED,
        eventId: nextId("event"),
      }),
    );

    const totals = database.transaction((tx) =>
      totalsByCategory(tx, BUSINESS, "2026-08-14T00:00:00.000Z", "2026-08-15T00:00:00.000Z"),
    );

    assert.deepEqual(totals, [
      { category: "RENT", totalMinor: 50_000, count: 1 },
      { category: "TRANSPORT", totalMinor: 20_000, count: 2 },
      // Netted to nothing, but still listed: two entries that cancel are not
      // the same as a category nobody used.
      { category: "MARKETING", totalMinor: 0, count: 2 },
    ]);
  });

  it("counts when the money was spent, not when it was recorded", () => {
    // A phone that recorded Monday's transport on Friday still spent it on
    // Monday.
    recordExpense(
      database,
      anExpense({
        category: "TRANSPORT",
        amountMinor: 15_000,
        occurredAt: "2026-08-12T09:00:00.000Z",
        recordedAt: "2026-08-16T09:00:00.000Z",
      }),
    );

    const monday = database.transaction((tx) =>
      expensesBetween(tx, BUSINESS, "2026-08-12T00:00:00.000Z", "2026-08-13T00:00:00.000Z"),
    );
    assert.equal(monday.length, 1);

    const friday = database.transaction((tx) =>
      expensesBetween(tx, BUSINESS, "2026-08-16T00:00:00.000Z", "2026-08-17T00:00:00.000Z"),
    );
    assert.equal(friday.length, 0);
  });
});
