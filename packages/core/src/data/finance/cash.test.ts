import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { completeSale, type Cart } from "../sales/sales.ts";
import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { pending } from "../sync/outbox.ts";
import {
  balanceOfAccount,
  CashError,
  moveCash,
  movementsOfAccount,
  reconcile,
  transfer,
  type CashMovement,
} from "./cash.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL_DEVICE = "33333333-3333-7333-8333-333333333333";
const RICE = "55555555-5555-7555-8555-555555555555";
const TILL = "77777777-7777-7777-8777-777777777777";
const WALLET = "88888888-8888-7888-8888-888888888888";
const CUSTOMER = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const CREATED = "2026-08-01T08:00:00.000Z";
const MOVED = "2026-08-14T09:30:00.000Z";
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
      [TILL_DEVICE, BUSINESS, CREATED, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO products (id, business_id, name, unit, divisible, selling_price_minor,
                             currency, created_at, updated_at)
       VALUES (?, ?, 'Riz 5kg', 'sac', 1, 6500, 'XAF', ?, ?)`,
      [RICE, BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO customers (id, business_id, name, created_at, updated_at)
       VALUES (?, ?, 'Jean Mbarga', ?, ?)`,
      [CUSTOMER, BUSINESS, CREATED, CREATED],
    );
    for (const [id, name, kind] of [
      [TILL, "Caisse", "CASH"],
      [WALLET, "MTN Mobile Money", "MOBILE_MONEY"],
    ] as const) {
      tx.run(
        `INSERT INTO financial_accounts (id, business_id, name, kind, currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'XAF', ?, ?)`,
        [id, BUSINESS, name, kind, CREATED, CREATED],
      );
    }
  });
});

let counter = 0;
function nextId(prefix: string): string {
  counter++;
  return `${prefix}-${counter}`;
}

function aMovement(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    id: nextId("movement"),
    accountId: TILL,
    businessId: BUSINESS,
    type: "OPENING_BALANCE",
    amountMinor: 50_000,
    userId: USER,
    deviceId: TILL_DEVICE,
    occurredAt: MOVED,
    recordedAt: RECORDED,
    ...overrides,
  };
}

function move(...movements: CashMovement[]): void {
  moveCash(database, { movements, eventId: nextId("event") });
}

function onHand(account: string): number {
  return database.transaction((tx) => balanceOfAccount(tx, BUSINESS, account)).onHandMinor;
}

describe("moving money by hand", () => {
  it("records the movement and queues the event carrying it", () => {
    move(aMovement());

    assert.equal(onHand(TILL), 50_000);

    const [queued] = database.transaction((tx) => pending(tx, 10));
    assert.equal(queued?.type, "CASH_MOVED");
    const payload = queued?.payload as { movements: Record<string, unknown>[] };
    assert.equal(payload.movements[0]?.["amount_minor"], 50_000);
    assert.equal(payload.movements[0]?.["account_id"], TILL);
    // Identity comes from the envelope, and everything is XAF (ADR-008, §46).
    for (const absent of ["business_id", "user_id", "device_id", "currency"]) {
      assert.equal(absent in (payload.movements[0] ?? {}), false, `${absent} was sent`);
    }
  });

  it("refuses a sign that contradicts its type", () => {
    // Cash taken out that read as money in would make a drawer look full that
    // is empty, and only a count would ever find it.
    assert.throws(
      () => move(aMovement({ type: "CASH_OUT", amountMinor: 5_000, reason: "banque" })),
      /must be negative/,
    );
    assert.throws(
      () => move(aMovement({ type: "CASH_IN", amountMinor: -5_000 })),
      /must be positive/,
    );
    // A correction goes either way, because a count can find more or less.
    move(aMovement({ type: "ADJUSTMENT", amountMinor: -5_000, reason: "manque" }));
    move(aMovement({ type: "ADJUSTMENT", amountMinor: 5_000, reason: "excédent" }));
    assert.equal(onHand(TILL), 0);
  });

  it("refuses money leaving with nothing written on it", () => {
    for (const type of ["CASH_OUT", "ADJUSTMENT"] as const) {
      assert.throws(
        () => move(aMovement({ type, amountMinor: -5_000 })),
        /needs a reason/,
        `${type} was recorded with no reason`,
      );
    }
  });

  it("refuses a movement of nothing", () => {
    assert.throws(() => move(aMovement({ amountMinor: 0 })), CashError);
  });

  it("refuses a type this build does not know", () => {
    assert.throws(() => move(aMovement({ type: "LOAN" as never })), CashError);
  });

  it("refuses an event that moved no money", () => {
    assert.throws(() => moveCash(database, { movements: [], eventId: "e" }), /moved no money/);
  });

  it("writes nothing when a movement is refused", () => {
    assert.throws(() =>
      move(aMovement(), aMovement({ type: "CASH_OUT", amountMinor: 5_000, reason: "banque" })),
    );

    assert.equal(onHand(TILL), 0);
    assert.equal(database.transaction((tx) => pending(tx, 10)).length, 0);
  });

  it("keeps the ledger append-only", () => {
    move(aMovement());

    for (const statement of [
      `UPDATE account_movements SET amount_minor = 1`,
      `DELETE FROM account_movements`,
    ]) {
      assert.throws(() => database.transaction((tx) => tx.run(statement)), /immutable/);
    }
    assert.equal(onHand(TILL), 50_000);
  });
});

