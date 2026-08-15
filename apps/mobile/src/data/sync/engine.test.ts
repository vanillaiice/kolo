import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { openDatabase } from "../database/node-sqlite.ts";
import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { recordMovement, stockOf } from "../inventory/movements.ts";
import { SyncEngine, UnusableEvent, type EventApplier } from "./engine.ts";
import { cursor, deferredCount, unusable } from "./inbox.ts";
import { pending, pendingCount, rejected } from "./outbox.ts";
import { stockApplier, STOCK_MOVED } from "./stock-applier.ts";
import { PRODUCT_SAVED, productApplier } from "./product-applier.ts";
import { productOf } from "../products/products.ts";
import { TransportError, type IncomingEvent, type PullResult, type PushResult } from "./transport.ts";

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const DEVICE = "33333333-3333-7333-8333-333333333333";
const OTHER_DEVICE = "44444444-4444-7444-8444-444444444444";
const PRODUCT = "55555555-5555-7555-8555-555555555555";
const AT = "2026-08-14T09:30:00.000Z";

/**
 * A transport the test drives directly.
 *
 * It records what it was asked to send, so a test can check the engine did not
 * resend what was already settled — which costs a shop money on a metered link.
 */
class FakeTransport {
  pushes: { event_id: string }[][] = [];
  pulls: { cursor: number; limit: number }[] = [];

  pushHandler: (events: readonly { event_id: string }[]) => PushResult = (events) =>
    accepted(events);
  pullHandler: (cursor: number, limit: number) => PullResult = () => empty();

  async push(events: readonly { event_id: string }[]): Promise<PushResult> {
    this.pushes.push([...events]);
    return this.pushHandler(events);
  }

  async pull(from: number, limit: number): Promise<PullResult> {
    this.pulls.push({ cursor: from, limit });
    return this.pullHandler(from, limit);
  }

  /** Every event identifier sent, across all pushes. */
  sent(): string[] {
    return this.pushes.flatMap((batch) => batch.map((event) => event.event_id));
  }
}

function accepted(events: readonly { event_id: string }[]): PushResult {
  return {
    results: events.map((event) => ({ event_id: event.event_id, status: "accepted", retry: false })),
    cursor: events.length,
    accepted: events.length,
    duplicates: 0,
    rejected: 0,
  };
}

function empty(): PullResult {
  return { events: [], cursor: 0, has_more: false };
}

let database: Database;
let transport: FakeTransport;

function newEngine(appliers: readonly EventApplier[] = [stockApplier, productApplier]): SyncEngine {
  return new SyncEngine({
    database,
    transport: transport as never,
    businessId: BUSINESS,
    appliers,
    now: () => new Date(AT),
  });
}

/** Seeds the rows a movement references, so foreign keys hold. */
function seed(): void {
  database.transaction((tx) => {
    tx.run(`INSERT INTO businesses (id, name, currency, created_at, updated_at)
            VALUES (?, 'Boutique', 'XAF', ?, ?)`, [BUSINESS, AT, AT]);
    tx.run(`INSERT INTO users (id, business_id, name, role, created_at, updated_at)
            VALUES (?, ?, 'Jean', 'CASHIER', ?, ?)`, [USER, BUSINESS, AT, AT]);
    for (const [id, label] of [
      [DEVICE, "Till"],
      [OTHER_DEVICE, "Phone"],
    ]) {
      tx.run(
        `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, 'ANDROID', ?, ?, ?)`,
        [id ?? "", BUSINESS, label ?? "", AT, AT, AT],
      );
    }
    tx.run(`INSERT INTO products (id, business_id, name, unit, divisible, selling_price_minor,
                                  currency, created_at, updated_at)
            VALUES (?, ?, 'Riz 5kg', 'sac', 0, 6500, 'XAF', ?, ?)`, [PRODUCT, BUSINESS, AT, AT]);
  });
}

/** Queues a sale, the ordinary thing a till does offline. */
function queueSale(eventId: string, movementId: string, thousandths = -1000): void {
  recordMovement(
    database,
    {
      id: movementId,
      businessId: BUSINESS,
      productId: PRODUCT,
      type: "SALE",
      quantity: thousandths,
      reference: { kind: "SALE", id: `sale-${movementId}` },
      userId: USER,
      deviceId: DEVICE,
      occurredAt: AT,
      recordedAt: AT,
    },
    { eventId, type: STOCK_MOVED },
  );
}

