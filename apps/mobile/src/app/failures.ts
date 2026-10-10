import { ExchangeError } from "@kolo/core/exchange/types";
import { WorkspaceError } from "@kolo/core/identity/types";
import { TransferError } from "@kolo/core/backup/types";
import { PhotoError } from "@kolo/core/data/products/photos";
import { RuleError } from "@kolo/core/rules/amounts";
import { transferErrorKey } from "./identity-errors.ts";
import type { TextKey, TextValues } from "./strings.ts";

/** The record changed after this screen read it; the user reloads before saving again. */
export class StaleRecord extends Error { constructor() { super("stale_record"); this.name = "StaleRecord"; } }
/** A validation message already keyed for the user. */
export class FormProblem extends Error {
  readonly key: TextKey; readonly values: TextValues | undefined;
  constructor(key: TextKey, values?: TextValues) { super(key); this.name = "FormProblem"; this.key = key; this.values = values; }
}

/** Stable, localized description of a failed command; native or SQL details are never shown. */
export function failureKey(error: unknown): TextKey {
  if (error instanceof FormProblem) return error.key;
  if (error instanceof StaleRecord) return "changedMeanwhile";
  if (error instanceof ExchangeError) return error.code === "return_conflict" ? "returnConflict" : error.code === "permission_denied" ? "denied" : error.code === "locked" ? "locked" : "error";
  if (error instanceof WorkspaceError) return error.code === "permission_denied" ? "denied" : error.code === "locked" ? "locked" : error.code === "actor_inactive" ? "identity.actor_inactive"
    : error.code === "scope_mismatch" ? "scopeMismatch" : error.code === "invalid_input" ? "invalidInput" : "error";
  if (error instanceof PhotoError) return error.code === "photo_storage_full" ? "photoStorageFull" : "invalidPhoto";
  if (error instanceof TransferError) return transferErrorKey(error);
  if (error instanceof RuleError) return error.code === "overflow" ? "TOO_LARGE" : "INVALID_AMOUNT";
  return "error";
}

/**
 * The version an edit writes: now, or just past the stored version when this clock is behind it, so a
 * local edit wins locally under last-write-wins (as on the desktop).
 */
export function nextVersion(stored: string, now = Date.now()): string {
  const previous = Date.parse(stored);
  return new Date(Number.isFinite(previous) && previous >= now ? previous + 1 : now).toISOString();
}
/** Refuses an edit made from a version that is no longer the stored one. */
export function requireVersion(stored: { readonly updatedAt: string } | undefined, loaded: string): void {
  if (stored === undefined || stored.updatedAt !== loaded) throw new StaleRecord();
}
