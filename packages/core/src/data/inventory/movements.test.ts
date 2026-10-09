import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import { pending, pendingCount } from "../sync/outbox.ts";
import {
  isNegative,
  MovementError,
  movementsFor,
  recordMovement,
  recordMovements,
  stockAsOf,
  stockOf,
  type MovementEvent,
  type MovementType,
  type NewMovement,
} from "./movements.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const DEVICE = "33333333-3333-7333-8333-333333333333";
const PRODUCT = "44444444-4444-7444-8444-444444444444";
const OTHER_PRODUCT = "55555555-5555-7555-8555-555555555555";

const OCCURRED_AT = "2026-08-14T09:30:00.000Z";

let database: Database;
let counter = 0;

beforeEach(() => {
  database = openDatabase();
  migrate(database);
  seed(database);
  counter = 0;
});

afterEach(() => {
  database.close();
});

function seed(db: Database): void {
  db.transaction((tx) => {
    tx.run(
      `INSERT INTO businesses (id, name, currency, created_at, updated_at)
       VALUES (?, 'Boutique Chez Jean', 'XAF', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      [BUSINESS],
    );
    tx.run(
      `INSERT INTO users (id, business_id, name, role, created_at, updated_at)
       VALUES (?, ?, 'Jean Mbarga', 'INVENTORY', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      [USER, BUSINESS],
    );
    tx.run(
      `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'Till 1', 'ANDROID',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      [DEVICE, BUSINESS],
    );
    for (const [id, name] of [
      [PRODUCT, "Riz parfumé 5kg"],
      [OTHER_PRODUCT, "Huile 1L"],
    ] as const) {
      tx.run(
        `INSERT INTO products (id, business_id, name, unit, selling_price_minor, currency,
                               created_at, updated_at)
         VALUES (?, ?, ?, 'sac', 6500, 'XAF',
                 '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
        [id, BUSINESS, name],
      );
    }
  });
}

function movement(overrides: Partial<NewMovement> = {}): NewMovement {
  counter += 1;
  const type: MovementType = overrides.type ?? "PURCHASE";

  const base: NewMovement = {
    id: `movement-${counter}`,
    businessId: BUSINESS,
    productId: PRODUCT,
    type,
    quantity: 100 * 1000,
    userId: USER,
    deviceId: DEVICE,
    occurredAt: OCCURRED_AT,
    recordedAt: OCCURRED_AT,
    ...overrides,
  };

  // Fill in whatever the type requires, unless the caller set it deliberately.
  const needsReference = ["PURCHASE", "SALE", "SALE_RETURN", "PURCHASE_RETURN", "TRANSFER_IN", "TRANSFER_OUT"];
  const needsReason = ["ADJUSTMENT", "STOCK_COUNT", "DAMAGE"];
  return {
    ...base,
    reference:
      "reference" in overrides
        ? overrides.reference
        : needsReference.includes(base.type)
          ? { kind: base.type, id: "reference-1" }
          : undefined,
    reason:
      "reason" in overrides
        ? overrides.reason
        : needsReason.includes(base.type)
          ? "counted the shelf"
          : undefined,
  };
}

function event(overrides: Partial<MovementEvent> = {}): MovementEvent {
  counter += 1;
  return { eventId: `event-${counter}`, type: "STOCK_MOVED", ...overrides };
}

/**
 * This is the reason the outbox exists, and the reason recordMovement writes
 * both in one transaction: a device holding stock history the server will never
 * hear about is a silent, permanent loss (ADR-014).
 */
describe("a movement and its event", () => {
  it("commit together", () => {
    recordMovement(database, movement(), event());

    assert.equal(movementsFor(database, BUSINESS, PRODUCT).length, 1);
    assert.equal(pendingCount(database), 1);

    const [queued] = pending(database, 10);
    const payload = queued?.payload as { movements: Array<{ product_id: string }> };
    assert.equal(payload.movements[0]?.product_id, PRODUCT);
  });

  it("roll back together when the movement is refused by the schema", () => {
    // A movement for a product that does not exist: the foreign key rejects it
    // after the event would already have been queued.
    assert.throws(() =>
      recordMovement(database, movement({ productId: "no-such-product" }), event()),
    );

    assert.equal(pendingCount(database), 0, "the event outlived the movement it described");
    assert.equal(movementsFor(database, BUSINESS, PRODUCT).length, 0);
  });

  it("roll back together when the event is refused", () => {
    assert.throws(() => recordMovement(database, movement(), event({ eventId: "" })));

    assert.equal(
      movementsFor(database, BUSINESS, PRODUCT).length,
      0,
      "the movement survived with no event to carry it to the server",
    );
    assert.equal(pendingCount(database), 0);
  });

  it("roll back together when the event is a duplicate", () => {
    recordMovement(database, movement(), event({ eventId: "duplicate" }));
    assert.equal(movementsFor(database, BUSINESS, PRODUCT).length, 1);

    assert.throws(() => recordMovement(database, movement(), event({ eventId: "duplicate" })));

    assert.equal(
      movementsFor(database, BUSINESS, PRODUCT).length,
      1,
      "a movement was recorded although its event could not be queued",
    );
  });
});

/**
 * A business event fans out: a sale of three lines moves three products' stock,
 * and those movements are one fact about the business.
 */
describe("a business event moving several products", () => {
  it("records every movement and one event", () => {
    recordMovements(
      database,
      [
        movement({ type: "SALE", quantity: -2000, productId: PRODUCT }),
        movement({ type: "SALE", quantity: -1000, productId: OTHER_PRODUCT }),
      ],
      event({ type: "SALE_COMPLETED", context: { sale_id: "sale-1" } }),
    );

    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, -2000);
    assert.equal(stockOf(database, BUSINESS, OTHER_PRODUCT).onHandThousandths, -1000);

    // One event, not three: the server applies the sale, not three unrelated
    // stock changes.
    assert.equal(pendingCount(database), 1);
    const [queued] = pending(database, 10);
    const payload = queued?.payload as { sale_id: string; movements: unknown[] };
    assert.equal(payload.sale_id, "sale-1");
    assert.equal(payload.movements.length, 2);
  });

  it("rolls every movement back when one is refused", () => {
    assert.throws(() =>
      recordMovements(
        database,
        [
          movement({ type: "SALE", quantity: -2000, productId: PRODUCT }),
          movement({ type: "SALE", quantity: -1000, productId: "no-such-product" }),
        ],
        event(),
      ),
    );

    assert.equal(
      stockOf(database, BUSINESS, PRODUCT).onHandThousandths,
      0,
      "half a sale was recorded",
    );
    assert.equal(pendingCount(database), 0);
  });

  it("refuses a business event that moves nothing", () => {
    assert.throws(() => recordMovements(database, [], event()), MovementError);
  });
});

