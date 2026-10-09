import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { balanceOfAccount } from "../finance/cash.ts";
import { balanceOfSupplier, supplierOf } from "../suppliers/suppliers.ts";
import { UnusableEvent } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";
import { supplierApplier, supplierPaymentApplier } from "./supplier-applier.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL = "33333333-3333-7333-8333-333333333333";
const PHONE_DEVICE = "44444444-4444-7444-8444-444444444444";
const ACCOUNT = "55555555-5555-7555-8555-555555555555";
const SUPPLIER = "77777777-7777-7777-8777-777777777777";
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
    tx.run(
      `INSERT INTO financial_accounts (id, business_id, name, kind, currency, created_at, updated_at)
       VALUES (?, ?, 'Caisse', 'CASH', 'XAF', ?, ?)`,
      [ACCOUNT, BUSINESS, CREATED, CREATED],
    );
  });
});

let counter = 0;
function nextId(prefix: string): string {
  counter++;
  return `${prefix}-${counter}`;
}

function anEvent(payload: unknown, overrides: Partial<InboxEvent> = {}): InboxEvent {
  return {
    eventId: nextId("event"),
    businessId: BUSINESS,
    deviceId: PHONE_DEVICE,
    userId: USER,
    type: "SUPPLIER_SAVED",
    payload,
    occurredAt: EARLIER,
    serverSequence: 1,
    state: "pending",
    attempts: 0,
    lastError: null,
    ...overrides,
  } as InboxEvent;
}

function applySupplier(payload: unknown, overrides: Partial<InboxEvent> = {}): void {
  database.transaction((tx) => {
    supplierApplier.apply(tx, anEvent(payload, overrides));
  });
}

function applyPayment(payload: unknown, overrides: Partial<InboxEvent> = {}): void {
  database.transaction((tx) => {
    supplierPaymentApplier.apply(tx, anEvent(payload, { type: "SUPPLIER_PAYMENT", ...overrides }));
  });
}

function savedPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    supplier: {
      id: SUPPLIER,
      name: "Grossiste Mokolo",
      created_at: CREATED,
      updated_at: EARLIER,
      ...overrides,
    },
  };
}

function paymentPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    payment: {
      id: nextId("entry"),
      supplier_id: SUPPLIER,
      account_id: ACCOUNT,
      amount_minor: 50_000,
      occurred_at: EARLIER,
      ...overrides,
    },
  };
}

function seedSupplier(): void {
  database.transaction((tx) => {
    tx.run(
      `INSERT INTO suppliers (id, business_id, name, created_at, updated_at)
       VALUES (?, ?, 'Grossiste Mokolo', ?, ?)`,
      [SUPPLIER, BUSINESS, CREATED, CREATED],
    );
  });
}

describe("a wholesaler arriving from another device", () => {
  it("lands, with the business and editing device from the envelope", () => {
    // Never from the payload: that is what stops a device nominating itself the
    // winner of a tie (ADR-008, ADR-015).
    applySupplier(
      savedPayload({
        phone: "+237677889900",
        contact: "Mama Ngo",
        address: "Marché Mokolo",
        notes: "livre le mardi",
      }),
    );

    const held = database.transaction((tx) => supplierOf(tx, BUSINESS, SUPPLIER));
    assert.equal(held?.name, "Grossiste Mokolo");
    assert.equal(held?.contact, "Mama Ngo");
    assert.equal(held?.phone, "+237677889900");
    assert.equal(held?.address, "Marché Mokolo");
    assert.equal(held?.notes, "livre le mardi");
    assert.equal(held?.businessId, BUSINESS);
    assert.equal(held?.updatedByDevice, PHONE_DEVICE);
    assert.equal(held?.active, true);
  });

  it("treats an absent active flag as active", () => {
    // A device that has never sent the field is not saying the shop stopped
    // buying from them.
    applySupplier(savedPayload());
    assert.equal(database.transaction((tx) => supplierOf(tx, BUSINESS, SUPPLIER))?.active, true);

    applySupplier(savedPayload({ active: false, updated_at: LATER }));
    assert.equal(database.transaction((tx) => supplierOf(tx, BUSINESS, SUPPLIER))?.active, false);
  });

  it("keeps the later edit whichever order the two arrive in", () => {
    for (const [first, second] of [
      [EARLIER, LATER],
      [LATER, EARLIER],
    ] as const) {
      database = openDatabase();
      migrate(database);
      database.transaction((tx) => {
        tx.run(
          `INSERT INTO businesses (id, name, currency, created_at, updated_at)
           VALUES (?, 'Boutique', 'XAF', ?, ?)`,
          [BUSINESS, CREATED, CREATED],
        );
        tx.run(
          `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
           VALUES (?, ?, 'Phone', 'ANDROID', ?, ?, ?)`,
          [PHONE_DEVICE, BUSINESS, CREATED, CREATED, CREATED],
        );
      });

      const names: Record<string, string> = {
        [EARLIER]: "Grossiste Mokolo",
        [LATER]: "Grossiste Mokolo SARL",
      };
      for (const at of [first, second]) {
        applySupplier(savedPayload({ name: names[at], updated_at: at }));
      }
      assert.equal(
        database.transaction((tx) => supplierOf(tx, BUSINESS, SUPPLIER))?.name,
        "Grossiste Mokolo SARL",
      );
    }
  });

  it("is fully handled even when the edit loses", () => {
    // A losing edit is not a failure. Treating it as one would defer the event
    // forever.
    applySupplier(savedPayload({ name: "later", updated_at: LATER }));
    assert.doesNotThrow(() => applySupplier(savedPayload({ name: "earlier" })));
    assert.equal(database.transaction((tx) => supplierOf(tx, BUSINESS, SUPPLIER))?.name, "later");
  });

  it("sets aside a payload it can never read", () => {
    for (const payload of [
      null,
      "a supplier",
      {},
      { supplier: null },
      { supplier: { name: "no identifier", created_at: CREATED, updated_at: EARLIER } },
      { supplier: { id: SUPPLIER, created_at: CREATED, updated_at: EARLIER } },
      { supplier: { id: SUPPLIER, name: "n", updated_at: EARLIER } },
      { supplier: { id: SUPPLIER, name: "n", created_at: CREATED } },
      { supplier: { id: SUPPLIER, name: "n", created_at: CREATED, updated_at: EARLIER, phone: 7 } },
      {
        supplier: {
          id: SUPPLIER,
          name: "n",
          created_at: CREATED,
          updated_at: EARLIER,
          active: "yes",
        },
      },
    ]) {
      assert.throws(() => applySupplier(payload), UnusableEvent);
    }
  });
});

