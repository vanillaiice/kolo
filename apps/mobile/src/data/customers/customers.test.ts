import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { pending } from "../sync/outbox.ts";
import {
  balanceOf,
  recordCustomerPayment,
  CustomerError,
  customerOf,
  customersByPhone,
  listCustomers,
  saveCustomer,
  upsertCustomer,
  wouldExceedCreditLimit,
  type CustomerPayment,
  type SaveCustomer,
} from "./customers.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL = "33333333-3333-7333-8333-333333333333";
const PHONE_DEVICE = "44444444-4444-7444-8444-444444444444";
const ACCOUNT = "55555555-5555-7555-8555-555555555555";
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

function aCustomer(overrides: Partial<SaveCustomer> = {}): SaveCustomer {
  return {
    id: nextId("customer"),
    businessId: BUSINESS,
    name: "Jean Mbarga",
    active: true,
    createdAt: CREATED,
    updatedAt: EARLIER,
    userId: USER,
    deviceId: TILL,
    ...overrides,
  };
}

function held(id: string) {
  return database.transaction((tx) => customerOf(tx, BUSINESS, id));
}

describe("saving a customer", () => {
  it("stores them and queues the event carrying them", () => {
    const customer = aCustomer();
    assert.equal(saveCustomer(database, customer), true);

    assert.equal(held(customer.id)?.name, "Jean Mbarga");

    const [queued] = database.transaction((tx) => pending(tx, 10));
    assert.equal(queued?.type, "CUSTOMER_SAVED");
    const payload = queued?.payload as { customer: Record<string, unknown> };
    assert.equal(payload.customer["id"], customer.id);
    assert.equal(payload.customer["name"], "Jean Mbarga");
  });

  it("needs only a name", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);

    const stored = held(customer.id);
    assert.equal(stored?.phone, undefined);
    assert.equal(stored?.address, undefined);
    assert.equal(stored?.creditLimitMinor, undefined);
    assert.equal(stored?.active, true);
  });

  it("keeps a limit of zero distinct from no limit", () => {
    // Undecided and cut off are different answers, and collapsing them would
    // either refuse every regular who has never been given a limit or extend
    // unlimited credit to someone deliberately stopped.
    const cutOff = aCustomer({ creditLimitMinor: 0 });
    const undecided = aCustomer();
    saveCustomer(database, cutOff);
    saveCustomer(database, undecided);

    assert.equal(held(cutOff.id)?.creditLimitMinor, 0);
    assert.equal(held(undecided.id)?.creditLimitMinor, undefined);

    // And the wire keeps them apart too.
    const events = database.transaction((tx) => pending(tx, 10));
    const first = events[0]?.payload as { customer: Record<string, unknown> };
    const second = events[1]?.payload as { customer: Record<string, unknown> };
    assert.equal(first.customer["credit_limit_minor"], 0);
    assert.equal("credit_limit_minor" in second.customer, false);
  });

  it("sends what it holds and nothing it does not", () => {
    const customer = aCustomer({
      phone: "+237699123456",
      address: "Carrefour Nsam",
      notes: "paie le vendredi",
      creditLimitMinor: 50_000,
      active: false,
    });
    saveCustomer(database, customer);

    const [queued] = database.transaction((tx) => pending(tx, 10));
    const payload = queued?.payload as { customer: Record<string, unknown> };
    assert.deepEqual(payload.customer, {
      id: customer.id,
      name: "Jean Mbarga",
      phone: "+237699123456",
      address: "Carrefour Nsam",
      notes: "paie le vendredi",
      credit_limit_minor: 50_000,
      active: false,
      created_at: CREATED,
      updated_at: EARLIER,
    });
    // No business, no device, no balance: identity comes from the envelope, and
    // a balance is the ledger's sum rather than a field (ADR-008, §13).
    for (const absent of ["business_id", "device_id", "updated_by_device", "balance_minor"]) {
      assert.equal(absent in payload.customer, false, `${absent} was sent`);
    }
  });

  it("refuses a customer missing what they cannot exist without", () => {
    for (const missing of ["id", "businessId", "name", "userId", "deviceId", "updatedAt"] as const) {
      assert.throws(
        () => saveCustomer(database, aCustomer({ [missing]: "  " })),
        CustomerError,
        `a customer with no ${missing} was saved`,
      );
    }
  });

  it("refuses a customer updated before they were created", () => {
    assert.throws(
      () => saveCustomer(database, aCustomer({ createdAt: LATER, updatedAt: EARLIER })),
      /before they were created/,
    );
  });

  it("refuses a credit limit that is not a whole amount at or above zero", () => {
    for (const limit of [-1, 1.5]) {
      assert.throws(() => saveCustomer(database, aCustomer({ creditLimitMinor: limit })), CustomerError);
    }
  });

  it("writes nothing when the write is refused", () => {
    const customer = aCustomer({ creditLimitMinor: -1 });
    assert.throws(() => saveCustomer(database, customer));

    assert.equal(held(customer.id), undefined);
    assert.equal(database.transaction((tx) => pending(tx, 10)).length, 0);
  });
});