/** An event as the server would relay it from another device. */
function relayed(eventId: string, movementId: string, sequence: number): IncomingEvent {
  return {
    event_id: eventId,
    device_id: OTHER_DEVICE,
    user_id: USER,
    type: STOCK_MOVED,
    payload: {
      movements: [
        {
          id: movementId,
          product_id: PRODUCT,
          type: "SALE",
          quantity: -2000,
          reference_kind: "SALE",
          reference_id: `sale-${movementId}`,
        },
      ],
    },
    occurred_at: AT,
    sequence,
  };
}

beforeEach(() => {
  database = openDatabase();
  migrate(database);
  seed();
  transport = new FakeTransport();
});

describe("pushing what is queued", () => {
  it("sends queued events and empties the outbox", async () => {
    queueSale("event-1", "movement-1");
    queueSale("event-2", "movement-2");

    const outcome = await newEngine().sync();

    assert.equal(outcome.pushed, 2);
    assert.equal(outcome.stillPending, 0);
    assert.deepEqual(transport.sent(), ["event-1", "event-2"]);
  });

  it("sends events oldest first, since later ones can depend on earlier ones", async () => {
    for (let i = 1; i <= 5; i++) {
      queueSale(`event-${i}`, `movement-${i}`);
    }

    await newEngine().sync();

    assert.deepEqual(transport.sent(), ["event-1", "event-2", "event-3", "event-4", "event-5"]);
  });

  it("treats a duplicate as delivered, because the server has the fact", async () => {
    queueSale("event-1", "movement-1");
    transport.pushHandler = (events) => ({
      results: events.map((e) => ({ event_id: e.event_id, status: "duplicate", retry: false })),
      cursor: 1,
      accepted: 0,
      duplicates: 1,
      rejected: 0,
    });

    const outcome = await newEngine().sync();

    assert.equal(outcome.duplicates, 1);
    assert.equal(outcome.stillPending, 0);
  });

  it("sends nothing when nothing is queued", async () => {
    await newEngine().sync();
    assert.equal(transport.pushes.length, 0);
  });

  it("carries the payload the server expects, and nothing more", async () => {
    queueSale("event-1", "movement-1");

    let seen: Record<string, unknown> = {};
    transport.pushHandler = (events) => {
      const [event] = events as unknown as readonly {
        payload: { movements: Record<string, unknown>[] };
      }[];
      seen = event?.payload.movements[0] ?? {};
      return accepted(events);
    };
    await newEngine().sync();

    // The server refuses a payload carrying a field it does not know, so this
    // list is a contract, not a convenience. Identity comes from the envelope.
    assert.deepEqual(Object.keys(seen).sort(), [
      "id",
      "occurred_at",
      "product_id",
      "quantity",
      "reference_id",
      "reference_kind",
      "type",
    ]);
  });

  it("splits a backlog into batches", async () => {
    for (let i = 1; i <= 7; i++) {
      queueSale(`event-${i}`, `movement-${i}`);
    }

    const engine = new SyncEngine({
      database,
      transport: transport as never,
      businessId: BUSINESS,
      pushBatchSize: 3,
      now: () => new Date(AT),
    });
    const outcome = await engine.sync();

    assert.equal(outcome.pushed, 7);
    assert.deepEqual(
      transport.pushes.map((batch) => batch.length),
      [3, 3, 1],
    );
  });
});

describe("when the server cannot be reached", () => {
  beforeEach(() => {
    transport.pushHandler = () => {
      throw new TransportError("the server could not be reached");
    };
  });

  it("keeps every event queued", async () => {
    queueSale("event-1", "movement-1");
    queueSale("event-2", "movement-2");

    const outcome = await newEngine().sync();

    assert.equal(outcome.pushed, 0);
    assert.equal(outcome.stillPending, 2);
  });

  it("reports the failure rather than throwing it", async () => {
    queueSale("event-1", "movement-1");

    const outcome = await newEngine().sync();

    assert.match(outcome.interrupted ?? "", /could not be reached/);
  });

  it("counts the attempt, so a device can show it has been trying", async () => {
    queueSale("event-1", "movement-1");

    await newEngine().sync();
    await newEngine().sync();

    const [event] = database.transaction((tx) => pending(tx, 10));
    assert.equal(event?.attempts, 2);
    assert.match(event?.lastError ?? "", /could not be reached/);
  });

  it("still leaves the local stock alone, since the sale already happened", async () => {
    queueSale("event-1", "movement-1");

    await newEngine().sync();

    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, -1000);
  });
});

