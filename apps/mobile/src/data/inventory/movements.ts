/**
 * Recording stock movements on the device.
 *
 * This is where the two rules meet. The ledger is append-only and stock is its
 * sum (ADR-009); a business write and the event that will carry it to the
 * server commit together or not at all (ADR-014). Every function here that
 * writes does both in one transaction, and there is no way to do one without
 * the other.
 *
 * The shape §4 requires:
 *
 *     record() → validate → SQLite transaction → success → the sync engine
 *                                                          drains later
 *
 * Nothing here waits for the network, and nothing here fails because the
 * network failed.
 */

import type { Database, Queryable, Row, SqlValue } from "../database/driver.ts";
import { enqueue, type NewEvent } from "../sync/outbox.ts";

/** Why stock moved (§7). */
export type MovementType =
  | "PURCHASE"
  | "SALE"
  | "SALE_RETURN"
  | "PURCHASE_RETURN"
  | "DAMAGE"
  | "ADJUSTMENT"
  | "STOCK_COUNT"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "OPENING_BALANCE";

/** How many thousandths make one unit, matching the server's quantity scale. */
export const QUANTITY_SCALE = 1000;

/** What caused a movement. */
export interface MovementReference {
  readonly kind: string;
  readonly id: string;
}

/** A movement to record. */
export interface NewMovement {
  readonly id: string;
  readonly businessId: string;
  readonly branchId?: string | undefined;
  readonly productId: string;
  readonly type: MovementType;
  /** Signed thousandths: positive adds stock, negative removes it. */
  readonly quantity: number;
  readonly unitCostMinor?: number | undefined;
  readonly unitCostCurrency?: string | undefined;
  readonly reference?: MovementReference | undefined;
  readonly reason?: string | undefined;
  readonly userId: string;
  readonly deviceId: string;
  /** When the stock actually moved, which may be well before now. */
  readonly occurredAt: string;
  /** When this record is being written. */
  readonly recordedAt: string;
}

/** A movement as stored. */
export interface StoredMovement extends NewMovement {
  readonly branchId: string | undefined;
  readonly unitCostMinor: number | undefined;
  readonly unitCostCurrency: string | undefined;
  readonly reference: MovementReference | undefined;
  readonly reason: string | undefined;
}

/** A product's stock, derived from its ledger. */
export interface StockLevel {
  readonly productId: string;
  /** Signed thousandths. Below zero is meaningful — see {@link isNegative}. */
  readonly onHandThousandths: number;
  readonly movements: number;
  readonly lastMovedAt: string | undefined;
}

/**
 * Whether more has left than ever arrived.
 *
 * Not corrupt data: two devices each selling the last unit offline is expected
 * (§29), and the honest total is below zero until someone counts the shelf.
 * A caller surfaces it rather than clamping it, because clamping would hide the
 * discrepancy the owner needs to see.
 */
export function isNegative(level: StockLevel): boolean {
  return level.onHandThousandths < 0;
}

/** Raised when a movement cannot be recorded. */
export class MovementError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MovementError";
  }
}

/** How the caller describes the event to queue alongside a movement. */
export interface MovementEvent {
  /** The globally unique identifier the server deduplicates on. */
  readonly eventId: string;
  /** The event type, such as "STOCK_ADJUSTED". */
  readonly type: string;
  /**
   * Anything the server needs beyond the movement itself. The movement is
   * included automatically, so this carries the surrounding business context —
   * which sale, which purchase.
   */
  readonly context?: Record<string, unknown> | undefined;
}

/**
 * Records a movement and queues the event that will carry it to the server.
 *
 * Both happen in one transaction. If either fails, neither happened — which is
 * the only way to make it impossible for a device to hold stock history the
 * server will never hear about (ADR-014).
 */
export function recordMovement(
  database: Database,
  movement: NewMovement,
  event: MovementEvent,
): void {
  validate(movement);

  database.transaction((tx) => {
    insertMovement(tx, movement);
    enqueue(tx, toEvent(movement, event));
  });
}

/**
 * Records several movements and one event covering them all.
 *
 * A business event fans out: a sale of three lines moves three products' stock,
 * and those movements are one fact. They are queued as one event because the
 * server applies the sale, not three unrelated stock changes — and because a
 * partial arrival would leave the server with a sale that does not balance.
 */