describe("transferring between accounts", () => {
  it("moves money out of one and into the other", () => {
    move(aMovement());

    move(
      ...transfer(
        {
          id: nextId("movement"),
          accountId: TILL,
          businessId: BUSINESS,
          amountMinor: -20_000,
          userId: USER,
          deviceId: TILL_DEVICE,
          occurredAt: MOVED,
          recordedAt: RECORDED,
        },
        {
          id: nextId("movement"),
          accountId: WALLET,
          businessId: BUSINESS,
          userId: USER,
          deviceId: TILL_DEVICE,
          occurredAt: MOVED,
          recordedAt: RECORDED,
        },
      ),
    );

    assert.equal(onHand(TILL), 30_000);
    assert.equal(onHand(WALLET), 20_000);

    // Each half names the other, so neither reads as money appearing from
    // nowhere.
    const [, leaving] = database.transaction((tx) => movementsOfAccount(tx, BUSINESS, TILL));
    const [arriving] = database.transaction((tx) => movementsOfAccount(tx, BUSINESS, WALLET));
    assert.equal(leaving?.counterpartId, WALLET);
    assert.equal(arriving?.counterpartId, TILL);
  });

  it("refuses a transfer to the same account or the wrong way round", () => {
    const leaving = {
      id: nextId("movement"),
      accountId: TILL,
      businessId: BUSINESS,
      amountMinor: -20_000,
      userId: USER,
      deviceId: TILL_DEVICE,
      occurredAt: MOVED,
      recordedAt: RECORDED,
    };
    const arriving = {
      id: nextId("movement"),
      accountId: TILL,
      businessId: BUSINESS,
      userId: USER,
      deviceId: TILL_DEVICE,
      occurredAt: MOVED,
      recordedAt: RECORDED,
    };

    assert.throws(() => transfer(leaving, arriving), /two accounts/);
    // Given as what leaves, negative: flipping a positive one silently would be
    // the only place a wrong sign is corrected rather than refused.
    assert.throws(
      () => transfer({ ...leaving, amountMinor: 20_000 }, { ...arriving, accountId: WALLET }),
      /must be negative/,
    );
  });

  it("keeps both halves in one transaction", () => {
    move(aMovement());
    const [out, into] = transfer(
      {
        id: nextId("movement"),
        accountId: TILL,
        businessId: BUSINESS,
        amountMinor: -20_000,
        userId: USER,
        deviceId: TILL_DEVICE,
        occurredAt: MOVED,
        recordedAt: RECORDED,
      },
      {
        id: nextId("movement"),
        accountId: "99999999-9999-7999-8999-999999999999",
        businessId: BUSINESS,
        userId: USER,
        deviceId: TILL_DEVICE,
        occurredAt: MOVED,
        recordedAt: RECORDED,
      },
    );
    assert.ok(out && into);

    // The arriving half names an account that does not exist: the database
    // refuses it, and the money must not have left either.
    assert.throws(() => move(out, into));
    assert.equal(onHand(TILL), 50_000);
  });
});