describe("when the server refuses an event", () => {
  it("sets it aside instead of retrying it forever", async () => {
    queueSale("event-1", "movement-1");
    transport.pushHandler = (events) => ({
      results: events.map((e) => ({
        event_id: e.event_id,
        status: "rejected",
        reason: "the payload is not readable",
        retry: false,
      })),
      cursor: 0,
      accepted: 0,
      duplicates: 0,
      rejected: events.length,
    });

    const outcome = await newEngine().sync();

    assert.equal(outcome.rejected, 1);
    assert.equal(outcome.stillPending, 0);

    const [refused] = database.transaction((tx) => rejected(tx));
    assert.equal(refused?.eventId, "event-1");
    assert.match(refused?.lastError ?? "", /not readable/);
  });

  it("does not let one rejection hold up the events behind it", async () => {
    queueSale("event-1", "movement-1");
    queueSale("event-2", "movement-2");
    queueSale("event-3", "movement-3");

    transport.pushHandler = (events) => ({
      results: events.map((e) => ({
        event_id: e.event_id,
        status: e.event_id === "event-2" ? "rejected" : "accepted",
        retry: false,
      })),
      cursor: 3,
      accepted: 2,
      duplicates: 0,
      rejected: 1,
    });

    const outcome = await newEngine().sync();

    assert.equal(outcome.pushed, 2);
    assert.equal(outcome.rejected, 1);
    assert.equal(outcome.stillPending, 0);
  });

  it("keeps an event the server did not settle", async () => {
    queueSale("event-1", "movement-1");
    queueSale("event-2", "movement-2");

    // No status at all: the server could not decide. Assuming it landed would
    // lose the sale.
    transport.pushHandler = (events) => ({
      results: events.map((e) => ({
        event_id: e.event_id,
        ...(e.event_id === "event-1" ? { status: "accepted" } : {}),
        retry: e.event_id !== "event-1",
      })),
      cursor: 1,
      accepted: 1,
      duplicates: 0,
      rejected: 0,
    });

    const outcome = await newEngine().sync();

    assert.equal(outcome.pushed, 1);
    assert.equal(outcome.stillPending, 1);
    const [waiting] = database.transaction((tx) => pending(tx, 10));
    assert.equal(waiting?.eventId, "event-2");
  });

  it("keeps an event the server did not mention at all", async () => {
    queueSale("event-1", "movement-1");
    queueSale("event-2", "movement-2");

    transport.pushHandler = () => ({
      results: [{ event_id: "event-1", status: "accepted", retry: false }],
      cursor: 1,
      accepted: 1,
      duplicates: 0,
      rejected: 0,
    });

    const outcome = await newEngine().sync();

    assert.equal(outcome.stillPending, 1);
  });

  it("stops rather than looping when a whole batch comes back unsettled", async () => {
    queueSale("event-1", "movement-1");
    transport.pushHandler = () => ({
      results: [],
      cursor: 0,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
    });

    const outcome = await newEngine().sync();

    assert.equal(transport.pushes.length, 1, "the engine resent a batch that settled nothing");
    assert.equal(outcome.stillPending, 1);
  });

  it("matches results by identifier, not by position", async () => {
    queueSale("event-1", "movement-1");
    queueSale("event-2", "movement-2");

    // A server answering out of order must not mark the wrong event delivered.
    transport.pushHandler = () => ({
      results: [
        { event_id: "event-2", status: "rejected", reason: "no", retry: false },
        { event_id: "event-1", status: "accepted", retry: false },
      ],
      cursor: 1,
      accepted: 1,
      duplicates: 0,
      rejected: 1,
    });

    await newEngine().sync();

    const [refused] = database.transaction((tx) => rejected(tx));
    assert.equal(refused?.eventId, "event-2");
  });
});

