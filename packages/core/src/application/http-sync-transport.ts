import { bootstrapResponseSchema, challengeSchema, entitlementSchema, joinEnrollmentSchema, joinOfferSchema, joinRequestSchema, pullResponseSchema, pushResponseSchema, receiptResponseSchema, serverIdentitySchema,
  sessionSchema, syncErrorSchema, syncStatusSchema, PULL_MAX_LIMIT } from "@kolo/contracts/sync";
import { canonicalJson } from "@kolo/contracts/canonical";
import { MAX_ENCRYPTED_FILE_BYTES } from "@kolo/contracts/transfer";
import type { JoinEnrollment, JoinRequestBody } from "@kolo/contracts/sync";
import { normalizeServerUrl, SyncTransportError, type SyncTransport } from "./server-sync.ts";

/** Any shared contract schema; avoids a direct validation-library dependency in core. */
interface Schema<T> { safeParse(value: unknown): { success: true; data: T } | { success: false } }

/** Minimal `fetch` shape, so mobile, desktop and tests can each supply their platform implementation. */
export type FetchPort = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect?: "error" }) =>
  Promise<{ readonly status: number; text(): Promise<string> }>;

/**
 * HTTP implementation of the sync transport. Responses are bounded and validated against the shared
 * contracts before use; the server's error codes are passed through, never its bodies or internals.
 */
export function createHttpSyncTransport(baseUrl: string, options: { readonly fetch?: FetchPort; readonly timeoutMs?: number } = {}): SyncTransport {
  const root = `${normalizeServerUrl(baseUrl)}/api/v2`, timeoutMs = options.timeoutMs ?? 30_000;
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  async function call<T>(method: "GET" | "POST" | "DELETE", path: string, schema: Schema<T> | undefined, body?: unknown, token?: string): Promise<T> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
    let payload: string | undefined;
    if (body !== undefined) { headers["content-type"] = "application/json"; payload = canonicalJson(body, MAX_ENCRYPTED_FILE_BYTES + 64 * 1024); }
    let status: number, text: string;
    try {
      const response = await send(`${root}${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }), signal: controller.signal });
      status = response.status; text = await response.text();
    } catch { throw new SyncTransportError("network_unavailable", 0, true); }
    finally { clearTimeout(timer); }
    if (text.length > MAX_ENCRYPTED_FILE_BYTES + 65_536) throw new SyncTransportError("invalid_response", status, true);
    let value: unknown;
    try { value = text === "" ? undefined : JSON.parse(text); } catch { throw new SyncTransportError("invalid_response", status, true); }
    if (status < 200 || status >= 300) {
      const error = syncErrorSchema.safeParse(value);
      const code = error.success ? error.data.error.code : "http_error";
      throw new SyncTransportError(code, status, error.success && error.data.error.retry !== undefined ? error.data.error.retry : status === 429 || status >= 500);
    }
    if (schema === undefined) return undefined as T;
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new SyncTransportError("invalid_response", status, false);
    return parsed.data;
  }
  return {
    identity: () => call("GET", "/server", serverIdentitySchema),
    challenge: input => call("POST", input.purpose === "enrollment" ? "/enrollment/challenges" : "/auth/challenges", challengeSchema, input),
    enroll: async input => { await call("POST", "/enrollment/complete", undefined, input); },
    session: input => call("POST", "/auth/sessions", sessionSchema, input),
    endSession: async token => { await call("DELETE", "/auth/session", undefined, undefined, token); },
    bootstrap: token => call("GET", "/sync/bootstrap", bootstrapResponseSchema, undefined, token),
    push: (token, batch) => call("POST", "/sync/push", pushResponseSchema, batch, token),
    pull: (token, cursor, limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > PULL_MAX_LIMIT) throw new SyncTransportError("invalid_request", 0, false);
      const query = new URLSearchParams({ limit: String(limit), ...(cursor === null ? {} : { cursor }) });
      return call("GET", `/sync/pull?${query.toString()}`, pullResponseSchema, undefined, token);
    },
    receipt: async (token, receipt) => (await call("POST", "/sync/receipts", receiptResponseSchema, receipt, token)).acknowledged,
    status: token => call("GET", "/sync/status", syncStatusSchema, undefined, token),
    entitlements: token => call("GET", "/entitlements", entitlementSchema, undefined, token),
    joinCreate: (token, offer) => call("POST", "/join", { safeParse: (value: unknown) => typeof value === "object" && value !== null && typeof (value as { expires_at?: unknown }).expires_at === "string" ? { success: true as const, data: value as { expires_at: string } } : { success: false as const } }, offer, token),
    joinRead: joinId => call("GET", `/join/${joinId}`, joinOfferSchema),
    joinRequest: async (joinId, body) => { await call("POST", `/join/${joinId}/request`, undefined, body); },
    joinPollRequest: async (token, joinId) => (await call("GET", `/join/${joinId}/request`, { safeParse: (value: unknown) => value === undefined ? { success: true as const, data: null } : joinRequestSchema.safeParse(value) }, undefined, token)) as JoinRequestBody | null,
    joinEnroll: async (token, joinId, body) => { await call("POST", `/join/${joinId}/enrollment`, undefined, body, token); },
    joinPollEnrollment: async joinId => (await call("GET", `/join/${joinId}/enrollment`, { safeParse: (value: unknown) => value === undefined ? { success: true as const, data: null } : joinEnrollmentSchema.safeParse(value) })) as JoinEnrollment | null,
    joinCancel: async (token, joinId) => { await call("DELETE", `/join/${joinId}`, undefined, undefined, token); },
  };
}
