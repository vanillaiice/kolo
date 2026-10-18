import { WorkspaceError } from "@kolo/core/identity/types";
import { translate, type Language, type TextKey } from "./strings.ts";

const errorKeys: Record<string, TextKey> = {
  invalid_input: "identity.invalid_input",
  invalid_credential: "identity.invalid_credential",
  retry_later: "identity.retry_later",
  recovery_required: "identity.recovery_required",
  credential_unavailable: "identity.credential_unavailable",
  actor_inactive: "identity.actor_inactive",
  permission_denied: "identity.permission_denied",
  scope_mismatch: "identity.scope_mismatch",
  setup_pending: "identity.setup_pending",
};
/** Identity failures disclose no native details or credentials and follow the current language. */
export function workspaceErrorText(error: unknown, language: Language): string {
  if (error instanceof WorkspaceError) {
    const text = translate(language, Object.hasOwn(errorKeys, error.code) ? errorKeys[error.code]! : "identity.failed");
    return error.retryAt === undefined ? text : `${text} ${translate(language, "identity.retryAt", {
      time: new Date(error.retryAt).toLocaleTimeString(language === "fr" ? "fr-FR" : "en-GB"),
    })}`;
  }
  return translate(language, "identity.failedMigration");
}
/** File/identity failures share keyed French/English descriptions without leaking native errors. */
export function transferErrorKey(error: unknown): TextKey {
  const code = error instanceof Error && "code" in error ? String(error.code) : error instanceof Error ? error.message : "";
  const keys: Record<string, TextKey> = {
    authentication_failed: "transferError.authentication_failed",
    invalid_password: "transferError.invalid_password",
    invalid_recovery_key: "transferError.invalid_recovery_key",
    recovery_key_required: "transferError.recovery_key_required",
    untrusted_backup: "transferError.untrusted_backup",
    invalid_file: "transferError.invalid_file",
    invalid_snapshot: "transferError.invalid_snapshot",
    inconsistent_records: "transferError.inconsistent_records",
    sync_keys_unavailable: "transferError.sync_keys_unavailable",
    too_large: "transferError.too_large",
    scope_mismatch: "transferError.scope_mismatch",
    confirmation_required: "transferError.confirmation_required",
    not_empty: "transferError.not_empty",
    pairing_conflict: "transferError.pairing_conflict",
    pairing_expired: "transferError.pairing_expired",
    pairing_pending: "transferError.pairing_pending",
    invalid_pairing: "transferError.invalid_pairing",
    untrusted_device: "transferError.untrusted_device",
    invalid_signature: "transferError.invalid_signature",
    locked: "transferError.locked",
    invalid_input: "transferError.invalid_input",
    invalid_credential: "transferError.invalid_credential",
    retry_later: "transferError.retry_later",
    permission_denied: "transferError.permission_denied",
    unsupported_version: "transferError.unsupported_version",
    activation_failed: "transferError.activation_failed",
    invalid_destination: "transferError.invalid_destination",
  };
  return Object.hasOwn(keys, code) ? keys[code]! : "transferError.failed";
}