export function recordMovements(
  database: Database,
  movements: readonly NewMovement[],
  event: MovementEvent,
): void {
  if (movements.length === 0) {
    throw new MovementError("a business event must move some stock");
  }
  for (const movement of movements) {
    validate(movement);
  }

  const [first] = movements;
  if (first === undefined) {
    throw new MovementError("a business event must move some stock");
  }

  database.transaction((tx) => {
    for (const movement of movements) {
      insertMovement(tx, movement);
    }
    enqueue(tx, {
      eventId: event.eventId,
      businessId: first.businessId,
      userId: first.userId,
      deviceId: first.deviceId,
      type: event.type,
      payload: {
        ...(event.context ?? {}),
        movements: movements.map(describe),
      },
      occurredAt: first.occurredAt,
    });
  });
}

/**
 * Returns a product's stock, summed by the database.
 *
 * A product sold for a year has thousands of movements, and a till asking how
 * many are left must not load them all (§46). The answer is the same addition
 * either way.
 */
export function stockOf(database: Queryable, businessId: string, productId: string): StockLevel {
  const row = database.get(
    `SELECT coalesce(sum(quantity), 0) AS on_hand,
            count(*) AS movements,
            max(occurred_at) AS last_moved_at
       FROM inventory_movements
      WHERE business_id = ? AND product_id = ?`,
    [businessId, productId],
  );

  return {
    productId,
    onHandThousandths: numberOf(row, "on_hand"),
    movements: numberOf(row, "movements"),
    lastMovedAt: optionalText(row, "last_moved_at"),
  };
}

/**
 * Returns what a product's stock was at a given moment.
 *
 * It counts by when stock moved, not when this device heard about it, so a
 * movement synced days late still lands in the period it belongs to.
 */
export function stockAsOf(
  database: Queryable,
  businessId: string,
  productId: string,
  asOf: string,
): StockLevel {
  const row = database.get(
    `SELECT coalesce(sum(quantity), 0) AS on_hand,
            count(*) AS movements,
            max(occurred_at) AS last_moved_at
       FROM inventory_movements
      WHERE business_id = ? AND product_id = ? AND occurred_at <= ?`,
    [businessId, productId, asOf],
  );

  return {
    productId,
    onHandThousandths: numberOf(row, "on_hand"),
    movements: numberOf(row, "movements"),
    lastMovedAt: optionalText(row, "last_moved_at"),
  };
}

/** Returns a product's movements, oldest first by when the stock moved. */
export function movementsFor(
  database: Queryable,
  businessId: string,
  productId: string,
): StoredMovement[] {
  const rows = database.all(
    `SELECT id, business_id, branch_id, product_id, type, quantity,
            unit_cost_minor, unit_cost_currency, reference_kind, reference_id, reason,
            user_id, device_id, occurred_at, recorded_at
       FROM inventory_movements
      WHERE business_id = ? AND product_id = ?
      ORDER BY occurred_at, id`,
    [businessId, productId],
  );
  return rows.map(toMovement);
}

