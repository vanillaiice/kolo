import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Database } from "../database/driver.ts";
import { migrate } from "../database/migrations.ts";
import { openDatabase } from "../database/node-sqlite.ts";
import {
  enqueue,
  markAttemptFailed,
  markDelivered,
  markRejected,
  OutboxError,
  pending,
  pendingCount,
  pruneDelivered,
  rejected,
  type NewEvent,
} from "./outbox.ts";

let database: Database;

beforeEach(() => {
  database = openDatabase();
  migrate(database);
  seedTenant(database);
});

afterEach(() => {
  database.close();
});

const BUSINESS = "11111111-1111-7111-8111-111111111111";
const USER = "22222222-2222-7222-8222-222222222222";
const DEVICE = "33333333-3333-7333-8333-333333333333";

let counter = 0;

function newEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  counter += 1;
  return {
    eventId: `event-${counter}`,
    businessId: BUSINESS,
    userId: USER,
    deviceId: DEVICE,
    type: "SALE_COMPLETED",
    payload: { total: 18_500, currency: "XAF" },
    occurredAt: "2026-08-14T09:30:00.000Z",
    ...overrides,
  };
}

/** Inserts the rows the outbox's foreign keys and tests depend on. */
function seedTenant(db: Database): void {
  db.transaction((tx) => {
    tx.run(
      `INSERT INTO businesses (id, name, currency, created_at, updated_at)
       VALUES (?, 'Boutique Chez Jean', 'XAF', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z')`,
      [BUSINESS],
    );
    tx.run(
      `INSERT INTO users (id, business_id, name, role, created_at, updated_at)
       VALUES (?, ?, 'Jean Mbarga', 'CASHIER', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z')`,
      [USER, BUSINESS],
    );
    tx.run(
      `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'Till 1', 'ANDROID',
               '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z')`,
      [DEVICE, BUSINESS],
    );
  });
}

describe("queueing an event", () => {
  it("stores it as pending", () => {
    const queued = database.transaction((tx) => enqueue(tx, newEvent()));

    assert.equal(queued.state, "pending");
    assert.equal(queued.attempts, 0);
    assert.equal(queued.deliveredAt, null);
    assert.equal(pendingCount(database), 1);
  });

  it("keeps the payload intact", () => {
    const payload = {
      total: 18_500,
      lines: [{ product: "abc", quantity: 3 }],
      note: "Chez Jean — 15% remise",
      credit: null,
    };
    database.transaction((tx) => enqueue(tx, newEvent({ payload })));

    const [waiting] = pending(database, 10);
    assert.deepEqual(waiting?.payload, payload);
  });

  it("hands out sequence numbers in order", () => {
    database.transaction((tx) => {
      enqueue(tx, newEvent({ eventId: "first" }));
      enqueue(tx, newEvent({ eventId: "second" }));
      enqueue(tx, newEvent({ eventId: "third" }));
    });

    const waiting = pending(database, 10);
    assert.deepEqual(
      waiting.map((event) => event.eventId),
      ["first", "second", "third"],
    );
    assert.ok(
      waiting[0]!.sequence < waiting[1]!.sequence && waiting[1]!.sequence < waiting[2]!.sequence,
      "sequence numbers should increase",
    );
  });

  it("refuses an event that is missing something", () => {
    const missing: ReadonlyArray<Partial<NewEvent>> = [
      { eventId: "" },
      { businessId: "" },
      { userId: "" },
      { deviceId: "" },
      { type: "" },
      { type: "   " },
      { occurredAt: "" },
    ];
    for (const override of missing) {
      assert.throws(
        () => database.transaction((tx) => enqueue(tx, newEvent(override))),
        OutboxError,
        `expected ${JSON.stringify(override)} to be refused`,
      );
    }
  });

  it("refuses a payload that cannot be encoded", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    assert.throws(
      () => database.transaction((tx) => enqueue(tx, newEvent({ payload: circular }))),
      OutboxError,
    );
  });

  it("refuses the same event twice", () => {
    database.transaction((tx) => enqueue(tx, newEvent({ eventId: "duplicate" })));

    assert.throws(() =>
      database.transaction((tx) => enqueue(tx, newEvent({ eventId: "duplicate" }))),
    );
    assert.equal(pendingCount(database), 1);
  });
});

/**
 * This is the reason the outbox exists. A sale a device can see and the server
 * never will is silent, permanent data loss — and nothing afterwards can detect
 * it, because from the device's side the sale looks complete (ADR-014).
 */
