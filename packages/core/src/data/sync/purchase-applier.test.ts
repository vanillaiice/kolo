import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { balanceOfAccount } from "../finance/cash.ts";
import { stockOf } from "../inventory/movements.ts";
import { recordPurchase, type Delivery, type DeliveryLine } from "../purchases/purchases.ts";
import { balanceOfSupplier } from "../suppliers/suppliers.ts";
import { UnusableEvent } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";
import { pending } from "./outbox.ts";
import { purchaseApplier } from "./purchase-applier.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL = "33333333-3333-7333-8333-333333333333";
const PHONE_DEVICE = "44444444-4444-7444-8444-444444444444";
const ACCOUNT = "55555555-5555-7555-8555-555555555555";
const PRODUCT = "66666666-6666-7666-8666-666666666666";
const SUPPLIER = "77777777-7777-7777-8777-777777777777";
const CREATED = "2026-08-01T08:00:00.000Z";
const ARRIVED = "2026-08-14T09:00:00.000Z";
const RECORDED = "2026-08-14T10:00:00.000Z";

let database: Database;

function fresh(): Database {
  const opened = openDatabase();
  migrate(opened);
  opened.transaction((tx) => {
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
    tx.run(
      `INSERT INTO products
         (id, business_id, name, unit, selling_price_minor, currency, created_at, updated_at)
       VALUES (?, ?, 'Riz 5kg', 'sac', 6500, 'XAF', ?, ?)`,
      [PRODUCT, BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO suppliers (id, business_id, name, created_at, updated_at)
       VALUES (?, ?, 'Grossiste Mokolo', ?, ?)`,
      [SUPPLIER, BUSINESS, CREATED, CREATED],
    );
    tx.run(
      `INSERT INTO account_movements
         (id, account_id, business_id, type, amount_minor, currency,
          user_id, device_id, occurred_at, recorded_at)
       VALUES ('float', ?, ?, 'OPENING_BALANCE', 200000, 'XAF', ?, ?, ?, ?)`,
      [ACCOUNT, BUSINESS, USER, TILL, ARRIVED, ARRIVED],
    );
  });
  return opened;
}

beforeEach(() => {
  database = fresh();
});

let counter = 0;
function nextId(prefix: string): string {
  counter++;
  return `${prefix}-${counter}`;
}

function aLine(overrides: Partial<DeliveryLine> = {}): DeliveryLine {
  return {
    id: nextId("line"),
    movementId: nextId("movement"),
    productId: PRODUCT,
    unitCostMinor: 5_000,
    quantity: 20_000,
    ...overrides,
  };
}

function aDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: nextId("purchase"),
    businessId: BUSINESS,
    supplierId: SUPPLIER,
    lines: [aLine()],
    payments: [],
    userId: USER,
    deviceId: TILL,
    occurredAt: ARRIVED,
    recordedAt: RECORDED,
    eventId: nextId("event"),
    ...overrides,
  };
}

function anEvent(payload: unknown, overrides: Partial<InboxEvent> = {}): InboxEvent {
  return {
    eventId: nextId("event"),
    businessId: BUSINESS,
    deviceId: PHONE_DEVICE,
    userId: USER,
    type: "PURCHASE_RECORDED",
    payload,
    occurredAt: ARRIVED,
    serverSequence: 1,
    state: "pending",
    attempts: 0,
    lastError: null,
    ...overrides,
  } as InboxEvent;
}

function apply(payload: unknown, overrides: Partial<InboxEvent> = {}): void {
  database.transaction((tx) => {
    purchaseApplier.apply(tx, anEvent(payload, overrides));
  });
}

function stock(): number {
  return database.transaction((tx) => stockOf(tx, BUSINESS, PRODUCT).onHandThousandths);
}

function owed(): number {
  return database.transaction((tx) => balanceOfSupplier(tx, BUSINESS, SUPPLIER).outstandingMinor);
}

function drawer(): number {
  return database.transaction((tx) => balanceOfAccount(tx, BUSINESS, ACCOUNT).onHandMinor);
}

/**
 * Records a delivery on one device and returns the payload it queued.
 *
 * This is what makes these tests worth having: the payload is not handwritten,
 * so `describe()` in purchases.ts and this applier are exercised as the two
 * halves of one wire format they actually are.
 */
function queued(delivery: Delivery): unknown {
  const sender = fresh();
  recordPurchase(sender, delivery);
  return sender.transaction((tx) => pending(tx, 10))[0]?.payload;
}

describe("a delivery arriving from another device", () => {
  it("lands whole: the purchase, its lines, the stock, the cash, and the debt", () => {
    const delivery = aDelivery({
      reference: "BL-2026-118",
      payments: [
        { id: nextId("payment"), accountId: ACCOUNT, amountMinor: 40_000, reason: "acompte" },
      ],
      supplierTransactionId: nextId("entry"),
    });
    apply(queued(delivery));

    assert.equal(stock(), 20_000);
    // The debt is worked out here, by the same arithmetic the sending device
    // used, rather than read from the wire.
    assert.equal(owed(), 60_000);
    // The money that left the drawer at the door.
    assert.equal(drawer(), 160_000);

    const held = database.transaction((tx) =>
      tx.get(`SELECT * FROM purchases WHERE id = ?`, [delivery.id]),
    );
    assert.equal(held?.["reference"], "BL-2026-118");
    // Tenant, user, and device come from the envelope, never the payload.
    assert.equal(held?.["business_id"], BUSINESS);
    assert.equal(held?.["device_id"], PHONE_DEVICE);
  });

  it("applies a delivery paid at the door with nothing owed", () => {
    apply(
      queued(
        aDelivery({
          payments: [
            {
              id: nextId("payment"),
              accountId: ACCOUNT,
              amountMinor: 100_000,
              reason: "payé au livreur",
            },
          ],
        }),
      ),
    );

    assert.equal(stock(), 20_000);
    assert.equal(drawer(), 100_000);
    assert.equal(owed(), 0);
  });

  it("applies one bought at the market, which names no wholesaler", () => {
    apply(
      queued(
        aDelivery({
          supplierId: undefined,
          payments: [
            { id: nextId("payment"), accountId: ACCOUNT, amountMinor: 100_000, reason: "marché" },
          ],
        }),
      ),
    );

    assert.equal(stock(), 20_000);
    assert.equal(drawer(), 100_000);
  });

  it("doubles nothing when the same delivery arrives twice", () => {
    // A pull retried after a lost response, or a device receiving back what it
    // sent. INSERT OR IGNORE throughout is the whole idempotency story (§27).
    const payload = queued(
      aDelivery({
        payments: [
          { id: nextId("payment"), accountId: ACCOUNT, amountMinor: 40_000, reason: "acompte" },
        ],
        supplierTransactionId: nextId("entry"),
      }),
    );
    apply(payload);
    apply(payload);

    assert.equal(stock(), 20_000);
    assert.equal(owed(), 60_000);
    assert.equal(drawer(), 160_000);
  });

  it("works out the same debt the sending device did", () => {
    // A rounding difference here would put a different number on a wholesaler's
    // account than the delivery note in their hand says.
    const delivery = aDelivery({
      lines: [aLine({ unitCostMinor: 333, quantity: 1_500 })],
      supplierTransactionId: nextId("entry"),
    });
    const sender = fresh();
    const totals = recordPurchase(sender, delivery);
    apply(sender.transaction((tx) => pending(tx, 10))[0]?.payload);

    assert.equal(totals.outstandingMinor, 500);
    assert.equal(owed(), 500);
  });
});

describe("a delivery this device cannot use", () => {
  it("is set aside rather than deferred forever", () => {
    for (const payload of [
      null,
      "a delivery",
      {},
      { purchase: null },
      { purchase: { items: [] } },
      { purchase: { id: "p", items: "not a list" } },
      { purchase: { id: "p", items: [{ product_id: PRODUCT }] } },
      { purchase: { id: "p", items: [{ id: "i" }] } },
      { purchase: { id: "p", items: [{ id: "i", product_id: PRODUCT, quantity: 1.5 }] } },
    ]) {
      assert.throws(() => apply(payload), UnusableEvent);
    }
  });

  it("refuses a door payment that did not take money out", () => {
    // The wire carries a door payment signed as it will be stored. A positive
    // one would make a drawer look full that is empty.
    assert.throws(
      () =>
        apply({
          purchase: {
            id: "p",
            items: [{ id: "i", product_id: PRODUCT, unit_cost_minor: 1, quantity: 1_000 }],
          },
          payments: [{ id: "pay", account_id: ACCOUNT, amount_minor: 1, reason: "r" }],
        }),
      UnusableEvent,
    );
  });

  it("refuses a door payment with no reason for the cash leaving", () => {
    // The schema refuses a CASH_OUT without one, so waiting will not help.
    assert.throws(
      () =>
        apply({
          purchase: {
            id: "p",
            items: [{ id: "i", product_id: PRODUCT, unit_cost_minor: 1, quantity: 1_000 }],
          },
          payments: [{ id: "pay", account_id: ACCOUNT, amount_minor: -1 }],
        }),
      UnusableEvent,
    );
  });

  it("refuses a delivery whose debt and ledger entry disagree", () => {
    const owing = {
      purchase: {
        id: "p1",
        supplier_id: SUPPLIER,
        items: [{ id: "i1", product_id: PRODUCT, unit_cost_minor: 5_000, quantity: 20_000 }],
      },
    };
    assert.throws(() => apply(owing), UnusableEvent);

    const settledButClaiming = {
      purchase: {
        id: "p2",
        supplier_id: SUPPLIER,
        supplier_transaction_id: "entry",
        items: [{ id: "i2", product_id: PRODUCT, unit_cost_minor: 5_000, quantity: 20_000 }],
      },
      payments: [{ id: "pay2", account_id: ACCOUNT, amount_minor: -100_000, reason: "r" }],
    };
    assert.throws(() => apply(settledButClaiming), UnusableEvent);
  });

  it("refuses a debt with nobody to owe it", () => {
    assert.throws(
      () =>
        apply({
          purchase: {
            id: "p",
            supplier_transaction_id: "entry",
            items: [{ id: "i", product_id: PRODUCT, unit_cost_minor: 5_000, quantity: 20_000 }],
          },
        }),
      UnusableEvent,
    );
  });

  it("refuses arithmetic it cannot do exactly", () => {
    assert.throws(
      () =>
        apply({
          purchase: {
            id: "p",
            supplier_id: SUPPLIER,
            items: [
              {
                id: "i",
                product_id: PRODUCT,
                unit_cost_minor: Number.MAX_SAFE_INTEGER,
                quantity: 2_000,
              },
            ],
          },
        }),
      UnusableEvent,
    );
  });
});

describe("a delivery whose numbers do not add up", () => {
  it("is refused when more was paid at the door than the delivery came to", () => {
    const payload = structuredClone(queued(aDelivery({
      payments: [{ id: nextId("payment"), accountId: ACCOUNT, amountMinor: 100_000, reason: "comptant" }],
    }))) as { payments: { amount_minor: number }[] };
    payload.payments[0]!.amount_minor = -100_001;
    assert.throws(() => apply(payload), UnusableEvent);
    assert.equal(stock(), 0);
  });
});
