/** Typed calls to the dashboard API on the same origin. The session lives in an HttpOnly cookie the page never reads. */

export type Role = "admin" | "viewer";
export interface Me { readonly username: string; readonly role: Role; readonly idleMinutes: number }
export interface Code { readonly codeId: string; readonly label: string; readonly createdBy: string; readonly createdAt: string; readonly expiresAt: string;
  readonly state: "unused" | "used" | "expired" | "cancelled"; readonly usedAt: string | null; readonly shopId: string | null; readonly shopName: string | null; readonly includedMonths: number; readonly recoveryShopId: string | null }
export interface Issued { readonly codeId: string; readonly code: string; readonly label: string; readonly expiresAt: string; readonly qr: string }
export interface Shop { readonly shopId: string; readonly name: string; readonly status: "active" | "suspended" | "removed"; readonly enrolledAt: string;
  readonly removeAfter: string | null; readonly devices: number; readonly lastSeenAt: string | null; readonly facts: number; readonly bytes: number;
  readonly service: "unlimited" | "active" | "grace" | "inactive"; readonly paidUntil: string | null }
export type Method = "cash" | "mtn_momo" | "orange_money" | "bank" | "card" | "other";
export interface Payment { readonly paymentId: string; readonly months: number; readonly amountMinor: number; readonly method: Method; readonly reference: string | null;
  readonly source: "manual" | "webhook" | "code"; readonly recordedBy: string; readonly recordedAt: string; readonly paidUntilAfter: string }
export interface ShopDetail extends Shop {
  readonly ownerId: string; readonly conflicts: number; readonly keyEpoch: number | null; readonly connectionCode: string | null;
  readonly graceUntil: string | null; readonly payments: readonly Payment[]; readonly edition: "selfhost" | "hosted";
  readonly deviceList: readonly { readonly deviceId: string; readonly label: string; readonly platform: string; readonly active: boolean; readonly authority: boolean; readonly lastSeenAt: string | null; readonly backlog: number }[];
}
export interface Health { readonly version: string; readonly edition: "selfhost" | "hosted"; readonly graceDays: number; readonly startedAt: string; readonly databaseBytes: number; readonly facts: number; readonly factsLastDay: number;
  readonly activeSessions: number; readonly shops: { readonly active: number; readonly suspended: number; readonly removed: number };
  readonly requests: number; readonly clientErrors: number; readonly serverErrors: number; readonly rateLimited: number;
  readonly migrations: readonly { readonly name: string; readonly appliedAt: string }[] }
export interface AuditEntry { readonly id: string; readonly at: string; readonly username: string; readonly action: string; readonly target: string | null; readonly address: string | null; readonly detail: Record<string, unknown> | null }

/** A refusal with the server's stable code; `signed_out` sends the person back to sign-in. */
export class ApiError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/admin/api${path}`, { method, credentials: "same-origin", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new ApiError("network", 0); }
  if (response.status === 204) return undefined as T;
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = typeof value === "object" && value !== null && "error" in value ? String((value as { error: { code?: unknown } }).error.code ?? "internal") : "internal";
    throw new ApiError(code, response.status);
  }
  return value as T;
}

export const api = {
  me: () => call<Me>("GET", "/me"),
  config: () => call<{ totp: boolean }>("GET", "/config"),
  signIn: (username: string, password: string, code: string) => call<Me>("POST", "/session", { username, password, code }),
  signOut: () => call<void>("DELETE", "/session"),
  health: () => call<Health>("GET", "/health"),
  codes: () => call<{ codes: Code[]; canIssue: boolean; publicUrl: string | null }>("GET", "/codes"),
  issue: (label: string, days: number, includedMonths: number) => call<Issued>("POST", "/codes", { label, days, includedMonths }),
  /** An owner-recovery code for an existing shop whose tills were all lost (ADR-036). */
  issueRecovery: (shopId: string) => call<Issued>("POST", "/codes", { label: "", days: 1, recoveryShopId: shopId }),
  cancel: (codeId: string) => call<void>("POST", `/codes/${codeId}/cancel`),
  shops: (search: string) => call<{ shops: Shop[]; edition: "selfhost" | "hosted" }>("GET", `/shops?search=${encodeURIComponent(search)}`),
  pay: (shopId: string, months: number, amountMinor: number, method: Method, reference: string) => call<{ paidUntilAfter: string }>("POST", `/shops/${shopId}/payments`, { months, amountMinor, method, reference }),
  shop: (shopId: string) => call<ShopDetail>("GET", `/shops/${shopId}`),
  shopAction: (shopId: string, action: "suspend" | "resume" | "remove" | "restore") => call<void>("POST", `/shops/${shopId}/${action}`, action === "remove" ? { confirm: shopId } : {}),
  audit: (before?: string) => call<{ entries: AuditEntry[] }>("GET", `/audit${before === undefined ? "" : `?before=${before}`}`),
};