describe("a business write and its event", () => {
  it("commit together", () => {
    database.transaction((tx) => {
      tx.run(
        `INSERT INTO branches (id, business_id, name, created_at, updated_at)
         VALUES ('branch-1', ?, 'Marché Central', '2026-08-14T09:30:00.000Z', '2026-08-14T09:30:00.000Z')`,
        [BUSINESS],
      );
      enqueue(tx, newEvent({ eventId: "branch-created", type: "BRANCH_CREATED" }));
    });

    assert.ok(database.get(`SELECT id FROM branches WHERE id = 'branch-1'`), "the branch was not stored");
    assert.equal(pendingCount(database), 1);
  });

  it("roll back together when the business write fails", () => {
    assert.throws(() =>
      database.transaction((tx) => {
        enqueue(tx, newEvent({ eventId: "doomed" }));
        // A branch of a business that does not exist: the foreign key rejects
        // it, after the event has already been appended.
        tx.run(
          `INSERT INTO branches (id, business_id, name, created_at, updated_at)
           VALUES ('branch-2', 'no-such-business', 'Nowhere',
                   '2026-08-14T09:30:00.000Z', '2026-08-14T09:30:00.000Z')`,
        );
      }),
    );

    assert.equal(pendingCount(database), 0, "the event outlived the write it described");
    assert.equal(database.get(`SELECT id FROM branches WHERE id = 'branch-2'`), undefined);
  });

  it("roll back together when the event fails", () => {
    assert.throws(() =>
      database.transaction((tx) => {
        tx.run(
          `INSERT INTO branches (id, business_id, name, created_at, updated_at)
           VALUES ('branch-3', ?, 'Marché Mokolo', '2026-08-14T09:30:00.000Z', '2026-08-14T09:30:00.000Z')`,
          [BUSINESS],
        );
        enqueue(tx, newEvent({ eventId: "" }));
      }),
    );

    assert.equal(
      database.get(`SELECT id FROM branches WHERE id = 'branch-3'`),
      undefined,
      "the write survived without an event to carry it to the server",
    );
    assert.equal(pendingCount(database), 0);
  });

  it("leave the sequence unspent when they roll back", () => {
    assert.throws(() =>
      database.transaction((tx) => {
        enqueue(tx, newEvent({ eventId: "rolled-back" }));
        throw new Error("the operation failed after queueing");
      }),
    );

    const queued = database.transaction((tx) => enqueue(tx, newEvent({ eventId: "kept" })));
    assert.equal(queued.sequence, 1, "a rolled-back event consumed a sequence number");
  });
});

describe("draining the outbox", () => {
  it("returns the oldest events first, up to the batch size", () => {
    database.transaction((tx) => {
      for (let index = 0; index < 5; index += 1) {
        enqueue(tx, newEvent({ eventId: `event-${index}` }));
      }
    });

    const batch = pending(database, 3);
    assert.equal(batch.length, 3);
    assert.deepEqual(
      batch.map((event) => event.eventId),
      ["event-0", "event-1", "event-2"],
    );
  });

  it("refuses a batch size that is not a positive whole number", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => pending(database, limit), OutboxError, `limit ${limit} should be refused`);
    }
  });

  it("stops returning an event once it is delivered", () => {
    database.transaction((tx) => {
      enqueue(tx, newEvent({ eventId: "sent" }));
      enqueue(tx, newEvent({ eventId: "waiting" }));
    });

    const changed = database.transaction((tx) =>
      markDelivered(tx, ["sent"], "2026-08-14T10:00:00.000Z"),
    );
    assert.equal(changed, 1);

    const waiting = pending(database, 10);
    assert.deepEqual(
      waiting.map((event) => event.eventId),
      ["waiting"],
    );
  });

  /**
   * A push whose response was lost is retried, and the server — being
   * idempotent — acknowledges the same events again. That must not be an error.
   */
  it("tolerates acknowledging the same event twice", () => {
    database.transaction((tx) => enqueue(tx, newEvent({ eventId: "sent" })));

    const first = database.transaction((tx) =>
      markDelivered(tx, ["sent"], "2026-08-14T10:00:00.000Z"),
    );
    const second = database.transaction((tx) =>
      markDelivered(tx, ["sent"], "2026-08-14T11:00:00.000Z"),
    );

    assert.equal(first, 1);
    assert.equal(second, 0, "the second acknowledgement changed something");

    // And the recorded time stays the first one, so it says when the event
    // actually reached the server.
    const row = database.get(`SELECT delivered_at FROM sync_outbox WHERE event_id = 'sent'`);
    assert.equal(row?.["delivered_at"], "2026-08-14T10:00:00.000Z");
  });

  it("acknowledging nothing is not an error", () => {
    assert.equal(
      database.transaction((tx) => markDelivered(tx, [], "2026-08-14T10:00:00.000Z")),
      0,
    );
  });
});