describe("pulling what other devices did", () => {
  it("applies a movement from another device to this device's stock", async () => {
    transport.pullHandler = (from) =>
      from === 0
        ? { events: [relayed("remote-1", "remote-movement-1", 1)], cursor: 1, has_more: false }
        : empty();

    const outcome = await newEngine().sync();

    assert.equal(outcome.received, 1);
    assert.equal(outcome.applied, 1);
    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, -2000);
  });

  it("resumes from the cursor rather than starting again", async () => {
    transport.pullHandler = (from) =>
      from === 0
        ? { events: [relayed("remote-1", "remote-movement-1", 1)], cursor: 7, has_more: false }
        : empty();

    await newEngine().sync();
    assert.equal(database.transaction((tx) => cursor(tx)), 7);

    await newEngine().sync();
    assert.deepEqual(
      transport.pulls.map((pull) => pull.cursor),
      [0, 7],
    );
  });

  it("never moves the cursor backwards", async () => {
    transport.pullHandler = (from) =>
      from === 0 ? { events: [], cursor: 9, has_more: false } : { events: [], cursor: 2, has_more: false };

    await newEngine().sync();
    await newEngine().sync();

    assert.equal(database.transaction((tx) => cursor(tx)), 9);
  });

  it("applies the same event only once, however often it arrives", async () => {
    transport.pullHandler = () => ({
      events: [relayed("remote-1", "remote-movement-1", 1)],
      cursor: 0,
      has_more: false,
    });

    await newEngine().sync();
    await newEngine().sync();
    await newEngine().sync();

    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, -2000);
  });

  it("follows has_more until the backlog is drained", async () => {
    let call = 0;
    transport.pullHandler = () => {
      call++;
      return call <= 3
        ? {
            events: [relayed(`remote-${call}`, `remote-movement-${call}`, call)],
            cursor: call,
            has_more: call < 3,
          }
        : empty();
    };

    const outcome = await newEngine().sync();

    assert.equal(outcome.received, 3);
    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, -6000);
  });

  it("stops when the server claims more but sends nothing", async () => {
    transport.pullHandler = () => ({ events: [], cursor: 1, has_more: true });

    await newEngine().sync();

    assert.equal(transport.pulls.length, 1, "the engine looped on an empty answer");
  });
});