describe("validating a movement", () => {
  it("refuses one that is missing something", () => {
    const missing: ReadonlyArray<Partial<NewMovement>> = [
      { id: "" },
      { businessId: "" },
      { productId: "" },
      { userId: "" },
      { deviceId: "" },
      { occurredAt: "" },
      { recordedAt: "  " },
    ];
    for (const override of missing) {
      assert.throws(
        () => recordMovement(database, movement(override), event()),
        MovementError,
        `expected ${JSON.stringify(override)} to be refused`,
      );
    }
  });

  it("refuses a movement of nothing", () => {
    assert.throws(() => recordMovement(database, movement({ quantity: 0 }), event()), MovementError);
  });

  it("refuses a fractional thousandth", () => {
    assert.throws(
      () => recordMovement(database, movement({ quantity: 1.5 }), event()),
      MovementError,
    );
  });

  /**
   * A sign error is caught where it is made, rather than as an inexplicable
   * stock level weeks later.
   */
  it("refuses a sign that contradicts the type", () => {
    const wrong: ReadonlyArray<readonly [MovementType, number]> = [
      ["PURCHASE", -1000],
      ["SALE_RETURN", -1000],
      ["TRANSFER_IN", -1000],
      ["OPENING_BALANCE", -1000],
      ["SALE", 1000],
      ["PURCHASE_RETURN", 1000],
      ["DAMAGE", 1000],
      ["TRANSFER_OUT", 1000],
    ];
    for (const [type, quantity] of wrong) {
      assert.throws(
        () => recordMovement(database, movement({ type, quantity }), event()),
        MovementError,
        `expected ${type} of ${quantity} to be refused`,
      );
    }
  });

  it("lets a correction go either way", () => {
    for (const type of ["ADJUSTMENT", "STOCK_COUNT"] as const) {
      for (const quantity of [5000, -5000]) {
        recordMovement(database, movement({ type, quantity }), event());
      }
    }
    assert.equal(movementsFor(database, BUSINESS, PRODUCT).length, 4);
  });

  it("requires a reason for corrections and write-offs", () => {
    for (const type of ["ADJUSTMENT", "STOCK_COUNT", "DAMAGE"] as const) {
      const quantity = type === "DAMAGE" ? -1000 : 1000;
      assert.throws(
        () => recordMovement(database, movement({ type, quantity, reason: "  " }), event()),
        MovementError,
        `expected ${type} without a reason to be refused`,
      );
    }
  });

  it("requires a reference for movements from business events", () => {
    for (const type of ["PURCHASE", "SALE", "SALE_RETURN", "PURCHASE_RETURN"] as const) {
      const quantity = type === "SALE" || type === "PURCHASE_RETURN" ? -1000 : 1000;
      assert.throws(
        () => recordMovement(database, movement({ type, quantity, reference: undefined }), event()),
        MovementError,
        `expected ${type} without a reference to be refused`,
      );
    }
  });

  it("requires a unit cost to have both an amount and a currency", () => {
    assert.throws(
      () => recordMovement(database, movement({ unitCostMinor: 400 }), event()),
      MovementError,
    );
    assert.throws(
      () => recordMovement(database, movement({ unitCostCurrency: "XAF" }), event()),
      MovementError,
    );
    assert.throws(
      () =>
        recordMovement(
          database,
          movement({ unitCostMinor: -1, unitCostCurrency: "XAF" }),
          event(),
        ),
      MovementError,
    );
  });
});

