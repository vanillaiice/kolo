/**
 * Events pulled from other devices, held here before they are applied.
 *
 * A pull cannot apply what it receives and move straight on. Events arrive in
 * the order the server learned of them, and a movement can reach this device
 * before the product it moves — the till selling something the owner's phone
 * created while both were offline. Applying that fails, and neither dropping the
 * event nor blocking every event behind it is acceptable.
 *
 * So arrival and application are separated. An event is stored durably, the
 * cursor advances past it, and applying is retried on later syncs when whatever
 * it was waiting for has usually turned up. The mirror image of the outbox: one
 * holds what has not left, this holds what has not landed.
 */

import type { Queryable, Row } from "../database/driver.ts";

/** How far along a received event is. */
export type InboxState = "deferred" | "applied" | "unusable";

/** An event received from the server. */
export interface InboxEvent {
  readonly eventId: string;
  readonly businessId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: string;
  /** The server's sequence, which orders events across every device. */
  readonly serverSequence: number;
  readonly state: InboxState;
  readonly attempts: number;
  readonly lastError: string | null;
}

/** What the caller supplies when an event arrives. */
export interface ReceivedEvent {
  readonly eventId: string;
  readonly businessId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly serverSequence: number;
}

/** Raised when a received event cannot be stored or read. */
export class InboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InboxError";
  }
}

/**
 * Stores an event that arrived, reporting whether it was new.
 *
 * An event already here is left exactly as it is. A pull that is retried after a
 * lost response delivers the same events again, and re-storing one would reset
 * an event already applied back to deferred — applying it a second time.
 */
export function receive(tx: Queryable, event: ReceivedEvent, at: string): boolean {
  const result = tx.run(
    `INSERT OR IGNORE INTO sync_inbox
       (event_id, business_id, device_id, user_id, type, payload,
        occurred_at, server_sequence, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.eventId,
      event.businessId,
      event.deviceId,
      event.userId,
      event.type,
      encode(event.payload),
      event.occurredAt,
      event.serverSequence,
      at,
    ],
  );
  return result.changes > 0;
}

/**
 * Returns events still waiting to be applied, in the server's order.
 *
 * Server order matters here in a way device order does not: it is the one
 * ordering every device agrees on.
 */
export function deferred(tx: Queryable, limit: number): InboxEvent[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new InboxError(`a batch must be a positive whole number, got ${limit}`);
  }
  const rows = tx.all(
    `SELECT event_id, business_id, device_id, user_id, type, payload,
            occurred_at, server_sequence, state, attempts, last_error
       FROM sync_inbox
      WHERE state = 'deferred'
      ORDER BY server_sequence
      LIMIT ?`,
    [limit],
  );
  return rows.map(toEvent);
}

/** How many received events are still waiting to be applied. */
export function deferredCount(tx: Queryable): number {
  const row = tx.get(`SELECT COUNT(*) AS waiting FROM sync_inbox WHERE state = 'deferred'`);
  const waiting = row?.["waiting"];
  return typeof waiting === "number" ? waiting : 0;
}

/** Marks an event as applied to this device's tables. */
export function markApplied(tx: Queryable, eventId: string, at: string): boolean {
  const result = tx.run(
    `UPDATE sync_inbox
        SET state = 'applied', applied_at = ?, last_error = NULL
      WHERE event_id = ? AND state <> 'applied'`,
    [at, eventId],
  );
  return result.changes > 0;
}

/**
 * Records that applying failed, leaving the event deferred so it is tried again.
 *
 * This is the ordinary case for an event that arrived before what it depends on.
 * It is not an error to report to anyone yet — the next sync usually resolves it.
 */
export function markDeferred(tx: Queryable, eventId: string, reason: string): boolean {
  const result = tx.run(
    `UPDATE sync_inbox
        SET attempts = attempts + 1, last_error = ?
      WHERE event_id = ? AND state = 'deferred'`,
    [truncate(reason), eventId],
  );
  return result.changes > 0;
}

/**
 * Sets an event aside as one this device cannot use.
 *
 * For an event that will never apply however long it waits: a type this build
 * does not know, or a payload it cannot read. It is kept rather than deleted —
 * it is another device's business record, and a build that does understand it
 * may yet be installed.
 */
export function markUnusable(tx: Queryable, eventId: string, reason: string): boolean {
  const result = tx.run(
    `UPDATE sync_inbox
        SET state = 'unusable', attempts = attempts + 1, last_error = ?
      WHERE event_id = ? AND state = 'deferred'`,
    [truncate(reason), eventId],
  );
  return result.changes > 0;
}

/** Returns events this device could not use, for someone to look at. */
export function unusable(tx: Queryable): InboxEvent[] {
  const rows = tx.all(
    `SELECT event_id, business_id, device_id, user_id, type, payload,
            occurred_at, server_sequence, state, attempts, last_error
       FROM sync_inbox
      WHERE state = 'unusable'
      ORDER BY server_sequence`,
  );
  return rows.map(toEvent);
}

/**
 * Where the next pull should resume from.
 *
 * Zero means the beginning, which is what a device that has never synced wants.
 */
export function cursor(tx: Queryable): number {
  const row = tx.get(`SELECT cursor FROM sync_state WHERE id = 1`);
  const stored = row?.["cursor"];
  if (typeof stored !== "string" || stored === "") {
    return 0;
  }
  const parsed = Number(stored);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Moves the cursor forward.
 *
 * It only ever moves forward. An out-of-order or repeated answer must not walk
 * it backwards, which would re-deliver events this device already holds.
 */
export function advanceCursor(tx: Queryable, to: number, at: string): number {
  const current = cursor(tx);
  const next = Math.max(current, to);
  tx.run(`UPDATE sync_state SET cursor = ?, last_pulled_at = ? WHERE id = 1`, [String(next), at]);
  return next;
}

/** When this device last heard from the server, or null if it never has. */
export function lastPulledAt(tx: Queryable): string | null {
  const row = tx.get(`SELECT last_pulled_at FROM sync_state WHERE id = 1`);
  const value = row?.["last_pulled_at"];
  return typeof value === "string" ? value : null;
}

function encode(payload: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(payload ?? {});
  } catch (cause) {
    throw new InboxError("the received payload cannot be stored as JSON", { cause });
  }
  if (encoded === undefined) {
    throw new InboxError("the received payload cannot be stored as JSON");
  }
  return encoded;
}

function truncate(reason: string): string {
  const limit = 500;
  return reason.length <= limit ? reason : `${reason.slice(0, limit)}…`;
}

function toEvent(row: Row): InboxEvent {
  return {
    eventId: text(row, "event_id"),
    businessId: text(row, "business_id"),
    deviceId: text(row, "device_id"),
    userId: text(row, "user_id"),
    type: text(row, "type"),
    payload: JSON.parse(text(row, "payload")) as unknown,
    occurredAt: text(row, "occurred_at"),
    serverSequence: number(row, "server_sequence"),
    state: text(row, "state") as InboxState,
    attempts: number(row, "attempts"),
    lastError: optionalText(row, "last_error"),
  };
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new InboxError(`the inbox row has no ${column}`);
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
    throw new InboxError(`the inbox row has no ${column}`);
  }
  return value;
}
