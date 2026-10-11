import { sumAmounts } from "../../rules/amounts.ts";
import { sqlInteger } from "../database/safe-values.ts";
/**
 * Money moved by hand, and what an account holds (§18).
 *
 * The float put in at opening, cash carried to the bank, a transfer from the
 * till to a wallet, the correction after a count. Money a *sale* or a *customer
 * payment* moved is not recorded here — those are written where they happened,
 * and {@link balanceOfAccount} sums every source. A second copy could disagree with
 * the first, and then there would be two answers to how much is in the drawer.
 *
 * Nothing here stores a balance. §18's whole job is setting what the system
 * says against what is actually in the drawer, and a stored figure would be both
 * the number being checked and the number checking (§59).
 */

import type { Database, Queryable, Row } from "../database/driver.ts";
import { enqueue } from "../sync/outbox.ts";

/** The event a cash movement queues. */
export const CASH_MOVED = "CASH_MOVED";

/** Everything is XAF (§46). */
const CURRENCY = "XAF";

/** Why money entered or left an account. */
export type MovementType =
  | "OPENING_BALANCE"
  | "CASH_IN"
  | "CASH_OUT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "ADJUSTMENT";

/** Money entering or leaving an account by someone's hand. */
export interface CashMovement {
  readonly id: string;
  readonly accountId: string;
  readonly businessId: string;
  readonly branchId?: string | undefined;
  readonly type: MovementType;
  /** Signed as it will be stored: positive in, negative out. */
  readonly amountMinor: number;
  /** The other account in a transfer, and absent otherwise. */
  readonly counterpartId?: string | undefined;
  readonly reason?: string | undefined;
  readonly userId: string;
  readonly deviceId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

/** What a caller supplies when recording movements. */
export interface MoveCash {
  readonly movements: readonly CashMovement[];
  /** The event identifier, which is what makes a replay a duplicate (§27). */
  readonly eventId: string;
}

/** What an account holds, worked out from what moved through it. */
export interface AccountBalance {
  readonly onHandMinor: number;
  /**
   * How many facts the sum came from, so a caller can tell "empty because
   * nothing has happened" from "empty because it was emptied".
   */
  readonly movements: number;
}

/** A cash count set against what the system believes (§18). */
export interface Reconciliation {
  readonly expectedMinor: number;
  readonly countedMinor: number;
  /** Counted less expected: negative for a drawer that is short. */
  readonly differenceMinor: number;
}

/** Raised when money cannot be moved or read. */
export class CashError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CashError";
  }
}

const TYPES: readonly MovementType[] = [
  "OPENING_BALANCE",
  "CASH_IN",
  "CASH_OUT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "ADJUSTMENT",
];

const INCREASES: readonly MovementType[] = ["OPENING_BALANCE", "CASH_IN", "TRANSFER_IN"];
const DECREASES: readonly MovementType[] = ["CASH_OUT", "TRANSFER_OUT"];
const NEEDS_REASON: readonly MovementType[] = ["ADJUSTMENT", "CASH_OUT"];
const TRANSFERS: readonly MovementType[] = ["TRANSFER_IN", "TRANSFER_OUT"];

