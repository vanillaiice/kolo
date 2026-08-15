/**
 * The sync engine: drains the outbox to the server and the inbox into the
 * device's own tables.
 *
 * Everything here is built around one assumption from §45 — the network is
 * slow, expensive, and usually absent. Sync failing is the normal case, not the
 * exception, and nothing in the app may depend on it having succeeded. So this
 * engine has no way to report "sync is required", only "here is what happened
 * this time".
 *
 * The rules it enforces:
 *
 *   - An event leaves the outbox only when the server says it has it. Anything
 *     else — a timeout, a 500, a lost response — leaves it queued.
 *   - An event the server will never accept is set aside, not retried forever,
 *     because retrying it blocks everything behind it.
 *   - An event that arrives is stored before it is applied, so a pull can move
 *     on past something this device is not yet ready for.
 *   - Every state change happens in a transaction with the effect it describes.
 */

import type { Database, Queryable } from "../database/driver.ts";
import {
  DEFAULT_BATCH_SIZE,
  markAttemptFailed,
  markDelivered,
  markRejected,
  pending,
  pendingCount,
  type OutboxEvent,
} from "./outbox.ts";
import {
  advanceCursor,
  cursor,
  deferred,
  deferredCount,
  markApplied,
  markDeferred,
  markUnusable,
  receive,
  type InboxEvent,
} from "./inbox.ts";
import type { OutgoingEvent, SyncTransport } from "./transport.ts";
import { TransportError } from "./transport.ts";

/** What one applier can do with a received event. */
export interface EventApplier {
  /** The event types this applier handles. */
  readonly types: readonly string[];
  /**
   * Applies one event inside the caller's transaction.
   *
   * Throwing defers the event for a later attempt, which is right for something
   * that may yet succeed — a movement whose product has not arrived. Throwing
   * {@link UnusableEvent} sets it aside permanently instead.
   */
  apply(tx: Queryable, event: InboxEvent): void;
}

/**
 * Thrown by an applier for an event that will never apply, however long it
 * waits — a payload it cannot read, a shape it does not recognise.
 */
export class UnusableEvent extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnusableEvent";
  }
}

/** What a sync run did. */
export interface SyncOutcome {
  readonly pushed: number;
  readonly duplicates: number;
  readonly rejected: number;
  /** Events still queued: either not tried this run, or tried and not settled. */
  readonly stillPending: number;
  readonly received: number;
  readonly applied: number;
  /** Received events waiting on something before they can be applied. */
  readonly stillDeferred: number;
  readonly unusable: number;
  readonly cursor: number;
  /**
   * Why the run stopped early, if it did. A run that could not reach the server
   * is a normal outcome, reported rather than thrown.
   */
  readonly interrupted: string | null;
}

/** How the engine is set up. */
export interface EngineOptions {
  readonly database: Database;
  readonly transport: SyncTransport;
  /**
   * The business this device is signed in to.
   *
   * The server does not put it on each pulled event, because a device is
   * authenticated for exactly one business and every event in the answer
   * belongs to it. It is recorded on each row anyway, so the table is
   * self-describing to anyone reading it directly.
   */
  readonly businessId: string;
  /** Appliers for the event types this build understands. */
  readonly appliers?: readonly EventApplier[];
  /** Events per push. Defaults to {@link DEFAULT_BATCH_SIZE}. */
  readonly pushBatchSize?: number;
  /** Events per pull. */
  readonly pullBatchSize?: number;
  /**
   * A bound on how many round trips one run may make, so a device with a large
   * backlog yields rather than holding the link indefinitely.
   */
  readonly maxRoundTrips?: number;
  /** The clock, injectable so tests are not timing-dependent. */
  readonly now?: () => Date;
}

/** How many events one pull asks for by default. */
export const DEFAULT_PULL_BATCH_SIZE = 200;

/** How many round trips one run makes before yielding. */
export const DEFAULT_MAX_ROUND_TRIPS = 20;

/**
 * Drains the outbox and the inbox.
 *
 * One engine per database. `sync()` is not safe to run concurrently with itself
 * — see the guard in {@link SyncEngine.sync}.
 */
export class SyncEngine {
  readonly #database: Database;
  readonly #transport: SyncTransport;
  readonly #businessId: string;
  readonly #appliers: Map<string, EventApplier>;
  readonly #pushBatchSize: number;
  readonly #pullBatchSize: number;
  readonly #maxRoundTrips: number;
  readonly #now: () => Date;
  #running = false;