describe("when a push fails", () => {
  /**
   * A transport failure is not the event's fault, and dropping it would lose
   * the business record it carries.
   */
  it("leaves the event pending and counts the attempt", () => {
    database.transaction((tx) => enqueue(tx, newEvent({ eventId: "retry-me" })));

    database.transaction((tx) => markAttemptFailed(tx, ["retry-me"], "network unreachable"));
    database.transaction((tx) => markAttemptFailed(tx, ["retry-me"], "network unreachable"));

    const [waiting] = pending(database, 10);
    assert.equal(waiting?.eventId, "retry-me");
    assert.equal(waiting?.attempts, 2);
    assert.equal(waiting?.lastError, "network unreachable");
  });

  it("keeps a runaway error message from filling storage", () => {
    database.transaction((tx) => enqueue(tx, newEvent({ eventId: "verbose" })));

    const enormous = "x".repeat(10_000);
    database.transaction((tx) => markAttemptFailed(tx, ["verbose"], enormous));

    const [waiting] = pending(database, 10);
    assert.ok(
      (waiting?.lastError?.length ?? 0) < 600,
      `the stored error is ${waiting?.lastError?.length} characters`,
    );
  });

  it("does not resurrect a delivered event", () => {
    database.transaction((tx) => enqueue(tx, newEvent({ eventId: "done" })));
    database.transaction((tx) => markDelivered(tx, ["done"], "2026-08-14T10:00:00.000Z"));

    const changed = database.transaction((tx) => markAttemptFailed(tx, ["done"], "late failure"));
    assert.equal(changed, 0);
    assert.equal(pendingCount(database), 0);
  });
});

/**
 * A rejection the server will repeat however often it is retried must not block
 * everything queued behind it — but the business record it carries still exists
 * on this device, so it is set aside and surfaced rather than dropped.
 */
describe("when the server refuses an event outright", () => {
  it("sets it aside and lets the rest drain", () => {
    database.transaction((tx) => {
      enqueue(tx, newEvent({ eventId: "malformed" }));
      enqueue(tx, newEvent({ eventId: "fine" }));
    });

    const wasRejected = database.transaction((tx) =>
      markRejected(tx, "malformed", "unknown event type"),
    );
    assert.equal(wasRejected, true);

    const waiting = pending(database, 10);
    assert.deepEqual(
      waiting.map((event) => event.eventId),
      ["fine"],
      "a rejected event is still blocking the queue",
    );

    const setAside = rejected(database);
    assert.equal(setAside.length, 1);
    assert.equal(setAside[0]?.eventId, "malformed");
    assert.equal(setAside[0]?.lastError, "unknown event type");
  });

  it("does not reject an event that already went", () => {
    database.transaction((tx) => enqueue(tx, newEvent({ eventId: "done" })));
    database.transaction((tx) => markDelivered(tx, ["done"], "2026-08-14T10:00:00.000Z"));

    assert.equal(
      database.transaction((tx) => markRejected(tx, "done", "too late")),
      false,
    );
  });
});

describe("pruning", () => {
  it("removes delivered events past the cutoff and nothing else", () => {
    database.transaction((tx) => {
      enqueue(tx, newEvent({ eventId: "old" }));
      enqueue(tx, newEvent({ eventId: "recent" }));
      enqueue(tx, newEvent({ eventId: "waiting" }));
      enqueue(tx, newEvent({ eventId: "refused" }));
    });
    database.transaction((tx) => {
      markDelivered(tx, ["old"], "2026-08-01T00:00:00.000Z");
      markDelivered(tx, ["recent"], "2026-08-14T00:00:00.000Z");
      markRejected(tx, "refused", "unknown event type");
    });

    const removed = database.transaction((tx) => pruneDelivered(tx, "2026-08-10T00:00:00.000Z"));
    assert.equal(removed, 1);

    const remaining = database
      .all(`SELECT event_id FROM sync_outbox ORDER BY sequence`)
      .map((row) => row["event_id"]);
    assert.deepEqual(
      remaining,
      ["recent", "waiting", "refused"],
      "pruning took something it should have kept",
    );
  });

  /**
   * Sequence numbers come from a counter rather than a rowid precisely so that
   * pruning cannot make a new event look older than one already sent.
   */
  it("does not let a later event reuse a pruned sequence number", () => {
    const first = database.transaction((tx) => enqueue(tx, newEvent({ eventId: "first" })));
    database.transaction((tx) => markDelivered(tx, ["first"], "2026-08-01T00:00:00.000Z"));
    database.transaction((tx) => pruneDelivered(tx, "2026-08-10T00:00:00.000Z"));

    const next = database.transaction((tx) => enqueue(tx, newEvent({ eventId: "next" })));
    assert.ok(
      next.sequence > first.sequence,
      `the new event took sequence ${next.sequence}, at or below the pruned ${first.sequence}`,
    );
  });
});

describe("the outbox as a whole", () => {
  /**
   * A device back from a week offline sends its backlog in pieces that can each
   * succeed, rather than one push that fails as a unit (§45).
   */
  it("drains a backlog in batches", () => {
    const total = 250;
    database.transaction((tx) => {
      for (let index = 0; index < total; index += 1) {
        enqueue(tx, newEvent({ eventId: `backlog-${index}` }));
      }
    });

    let drained = 0;
    let batches = 0;
    for (;;) {
      const batch = pending(database, 100);
      if (batch.length === 0) {
        break;
      }
      batches += 1;
      database.transaction((tx) =>
        markDelivered(
          tx,
          batch.map((event) => event.eventId),
          "2026-08-14T10:00:00.000Z",
        ),
      );
      drained += batch.length;
    }

    assert.equal(drained, total);
    assert.equal(batches, 3);
    assert.equal(pendingCount(database), 0);
  });
});
