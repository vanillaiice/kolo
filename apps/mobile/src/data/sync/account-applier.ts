/**
 * Applies ACCOUNT_SAVED events from other devices.
 *
 * This is what §10 actually means in practice: the owner opens Orange Money on
 * their phone, and the till at the counter can take money into it after the next
 * sync — without a new build.
 *
 * The payload shape is the wire contract, matching `AccountSavedPayload` in
 * backend/internal/app/syncing and what `accounts.ts` sends.
 */

import type { Queryable } from "../database/driver.ts";
import { upsertAccount, type Account, type AccountKind } from "../finance/accounts.ts";
import { UnusableEvent, type EventApplier } from "./engine.ts";
import type { InboxEvent } from "./inbox.ts";

/** The event type this applier handles. */
export const ACCOUNT_SAVED = "ACCOUNT_SAVED";

const KINDS: readonly string[] = ["CASH", "MOBILE_MONEY", "BANK", "CARD", "OTHER"];

/** Applies account edits arriving from other devices. */
export const accountApplier: EventApplier = {
  types: [ACCOUNT_SAVED],

  apply(tx: Queryable, event: InboxEvent): void {
    const wire = accountOf(event);
    const kind = required(wire, "kind");
    if (!KINDS.includes(kind)) {
      // A kind this build does not know would decide whether the account is
      // counted against a drawer, so it is refused rather than guessed at.
      throw new UnusableEvent(`${kind} is not a kind of account this build knows`);
    }

    const account: Account = {
      id: required(wire, "id"),
      // Business and device come from the envelope, never the payload (ADR-008).
      businessId: event.businessId,
      name: required(wire, "name"),
      kind: kind as AccountKind,
      // Not on the wire: everything is XAF (§46).
      currency: "XAF",
      number: optional(wire, "number"),
      notes: optional(wire, "notes"),
      active: flag(wire, "active", true),
      createdAt: required(wire, "created_at"),
      updatedAt: required(wire, "updated_at"),
    };

    // The return is ignored: a losing edit means this device already holds a
    // later one, and the event is fully handled either way.
    upsertAccount(tx, account, event.deviceId);
  },
};

type Wire = Record<string, unknown>;

function accountOf(event: InboxEvent): Wire {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new UnusableEvent("an account event's payload is not an object");
  }
  const account = (payload as { account?: unknown }).account;
  if (typeof account !== "object" || account === null) {
    throw new UnusableEvent("an account event carries no account");
  }
  return account as Wire;
}

function required(wire: Wire, field: string): string {
  const value = wire[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UnusableEvent(`an account needs a ${field}`);
  }
  return value;
}

function optional(wire: Wire, field: string): string | undefined {
  const value = wire[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new UnusableEvent(`an account's ${field} must be text`);
  }
  return value;
}

function flag(wire: Wire, field: string, fallback: boolean): boolean {
  const value = wire[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new UnusableEvent(`an account's ${field} must be true or false`);
  }
  return value;
}
