import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { stockOf } from "../inventory/movements.ts";
import { completeSale, type Cart } from "../sales/sales.ts";
import { UnusableEvent } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";
import { pending } from "./outbox.ts";
import { SALE_COMPLETED, saleApplier } from "./sale-applier.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const TILL = "33333333-3333-7333-8333-333333333333";
const PHONE = "44444444-4444-7444-8444-444444444444";
const ACCOUNT = "55555555-5555-7555-8555-555555555555";
const PRODUCT = "66666666-6666-7666-8666-666666666666";
const CREATED = "2026-08-01T08:00:00.000Z", SOLD = "2026-08-14T09:00:00.000Z", RECORDED = "2026-08-14T10:00:00.000Z";

function fresh(): Database {
  const opened = openDatabase();
  migrate(opened);
  opened.transaction((tx) => {
    tx.run(`INSERT INTO businesses (id, name, currency, created_at, updated_at) VALUES (?, 'Boutique', 'XAF', ?, ?)`, [BUSINESS, CREATED, CREATED]);
    tx.run(`INSERT INTO users (id, business_id, name, role, created_at, updated_at) VALUES (?, ?, 'Jean', 'CASHIER', ?, ?)`, [USER, BUSINESS, CREATED, CREATED]);
    for (const id of [TILL, PHONE]) {
      tx.run(`INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at) VALUES (?, ?, 'Till', 'ANDROID', ?, ?, ?)`, [id, BUSINESS, CREATED, CREATED, CREATED]);
    }
    tx.run(`INSERT INTO financial_accounts (id, business_id, name, kind, currency, created_at, updated_at) VALUES (?, ?, 'Caisse', 'CASH', 'XAF', ?, ?)`, [ACCOUNT, BUSINESS, CREATED, CREATED]);
    tx.run(`INSERT INTO products (id, business_id, name, unit, selling_price_minor, currency, created_at, updated_at) VALUES (?, ?, 'Riz', 'sac', 1000, 'XAF', ?, ?)`, [PRODUCT, BUSINESS, CREATED, CREATED]);
  });
  return opened;
}

/** A paid two-sack sale as the sending till queues it, so the wire format is real. */
function queued(): { sale: Record<string, unknown>; payments: { amount_minor: number }[] } {
  const sender = fresh();
  const cart: Cart = { id: "sale-1", businessId: BUSINESS, number: "V-1", userId: USER, deviceId: TILL, occurredAt: SOLD, recordedAt: RECORDED, eventId: "event-1",
    lines: [{ id: "line-1", movementId: "movement-1", productId: PRODUCT, name: "Riz", unitPriceMinor: 1000, quantity: 2000 }],
    payments: [{ id: "payment-1", accountId: ACCOUNT, amountMinor: 2000 }] };
  completeSale(sender, cart);
  return structuredClone(sender.transaction((tx) => pending(tx, 10))[0]!.payload) as ReturnType<typeof queued>;
}

function apply(database: Database, payload: unknown): void {
  const event = { eventId: "received-1", businessId: BUSINESS, deviceId: PHONE, userId: USER, type: SALE_COMPLETED, payload, occurredAt: SOLD,
    serverSequence: 1, state: "deferred", attempts: 0, lastError: null } satisfies InboxEvent;
  database.transaction((tx) => saleApplier.apply(tx, event));
}

describe("a sale from another device whose numbers do not add up", () => {
  it("lands when it adds up", () => {
    const database = fresh();
    apply(database, queued());
    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, -2000);
  });

  it("is refused, whole, when more was paid than it came to", () => {
    const database = fresh(), payload = queued();
    payload.payments[0]!.amount_minor = 2001;
    assert.throws(() => apply(database, payload), UnusableEvent);
    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, 0);
  });

  it("is refused when its discount is larger than the sale", () => {
    const database = fresh(), payload = queued();
    payload.sale["discount_minor"] = 2001;
    payload.payments.splice(0);
    assert.throws(() => apply(database, payload), UnusableEvent);
  });

  it("names the customer it is missing when a balance is left owing", () => {
    const database = fresh(), payload = queued();
    payload.payments[0]!.amount_minor = 500;
    payload.sale["credit_transaction_id"] = "credit-1";
    assert.throws(() => apply(database, payload), /no customer to owe it/);
  });
});