describe("an event that cannot be applied yet", () => {
  it("is kept and retried, not dropped", async () => {
    // A movement for a product this device has never heard of, which is what a
    // till sees when the owner's phone created it while both were offline.
    const orphan: IncomingEvent = {
      ...relayed("remote-1", "remote-movement-1", 1),
      payload: {
        movements: [
          {
            id: "remote-movement-1",
            product_id: "99999999-9999-7999-8999-999999999999",
            type: "SALE",
            quantity: -2000,
            reference_kind: "SALE",
            reference_id: "sale-1",
          },
        ],
      },
    };
    transport.pullHandler = (from) =>
      from === 0 ? { events: [orphan], cursor: 1, has_more: false } : empty();

    const outcome = await newEngine().sync();

    assert.equal(outcome.received, 1);
    assert.equal(outcome.applied, 0);
    assert.equal(outcome.stillDeferred, 1, "the event was dropped instead of kept");
    // And the cursor still moved: the event is durably here, so blocking on it
    // would stall every event behind it.
    assert.equal(outcome.cursor, 1);
  });

  it("is applied once what it was waiting for arrives", async () => {
    const late = "66666666-6666-7666-8666-666666666666";
    const orphan: IncomingEvent = {
      ...relayed("remote-1", "remote-movement-1", 1),
      payload: {
        movements: [
          {
            id: "remote-movement-1",
            product_id: late,
            type: "SALE",
            quantity: -2000,
            reference_kind: "SALE",
            reference_id: "sale-1",
          },
        ],
      },
    };
    transport.pullHandler = (from) =>
      from === 0 ? { events: [orphan], cursor: 1, has_more: false } : empty();

    assert.equal((await newEngine().sync()).stillDeferred, 1);

    // The product turns up.
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO products (id, business_id, name, unit, divisible, selling_price_minor,
                               currency, created_at, updated_at)
         VALUES (?, ?, 'Sucre', 'paquet', 0, 900, 'XAF', ?, ?)`,
        [late, BUSINESS, AT, AT],
      );
    });

    const outcome = await newEngine().sync();

    assert.equal(outcome.applied, 1);
    assert.equal(outcome.stillDeferred, 0);
    assert.equal(stockOf(database, BUSINESS, late).onHandThousandths, -2000);
  });

  it("is retried even when the network is down", async () => {
    transport.pullHandler = (from) =>
      from === 0
        ? { events: [relayed("remote-1", "remote-movement-1", 1)], cursor: 1, has_more: false }
        : empty();

    // Arrive with an applier that always defers, so the event lands but waits.
    const stubborn: EventApplier = {
      types: [STOCK_MOVED],
      apply: (): void => {
        throw new Error("not yet");
      },
    };
    assert.equal((await newEngine([stubborn]).sync()).stillDeferred, 1);

    // Now the network is gone, but applying needs no network.
    transport.pullHandler = () => {
      throw new TransportError("offline");
    };
    const outcome = await newEngine().sync();

    assert.equal(outcome.applied, 1);
    assert.match(outcome.interrupted ?? "", /offline/);
  });
});

describe("an event this device cannot use", () => {
  it("is set aside when no applier knows the type", async () => {
    const future: IncomingEvent = {
      ...relayed("remote-1", "remote-movement-1", 1),
      type: "LOYALTY_POINTS_AWARDED",
    };
    transport.pullHandler = (from) =>
      from === 0 ? { events: [future], cursor: 1, has_more: false } : empty();

    const outcome = await newEngine().sync();

    assert.equal(outcome.unusable, 1);
    assert.equal(outcome.stillDeferred, 0, "an unknown type was retried forever");
    // Kept rather than deleted: it is another device's business record, and a
    // later build may understand it.
    assert.equal(database.transaction((tx) => unusable(tx)).length, 1);
  });

  it("is set aside when the payload cannot be read", async () => {
    const broken: IncomingEvent = {
      ...relayed("remote-1", "remote-movement-1", 1),
      payload: { movements: "three" },
    };
    transport.pullHandler = (from) =>
      from === 0 ? { events: [broken], cursor: 1, has_more: false } : empty();

    const outcome = await newEngine().sync();

    assert.equal(outcome.unusable, 1);
    assert.equal(outcome.stillDeferred, 0);
  });

  it("is distinguished from one that is merely waiting", async () => {
    transport.pullHandler = (from) =>
      from === 0
        ? { events: [relayed("remote-1", "remote-movement-1", 1)], cursor: 1, has_more: false }
        : empty();

    const fussy: EventApplier = {
      types: [STOCK_MOVED],
      apply: (): void => {
        throw new UnusableEvent("this will never work");
      },
    };
    const outcome = await newEngine([fussy]).sync();

    assert.equal(outcome.unusable, 1);
    assert.equal(outcome.stillDeferred, 0);
  });

  it("does not stop the events around it", async () => {
    const broken: IncomingEvent = {
      ...relayed("remote-2", "remote-movement-2", 2),
      payload: { movements: [] },
    };
    transport.pullHandler = (from) =>
      from === 0
        ? {
            events: [relayed("remote-1", "remote-movement-1", 1), broken, relayed("remote-3", "remote-movement-3", 3)],
            cursor: 3,
            has_more: false,
          }
        : empty();

    const outcome = await newEngine().sync();

    assert.equal(outcome.applied, 2);
    assert.equal(outcome.unusable, 1);
    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, -4000);
  });
});

describe("the whole round trip", () => {
  it("sends what this device did and applies what the other did", async () => {
    queueSale("event-1", "movement-1");
    transport.pullHandler = (from) =>
      from === 0
        ? { events: [relayed("remote-1", "remote-movement-1", 1)], cursor: 1, has_more: false }
        : empty();

    const outcome = await newEngine().sync();

    assert.equal(outcome.pushed, 1);
    assert.equal(outcome.applied, 1);
    // One unit sold here, two there, and the ledger holds both. Neither device
    // overwrote the other's number, because neither sent a number (§29).
    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, -3000);
  });

  it("does not resend what is already delivered", async () => {
    queueSale("event-1", "movement-1");

    await newEngine().sync();
    queueSale("event-2", "movement-2");
    await newEngine().sync();

    assert.deepEqual(transport.sent(), ["event-1", "event-2"]);
  });

  it("comes back from a movement its own device recorded", async () => {
    // The server relays an event this device sent. Its movement is already in
    // the ledger, and applying it again must not double the stock.
    queueSale("event-1", "movement-1");
    transport.pullHandler = (from) =>
      from === 0
        ? {
            events: [
              {
                ...relayed("event-1", "movement-1", 1),
                device_id: DEVICE,
                payload: {
                  movements: [
                    {
                      id: "movement-1",
                      product_id: PRODUCT,
                      type: "SALE",
                      quantity: -1000,
                      reference_kind: "SALE",
                      reference_id: "sale-movement-1",
                    },
                  ],
                },
              },
            ],
            cursor: 1,
            has_more: false,
          }
        : empty();

    await newEngine().sync();

    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, -1000);
  });
});

describe("guarding against misuse", () => {
  it("refuses to run twice at once", async () => {
    queueSale("event-1", "movement-1");

    // The first run is in flight — it has not been awaited — so the second must
    // refuse rather than push the same batch down an expensive link twice.
    const engine = newEngine();
    const first = engine.sync();
    await assert.rejects(() => engine.sync(), /already running/);
    await first;

    // And the guard releases: the engine is usable again afterwards.
    await engine.sync();
    assert.deepEqual(transport.sent(), ["event-1"]);
  });

  it("needs the business it is signed in to", () => {
    assert.throws(
      () =>
        new SyncEngine({ database, transport: transport as never, businessId: "  " }),
      /needs the business/,
    );
  });

  it("refuses a batch size that is not a positive whole number", () => {
    for (const size of [0, -1, 1.5]) {
      assert.throws(
        () =>
          new SyncEngine({
            database,
            transport: transport as never,
            businessId: BUSINESS,
            pushBatchSize: size,
          }),
        /positive whole number/,
      );
    }
  });

  it("stops after its round-trip bound rather than holding the link", async () => {
    for (let i = 1; i <= 30; i++) {
      queueSale(`event-${i}`, `movement-${i}`);
    }

    const engine = new SyncEngine({
      database,
      transport: transport as never,
      businessId: BUSINESS,
      pushBatchSize: 1,
      maxRoundTrips: 4,
      now: () => new Date(AT),
    });
    const outcome = await engine.sync();

    assert.equal(transport.pushes.length, 4);
    assert.equal(outcome.pushed, 4);
    assert.equal(outcome.stillPending, 26, "the rest must still be queued for next time");
  });
});

describe("the outbox and the ledger stay in step", () => {
  it("leaves nothing queued that the ledger does not hold", async () => {
    for (let i = 1; i <= 4; i++) {
      queueSale(`event-${i}`, `movement-${i}`);
    }

    transport.pushHandler = (events) => ({
      results: events.map((e) => ({
        event_id: e.event_id,
        status: e.event_id === "event-3" ? "rejected" : "accepted",
        retry: false,
      })),
      cursor: 4,
      accepted: 3,
      duplicates: 0,
      rejected: 1,
    });
    await newEngine().sync();

    // Whatever the server made of them, all four sales happened on this device
    // and all four are in its ledger. A rejection is a sync problem, never a
    // reason to unmake a sale (ADR-009).
    assert.equal(stockOf(database, BUSINESS, PRODUCT).onHandThousandths, -4000);
    assert.equal(database.transaction((tx) => pendingCount(tx)), 0);
    assert.equal(database.transaction((tx) => rejected(tx)).length, 1);
    assert.equal(database.transaction((tx) => deferredCount(tx)), 0);
  });
});

describe("products arriving with the stock that needs them", () => {
  const LATE_PRODUCT = "66666666-6666-7666-8666-666666666666";

  /** A product event as another device would send it. */
  function productEvent(sequence: number, price = 900): IncomingEvent {
    return {
      event_id: `product-event-${sequence}`,
      device_id: OTHER_DEVICE,
      user_id: USER,
      type: PRODUCT_SAVED,
      payload: {
        product: {
          id: LATE_PRODUCT,
          name: "Sucre 1kg",
          unit: "paquet",
          selling_price_minor: price,
          created_at: "2026-08-01T08:00:00.000Z",
          updated_at: AT,
        },
      },
      occurred_at: AT,
      sequence,
    };
  }

  /** A sale of the product above, which cannot apply until it exists here. */
  function saleOfLateProduct(sequence: number): IncomingEvent {
    return {
      ...relayed(`sale-event-${sequence}`, `sale-movement-${sequence}`, sequence),
      payload: {
        movements: [
          {
            id: `sale-movement-${sequence}`,
            product_id: LATE_PRODUCT,
            type: "SALE",
            quantity: -2000,
            reference_kind: "SALE",
            reference_id: `sale-${sequence}`,
          },
        ],
      },
    };
  }

  it("applies a product from another device", async () => {
    transport.pullHandler = (from) =>
      from === 0 ? { events: [productEvent(1)], cursor: 1, has_more: false } : empty();

    const outcome = await newEngine().sync();

    assert.equal(outcome.applied, 1);
    const stored = database.transaction((tx) => productOf(tx, BUSINESS, LATE_PRODUCT));
    assert.equal(stored?.sellingPriceMinor, 900);
    // The editing device comes from the envelope, which is what breaks a tie.
    assert.equal(stored?.updatedByDevice, OTHER_DEVICE);
  });

  it("unblocks a sale that arrived before its product", async () => {
    // The sale comes first, which is the ordering that made the inbox
    // necessary: the server relays events as it learned of them, and the till
    // sold something the owner's phone had only just created.
    transport.pullHandler = (from) =>
      from === 0 ? { events: [saleOfLateProduct(1)], cursor: 1, has_more: false } : empty();

    const first = await newEngine().sync();
    assert.equal(first.applied, 0);
    assert.equal(first.stillDeferred, 1);

    // Now the product turns up on a later sync.
    transport.pullHandler = (from) =>
      from === 1 ? { events: [productEvent(2)], cursor: 2, has_more: false } : empty();

    const second = await newEngine().sync();

    assert.equal(second.applied, 2, "the product and the sale waiting on it");
    assert.equal(second.stillDeferred, 0);
    assert.equal(stockOf(database, BUSINESS, LATE_PRODUCT).onHandThousandths, -2000);
  });

  it("applies both in one sync when they arrive together, product first", async () => {
    transport.pullHandler = (from) =>
      from === 0
        ? { events: [productEvent(1), saleOfLateProduct(2)], cursor: 2, has_more: false }
        : empty();

    const outcome = await newEngine().sync();

    assert.equal(outcome.applied, 2);
    assert.equal(outcome.stillDeferred, 0);
  });

  it("keeps the newer edit when two devices edited the same product", async () => {
    const earlier = "2026-08-14T09:00:00.000Z";
    const later = "2026-08-14T17:00:00.000Z";

    transport.pullHandler = (from) =>
      from === 0
        ? {
            events: [
              { ...productEvent(1, 7000), payload: withUpdatedAt(productEvent(1, 7000), later) },
              { ...productEvent(2, 6500), payload: withUpdatedAt(productEvent(2, 6500), earlier) },
            ],
            cursor: 2,
            has_more: false,
          }
        : empty();

    await newEngine().sync();

    // The older edit arrived last and must not win, or two devices syncing in
    // different orders would hold different prices (ADR-015).
    const stored = database.transaction((tx) => productOf(tx, BUSINESS, LATE_PRODUCT));
    assert.equal(stored?.sellingPriceMinor, 7000);
  });

  it("does not defer a product edit that merely lost", async () => {
    const earlier = "2026-08-14T09:00:00.000Z";
    transport.pullHandler = (from) =>
      from === 0
        ? {
            events: [
              productEvent(1, 7000),
              { ...productEvent(2, 6500), payload: withUpdatedAt(productEvent(2, 6500), earlier) },
            ],
            cursor: 2,
            has_more: false,
          }
        : empty();

    const outcome = await newEngine().sync();

    // A losing edit is fully handled: the device already holds a later one.
    // Deferring it would leave it retrying forever.
    assert.equal(outcome.applied, 2);
    assert.equal(outcome.stillDeferred, 0);
  });
});

/** Rewrites a product event's updated_at, leaving everything else alone. */
function withUpdatedAt(event: IncomingEvent, at: string): unknown {
  const payload = event.payload as { product: Record<string, unknown> };
  return { product: { ...payload.product, updated_at: at } };
}