describe("what an account holds", () => {
  it("sums every source that moved money", () => {
    // The float.
    move(aMovement());

    // A sale paid into the till.
    const cart: Cart = {
      id: nextId("sale"),
      businessId: BUSINESS,
      number: nextId("V"),
      lines: [
        {
          id: nextId("line"),
          movementId: nextId("stock"),
          productId: RICE,
          name: "Riz 5kg",
          unitPriceMinor: 6_500,
          quantity: 2_000,
        },
      ],
      payments: [{ id: nextId("pay"), accountId: TILL, amountMinor: 13_000 }],
      userId: USER,
      deviceId: TILL_DEVICE,
      occurredAt: MOVED,
      recordedAt: RECORDED,
      eventId: nextId("event"),
    };
    completeSale(database, cart);

    // A customer settling an old debt in cash: negative in their ledger, where
    // it reduces what they owe, and money arriving here.
    database.transaction((tx) =>
      tx.run(
        `INSERT INTO customer_transactions
           (id, customer_id, business_id, type, amount_minor, currency, account_id,
            user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'PAYMENT', -8000, 'XAF', ?, ?, ?, ?, ?)`,
        [nextId("entry"), CUSTOMER, BUSINESS, TILL, USER, TILL_DEVICE, MOVED, RECORDED],
      ),
    );

    // And cash carried to the bank.
    move(aMovement({ type: "CASH_OUT", amountMinor: -20_000, reason: "porté à la banque" }));

    assert.equal(onHand(TILL), 51_000);
    assert.equal(
      database.transaction((tx) => balanceOfAccount(tx, BUSINESS, TILL)).movements,
      4,
    );
  });

  it("tells an untouched account from an emptied one", () => {
    const untouched = database.transaction((tx) => balanceOfAccount(tx, BUSINESS, WALLET));
    assert.deepEqual(untouched, { onHandMinor: 0, movements: 0 });

    move(aMovement());
    move(aMovement({ type: "CASH_OUT", amountMinor: -50_000, reason: "banque" }));
    const emptied = database.transaction((tx) => balanceOfAccount(tx, BUSINESS, TILL));
    assert.deepEqual(emptied, { onHandMinor: 0, movements: 2 });
  });

  it("reads below zero rather than hiding it", () => {
    // A till reading negative is a real condition — a payment recorded that
    // never happened — and the honest answer is what makes someone look.
    move(aMovement({ amountMinor: 5_000 }));
    move(aMovement({ type: "CASH_OUT", amountMinor: -8_000, reason: "banque" }));

    assert.equal(onHand(TILL), -3_000);
  });
});

describe("counting the drawer", () => {
  it("works out §18's difference and corrects it", () => {
    move(aMovement({ amountMinor: 245_500 }));

    const count = database.transaction((tx) => reconcile(tx, BUSINESS, TILL, 240_500));
    assert.deepEqual(count, {
      expectedMinor: 245_500,
      countedMinor: 240_500,
      differenceMinor: -5_000,
    });

    move(
      aMovement({
        type: "ADJUSTMENT",
        amountMinor: count.differenceMinor,
        reason: "manque constaté au comptage",
      }),
    );

    assert.equal(onHand(TILL), 240_500);
    // The shortfall stays visible: a correction is a record of what was found,
    // not an edit to what was believed.
    const movements = database.transaction((tx) => movementsOfAccount(tx, BUSINESS, TILL));
    assert.equal(movements.length, 2);
    assert.equal(movements[1]?.reason, "manque constaté au comptage");
  });

  it("refuses a count that could not be in a drawer", () => {
    assert.throws(
      () => database.transaction((tx) => reconcile(tx, BUSINESS, TILL, -1)),
      CashError,
    );
  });
});
