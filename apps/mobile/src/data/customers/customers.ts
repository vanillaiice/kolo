/**
 * Customers on the device, and what they owe (§12, §13).
 *
 * Two different kinds of thing live here, and keeping them apart is the point.
 *
 * A customer's details are **state**: two tills cannot both set a different
 * phone number and have both stand, so one edit wins, by the same rule a
 * product's does — last-write-wins ordered by `(updated_at, updated_by_device)`
 * (ADR-015). The rule is written on the device as well as the server because a
 * device has to resolve a conflict with no network.
 *
 * What a customer owes is **not** state and is never resolved that way. It is
 * the sum of an append-only ledger, so two tills each recording a purchase both
 * stand and the balance is their total. There is no balance column here, on
 * purpose: a stored copy could disagree with the entries it came from, over the
 * one number a shopkeeper and a customer will actually argue about.
 */

import type { Database, Queryable, Row } from "../database/driver.ts";
import { enqueue } from "../sync/outbox.ts";

/** The event a customer write queues. */
export const CUSTOMER_SAVED = "CUSTOMER_SAVED";

/** Everything is XAF (§46). */
const CURRENCY = "XAF";

/** A customer as the device holds them. */
export interface Customer {
  readonly id: string;
  readonly businessId: string;
  /** All §12 requires. Everything below is filled in as the shop learns it. */
  readonly name: string;
  readonly phone?: string | undefined;
  readonly address?: string | undefined;
  readonly notes?: string | undefined;
  /**
   * How much they may owe at once, and undefined when no limit has been set.
   *
   * Undefined and zero are different answers: undefined means the shopkeeper
   * has not decided, zero means this customer may not have credit. Collapsing
   * them would either refuse every regular who has never been given a limit, or
   * extend unlimited credit to someone deliberately cut off.
   */
  readonly creditLimitMinor?: number | undefined;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The device whose edit is currently in force. */
  readonly updatedByDevice?: string | undefined;
}

/** What a caller supplies when saving a customer. */
export interface SaveCustomer extends Customer {
  /** The user making the edit, recorded on the event for the audit trail. */
  readonly userId: string;
  /** The device making the edit. Breaks a tie between simultaneous edits. */
  readonly deviceId: string;
}

/** What a customer owes, worked out from their ledger. */
export interface Balance {
  /** Positive is a debt; negative means they have paid more than they took. */
  readonly outstandingMinor: number;
  /**
   * How many entries the sum came from, so a caller can tell "owes nothing
   * because they always pay" from "owes nothing because they have never
   * bought".
   */
  readonly entries: number;
}

/** Raised when a customer cannot be saved or read. */
export class CustomerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CustomerError";
  }
}

/**
 * The conflict rule, as SQL.
 *
 * Written once and used by both the local save and the applier that takes an
 * edit from another device, so a device cannot resolve its own writes by one
 * rule and other devices' by another. Because the comparison reads only the two
 * rows, applying edits in any order gives every device the same answer.
 */
const WINS = `excluded.updated_at > customers.updated_at
   OR (excluded.updated_at = customers.updated_at
       AND excluded.updated_by_device > customers.updated_by_device)`;

const UPSERT = `
  INSERT INTO customers
    (id, business_id, name, phone, address, notes, credit_limit_minor,
     credit_limit_currency, active, created_at, updated_at, updated_by_device)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    name                  = excluded.name,
    phone                 = excluded.phone,
    address               = excluded.address,
    notes                 = excluded.notes,
    credit_limit_minor    = excluded.credit_limit_minor,
    credit_limit_currency = excluded.credit_limit_currency,
    active                = excluded.active,
    updated_at            = excluded.updated_at,
    updated_by_device     = excluded.updated_by_device
  WHERE ${WINS}`;

