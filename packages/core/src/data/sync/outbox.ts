import { captureOutboxEvent } from "../exchange/journal.ts";
/**
 * The queue of events waiting to reach the server.
 *
 * The one rule this file exists to enforce: an event is appended in the same
 * transaction as the business rows it describes (ADR-014). A sale that a device
 * can see and the server never will is a silent, permanent data loss, and the
 * only way to make it impossible is to write both or neither.
 *
 * The sync engine transports what is here. It does not construct it — an event
 * is built by the code that performed the business operation, because only that
 * code knows what happened.
 */

import type { Queryable, Row, SqlValue } from "../database/driver.ts";

/** An event waiting to be sent, or already sent. */
export interface OutboxEvent {
  readonly eventId: string;
  readonly businessId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly type: string;
  readonly payload: unknown;
  /** When the business event happened, not when it was queued. */
  readonly occurredAt: string;
  readonly sequence: number;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly deliveredAt: string | null;
}

/** How far along an event is. */
export type DeliveryState = "pending" | "delivered" | "rejected";

/** What the caller supplies when queueing an event. */
export interface NewEvent {
  readonly eventId: string;
  readonly businessId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: string;
}

/** Raised when an event cannot be queued or read. */
export class OutboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OutboxError";
  }
}

/**
 * Appends an event to the outbox.
 *
 * It takes a {@link Queryable} rather than a Database precisely so it cannot be
 * called on its own: the caller must already be inside the transaction that is
 * writing the business rows. That is the whole point (see ADR-014).
 */
