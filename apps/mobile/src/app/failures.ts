import { ExchangeError } from "@kolo/core/exchange/types";
import { WorkspaceError } from "@kolo/core/identity/types";
import { TransferError } from "@kolo/core/backup/types";
import { PhotoError } from "@kolo/core/data/products/photos";
import { RuleError } from "@kolo/core/rules/amounts";
import { SyncTransportError } from "@kolo/core/application/server-sync";
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
    : error.code === "scope_mismatch" ? "scopeMismatch" : error.code === "invalid_input" ? "invalidInput"
    : error.code === "role_in_use" ? "roleInUse" : error.code === "duplicate_name" ? "duplicateRole" : "error";
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

const SYNC_REFUSALS: Readonly<Record<string, TextKey>> = {
  invalid_connection_code: "invalidConnectionCode", connection_code_used: "connectionCodeUsed", connection_code_expired: "connectionCodeExpired",
  enrollment_conflict: "enrollmentConflict", shop_suspended: "shopSuspended", shop_removed: "shopRemoved", hosted_service_inactive: "hostedServiceInactive", till_limit_reached: "tillLimitReached", join_not_found: "joinNotFound", join_conflict: "joinConflict",
};
/**
 * Localized description of a failed sync-server command. Server refusals keep their meaning; anything retryable is
 * "unreachable", the rest "refused". Response bodies and network details are never shown.
 */
export function syncFailureKey(error: unknown): TextKey {
  if (error instanceof SyncTransportError) return SYNC_REFUSALS[error.code] ?? (error.retry || error.status === 0 ? "serverUnreachable" : "serverRefused");
  if (error instanceof ExchangeError) {
    if (error.code === "fingerprint_mismatch") return "fingerprintMismatch";
    if (error.code === "invalid_destination") return "invalidServerAddress";
    if (error.code === "untrusted_device") return "serverNotApproved";
    if (error.code === "permission_denied" || error.code === "locked" || error.code === "scope_mismatch") return failureKey(error);
    return "serverRefused";
  }
  if (error instanceof TransferError && error.code === "authentication_failed") return "joinTampered";
  return failureKey(error);
}