  constructor(options: EngineOptions) {
    if (options.businessId.trim() === "") {
      throw new Error("a sync engine needs the business it is signed in to");
    }
    this.#database = options.database;
    this.#transport = options.transport;
    this.#businessId = options.businessId;
    this.#pushBatchSize = positive(options.pushBatchSize, DEFAULT_BATCH_SIZE, "pushBatchSize");
    this.#pullBatchSize = positive(options.pullBatchSize, DEFAULT_PULL_BATCH_SIZE, "pullBatchSize");
    this.#maxRoundTrips = positive(options.maxRoundTrips, DEFAULT_MAX_ROUND_TRIPS, "maxRoundTrips");
    this.#now = options.now ?? ((): Date => new Date());

    this.#appliers = new Map();
    for (const applier of options.appliers ?? []) {
      for (const type of applier.types) {
        this.#appliers.set(type, applier);
      }
    }
  }

  /**
   * Sends what is queued and applies what has arrived.
   *
   * It does not throw for an unreachable server. Losing the network is ordinary
   * here, and a caller that had to catch it would end up treating the ordinary
   * case as an error.
   */
  async sync(): Promise<SyncOutcome> {
    // Two runs at once would push the same batch twice. The server would
    // deduplicate, so nothing would be applied twice, but the device would
    // spend a scarce, expensive link sending what it had already sent.
    if (this.#running) {
      throw new Error("a sync is already running");
    }
    this.#running = true;
    try {
      return await this.#run();
    } finally {
      this.#running = false;
    }
  }

  async #run(): Promise<SyncOutcome> {
    const tally = {
      pushed: 0,
      duplicates: 0,
      rejected: 0,
      received: 0,
      applied: 0,
      unusable: 0,
    };
    let interrupted: string | null = null;

    try {
      await this.#drainOutbox(tally);
      await this.#drainInbox(tally);
    } catch (error) {
      if (!(error instanceof TransportError)) {
        throw error;
      }
      interrupted = error.message;
    }

    // Applying is always attempted, even when the network failed: events
    // received on an earlier run may be applicable now, and that needs no
    // server at all.
    this.#applyDeferred(tally);

