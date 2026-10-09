import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { balanceOfAccount } from "../finance/cash.ts";
import { pending } from "../sync/outbox.ts";
import {
  balanceOfSupplier,
  ledgerOfSupplier,
  listSuppliers,
  recordSupplierPayment,
  saveSupplier,
  SupplierError,
  supplierOf,
  upsertSupplier,
  type SaveSupplier,
  type SupplierPayment,
} from "./suppliers.ts";

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

function aSupplier(overrides: Partial<SaveSupplier> = {}): SaveSupplier {
  return {
    id: nextId("supplier"),
    businessId: BUSINESS,
    name: "Grossiste Mokolo",
    active: true,
    createdAt: CREATED,
    updatedAt: EARLIER,
    userId: USER,
    deviceId: TILL,
    ...overrides,
  };
}

function aPayment(overrides: Partial<SupplierPayment> = {}): SupplierPayment {
  return {
    id: nextId("entry"),
    businessId: BUSINESS,
    supplierId: "supplier",
    accountId: ACCOUNT,
    amountMinor: 50_000,
    userId: USER,
    deviceId: TILL,
    occurredAt: EARLIER,
    recordedAt: EARLIER,
    eventId: nextId("event"),
    ...overrides,
  };
}

/** Writes a delivery's debt straight to the ledger, for the balance tests. */
function owe(supplierId: string, minor: number, purchaseId = nextId("purchase")): void {
  database.transaction((tx) => {
    tx.run(
      `INSERT INTO supplier_transactions
         (id, supplier_id, business_id, type, amount_minor, currency,
          reference_kind, reference_id, user_id, device_id, occurred_at, recorded_at)
       VALUES (?, ?, ?, 'PURCHASE', ?, 'XAF', 'PURCHASE', ?, ?, ?, ?, ?)`,
      [nextId("entry"), supplierId, BUSINESS, minor, purchaseId, USER, TILL, EARLIER, EARLIER],
    );
  });
}

describe("saving a wholesaler", () => {
  it("stores one and queues the event carrying them", () => {
    const supplier = aSupplier({ contact: "Mama Ngo", phone: "+237677889900" });
    assert.equal(saveSupplier(database, supplier), true);

    const held = database.transaction((tx) => supplierOf(tx, BUSINESS, supplier.id));
    assert.equal(held?.name, "Grossiste Mokolo");
    // The person to ask for, which is what a shopkeeper actually remembers.
    assert.equal(held?.contact, "Mama Ngo");
    assert.equal(held?.phone, "+237677889900");
    assert.equal(held?.active, true);
    assert.equal(held?.updatedByDevice, TILL);

    const queued = database.transaction((tx) => pending(tx, 10));
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.type, "SUPPLIER_SAVED");
  });

  it("writes the supplier and its event in one transaction", () => {
    // A supplier the shopkeeper can see and the server never will is worse than
    // a product: a delivery recorded against them would be refused everywhere
    // else in the shop (ADR-014).
    const supplier = aSupplier();
    saveSupplier(database, supplier);

    const held = database.transaction((tx) => supplierOf(tx, BUSINESS, supplier.id));
    const queued = database.transaction((tx) => pending(tx, 10));
    assert.notEqual(held, undefined);
    assert.equal(queued.length, 1);
  });

  it("needs only a name", () => {
    const supplier = aSupplier();
    saveSupplier(database, supplier);

    const held = database.transaction((tx) => supplierOf(tx, BUSINESS, supplier.id));
    assert.equal(held?.contact, undefined);
    assert.equal(held?.phone, undefined);
    assert.equal(held?.address, undefined);
    assert.equal(held?.notes, undefined);
  });

  it("refuses one missing what it needs", () => {
    for (const overrides of [
      { id: "" },
      { businessId: "" },
      { name: "   " },
      { userId: "" },
      { deviceId: "" },
      { createdAt: "" },
      { updatedAt: "" },
    ] as Partial<SaveSupplier>[]) {
      assert.throws(() => saveSupplier(database, aSupplier(overrides)), SupplierError);
    }
  });

  it("refuses one edited before it was created", () => {
    assert.throws(
      () => saveSupplier(database, aSupplier({ createdAt: LATER, updatedAt: EARLIER })),
      SupplierError,
    );
  });

  it("queues nothing when the write is refused", () => {
    assert.throws(() => saveSupplier(database, aSupplier({ name: "" })));
    assert.equal(
      database.transaction((tx) => pending(tx, 10)).length,
      0,
    );
  });
});