function insertMovement(tx: Queryable, movement: NewMovement): void {
  const reference = movement.reference;
  tx.run(
    `INSERT INTO inventory_movements
       (id, business_id, branch_id, product_id, type, quantity,
        unit_cost_minor, unit_cost_currency, reference_kind, reference_id, reason,
        user_id, device_id, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      movement.id,
      movement.businessId,
      movement.branchId ?? null,
      movement.productId,
      movement.type,
      movement.quantity,
      movement.unitCostMinor ?? null,
      movement.unitCostCurrency ?? null,
      reference?.kind ?? null,
      reference?.id ?? null,
      movement.reason ?? null,
      movement.userId,
      movement.deviceId,
      movement.occurredAt,
      movement.recordedAt,
    ],
  );
}

function toEvent(movement: NewMovement, event: MovementEvent): NewEvent {
  return {
    eventId: event.eventId,
    businessId: movement.businessId,
    userId: movement.userId,
    deviceId: movement.deviceId,
    type: event.type,
    payload: {
      ...(event.context ?? {}),
      movements: [describe(movement)],
    },
    occurredAt: movement.occurredAt,
  };
}

/**
 * Renders a movement for the wire.
 *
 * The event carries the movement itself rather than only its identifier, so the
 * server can apply it without asking this device for anything — which it could
 * not do anyway, since the device may be offline again by the time the event
 * arrives (ADR-006).
 */
function describe(movement: NewMovement): Record<string, unknown> {
  const described: Record<string, unknown> = {
    id: movement.id,
    product_id: movement.productId,
    type: movement.type,
    quantity: movement.quantity,
    occurred_at: movement.occurredAt,
  };
  // No business, branch, device, or user. The server takes all four from the
  // authenticated envelope, so sending them would at best be ignored and at
  // worst be a device claiming to write somewhere it may not (ADR-008). The
  // server refuses a payload carrying a field it does not know, so these are
  // absent rather than merely unread.
  if (movement.unitCostMinor !== undefined) {
    // The amount travels; the currency does not. Everything is XAF (§46), and
    // a device announcing otherwise would be putting two currencies in one
    // ledger that nothing adds up.
    described["unit_cost_minor"] = movement.unitCostMinor;
  }
  if (movement.reference !== undefined) {
    described["reference_kind"] = movement.reference.kind;
    described["reference_id"] = movement.reference.id;
  }
  if (movement.reason !== undefined) {
    described["reason"] = movement.reason;
  }
  return described;
}

/**
 * Checks a movement before it reaches the database.
 *
 * The schema checks these too. Doing it here as well means the message names
 * the field rather than a constraint, which is what a person reading an error
 * on a till needs.
 */
function validate(movement: NewMovement): void {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["id", movement.id],
    ["businessId", movement.businessId],
    ["productId", movement.productId],
    ["userId", movement.userId],
    ["deviceId", movement.deviceId],
    ["occurredAt", movement.occurredAt],
    ["recordedAt", movement.recordedAt],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new MovementError(`a movement needs a ${field}`);
    }
  }

  if (!Number.isInteger(movement.quantity)) {
    throw new MovementError(
      `a quantity is a whole number of thousandths, got ${movement.quantity}`,
    );
  }
  if (movement.quantity === 0) {
    throw new MovementError("a movement of zero changes nothing");
  }

  const direction = directionOf(movement.type);
  if (direction > 0 && movement.quantity < 0) {
    throw new MovementError(`${movement.type} adds stock, so the quantity cannot be negative`);
  }
  if (direction < 0 && movement.quantity > 0) {
    throw new MovementError(`${movement.type} removes stock, so the quantity must be negative`);
  }

  if (requiresReason(movement.type) && (movement.reason ?? "").trim() === "") {
    throw new MovementError(`${movement.type} needs a reason`);
  }
  if (requiresReference(movement.type) && movement.reference === undefined) {
    throw new MovementError(`${movement.type} needs a reference to what caused it`);
  }
  if ((movement.unitCostMinor === undefined) !== (movement.unitCostCurrency === undefined)) {
    throw new MovementError("a unit cost needs both an amount and a currency");
  }
  if (movement.unitCostMinor !== undefined && movement.unitCostMinor < 0) {
    throw new MovementError(`a unit cost cannot be negative, got ${movement.unitCostMinor}`);
  }
}

/** Which way a type of movement may go: 1 adds, -1 removes, 0 either. */
function directionOf(type: MovementType): number {
  switch (type) {
    case "PURCHASE":
    case "SALE_RETURN":
    case "TRANSFER_IN":
    case "OPENING_BALANCE":
      return 1;
    case "SALE":
    case "PURCHASE_RETURN":
    case "DAMAGE":
    case "TRANSFER_OUT":
      return -1;
    case "ADJUSTMENT":
    case "STOCK_COUNT":
      return 0;
  }
}

function requiresReason(type: MovementType): boolean {
  return type === "ADJUSTMENT" || type === "STOCK_COUNT" || type === "DAMAGE";
}

function requiresReference(type: MovementType): boolean {
  return (
    type === "PURCHASE" ||
    type === "SALE" ||
    type === "SALE_RETURN" ||
    type === "PURCHASE_RETURN" ||
    type === "TRANSFER_IN" ||
    type === "TRANSFER_OUT"
  );
}

function toMovement(row: Row): StoredMovement {
  const kind = optionalText(row, "reference_kind");
  const identifier = optionalText(row, "reference_id");

  return {
    id: textOf(row, "id"),
    businessId: textOf(row, "business_id"),
    branchId: optionalText(row, "branch_id"),
    productId: textOf(row, "product_id"),
    type: textOf(row, "type") as MovementType,
    quantity: numberOf(row, "quantity"),
    unitCostMinor: optionalNumber(row, "unit_cost_minor"),
    unitCostCurrency: optionalText(row, "unit_cost_currency"),
    reference: kind !== undefined && identifier !== undefined ? { kind, id: identifier } : undefined,
    reason: optionalText(row, "reason"),
    userId: textOf(row, "user_id"),
    deviceId: textOf(row, "device_id"),
    occurredAt: textOf(row, "occurred_at"),
    recordedAt: textOf(row, "recorded_at"),
  };
}

function textOf(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new MovementError(`the movement row has no ${column}`);
  }
  return value;
}

function optionalText(row: Row | undefined, column: string): string | undefined {
  const value = row?.[column];
  return typeof value === "string" ? value : undefined;
}

function numberOf(row: Row | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new MovementError(`the row has no ${column}`);
}

function optionalNumber(row: Row, column: string): number | undefined {
  const value = row[column];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return undefined;
}

export type { SqlValue };