describe("two devices editing one customer", () => {
  // A customer is state: two tills cannot both set a different phone number and
  // have both stand. One edit wins, by the same rule a product's does (ADR-015).

  function edit(id: string, name: string, at: string, device: string): void {
    database.transaction((tx) =>
      upsertCustomer(
        tx,
        {
          id,
          businessId: BUSINESS,
          name,
          active: true,
          createdAt: CREATED,
          updatedAt: at,
        },
        device,
      ),
    );
  }

  it("keeps the newer edit whichever order they arrive in", () => {
    const forwards = nextId("customer");
    edit(forwards, "Jean Mbarga", EARLIER, TILL);
    edit(forwards, "Jean-Paul Mbarga", LATER, PHONE_DEVICE);

    const backwards = nextId("customer");
    edit(backwards, "Jean-Paul Mbarga", LATER, PHONE_DEVICE);
    edit(backwards, "Jean Mbarga", EARLIER, TILL);

    assert.equal(held(forwards)?.name, "Jean-Paul Mbarga");
    assert.equal(held(backwards)?.name, "Jean-Paul Mbarga");
  });

  it("breaks a tie the same way whichever order they arrive in", () => {
    // Without the tie-break the two devices could settle on different names,
    // permanently and with nothing to detect it.
    const [low, high] = [TILL, PHONE_DEVICE].sort();
    const forwards = nextId("customer");
    edit(forwards, "Jean Mbarga", EARLIER, low ?? "");
    edit(forwards, "Jean-Paul Mbarga", EARLIER, high ?? "");

    const backwards = nextId("customer");
    edit(backwards, "Jean-Paul Mbarga", EARLIER, high ?? "");
    edit(backwards, "Jean Mbarga", EARLIER, low ?? "");

    assert.equal(held(forwards)?.name, held(backwards)?.name);
    assert.equal(held(forwards)?.name, "Jean-Paul Mbarga");
  });

  it("reports a losing local save rather than failing", () => {
    const customer = aCustomer({ updatedAt: LATER });
    saveCustomer(database, customer);

    // The same customer edited earlier on this device: it loses, which is a
    // false return and not an error — treating it as a failure would defer the
    // event forever.
    const stale = saveCustomer(database, { ...customer, name: "Ancien", updatedAt: EARLIER });
    assert.equal(stale, false);
    assert.equal(held(customer.id)?.name, "Jean Mbarga");

    // And the event is queued anyway: the server judges against what it holds.
    assert.equal(database.transaction((tx) => pending(tx, 10)).length, 2);
  });
});

describe("finding customers", () => {
  it("lists them by name, and can leave out the closed ones", () => {
    saveCustomer(database, aCustomer({ name: "Bertrand Fouda" }));
    saveCustomer(database, aCustomer({ name: "Alice Ngo" }));
    saveCustomer(database, aCustomer({ name: "Chantal Etoa", active: false }));

    const open = database.transaction((tx) => listCustomers(tx, BUSINESS));
    assert.deepEqual(
      open.map((customer) => customer.name),
      ["Alice Ngo", "Bertrand Fouda"],
    );

    const everyone = database.transaction((tx) =>
      listCustomers(tx, BUSINESS, { includeClosed: true }),
    );
    assert.equal(everyone.length, 3);
  });

  it("returns everyone on a shared number", () => {
    // A household shares one phone. Returning a single record would be picking
    // one of them arbitrarily.
    saveCustomer(database, aCustomer({ name: "Alice Ngo", phone: "+237699123456" }));
    saveCustomer(database, aCustomer({ name: "Bertrand Fouda", phone: "+237699123456" }));
    saveCustomer(database, aCustomer({ name: "Chantal Etoa", phone: "+237677000000" }));

    const found = database.transaction((tx) =>
      customersByPhone(tx, BUSINESS, "+237699123456"),
    );
    assert.deepEqual(
      found.map((customer) => customer.name),
      ["Alice Ngo", "Bertrand Fouda"],
    );
  });
});