describe("two devices editing the same wholesaler", () => {
  // ADR-015 on the device, because a device has to resolve a conflict with no
  // network at all.
  it("keeps the later edit whichever order they arrive in", () => {
    for (const [first, second] of [
      [EARLIER, LATER],
      [LATER, EARLIER],
    ] as const) {
      const id = nextId("supplier");
      const names: Record<string, string> = {
        [EARLIER]: "Grossiste Mokolo",
        [LATER]: "Grossiste Mokolo SARL",
      };
      for (const at of [first, second]) {
        saveSupplier(database, aSupplier({ id, name: names[at] ?? "", updatedAt: at }));
      }

      const held = database.transaction((tx) => supplierOf(tx, BUSINESS, id));
      assert.equal(held?.name, "Grossiste Mokolo SARL");
      assert.equal(held?.updatedAt, LATER);
    }
  });

  it("breaks a tie by device, so both devices settle on the same answer", () => {
    const id = nextId("supplier");
    // The same instant from two devices: the higher identifier wins, and it
    // wins on every device because the comparison reads only the two rows.
    upsertSupplier(
      database,
      { ...aSupplier({ id, name: "from the till" }), updatedAt: EARLIER },
      TILL,
    );
    upsertSupplier(
      database,
      { ...aSupplier({ id, name: "from the phone" }), updatedAt: EARLIER },
      PHONE_DEVICE,
    );

    const held = database.transaction((tx) => supplierOf(tx, BUSINESS, id));
    const winner = TILL > PHONE_DEVICE ? "from the till" : "from the phone";
    assert.equal(held?.name, winner);
  });

  it("reports a losing edit as false rather than raising", () => {
    // Treating it as a failure would defer the event forever.
    const id = nextId("supplier");
    saveSupplier(database, aSupplier({ id, updatedAt: LATER }));
    assert.equal(saveSupplier(database, aSupplier({ id, updatedAt: EARLIER })), false);
  });

  it("queues a losing edit anyway", () => {
    // Losing here says only that this device already knows of a later edit. The
    // server and the other devices judge for themselves.
    const id = nextId("supplier");
    saveSupplier(database, aSupplier({ id, updatedAt: LATER }));
    saveSupplier(database, aSupplier({ id, updatedAt: EARLIER }));
    assert.equal(database.transaction((tx) => pending(tx, 10)).length, 2);
  });
});

describe("listing wholesalers", () => {
  it("leaves out the ones no longer used unless asked", () => {
    const kept = aSupplier({ name: "Alpha Distribution" });
    const dropped = aSupplier({ name: "Zeta Commerce", active: false });
    saveSupplier(database, kept);
    saveSupplier(database, dropped);

    const active = database.transaction((tx) => listSuppliers(tx, BUSINESS));
    assert.deepEqual(
      active.map((supplier) => supplier.name),
      ["Alpha Distribution"],
    );

    const all = database.transaction((tx) =>
      listSuppliers(tx, BUSINESS, { includeInactive: true }),
    );
    assert.deepEqual(
      all.map((supplier) => supplier.name),
      ["Alpha Distribution", "Zeta Commerce"],
    );
  });

  it("returns nothing for a business that is not this one", () => {
    saveSupplier(database, aSupplier());
    assert.deepEqual(
      database.transaction((tx) => listSuppliers(tx, "another-business")),
      [],
    );
  });
});