/**
 * The ledger is append-only here as on the server. The repository offers no way
 * to edit a movement, but a future screen, a migration, or a support build
 * could reach the table directly.
 */
describe("the ledger", () => {
  it("refuses an update", () => {
    recordMovement(database, movement(), event());

    assert.throws(() => database.run(`UPDATE inventory_movements SET quantity = 1`));
    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, 100_000);
  });

  it("refuses a delete", () => {
    recordMovement(database, movement(), event());

    assert.throws(() => database.run(`DELETE FROM inventory_movements`));
    assert.equal(movementsFor(database, BUSINESS, PRODUCT).length, 1);
  });
});

describe("deriving stock", () => {
  it("sums the ledger", () => {
    // The worked example from §7.
    recordMovement(database, movement({ type: "PURCHASE", quantity: 100_000 }), event());
    recordMovement(database, movement({ type: "SALE", quantity: -3000 }), event());
    recordMovement(database, movement({ type: "SALE_RETURN", quantity: 1000 }), event());
    recordMovement(database, movement({ type: "DAMAGE", quantity: -2000 }), event());
    recordMovement(database, movement({ type: "ADJUSTMENT", quantity: 5000 }), event());

    const level = stockOf(database, BUSINESS, PRODUCT);
    assert.equal(level.onHandThousandths, 101_000);
    assert.equal(level.movements, 5);
    assert.equal(level.lastMovedAt, OCCURRED_AT);
  });

  it("reports nothing for a product that never moved", () => {
    const level = stockOf(database, BUSINESS, OTHER_PRODUCT);
    assert.equal(level.onHandThousandths, 0);
    assert.equal(level.movements, 0);
    assert.equal(level.lastMovedAt, undefined);
  });

  /**
   * §29's case: two devices each sold the last unit offline. Both stand, and
   * the total below zero is a true statement about the business.
   */
  it("keeps both sales when two devices sold the last unit", () => {
    recordMovement(database, movement({ type: "PURCHASE", quantity: 1000 }), event());
    recordMovement(database, movement({ type: "SALE", quantity: -1000 }), event());
    recordMovement(database, movement({ type: "SALE", quantity: -1000 }), event());

    const level = stockOf(database, BUSINESS, PRODUCT);
    assert.equal(level.onHandThousandths, -1000);
    assert.equal(level.movements, 3, "a sale was discarded");
    assert.ok(isNegative(level), "the discrepancy is not surfaced");

    // A count corrects it by adding to history, not by editing it.
    recordMovement(
      database,
      movement({ type: "STOCK_COUNT", quantity: 1000, reason: "counted after a double sale" }),
      event(),
    );
    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, 0);
    assert.equal(movementsFor(database, BUSINESS, PRODUCT).length, 4);
  });

  it("keeps fractional quantities exact", () => {
    // A tenth of a kilo, ten times, is exactly one kilo.
    for (let i = 0; i < 10; i += 1) {
      recordMovement(database, movement({ type: "PURCHASE", quantity: 100 }), event());
    }
    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, 1000);
  });

  it("counts by when stock moved, not when it was recorded", () => {
    recordMovement(
      database,
      movement({ type: "PURCHASE", quantity: 100_000, occurredAt: "2026-08-14T09:00:00.000Z" }),
      event(),
    );
    // A sale from within the period, recorded days later by a device that was
    // offline.
    recordMovement(
      database,
      movement({
        type: "SALE",
        quantity: -10_000,
        occurredAt: "2026-08-14T12:00:00.000Z",
        recordedAt: "2026-08-18T08:00:00.000Z",
      }),
      event(),
    );

    const asOf = stockAsOf(database, BUSINESS, PRODUCT, "2026-08-14T23:59:59.000Z");
    assert.equal(asOf.onHandThousandths, 90_000, "the late arrival was not counted in its period");

    const earlier = stockAsOf(database, BUSINESS, PRODUCT, "2026-08-14T10:00:00.000Z");
    assert.equal(earlier.onHandThousandths, 100_000);
  });

  it("keeps products apart", () => {
    recordMovement(database, movement({ productId: PRODUCT, quantity: 10_000 }), event());
    recordMovement(database, movement({ productId: OTHER_PRODUCT, quantity: 5000 }), event());

    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, 10_000);
    assert.equal(stockOf(database, BUSINESS, OTHER_PRODUCT).onHandThousandths, 5000);
  });
});