describe("a customer paying what they owe", () => {
  function aPayment(overrides: Partial<CustomerPayment> = {}): CustomerPayment {
    return {
      id: nextId("payment"),
      businessId: BUSINESS,
      customerId: "unset",
      accountId: ACCOUNT,
      amountMinor: 5_000,
      userId: USER,
      deviceId: TILL,
      occurredAt: EARLIER,
      recordedAt: LATER,
      eventId: nextId("event"),
      ...overrides,
    };
  }

  function owing(customerId: string): number {
    return database.transaction((tx) => balanceOf(tx, BUSINESS, customerId)).outstandingMinor;
  }

  function owe(customerId: string, amountMinor: number): void {
    database.transaction((tx) =>
      tx.run(
        `INSERT INTO customer_transactions
           (id, customer_id, business_id, type, amount_minor, currency,
            reference_kind, reference_id, user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'CREDIT_SALE', ?, 'XAF', 'SALE', 'v-1', ?, ?, ?, ?)`,
        [nextId("entry"), customerId, BUSINESS, amountMinor, USER, TILL, EARLIER, EARLIER],
      ),
    );
  }

  it("reduces the balance and queues the event carrying it", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);
    owe(customer.id, 25_000);

    recordCustomerPayment(database, aPayment({ customerId: customer.id, amountMinor: 10_000 }));

    // §13's worked example, from the other end: 25,000 owed, 10,000 paid.
    assert.equal(owing(customer.id), 15_000);

    const queued = database.transaction((tx) => pending(tx, 10));
    const event = queued.at(-1);
    assert.equal(event?.type, "CUSTOMER_PAYMENT");
    const payload = event?.payload as { payment: Record<string, unknown> };
    // What was handed over travels positive; the sign is the server's to apply.
    assert.equal(payload.payment["amount_minor"], 10_000);
    assert.equal(payload.payment["customer_id"], customer.id);
    assert.equal(payload.payment["account_id"], ACCOUNT);
  });

  it("records where the money went", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);
    recordCustomerPayment(database, aPayment({ customerId: customer.id }));

    const entry = database.transaction((tx) => ({
      ...tx.get(`SELECT type, amount_minor, account_id FROM customer_transactions`),
    }));
    assert.deepEqual(entry, { type: "PAYMENT", amount_minor: -5_000, account_id: ACCOUNT });
  });

  it("leaves a customer who overpays in credit", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);
    owe(customer.id, 3_000);

    // Money the shopkeeper has already taken. Refusing it would turn away cash
    // in their hand; clamping it would quietly lose the customer's.
    recordCustomerPayment(database, aPayment({ customerId: customer.id, amountMinor: 5_000 }));
    assert.equal(owing(customer.id), -2_000);
  });

  it("takes part of a debt as readily as all of it", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);
    owe(customer.id, 25_000);

    recordCustomerPayment(database, aPayment({ customerId: customer.id, amountMinor: 5_000 }));
    recordCustomerPayment(database, aPayment({ customerId: customer.id, amountMinor: 5_000 }));

    assert.equal(owing(customer.id), 15_000);
  });

  it("refuses a payment of nothing or less", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);

    for (const amountMinor of [0, -5_000, 1.5]) {
      assert.throws(
        () => recordCustomerPayment(database, aPayment({ customerId: customer.id, amountMinor })),
        /not money changing hands/,
      );
    }
    assert.equal(owing(customer.id), 0);
  });

  it("refuses a payment missing what it cannot exist without", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);

    for (const missing of ["id", "customerId", "accountId", "eventId", "occurredAt"] as const) {
      assert.throws(
        () =>
          recordCustomerPayment(
            database,
            aPayment({ customerId: customer.id, [missing]: "  " }),
          ),
        CustomerError,
        `a payment with no ${missing} was recorded`,
      );
    }
  });

  it("writes the entry and the event together or neither", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);
    const payment = aPayment({ customerId: customer.id });
    recordCustomerPayment(database, payment);

    // The same identifier again: the ledger's primary key refuses it, and the
    // event must not be queued for a payment that was not recorded.
    assert.throws(() => recordCustomerPayment(database, { ...payment, eventId: nextId("event") }));

    const events = database.transaction((tx) => pending(tx, 10));
    assert.equal(events.filter((event) => event.type === "CUSTOMER_PAYMENT").length, 1);
    assert.equal(owing(customer.id), -5_000);
  });

  it("keeps the payment in the append-only ledger", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);
    recordCustomerPayment(database, aPayment({ customerId: customer.id }));

    for (const statement of [
      `UPDATE customer_transactions SET amount_minor = -1`,
      `DELETE FROM customer_transactions`,
    ]) {
      assert.throws(() => database.transaction((tx) => tx.run(statement)), /immutable/);
    }
  });
});