describe("what the shop owes", () => {
  it("is the sum of the ledger and never a stored number", () => {
    const supplier = aSupplier();
    saveSupplier(database, supplier);
    owe(supplier.id, 150_000);
    recordSupplierPayment(database, aPayment({ supplierId: supplier.id, amountMinor: 50_000 }));

    const balance = database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, supplier.id));
    assert.equal(balance.outstandingMinor, 100_000);
    assert.equal(balance.entries, 2);
  });

  it("tells never having bought from them apart from owing nothing", () => {
    const supplier = aSupplier();
    saveSupplier(database, supplier);

    const untouched = database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, supplier.id));
    assert.equal(untouched.outstandingMinor, 0);
    assert.equal(untouched.entries, 0);

    owe(supplier.id, 40_000);
    recordSupplierPayment(database, aPayment({ supplierId: supplier.id, amountMinor: 40_000 }));

    const settled = database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, supplier.id));
    assert.equal(settled.outstandingMinor, 0);
    assert.equal(settled.entries, 2);
  });

  it("goes negative when the shop pays ahead", () => {
    // Clamping at zero would quietly lose money already handed over.
    const supplier = aSupplier();
    saveSupplier(database, supplier);
    owe(supplier.id, 40_000);
    recordSupplierPayment(database, aPayment({ supplierId: supplier.id, amountMinor: 60_000 }));

    const balance = database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, supplier.id));
    assert.equal(balance.outstandingMinor, -20_000);
  });

  it("counts only this wholesaler", () => {
    const one = aSupplier({ name: "Alpha" });
    const other = aSupplier({ name: "Beta" });
    saveSupplier(database, one);
    saveSupplier(database, other);
    owe(one.id, 40_000);
    owe(other.id, 90_000);

    assert.equal(
      database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, one.id)).outstandingMinor,
      40_000,
    );
  });
});

