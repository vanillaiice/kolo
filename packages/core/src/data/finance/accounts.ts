/**
 * Financial accounts on the device (§17).
 *
 * An account is a place money sits: the till, the safe, an MTN wallet, an Orange
 * wallet, a bank account. Every payment names one, which is what makes adding a
 * provider a row rather than a release (§10) — a shopkeeper opens Orange Money
 * on their phone and every till has it after the next sync.
 *
 * An account is state, so two devices editing one cannot both win: the rule is
 * last-write-wins ordered by `(updated_at, updated_by_device)`, the same one
 * products and customers settle by (ADR-015).
 *
 * There is no balance here. What an account holds is the sum of what moved
 * through it, and §18's job is comparing that against what is actually in the
 * drawer — a stored balance would be both the number being checked and the
 * number checking (§59).
 */

import type { Database, Queryable, Row } from "../database/driver.ts";
import { enqueue } from "../sync/outbox.ts";

/** The event an account write queues. */
export const ACCOUNT_SAVED = "ACCOUNT_SAVED";

/** Everything is XAF (§46). */
const CURRENCY = "XAF";

/** What sort of place money sits in (§10, §17). */
export type AccountKind = "CASH" | "MOBILE_MONEY" | "BANK" | "CARD" | "OTHER";

/** An account as the device holds it. */
export interface Account {
  readonly id: string;
  readonly businessId: string;
  readonly branchId?: string | undefined;
  readonly name: string;
  /**
   * How the system reasons about the account — cash is counted against a
   * drawer, a wallet is not. Which *provider* a wallet belongs to is the name.
   */
  readonly kind: AccountKind;
  readonly currency: string;
  /** The wallet number, bank number, or till label. */
  readonly number?: string | undefined;
  readonly notes?: string | undefined;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The device whose edit is currently in force. */
  readonly updatedByDevice?: string | undefined;
}

/** What a caller supplies when saving an account. */
export interface SaveAccount extends Account {
  readonly userId: string;
  readonly deviceId: string;
}

/** Raised when an account cannot be saved or read. */
export class AccountError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AccountError";
  }
}

const KINDS: readonly AccountKind[] = ["CASH", "MOBILE_MONEY", "BANK", "CARD", "OTHER"];

/**
 * The conflict rule, as SQL. Written once and used by both the local save and
 * the applier, so a device cannot resolve its own writes by one rule and other
 * devices' by another.
 */
const WINS = `excluded.updated_at > financial_accounts.updated_at
   OR (excluded.updated_at = financial_accounts.updated_at
       AND excluded.updated_by_device > financial_accounts.updated_by_device)`;

const UPSERT = `
  INSERT INTO financial_accounts
    (id, business_id, branch_id, name, kind, currency, number, notes, active,
     created_at, updated_at, updated_by_device)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    branch_id         = excluded.branch_id,
    name              = excluded.name,
    kind              = excluded.kind,
    currency          = excluded.currency,
    number            = excluded.number,
    notes             = excluded.notes,
    active            = excluded.active,
    updated_at        = excluded.updated_at,
    updated_by_device = excluded.updated_by_device
  WHERE ${WINS}`;

/**
 * Saves an account and queues the event carrying it to the server.
 *
 * Both in one transaction (ADR-014). An account the till can take money into
 * and the server has never heard of would have every payment naming it
 * rejected.
 *
 * Returns whether the write took effect; it can lose to a later edit from
 * another device, which is not a failure.
 * Application adapters supply a native UUIDv7 event ID; omitted IDs retain the
 * legacy randomUUID behavior for existing repository callers.
 */
export function saveAccount(database: Database, account: SaveAccount, eventId?: string): boolean {
  validate(account);

  return database.transaction((tx) => {
    const applied = upsertAccount(tx, account, account.deviceId);

    enqueue(tx, {
      eventId: eventId ?? crypto.randomUUID(),
      businessId: account.businessId,
      userId: account.userId,
      deviceId: account.deviceId,
      type: ACCOUNT_SAVED,
      payload: { account: describe(account) },
      occurredAt: account.updatedAt,
    });

    return applied;
  });
}