describe("what a customer owes", () => {
  function record(customerId: string, type: string, amountMinor: number): void {
    database.transaction((tx) =>
      tx.run(
        `INSERT INTO customer_transactions
           (id, customer_id, business_id, type, amount_minor, currency, account_id,
            reference_kind, reference_id, user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, 'XAF', ?, 'SALE', 'v-1', ?, ?, ?, ?)`,
        [
          nextId("entry"),
          customerId,
          BUSINESS,
          type,
          amountMinor,
          // Only a payment names an account, and every payment must.
          type === "PAYMENT" ? ACCOUNT : null,
          USER,
          TILL,
          EARLIER,
          EARLIER,
        ],
      ),
    );
  }

  it("is the sum of the ledger, never a stored number", () => {
    // §13's worked example: Jean buys 25,000, pays 10,000, owes 15,000.
    const customer = aCustomer();
    saveCustomer(database, customer);
    record(customer.id, "CREDIT_SALE", 25_000);
    record(customer.id, "PAYMENT", -10_000);

    const balance = database.transaction((tx) => balanceOf(tx, BUSINESS, customer.id));
    assert.equal(balance.outstandingMinor, 15_000);
    assert.equal(balance.entries, 2);
  });

  it("tells a customer who always pays from one who never bought", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);

    const untouched = database.transaction((tx) => balanceOf(tx, BUSINESS, customer.id));
    assert.deepEqual(untouched, { outstandingMinor: 0, entries: 0 });

    record(customer.id, "CREDIT_SALE", 5_000);
    record(customer.id, "PAYMENT", -5_000);
    const settled = database.transaction((tx) => balanceOf(tx, BUSINESS, customer.id));
    assert.deepEqual(settled, { outstandingMinor: 0, entries: 2 });
  });

  it("leaves an overpaying customer in credit rather than at zero", () => {
    const customer = aCustomer();
    saveCustomer(database, customer);
    record(customer.id, "CREDIT_SALE", 10_000);
    record(customer.id, "PAYMENT", -12_000);

    // Clamping at zero would quietly lose their money.
    assert.equal(
      database.transaction((tx) => balanceOf(tx, BUSINESS, customer.id)).outstandingMinor,
      -2_000,
    );
  });

  it("answers the credit limit question without enforcing it", () => {
    const customer = aCustomer({ creditLimitMinor: 20_000 });
    saveCustomer(database, customer);
    record(customer.id, "CREDIT_SALE", 15_000);

    const stored = held(customer.id);
    assert.ok(stored);
    assert.equal(database.transaction((tx) => wouldExceedCreditLimit(tx, BUSINESS, stored, 4_000)), false);
    assert.equal(database.transaction((tx) => wouldExceedCreditLimit(tx, BUSINESS, stored, 6_000)), true);

    // A customer with no limit set is never over it: no limit means the
    // shopkeeper has not decided, and refusing on that basis would block every
    // regular who has never been given one.
    const undecided = aCustomer();
    saveCustomer(database, undecided);
    const other = held(undecided.id);
    assert.ok(other);
    assert.equal(
      database.transaction((tx) => wouldExceedCreditLimit(tx, BUSINESS, other, 999_999)),
      false,
    );
  });
});