describe("reading movements back", () => {
  it("returns everything that was stored", () => {
    recordMovement(
      database,
      movement({
        type: "PURCHASE",
        quantity: 100_000,
        unitCostMinor: 400,
        unitCostCurrency: "XAF",
        reference: { kind: "PURCHASE", id: "purchase-7" },
      }),
      event(),
    );

    const [stored] = movementsFor(database, BUSINESS, PRODUCT);
    assert.ok(stored);
    assert.equal(stored.unitCostMinor, 400);
    assert.equal(stored.unitCostCurrency, "XAF");
    assert.deepEqual(stored.reference, { kind: "PURCHASE", id: "purchase-7" });
    assert.equal(stored.reason, undefined);
    assert.equal(stored.branchId, undefined);
  });

  it("returns them oldest first by when the stock moved", () => {
    recordMovement(
      database,
      movement({ type: "PURCHASE", quantity: 1000, occurredAt: "2026-08-14T12:00:00.000Z" }),
      event(),
    );
    recordMovement(
      database,
      movement({ type: "PURCHASE", quantity: 2000, occurredAt: "2026-08-14T09:00:00.000Z" }),
      event(),
    );

    const stored = movementsFor(database, BUSINESS, PRODUCT);
    assert.deepEqual(
      stored.map((entry) => entry.occurredAt),
      ["2026-08-14T09:00:00.000Z", "2026-08-14T12:00:00.000Z"],
    );
  });
});

/**
 * The event carries the movement itself rather than only its identifier, so the
 * server can apply it without asking this device for anything — which it could
 * not do anyway, since the device may be offline again by then (ADR-006).
 */
describe("the queued event", () => {
  it("carries enough for the server to apply it alone", () => {
    recordMovement(
      database,
      movement({
        type: "ADJUSTMENT",
        quantity: 5000,
        reason: "found in the storeroom",
        unitCostMinor: 400,
        unitCostCurrency: "XAF",
      }),
      event({ type: "STOCK_ADJUSTED" }),
    );

    const [queued] = pending(database, 10);
    assert.ok(queued);
    assert.equal(queued.type, "STOCK_ADJUSTED");
    assert.equal(queued.businessId, BUSINESS);
    assert.equal(queued.userId, USER);
    assert.equal(queued.deviceId, DEVICE);
    assert.equal(queued.occurredAt, OCCURRED_AT);

    const payload = queued.payload as { movements: Array<Record<string, unknown>> };
    const described = payload.movements[0];
    assert.ok(described);
    assert.equal(described["type"], "ADJUSTMENT");
    assert.equal(described["quantity"], 5000);
    assert.equal(described["reason"], "found in the storeroom");
    assert.equal(described["unit_cost_minor"], 400);
    assert.equal(described["occurred_at"], OCCURRED_AT);
  });

  it("omits what was not recorded rather than sending nulls", () => {
    recordMovement(database, movement({ type: "OPENING_BALANCE", quantity: 1000 }), event());

    const [queued] = pending(database, 10);
    const payload = queued?.payload as { movements: Array<Record<string, unknown>> };
    const described = payload.movements[0];
    assert.ok(described);
    assert.ok(!("reason" in described), "an unset reason was sent");
    assert.ok(!("reference_kind" in described), "an unset reference was sent");
    assert.ok(!("unit_cost_minor" in described), "an unset cost was sent");
  });
});