/**
 * Writes an account, keeping whichever edit wins.
 *
 * Shared by a local save and by an edit arriving from another device.
 */
export function upsertAccount(tx: Queryable, account: Account, deviceId: string): boolean {
  const result = tx.run(UPSERT, [
    account.id,
    account.businessId,
    account.branchId ?? null,
    account.name,
    account.kind,
    account.currency,
    account.number ?? null,
    account.notes ?? null,
    account.active ? 1 : 0,
    account.createdAt,
    account.updatedAt,
    deviceId,
  ]);
  return result.changes > 0;
}

/** Returns an account, or undefined if this device does not hold it. */
export function accountOf(tx: Queryable, businessId: string, id: string): Account | undefined {
  const row = tx.get(`SELECT * FROM financial_accounts WHERE business_id = ? AND id = ?`, [
    businessId,
    id,
  ]);
  return row === undefined ? undefined : toAccount(row);
}

/**
 * Lists the accounts a till can take money into, by name.
 *
 * Closed accounts are absent by default but never deleted: the payments they
 * took still name them, and history is not deleted (§40).
 */
export function listAccounts(
  tx: Queryable,
  businessId: string,
  options: { readonly includeClosed?: boolean } = {},
): Account[] {
  const rows = tx.all(
    `SELECT * FROM financial_accounts
      WHERE business_id = ?${options.includeClosed === true ? "" : " AND active = 1"}
      ORDER BY name`,
    [businessId],
  );
  return rows.map(toAccount);
}

/**
 * The payload an ACCOUNT_SAVED event carries.
 *
 * These names are the wire contract with `AccountSavedPayload` on the server,
 * which refuses a field it does not know. No business, no branch, no device, no
 * currency: identity comes from the envelope (ADR-008) and everything is XAF.
 * No balance, and there could not be one.
 */
function describe(account: Account): Record<string, unknown> {
  const described: Record<string, unknown> = {
    id: account.id,
    name: account.name,
    kind: account.kind,
    created_at: account.createdAt,
    updated_at: account.updatedAt,
  };
  if (account.number !== undefined) {
    described["number"] = account.number;
  }
  if (account.notes !== undefined) {
    described["notes"] = account.notes;
  }
  // Absent means active, which is what an account is opened as.
  if (!account.active) {
    described["active"] = false;
  }
  return described;
}

function toAccount(row: Row): Account {
  const account: Account = {
    id: String(row["id"]),
    businessId: String(row["business_id"]),
    name: String(row["name"]),
    kind: String(row["kind"]) as AccountKind,
    currency: String(row["currency"]),
    active: Number(row["active"]) === 1,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
  return {
    ...account,
    ...(row["branch_id"] === null ? {} : { branchId: String(row["branch_id"]) }),
    ...(row["number"] === null ? {} : { number: String(row["number"]) }),
    ...(row["notes"] === null ? {} : { notes: String(row["notes"]) }),
    ...(row["updated_by_device"] === null
      ? {}
      : { updatedByDevice: String(row["updated_by_device"]) }),
  };
}

function validate(account: SaveAccount): void {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["id", account.id],
    ["businessId", account.businessId],
    ["name", account.name],
    ["userId", account.userId],
    ["deviceId", account.deviceId],
    ["createdAt", account.createdAt],
    ["updatedAt", account.updatedAt],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new AccountError(`an account needs a ${field}`);
    }
  }
  if (!KINDS.includes(account.kind)) {
    throw new AccountError(`${account.kind} is not a kind of account this build knows`);
  }
  if (account.currency !== CURRENCY) {
    // Everything is XAF (§46). An account in another currency would hold money
    // nothing else here could add up.
    throw new AccountError(`an account in ${account.currency}, but everything is ${CURRENCY}`);
  }
  if (account.updatedAt < account.createdAt) {
    throw new AccountError("an account cannot be updated before it was opened");
  }
}