    return {
      ...tally,
      stillPending: this.#database.transaction((tx) => pendingCount(tx)),
      stillDeferred: this.#database.transaction((tx) => deferredCount(tx)),
      cursor: this.#database.transaction((tx) => cursor(tx)),
      interrupted,
    };
  }

  /** Sends queued events until none are left or nothing more can be settled. */
  async #drainOutbox(tally: Tally): Promise<void> {
    for (let trip = 0; trip < this.#maxRoundTrips; trip++) {
      const batch = this.#database.transaction((tx) => pending(tx, this.#pushBatchSize));
      if (batch.length === 0) {
        return;
      }

      let result;
      try {
        result = await this.#transport.push(batch.map(toOutgoing));
      } catch (error) {
        // Nothing was settled. The events stay pending; only the attempt count
        // moves, so a device can show that it has been trying.
        const reason = error instanceof Error ? error.message : String(error);
        this.#database.transaction((tx) => {
          markAttemptFailed(tx, batch.map(idOf), reason);
        });
        throw error;
      }

      const settled = this.#settle(batch, result.results, tally);

      // No progress means every event in this batch came back unsettled. Sending
      // the same batch again would loop, so the run yields and tries later.
      if (settled === 0) {
        return;
      }
    }
  }

  /**
   * Records what the server said about each event, in one transaction.
   *
   * Results are matched by identifier rather than by position. The server
   * echoes the identifier back, and matching on it means a reordered or partial
   * list cannot mark the wrong event delivered — which would lose it silently.
   */
  #settle(
    batch: readonly OutboxEvent[],
    results: readonly { event_id: string; status?: string; reason?: string }[],
    tally: Tally,
  ): number {
    const byId = new Map(results.map((result) => [result.event_id, result]));
    const at = this.#timestamp();

    return this.#database.transaction((tx) => {
      const delivered: string[] = [];
      const unsettled: string[] = [];
      let settled = 0;

      for (const event of batch) {
        const result = byId.get(event.eventId);
        switch (result?.status) {
          case "accepted":
            delivered.push(event.eventId);
            tally.pushed++;
            settled++;
            break;

          case "duplicate":
            // The server already had it, which is a success: the business fact
            // reached it, whatever happened to the response that said so.
            delivered.push(event.eventId);
            tally.duplicates++;
            settled++;
            break;

          case "rejected":
            // The server will refuse this every time. Retrying would block the
            // queue behind it, so it is set aside for someone to look at — the
            // business record it carries still exists on this device.
            markRejected(tx, event.eventId, result.reason ?? "the server rejected this event");
            tally.rejected++;
            settled++;
            break;

          default:
            // No status, or no result at all: the server did not settle this
            // one. It stays pending. An event the server simply did not mention
            // is treated the same way, since assuming it landed would lose it.
            unsettled.push(event.eventId);
            break;
        }
      }

      markDelivered(tx, delivered, at);
      markAttemptFailed(tx, unsettled, "the server did not settle this event");
      return settled;
    });
  }

  /** Fetches events from other devices until there are no more. */
  async #drainInbox(tally: Tally): Promise<void> {
    for (let trip = 0; trip < this.#maxRoundTrips; trip++) {
      const from = this.#database.transaction((tx) => cursor(tx));
      const result = await this.#transport.pull(from, this.#pullBatchSize);
      const at = this.#timestamp();

      // Storing the events and advancing the cursor happen together. Advancing
      // past an event that was not stored would lose it permanently, and there
      // is no way to ask for it again.
      this.#database.transaction((tx) => {
        for (const event of result.events) {
          const isNew = receive(
            tx,
            {
              eventId: event.event_id,
              businessId: this.#businessId,
              deviceId: event.device_id,
              userId: event.user_id,
              type: event.type,
              payload: event.payload,
              occurredAt: event.occurred_at,
              serverSequence: event.sequence,
            },
            at,
          );
          if (isNew) {
            tally.received++;
          }
        }
        advanceCursor(tx, result.cursor, at);
      });

      // A server that says there is more but sends nothing would loop forever.
      if (!result.has_more || result.events.length === 0) {
        return;
      }
    }
  }

  /**
   * Applies received events to this device's tables.
   *
   * Each event is applied in its own transaction, so one that cannot be applied
   * does not roll back the ones before it. An event that fails is left deferred
   * and tried again, which is what makes it safe for events to arrive before
   * what they depend on.
   */
  #applyDeferred(tally: Tally): void {
    // Repeated passes, not one. Events are applied in the order the server
    // learned of them, and that order does not respect dependencies: a sale can
    // sit ahead of the product it needs in the very same batch. One pass would
    // try the sale, fail, apply the product, and leave the sale waiting for a
    // whole extra sync — on a link that may not come back for days (§45).
    //
    // Each pass either applies something or changes nothing, so this terminates:
    // the bound is the number of deferred events, and in practice it is two.
    for (;;) {
      const applied = this.#applyPass(tally);
      if (applied === 0) {
        return;
      }
    }
  }

  /** One attempt at every deferred event. Returns how many landed. */
  #applyPass(tally: Tally): number {
    // A bound rather than everything: applying is synchronous, and a device
    // with thousands of deferred events must not freeze the interface.
    const batch = this.#database.transaction((tx) =>
      deferred(tx, this.#pullBatchSize * this.#maxRoundTrips),
    );
    let applied = 0;

    for (const event of batch) {
      const applier = this.#appliers.get(event.type);
      const at = this.#timestamp();

      if (applier === undefined) {
        // An event type this build does not know. It is kept: the server
        // relays events from newer clients on purpose, and a later build may
        // understand this one.
        this.#database.transaction((tx) => {
          markUnusable(tx, event.eventId, `this build cannot apply a ${event.type} event`);
        });
        tally.unusable++;
        continue;
      }

      try {
        this.#database.transaction((tx) => {
          applier.apply(tx, event);
          markApplied(tx, event.eventId, at);
        });
        tally.applied++;
        applied++;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof UnusableEvent) {
          this.#database.transaction((tx) => {
            markUnusable(tx, event.eventId, reason);
          });
          tally.unusable++;
        } else {
          this.#database.transaction((tx) => {
            markDeferred(tx, event.eventId, reason);
          });
        }
      }
    }
    return applied;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

interface Tally {
  pushed: number;
  duplicates: number;
  rejected: number;
  received: number;
  applied: number;
  unusable: number;
}

function toOutgoing(event: OutboxEvent): OutgoingEvent {
  return {
    event_id: event.eventId,
    user_id: event.userId,
    type: event.type,
    payload: event.payload,
    occurred_at: event.occurredAt,
    sequence: event.sequence,
  };
}

function idOf(event: OutboxEvent): string {
  return event.eventId;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number, got ${value}`);
  }
  return value;
}