describe("a payment to a wholesaler arriving from another device", () => {
  it("is appended, negative, and takes money out of the drawer", () => {
    seedSupplier();
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO account_movements
           (id, account_id, business_id, type, amount_minor, currency,
            user_id, device_id, occurred_at, recorded_at)
         VALUES ('float', ?, ?, 'OPENING_BALANCE', 200000, 'XAF', ?, ?, ?, ?)`,
        [ACCOUNT, BUSINESS, USER, TILL, EARLIER, EARLIER],
      );
    });

    applyPayment(paymentPayload({ note: "acompte" }));

    assert.equal(
      database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, SUPPLIER)).outstandingMinor,
      -50_000,
    );
    // §18: the drawer has to know. A payment missing from the balance would
    // leave the till reading long by exactly what it paid out.
    assert.equal(
      database.transaction((tx) => balanceOfAccount(tx, BUSINESS, ACCOUNT)).onHandMinor,
      150_000,
    );
  });

  it("leaves one entry when the same payment arrives twice", () => {
    // A pull retried after a lost response, or a device receiving back what it
    // sent (§27).
    seedSupplier();
    const payload = paymentPayload();
    applyPayment(payload);
    applyPayment(payload);

    const balance = database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, SUPPLIER));
    assert.equal(balance.entries, 1);
    assert.equal(balance.outstandingMinor, -50_000);
  });

  it("keeps both when two devices each settle part of a bill", () => {
    // A ledger is not resolved the way a name is: both entries stand.
    seedSupplier();
    applyPayment(paymentPayload({ amount_minor: 30_000 }));
    applyPayment(paymentPayload({ amount_minor: 20_000 }), { deviceId: TILL });

    const balance = database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, SUPPLIER));
    assert.equal(balance.entries, 2);
    assert.equal(balance.outstandingMinor, -50_000);
  });

  it("refuses a payment that is not money changing hands", () => {
    // The sign is applied here, so a payment that increased a bill is something
    // no device can express.
    seedSupplier();
    for (const amount_minor of [0, -50_000]) {
      assert.throws(() => applyPayment(paymentPayload({ amount_minor })), UnusableEvent);
    }
  });

  it("sets aside a payload it can never read", () => {
    seedSupplier();
    for (const payload of [
      null,
      {},
      { payment: null },
      { payment: { supplier_id: SUPPLIER, account_id: ACCOUNT, amount_minor: 1 } },
      { payment: { id: "e", account_id: ACCOUNT, amount_minor: 1 } },
      // A payment naming no account is money no report can place (§18).
      { payment: { id: "e", supplier_id: SUPPLIER, amount_minor: 1 } },
      { payment: { id: "e", supplier_id: SUPPLIER, account_id: ACCOUNT } },
      { payment: { id: "e", supplier_id: SUPPLIER, account_id: ACCOUNT, amount_minor: 1.5 } },
      {
        payment: {
          id: "e",
          supplier_id: SUPPLIER,
          account_id: ACCOUNT,
          amount_minor: 1,
          note: 7,
        },
      },
    ]) {
      assert.throws(() => applyPayment(payload), UnusableEvent);
    }
  });
});
