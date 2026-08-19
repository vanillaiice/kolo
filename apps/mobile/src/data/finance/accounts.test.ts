import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { pending } from "../sync/outbox.ts";
import {
  accountOf,
  AccountError,
  listAccounts,
  saveAccount,
  upsertAccount,
  type SaveAccount,
} from "./accounts.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL = "33333333-3333-7333-8333-333333333333";
const PHONE_DEVICE = "44444444-4444-7444-8444-444444444444";
const CREATED = "2026-08-01T08:00:00.000Z";
const EARLIER = "2026-08-14T09:00:00.000Z";
const LATER = "2026-08-14T17:00:00.000Z";

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
    for (const [id, label] of [
      [TILL, "Till"],
      [PHONE_DEVICE, "Phone"],
    ] as const) {
      tx.run(
        `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, 'ANDROID', ?, ?, ?)`,
        [id, BUSINESS, label, CREATED, CREATED, CREATED],
      );
    }
  });
});

let counter = 0;
function nextId(prefix: string): string {
  counter++;
  return `${prefix}-${counter}`;
}

function anAccount(overrides: Partial<SaveAccount> = {}): SaveAccount {
  return {
    id: nextId("account"),
    businessId: BUSINESS,
    name: "Caisse",
    kind: "CASH",
    currency: "XAF",
    active: true,
    createdAt: CREATED,
    updatedAt: EARLIER,
    userId: USER,
    deviceId: TILL,
    ...overrides,
  };
}

function held(id: string) {
  return database.transaction((tx) => accountOf(tx, BUSINESS, id));
}

describe("opening an account", () => {
  it("stores it and queues the event carrying it", () => {
    const account = anAccount();
    assert.equal(saveAccount(database, account), true);

    assert.equal(held(account.id)?.name, "Caisse");

    const [queued] = database.transaction((tx) => pending(tx, 10));
    assert.equal(queued?.type, "ACCOUNT_SAVED");
    const payload = queued?.payload as { account: Record<string, unknown> };
    assert.deepEqual(payload.account, {
      id: account.id,
      name: "Caisse",
      kind: "CASH",
      created_at: CREATED,
      updated_at: EARLIER,
    });
    // No balance, and there could not be one: what an account holds is the sum
    // of what moved through it (§18, §59).
    for (const absent of ["balance_minor", "business_id", "currency", "updated_by_device"]) {
      assert.equal(absent in payload.account, false, `${absent} was sent`);
    }
  });

  it("makes a Mobile Money provider a row rather than a release", () => {
    // §10: two wallets differ by name, not by a kind this build has to know.
    saveAccount(database, anAccount({ name: "MTN Mobile Money", kind: "MOBILE_MONEY", number: "+237699123456" }));
    saveAccount(database, anAccount({ name: "Orange Money", kind: "MOBILE_MONEY", number: "+237699000000" }));

    const accounts = database.transaction((tx) => listAccounts(tx, BUSINESS));
    assert.deepEqual(
      accounts.map((account) => account.name),
      ["MTN Mobile Money", "Orange Money"],
    );
    assert.equal(new Set(accounts.map((account) => account.kind)).size, 1);
  });

  it("refuses two accounts a cashier could not tell apart", () => {
    saveAccount(database, anAccount({ name: "Caisse" }));

    // Choosing between two accounts called the same thing is choosing at
    // random, and the money goes wherever they happened to tap.
    assert.throws(() => saveAccount(database, anAccount({ name: "  caisse " })));
  });

  it("refuses a kind this build does not know", () => {
    assert.throws(
      () => saveAccount(database, anAccount({ kind: "CRYPTO" as never })),
      /not a kind of account this build knows/,
    );
  });

  it("refuses an account in another currency", () => {
    assert.throws(() => saveAccount(database, anAccount({ currency: "EUR" })), AccountError);
  });

  it("refuses an account missing what it cannot exist without", () => {
    for (const missing of ["id", "businessId", "name", "userId", "deviceId"] as const) {
      assert.throws(() => saveAccount(database, anAccount({ [missing]: " " })), AccountError);
    }
  });

  it("writes nothing when the write is refused", () => {
    const account = anAccount({ currency: "EUR" });
    assert.throws(() => saveAccount(database, account));

    assert.equal(held(account.id), undefined);
    assert.equal(database.transaction((tx) => pending(tx, 10)).length, 0);
  });
});

describe("two devices editing one account", () => {
  function edit(id: string, name: string, at: string, device: string): void {
    database.transaction((tx) =>
      upsertAccount(
        tx,
        {
          id,
          businessId: BUSINESS,
          name,
          kind: "CASH",
          currency: "XAF",
          active: true,
          createdAt: CREATED,
          updatedAt: at,
        },
        device,
      ),
    );
  }

  // Two accounts in one business cannot share a name, so each order works on
  // its own account and the two are compared by which edit survived.

  it("keeps the newer edit whichever order they arrive in", () => {
    const forwards = nextId("account");
    edit(forwards, "Caisse A", EARLIER, TILL);
    edit(forwards, "Caisse A principale", LATER, PHONE_DEVICE);

    const backwards = nextId("account");
    edit(backwards, "Caisse B principale", LATER, PHONE_DEVICE);
    edit(backwards, "Caisse B", EARLIER, TILL);

    assert.equal(held(forwards)?.name, "Caisse A principale");
    assert.equal(held(backwards)?.name, "Caisse B principale");
  });

  it("breaks a tie the same way whichever order they arrive in", () => {
    // Without the tie-break, the two devices could settle on different answers
    // permanently, with nothing able to detect it.
    const [low, high] = [TILL, PHONE_DEVICE].sort();
    const forwards = nextId("account");
    edit(forwards, "Caisse C", EARLIER, low ?? "");
    edit(forwards, "Caisse C bis", EARLIER, high ?? "");

    const backwards = nextId("account");
    edit(backwards, "Caisse D bis", EARLIER, high ?? "");
    edit(backwards, "Caisse D", EARLIER, low ?? "");

    // The same device wins both times: the higher identifier.
    assert.equal(held(forwards)?.updatedByDevice, high);
    assert.equal(held(backwards)?.updatedByDevice, high);
    assert.equal(held(forwards)?.name, "Caisse C bis");
    assert.equal(held(backwards)?.name, "Caisse D bis");
  });
});

describe("closing an account", () => {
  it("keeps it off the till's list but on the books", () => {
    const open = anAccount({ name: "Caisse" });
    const closing = anAccount({ name: "Ancien portefeuille", kind: "MOBILE_MONEY" });
    saveAccount(database, open);
    saveAccount(database, closing);

    saveAccount(database, { ...closing, active: false, updatedAt: LATER });

    const offered = database.transaction((tx) => listAccounts(tx, BUSINESS));
    assert.deepEqual(
      offered.map((account) => account.id),
      [open.id],
    );

    // Still there: the payments it took name it, and history is not deleted
    // (§40).
    const all = database.transaction((tx) => listAccounts(tx, BUSINESS, { includeClosed: true }));
    assert.equal(all.length, 2);

    const [, queued] = database.transaction((tx) => pending(tx, 10));
    assert.ok(queued);
    const payload = database
      .transaction((tx) => pending(tx, 10))
      .at(-1)?.payload as { account: Record<string, unknown> };
    assert.equal(payload.account["active"], false);
  });
});