describe("settling a wholesaler's account", () => {
  it("stores the payment negative and queues it positive", () => {
    // The ledger stores the sign so summing is plain addition; the wire carries
    // what was handed over, and the sign is the server's to apply.
    const supplier = aSupplier();
    saveSupplier(database, supplier);
    const payment = aPayment({ supplierId: supplier.id, amountMinor: 50_000 });
    recordSupplierPayment(database, payment);

    const ledger = database.transaction((tx) => ledgerOfSupplier(tx, BUSINESS, supplier.id));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.["amount_minor"], -50_000);
    assert.equal(ledger[0]?.["type"], "PAYMENT");
    assert.equal(ledger[0]?.["account_id"], ACCOUNT);

    const queued = database.transaction((tx) => pending(tx, 10));
    const sent = queued.find((event) => event.type === "SUPPLIER_PAYMENT");
    assert.notEqual(sent, undefined);
    const body = sent?.payload as { payment: Record<string, unknown> };
    assert.equal(body.payment["amount_minor"], 50_000);
    assert.equal(body.payment["supplier_id"], supplier.id);
    assert.equal(body.payment["account_id"], ACCOUNT);
    // No business, branch, user, or device: identity comes from the envelope.
    assert.deepEqual(
      Object.keys(body.payment).sort(),
      ["account_id", "amount_minor", "id", "occurred_at", "supplier_id"],
    );
  });

  it("takes the money out of the drawer", () => {
    // §18: a payment to a wholesaler is a source of money like any other, and
    // one missing from the balance would leave the till reading long.
    const supplier = aSupplier();
    saveSupplier(database, supplier);
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO account_movements
           (id, account_id, business_id, type, amount_minor, currency,
            user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'OPENING_BALANCE', 200000, 'XAF', ?, ?, ?, ?)`,
        [nextId("movement"), ACCOUNT, BUSINESS, USER, TILL, EARLIER, EARLIER],
      );
    });

    owe(supplier.id, 100_000);
    recordSupplierPayment(database, aPayment({ supplierId: supplier.id, amountMinor: 30_000 }));

    assert.equal(
      database.transaction((tx) => balanceOfAccount(tx, BUSINESS, ACCOUNT)).onHandMinor,
      170_000,
    );
  });

  it("leaves the drawer alone for goods going back", () => {
    // A return reduces the bill without a franc leaving the till, which is why
    // it names no account (§16).
    const supplier = aSupplier();
    saveSupplier(database, supplier);
    const purchaseId = nextId("purchase");
    owe(supplier.id, 100_000, purchaseId);
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO supplier_transactions
           (id, supplier_id, business_id, type, amount_minor, currency,
            reference_kind, reference_id, user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'RETURN', -10000, 'XAF', 'PURCHASE', ?, ?, ?, ?, ?)`,
        [nextId("entry"), supplier.id, BUSINESS, purchaseId, USER, TILL, EARLIER, EARLIER],
      );
    });

    assert.equal(
      database.transaction((tx) => balanceOfAccount(tx, BUSINESS, ACCOUNT)).onHandMinor,
      0,
    );
    assert.equal(
      database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, supplier.id)).outstandingMinor,
      90_000,
    );
  });

  it("refuses a payment that is not money changing hands", () => {
    const supplier = aSupplier();
    saveSupplier(database, supplier);
    for (const amountMinor of [0, -1, 1.5]) {
      assert.throws(
        () => recordSupplierPayment(database, aPayment({ supplierId: supplier.id, amountMinor })),
        SupplierError,
      );
    }
  });

  it("refuses one missing what it needs", () => {
    for (const overrides of [
      { id: "" },
      { businessId: "" },
      { supplierId: "" },
      { accountId: "" },
      { userId: "" },
      { deviceId: "" },
      { occurredAt: "" },
      { recordedAt: "" },
      { eventId: "" },
    ] as Partial<SupplierPayment>[]) {
      assert.throws(() => recordSupplierPayment(database, aPayment(overrides)), SupplierError);
    }
  });

  it("refuses one recorded before it happened", () => {
    assert.throws(
      () => recordSupplierPayment(database, aPayment({ occurredAt: LATER, recordedAt: EARLIER })),
      SupplierError,
    );
  });

  it("lets the shop pay more than it owes", () => {
    // Refusing would refuse a payment the shopkeeper has actually made.
    const supplier = aSupplier();
    saveSupplier(database, supplier);
    owe(supplier.id, 10_000);
    recordSupplierPayment(database, aPayment({ supplierId: supplier.id, amountMinor: 50_000 }));

    assert.equal(
      database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, supplier.id)).outstandingMinor,
      -40_000,
    );
  });
});

describe("the supplier ledger", () => {
  it("refuses an edit, because a correction is another entry", () => {
    const supplier = aSupplier();
    saveSupplier(database, supplier);
    const payment = aPayment({ supplierId: supplier.id });
    recordSupplierPayment(database, payment);

    assert.throws(() =>
      database.transaction((tx) => {
        tx.run(`UPDATE supplier_transactions SET amount_minor = -1 WHERE id = ?`, [payment.id]);
      }),
    );
    assert.throws(() =>
      database.transaction((tx) => {
        tx.run(`DELETE FROM supplier_transactions WHERE id = ?`, [payment.id]);
      }),
    );

    assert.equal(
      database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, supplier.id)).outstandingMinor,
      -50_000,
    );
  });

  it("reads in the order things happened, not the order they arrived", () => {
    const supplier = aSupplier();
    saveSupplier(database, supplier);
    recordSupplierPayment(
      database,
      aPayment({ supplierId: supplier.id, occurredAt: LATER, recordedAt: LATER }),
    );
    recordSupplierPayment(
      database,
      aPayment({ supplierId: supplier.id, occurredAt: EARLIER, recordedAt: LATER }),
    );

    const ledger = database.transaction((tx) => ledgerOfSupplier(tx, BUSINESS, supplier.id));
    assert.deepEqual(
      ledger.map((row) => row["occurred_at"]),
      [EARLIER, LATER],
    );
  });
});