/**
 * Saves a customer and queues the event carrying them to the server.
 *
 * Both in one transaction (ADR-014). A customer the shopkeeper can see and the
 * server never will is worse here than for a product: a credit sale to them
 * would be refused everywhere else in the shop.
 *
 * Returns whether the write took effect. A local save normally does, but it can
 * lose to an edit from another device that arrived with a later timestamp, and
 * the caller should show what is stored rather than what was typed.
 */
export function saveCustomer(database: Database, customer: SaveCustomer): boolean {
  validate(customer);

  return database.transaction((tx) => {
    const applied = upsertCustomer(tx, customer, customer.deviceId);

    // Queued whether or not the local write won. Losing here says only that
    // this device already knows of a later edit; the server and the other
    // devices judge for themselves, against what they hold.
    enqueue(tx, {
      eventId: crypto.randomUUID(),
      businessId: customer.businessId,
      userId: customer.userId,
      deviceId: customer.deviceId,
      type: CUSTOMER_SAVED,
      payload: { customer: describe(customer) },
      occurredAt: customer.updatedAt,
    });

    return applied;
  });
}

/**
 * Writes a customer, keeping whichever edit wins.
 *
 * Shared by a local save and by an edit arriving from another device, so both
 * are resolved by the same comparison.
 */
export function upsertCustomer(tx: Queryable, customer: Customer, deviceId: string): boolean {
  const result = tx.run(UPSERT, [
    customer.id,
    customer.businessId,
    customer.name,
    customer.phone ?? null,
    customer.address ?? null,
    customer.notes ?? null,
    customer.creditLimitMinor ?? null,
    // The currency travels with the limit or not at all, which is what keeps a
    // limit of zero distinct from no limit in the row itself.
    customer.creditLimitMinor === undefined ? null : CURRENCY,
    customer.active ? 1 : 0,
    customer.createdAt,
    customer.updatedAt,
    deviceId,
  ]);
  return result.changes > 0;
}

/** Returns a customer, or undefined if this device does not hold them. */
export function customerOf(tx: Queryable, businessId: string, id: string): Customer | undefined {
  const row = tx.get(`SELECT * FROM customers WHERE business_id = ? AND id = ?`, [businessId, id]);
  return row === undefined ? undefined : toCustomer(row);
}

/** Lists a business's customers, by name. */
export function listCustomers(
  tx: Queryable,
  businessId: string,
  options: { readonly includeClosed?: boolean } = {},
): Customer[] {
  const rows = tx.all(
    `SELECT * FROM customers
      WHERE business_id = ?${options.includeClosed === true ? "" : " AND active = 1"}
      ORDER BY name`,
    [businessId],
  );
  return rows.map(toCustomer);
}

/**
 * Finds everyone registered to a number.
 *
 * Several, deliberately: a number is how a customer is found at the counter but
 * it is not an identity. A household shares one phone, and returning a single
 * record would be picking one of them arbitrarily.
 */
export function customersByPhone(tx: Queryable, businessId: string, phone: string): Customer[] {
  const rows = tx.all(`SELECT * FROM customers WHERE business_id = ? AND phone = ? ORDER BY name`, [
    businessId,
    phone,
  ]);
  return rows.map(toCustomer);
}

/**
 * What a customer owes: the sum of their ledger, never a stored number (§13).
 *
 * Summed by SQLite rather than by loading every entry, because a regular who has
 * bought on credit for two years has hundreds and a till asking what they owe
 * must not pay for all of them (§46).
 */
export function balanceOf(tx: Queryable, businessId: string, customerId: string): Balance {
  const row = tx.get(
    `SELECT coalesce(sum(amount_minor), 0) AS outstanding, count(*) AS entries
       FROM customer_transactions
      WHERE business_id = ? AND customer_id = ?`,
    [businessId, customerId],
  );
  return {
    outstandingMinor: Number(row?.["outstanding"] ?? 0),
    entries: Number(row?.["entries"] ?? 0),
  };
}