export function enqueue(tx: Queryable, event: NewEvent): OutboxEvent {
  validate(event);

  const sequence = nextSequence(tx);
  const payload = encodePayload(event.payload);

  tx.run(
    `INSERT INTO sync_outbox
       (event_id, business_id, user_id, device_id, type, payload, occurred_at, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.eventId,
      event.businessId,
      event.userId,
      event.deviceId,
      event.type,
      payload,
      event.occurredAt,
      sequence,
    ],
  );

  captureOutboxEvent(tx, event);

  return {
    ...event,
    sequence,
    state: "pending",
    attempts: 0,
    lastError: null,
    deliveredAt: null,
  };
}

/**
 * Returns the events waiting to be sent, oldest first, up to a limit.
 *
 * The limit is what makes a push a batch rather than everything a device has
 * accumulated. §45 assumes slow, expensive links, and a device back from a week
 * offline should send its backlog in pieces that can each succeed.
 */
export function pending(tx: Queryable, limit: number): OutboxEvent[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new OutboxError(`a batch must be a positive whole number, got ${limit}`);
  }

  const rows = tx.all(
    `SELECT event_id, business_id, user_id, device_id, type, payload,
            occurred_at, sequence, state, attempts, last_error, delivered_at
       FROM sync_outbox
      WHERE state = 'pending'
      ORDER BY sequence
      LIMIT ?`,
    [limit],
  );
  return rows.map(toEvent);
}

/** How many events are still waiting. */
export function pendingCount(tx: Queryable): number {
  const row = tx.get(`SELECT COUNT(*) AS waiting FROM sync_outbox WHERE state = 'pending'`);
  const waiting = row?.["waiting"];
  return typeof waiting === "number" ? waiting : 0;
}

/**
 * Marks events the server acknowledged.
 *
 * Acknowledging an event that is already delivered is not an error: a push
 * whose response was lost is retried, and the server, being idempotent
 * (ADR-006), acknowledges it again.
 */
export function markDelivered(tx: Queryable, eventIds: readonly string[], at: string): number {
  if (eventIds.length === 0) {
    return 0;
  }

  let changed = 0;
  for (const eventId of eventIds) {
    const result = tx.run(
      `UPDATE sync_outbox
          SET state = 'delivered', delivered_at = ?, last_error = NULL
        WHERE event_id = ? AND state <> 'delivered'`,
      [at, eventId],
    );
    changed += result.changes;
  }
  return changed;
}

/**
 * Records that an attempt failed, leaving the event pending so it is tried
 * again.
 *
 * A transport failure is not the event's fault, and dropping it would lose the
 * business record it carries.
 */
export function markAttemptFailed(tx: Queryable, eventIds: readonly string[], reason: string): number {
  let changed = 0;
  for (const eventId of eventIds) {
    const result = tx.run(
      `UPDATE sync_outbox
          SET attempts = attempts + 1, last_error = ?
        WHERE event_id = ? AND state = 'pending'`,
      [truncate(reason), eventId],
    );
    changed += result.changes;
  }
  return changed;
}

/**
 * Marks an event the server refused outright.
 *
 * This is for a rejection the server will give again however many times it is
 * retried: a malformed payload, an event type it does not know. Retrying
 * forever would block everything queued behind it, so it is set aside and
 * surfaced rather than dropped: the business record it carries still exists on
 * this device and someone has to decide what to do about it.
 */
export function markRejected(tx: Queryable, eventId: string, reason: string): boolean {
  const result = tx.run(
    `UPDATE sync_outbox
        SET state = 'rejected', attempts = attempts + 1, last_error = ?
      WHERE event_id = ? AND state = 'pending'`,
    [truncate(reason), eventId],
  );
  return result.changes > 0;
}

/** Returns events the server refused, for someone to look at. */
export function rejected(tx: Queryable): OutboxEvent[] {
  const rows = tx.all(
    `SELECT event_id, business_id, user_id, device_id, type, payload,
            occurred_at, sequence, state, attempts, last_error, delivered_at
       FROM sync_outbox
      WHERE state = 'rejected'
      ORDER BY sequence`,
  );
  return rows.map(toEvent);
}

/**
 * Removes delivered events older than a cutoff, returning how many went.
 *
 * Delivered events are kept for a while rather than deleted on acknowledgement,
 * so a question about what a device sent can still be answered. They are not
 * kept forever: on cheap hardware an unbounded table is a real problem.
 *
 * Only delivered events are pruned. Pending ones are the business's data and
 * rejected ones are waiting for a decision.
 */
export function pruneDelivered(tx: Queryable, deliveredBefore: string): number {
  const result = tx.run(
    `DELETE FROM sync_outbox WHERE state = 'delivered' AND delivered_at < ?`,
    [deliveredBefore],
  );
  return result.changes;
}

/**
 * Draws the next sequence number.
 *
 * Numbers come from a counter rather than from the rowid so that pruning
 * delivered rows cannot make a new event look older than one already sent.
 */
function nextSequence(tx: Queryable): number {
  const row = tx.get(`SELECT next FROM sync_sequence WHERE id = 1`);
  const next = row?.["next"];
  if (typeof next !== "number") {
    throw new OutboxError("the outbox sequence is missing; the schema is not initialised");
  }

  tx.run(`UPDATE sync_sequence SET next = next + 1 WHERE id = 1`);
  return next;
}

function validate(event: NewEvent): void {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["eventId", event.eventId],
    ["businessId", event.businessId],
    ["userId", event.userId],
    ["deviceId", event.deviceId],
    ["type", event.type],
    ["occurredAt", event.occurredAt],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new OutboxError(`an event needs a ${field}`);
    }
  }
}

function encodePayload(payload: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(payload ?? {});
  } catch (cause) {
    throw new OutboxError("the event payload cannot be encoded as JSON", { cause });
  }
  // JSON.stringify returns undefined for values it cannot represent, such as a
  // bare function. Storing the string "undefined" would fail the column's
  // json_valid check later, at a point far from the mistake.
  if (encoded === undefined) {
    throw new OutboxError("the event payload cannot be encoded as JSON");
  }
  return encoded;
}

/** Keeps a runaway server message from filling the device's storage. */
function truncate(reason: string): string {
  const limit = 500;
  return reason.length <= limit ? reason : `${reason.slice(0, limit)}…`;
}

function toEvent(row: Row): OutboxEvent {
  return {
    eventId: text(row, "event_id"),
    businessId: text(row, "business_id"),
    userId: text(row, "user_id"),
    deviceId: text(row, "device_id"),
    type: text(row, "type"),
    payload: JSON.parse(text(row, "payload")) as unknown,
    occurredAt: text(row, "occurred_at"),
    sequence: number(row, "sequence"),
    state: text(row, "state") as DeliveryState,
    attempts: number(row, "attempts"),
    lastError: optionalText(row, "last_error"),
    deliveredAt: optionalText(row, "delivered_at"),
  };
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new OutboxError(`the outbox row has no ${column}`);
  }
  return value;
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

function number(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new OutboxError(`the outbox row has no ${column}`);
  }
  return value;
}

/** How many events a single push carries by default. */
export const DEFAULT_BATCH_SIZE = 100;

/** Reads a payload as a typed value, for callers that know the event type. */
export function payloadOf<T>(event: OutboxEvent): T {
  return event.payload as T;
}

/** Every SQL value the outbox binds, for callers building their own writes. */
export type { SqlValue };
