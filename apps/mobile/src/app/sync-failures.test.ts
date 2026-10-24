import assert from "node:assert/strict";
import { it } from "node:test";
import { SyncTransportError } from "@kolo/core/application/server-sync";
import { ExchangeError } from "@kolo/core/exchange/types";
import { FormProblem, syncFailureKey } from "./failures.ts";
import { strings } from "./strings.ts";

it("sync failures keep the server's meaning, never its details, and every key has both languages", () => {
  const cases: [unknown, string][] = [
    [new SyncTransportError("connection_code_used", 403, false), "connectionCodeUsed"],
    [new SyncTransportError("connection_code_expired", 403, false), "connectionCodeExpired"],
    [new SyncTransportError("invalid_connection_code", 403, false), "invalidConnectionCode"],
    [new SyncTransportError("enrollment_conflict", 409, false), "enrollmentConflict"],
    [new SyncTransportError("shop_suspended", 403, false), "shopSuspended"],
    [new SyncTransportError("shop_removed", 403, false), "shopRemoved"],
    [new SyncTransportError("hosted_service_inactive", 403, false), "hostedServiceInactive"],
    [new SyncTransportError("till_limit_reached", 403, false), "tillLimitReached"],
    [new SyncTransportError("network_unavailable", 0, true), "serverUnreachable"],
    [new SyncTransportError("rate_limited", 429, true), "serverUnreachable"],
    [new SyncTransportError("invalid_session", 401, false), "serverRefused"],
    [new SyncTransportError("something_new", 400, false), "serverRefused"],
    [new ExchangeError("fingerprint_mismatch"), "fingerprintMismatch"],
    [new ExchangeError("invalid_destination"), "invalidServerAddress"],
    [new ExchangeError("untrusted_device"), "serverNotApproved"],
    [new ExchangeError("permission_denied"), "denied"],
    [new ExchangeError("invalid_signature"), "serverRefused"],
    [new FormProblem("invalidCode"), "invalidCode"],
    [new Error("ECONNREFUSED 10.0.0.1 secret detail"), "error"],
  ];
  for (const [error, key] of cases) {
    assert.equal(syncFailureKey(error), key, String((error as Error).message));
    const entry = (strings as Record<string, readonly [string, string]>)[key];
    assert.ok(entry !== undefined && entry[0].length > 0 && entry[1].length > 0, key);
  }
});