const INSERT = `
  INSERT INTO account_movements
    (id, account_id, business_id, branch_id, type, amount_minor, currency,
     counterpart_id, reason, user_id, device_id, occurred_at, recorded_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Records money moving, and queues the event carrying it.
 *
 * Several movements at once, because a transfer is two: money leaving one
 * account and arriving in another. They are written in one transaction, since
 * half a transfer is money genuinely lost, gone from the till with nothing to
 * show where it went.
 */
export function moveCash(database: Database, request: MoveCash): void {
  validate(request);

  database.transaction((tx) => {
    for (const movement of request.movements) {
      tx.run(INSERT, [
        movement.id,
        movement.accountId,
        movement.businessId,
        movement.branchId ?? null,
        movement.type,
        movement.amountMinor,
        CURRENCY,
        movement.counterpartId ?? null,
        movement.reason ?? null,
        movement.userId,
        movement.deviceId,
        movement.occurredAt,
        movement.recordedAt,
      ]);
    }

    const first = request.movements[0];
    enqueue(tx, {
      eventId: request.eventId,
      businessId: first?.businessId ?? "",
      userId: first?.userId ?? "",
      deviceId: first?.deviceId ?? "",
      type: CASH_MOVED,
      payload: { movements: request.movements.map(describe) },
      occurredAt: first?.occurredAt ?? "",
    });
  });
}

/**
 * Builds the two halves of moving money between two accounts.
 *
 * The amount is given as what leaves, negative, exactly as the domain requires
 * on the server: flipping a positive one silently would be the only place a
 * sign that contradicts its meaning is corrected rather than refused.
 */
export function transfer(
  leaving: Omit<CashMovement, "type" | "counterpartId">,
  arriving: Omit<CashMovement, "type" | "counterpartId" | "amountMinor">,
): CashMovement[] {
  if (leaving.accountId === arriving.accountId) {
    throw new CashError("a transfer needs two accounts");
  }
  if (!Number.isSafeInteger(leaving.amountMinor) || leaving.amountMinor >= 0) {
    throw new CashError(
      `${leaving.amountMinor} leaves an account, so it must be negative`,
    );
  }

  return [
    { ...leaving, type: "TRANSFER_OUT", counterpartId: arriving.accountId },
    {
      ...arriving,
      type: "TRANSFER_IN",
      amountMinor: -leaving.amountMinor,
      counterpartId: leaving.accountId,
    },
  ];
}

/**
 * What an account holds: the sum of every source that moved money.
 *
 * Five arms, because each source is authoritative for its own facts: the
 * payments taken into the account, the customers settling debts into it, the
 * movements made by hand, the expenses paid out of it, and the wholesalers
 * settled out of it.
 *
 * The signs are where the care is, because a ledger's sign means "more or less
 * owed" and an account's means "more or less cash", and the two agree only
 * sometimes. A customer's payment is negative in their ledger and is **negated**
 * here, where the meaning becomes money arriving. A supplier's payment is
 * negative in theirs too and is taken **as stored**, because the money really
 * did leave. Getting that one backwards makes paying a wholesaler look like
 * taking money in.
 *
 * A new source of money must be added to this query or the drawer will read
 * wrong by exactly what it moved.
 */
export function balanceOfAccount(
  tx: Queryable,
  businessId: string,
  accountId: string,
): AccountBalance {
  const row = tx.get(
    `WITH moved AS (
       SELECT amount_minor FROM sale_payments
        WHERE business_id = ? AND account_id = ?
       UNION ALL
       SELECT -amount_minor FROM customer_transactions
        WHERE business_id = ? AND account_id = ? AND type = 'PAYMENT'
       UNION ALL
       SELECT amount_minor FROM account_movements
        WHERE business_id = ? AND account_id = ?
       UNION ALL
       -- Expenses are stored positive as costs, so they are negated here: money
       -- the business spent is money the account no longer holds.
       SELECT -amount_minor FROM expenses
        WHERE business_id = ? AND account_id = ?
       UNION ALL
       -- Settling a wholesaler's account. Stored negative, meaning less owed,
       -- and taken as stored because the money left the drawer. Only a PAYMENT
       -- names an account: goods going back reduce a bill without a franc
       -- moving (§16).
       SELECT amount_minor FROM supplier_transactions
        WHERE business_id = ? AND account_id = ? AND type = 'PAYMENT'
     )
     SELECT coalesce(sum(amount_minor), 0) AS on_hand, count(*) AS movements FROM moved`,
    [
      businessId,
      accountId,
      businessId,
      accountId,
      businessId,
      accountId,
      businessId,
      accountId,
      businessId,
      accountId,
    ],
  );
  return {
    onHandMinor: sqlInteger(row?.["on_hand"] ?? 0),
    movements: sqlInteger(row?.["movements"] ?? 0),
  };
}

/** An account's movements, oldest first by when the money actually moved. */
export function movementsOfAccount(
  tx: Queryable,
  businessId: string,
  accountId: string,
): CashMovement[] {
  const rows = tx.all(
    `SELECT * FROM account_movements
      WHERE business_id = ? AND account_id = ?
      ORDER BY occurred_at, id`,
    [businessId, accountId],
  );
  return rows.map(toMovement);
}

/**
 * Sets a count against what the system believes (§18).
 *
 * The difference is counted less expected, so a shortfall reads negative: the
 * direction an adjustment would have to move the account to make the books
 * agree with the drawer. Nothing is changed here: correcting it is a movement,
 * which is a new record of what was found rather than an edit to what was
 * believed.
 */
export function reconcile(
  tx: Queryable,
  businessId: string,
  accountId: string,
  countedMinor: number,
): Reconciliation {
  if (!Number.isSafeInteger(countedMinor) || countedMinor < 0) {
    throw new CashError(`a count of ${countedMinor} is not an amount that could be in a drawer`);
  }
  const { onHandMinor } = balanceOfAccount(tx, businessId, accountId);
  return {
    expectedMinor: onHandMinor,
    countedMinor,
    differenceMinor: sumAmounts([countedMinor,-onHandMinor]),
  };
}

/**
 * The payload a CASH_MOVED event carries.
 *
 * These names are the wire contract with `CashMovedPayload` on the server, which
 * refuses a field it does not know. No business, branch, user, device, or
 * currency: identity comes from the envelope (ADR-008) and everything is XAF.
 */
function describe(movement: CashMovement): Record<string, unknown> {
  const described: Record<string, unknown> = {
    id: movement.id,
    account_id: movement.accountId,
    type: movement.type,
    amount_minor: movement.amountMinor,
    occurred_at: movement.occurredAt,
  };
  if (movement.counterpartId !== undefined) {
    described["counterpart_id"] = movement.counterpartId;
  }
  if (movement.reason !== undefined) {
    described["reason"] = movement.reason;
  }
  return described;
}

function toMovement(row: Row): CashMovement {
  const movement: CashMovement = {
    id: String(row["id"]),
    accountId: String(row["account_id"]),
    businessId: String(row["business_id"]),
    type: String(row["type"]) as MovementType,
    amountMinor: sqlInteger(row["amount_minor"]),
    userId: String(row["user_id"]),
    deviceId: String(row["device_id"]),
    occurredAt: String(row["occurred_at"]),
    recordedAt: String(row["recorded_at"]),
  };
  return {
    ...movement,
    ...(row["branch_id"] === null ? {} : { branchId: String(row["branch_id"]) }),
    ...(row["counterpart_id"] === null ? {} : { counterpartId: String(row["counterpart_id"]) }),
    ...(row["reason"] === null ? {} : { reason: String(row["reason"]) }),
  };
}

/**
 * Checks movements before they reach the database.
 *
 * The schema checks these too. Doing it here as well means the message names the
 * field rather than a constraint, which is what a person reading an error on a
 * till needs.
 */
function validate(request: MoveCash): void {
  if (typeof request.eventId !== "string" || request.eventId.trim() === "") {
    throw new CashError("moving money needs an eventId");
  }
  if (request.movements.length === 0) {
    throw new CashError("an event that moved no money");
  }

  for (const [index, movement] of request.movements.entries()) {
    const required: ReadonlyArray<readonly [string, string]> = [
      ["id", movement.id],
      ["accountId", movement.accountId],
      ["businessId", movement.businessId],
      ["userId", movement.userId],
      ["deviceId", movement.deviceId],
      ["occurredAt", movement.occurredAt],
      ["recordedAt", movement.recordedAt],
    ];
    for (const [field, value] of required) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new CashError(`movement ${index} needs a ${field}`);
      }
    }
    if (!TYPES.includes(movement.type)) {
      throw new CashError(`${movement.type} is not a movement this build knows`);
    }
    if (!Number.isSafeInteger(movement.amountMinor) || movement.amountMinor === 0) {
      throw new CashError(`movement ${index} moves ${movement.amountMinor}, which is nothing`);
    }
    // Cash taken out that read as money in would make a drawer look full that
    // is empty, and only a count would ever find it.
    if (INCREASES.includes(movement.type) && movement.amountMinor < 0) {
      throw new CashError(`${movement.type} puts money in, so it must be positive`);
    }
    if (DECREASES.includes(movement.type) && movement.amountMinor > 0) {
      throw new CashError(`${movement.type} takes money out, so it must be negative`);
    }
    if (NEEDS_REASON.includes(movement.type) && (movement.reason ?? "").trim() === "") {
      throw new CashError(`${movement.type} moves money with nothing behind it, so it needs a reason`);
    }
    // Half a transfer is money vanishing with nothing to show where it went.
    if (TRANSFERS.includes(movement.type) && (movement.counterpartId ?? "") === "") {
      throw new CashError(`${movement.type} needs the account at the other end`);
    }
    if (!TRANSFERS.includes(movement.type) && movement.counterpartId !== undefined) {
      throw new CashError(`${movement.type} moves nothing between accounts`);
    }
    if (movement.counterpartId === movement.accountId) {
      throw new CashError("a transfer needs two accounts");
    }
    if (movement.recordedAt < movement.occurredAt) {
      throw new CashError(`movement ${index} cannot be recorded before it happened`);
    }
  }
}