/**
 * Whether a further amount would put a customer past their limit.
 *
 * A question, not a rule this layer enforces. A shopkeeper who lets a regular go
 * over their limit is making a business decision, and §13 lists limits alongside
 * statements as information. What a caller must not do is ask and then ignore
 * the answer silently.
 *
 * A customer with no limit set is never over it: no limit means the shopkeeper
 * has not decided, and refusing on that basis would block every regular who has
 * never been given one.
 */
export function wouldExceedCreditLimit(
  tx: Queryable,
  businessId: string,
  customer: Customer,
  furtherMinor: number,
): boolean {
  if (customer.creditLimitMinor === undefined) {
    return false;
  }
  const { outstandingMinor } = balanceOf(tx, businessId, customer.id);
  return outstandingMinor + furtherMinor > customer.creditLimitMinor;
}

/**
 * The payload a CUSTOMER_SAVED event carries.
 *
 * These names are the wire contract with `CustomerSavedPayload` on the server,
 * which refuses a payload carrying a field it does not know. No business and no
 * device: both come from the authenticated envelope (ADR-008), and taking the
 * device from there is what stops one nominating itself the winner of a tie.
 *
 * No balance either, and there could not be one: what a customer owes is the sum
 * of their ledger, and a field here would be a second answer to it.
 */
function describe(customer: Customer): Record<string, unknown> {
  const described: Record<string, unknown> = {
    id: customer.id,
    name: customer.name,
    created_at: customer.createdAt,
    updated_at: customer.updatedAt,
  };
  const optional: ReadonlyArray<readonly [string, unknown]> = [
    ["phone", customer.phone],
    ["address", customer.address],
    ["notes", customer.notes],
    // Sent when set, including when it is zero — that is the whole point of the
    // distinction, and `omitempty` on the server side keeps the two apart the
    // same way.
    ["credit_limit_minor", customer.creditLimitMinor],
  ];
  for (const [field, value] of optional) {
    if (value !== undefined) {
      described[field] = value;
    }
  }
  // Absent means active, which is what a customer is created as. Sent only when
  // it is the thing that changed.
  if (!customer.active) {
    described["active"] = false;
  }
  return described;
}

function toCustomer(row: Row): Customer {
  const limit = row["credit_limit_minor"];
  const customer: Customer = {
    id: String(row["id"]),
    businessId: String(row["business_id"]),
    name: String(row["name"]),
    active: Number(row["active"]) === 1,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
  return {
    ...customer,
    ...(row["phone"] === null ? {} : { phone: String(row["phone"]) }),
    ...(row["address"] === null ? {} : { address: String(row["address"]) }),
    ...(row["notes"] === null ? {} : { notes: String(row["notes"]) }),
    ...(limit === null || limit === undefined ? {} : { creditLimitMinor: Number(limit) }),
    ...(row["updated_by_device"] === null
      ? {}
      : { updatedByDevice: String(row["updated_by_device"]) }),
  };
}

/**
 * Checks a customer before it reaches the database.
 *
 * The schema checks these too. Doing it here as well means the message names the
 * field rather than a constraint, which is what a person reading an error on a
 * till needs.
 */
function validate(customer: SaveCustomer): void {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["id", customer.id],
    ["businessId", customer.businessId],
    ["name", customer.name],
    ["userId", customer.userId],
    ["deviceId", customer.deviceId],
    ["createdAt", customer.createdAt],
    ["updatedAt", customer.updatedAt],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new CustomerError(`a customer needs a ${field}`);
    }
  }
  if (customer.updatedAt < customer.createdAt) {
    throw new CustomerError("a customer cannot be updated before they were created");
  }
  if (customer.creditLimitMinor !== undefined) {
    if (!Number.isInteger(customer.creditLimitMinor) || customer.creditLimitMinor < 0) {
      throw new CustomerError(
        `a credit limit of ${customer.creditLimitMinor} is not a whole amount at or above zero`,
      );
    }
  }
}
