/** Typed calls to the dashboard API on the same origin. The session lives in an HttpOnly cookie the page never reads. */

export type Role = "admin" | "viewer";
export type Edition = "selfhost" | "hosted";
export type Service = "unlimited" | "active" | "grace" | "inactive";
export interface Me { readonly username: string; readonly role: Role; readonly idleMinutes: number; readonly expiresAt?: string; readonly confirmedUntil?: string | null }
export type CodeState = "unused" | "used" | "expired" | "cancelled";
export interface Code { readonly codeId: string; readonly label: string; readonly createdBy: string; readonly createdAt: string; readonly expiresAt: string;
  readonly state: CodeState; readonly usedAt: string | null; readonly shopId: string | null; readonly shopName: string | null; readonly includedMonths: number; readonly recoveryShopId: string | null;
  /** Trial days and the till limit the shop starts with (null unlimited; ADR-039). */
  readonly includedDays: number; readonly maxTills: number | null }
export interface Issued { readonly codeId: string; readonly code: string; readonly label: string; readonly expiresAt: string; readonly qr: string }
export type ShopStatus = "active" | "suspended" | "removed";
export interface Shop { readonly shopId: string; readonly name: string; readonly status: ShopStatus; readonly enrolledAt: string;
  readonly removeAfter: string | null; readonly devices: number; readonly lastSeenAt: string | null; readonly facts: number; readonly bytes: number;
  readonly service: Service; readonly paidUntil: string | null;
  /** Till limit (null unlimited) and tills waiting for a place; `devices` counts those holding one. */
  readonly maxTills: number | null; readonly heldTills: number }
export type Method = "cash" | "mtn_momo" | "orange_money" | "bank" | "card" | "other";
export interface Payment { readonly paymentId: string; readonly months: number; readonly days: number; readonly amountMinor: number; readonly method: Method; readonly reference: string | null;
  readonly source: "manual" | "webhook" | "code"; readonly recordedBy: string; readonly recordedAt: string; readonly paidUntilAfter: string }
export interface AuditEntry { readonly id: string; readonly seq: string; readonly hash: string; readonly at: string; readonly username: string; readonly action: string; readonly target: string | null; readonly address: string | null; readonly detail: Record<string, unknown> | null }
export interface ShopDetail extends Shop {
  readonly ownerId: string; readonly conflicts: number; readonly keyEpoch: number | null; readonly connectionCode: string | null;
  readonly graceUntil: string | null; readonly payments: readonly Payment[]; readonly edition: Edition; readonly activity: readonly AuditEntry[];
  readonly deviceList: readonly { readonly deviceId: string; readonly label: string; readonly platform: string; readonly active: boolean; readonly held: boolean; readonly authority: boolean; readonly lastSeenAt: string | null; readonly backlog: number }[];
}
export interface Health { readonly version: string; readonly edition: Edition; readonly graceDays: number; readonly startedAt: string; readonly databaseBytes: number; readonly facts: number; readonly factsLastDay: number;
  readonly activeSessions: number; readonly shops: Record<ShopStatus, number>;
  readonly requests: number; readonly clientErrors: number; readonly serverErrors: number; readonly rateLimited: number;
  readonly migrations: readonly { readonly name: string; readonly appliedAt: string }[];
  readonly runtime: { readonly node: string; readonly postgres: string; readonly memoryBytes: number; readonly uptimeSeconds: number } }
export type AttentionKind = "service_inactive" | "service_grace" | "service_expiring" | "held_tills" | "conflicts" | "stale_shop" | "code_expiring" | "purge_soon" | "server_errors" | "integrity";
export interface Attention { readonly kind: AttentionKind; readonly target: string | null; readonly label: string; readonly at: string | null; readonly count: number | null }
export interface Overview { readonly edition: Edition; readonly shops: Record<ShopStatus, number>; readonly services: Record<"active" | "grace" | "inactive", number> | null;
  readonly tills: { readonly used: number; readonly held: number }; readonly factsLastDay: number; readonly unusedCodes: number;
  readonly activity: readonly { readonly day: string; readonly facts: number }[]; readonly revenue: { readonly amountMinor: number; readonly payments: number; readonly days: number } | null;
  readonly attention: readonly Attention[]; readonly integrity: { readonly ok: boolean; readonly failing: readonly string[] } }
export type CheckName = "audit_chain" | "payment_chain" | "paid_until" | "held_with_free_places" | "sessions_on_stopped_shops" | "purge_overdue";
export interface Integrity { readonly ok: boolean; readonly checkedAt: string; readonly checks: readonly { readonly name: CheckName; readonly ok: boolean; readonly targets: readonly string[] }[];
  readonly audit: { readonly entries: number; readonly headSeq: string | null; readonly headHash: string | null } }
export interface Billing { readonly from: string; readonly to: string; readonly payments: readonly (Payment & { readonly shopId: string; readonly shopName: string })[];
  readonly total: { readonly payments: number; readonly amountMinor: number };
  readonly byMethod: readonly { readonly key: Method; readonly payments: number; readonly amountMinor: number }[]; readonly bySource: readonly { readonly key: Payment["source"]; readonly payments: number; readonly amountMinor: number }[];
  readonly ending: readonly { readonly shopId: string; readonly name: string; readonly paidUntil: string | null; readonly service: Service }[] }
export interface SessionView { readonly id: string; readonly createdAt: string; readonly lastSeenAt: string; readonly expiresAt: string; readonly address: string; readonly current: boolean }
export interface Operator { readonly adminId: string; readonly username: string; readonly role: Role; readonly active: boolean; readonly locked: boolean; readonly createdAt: string; readonly lastLoginAt: string | null; readonly sessions: number }
export interface Enrolment { readonly username: string; readonly uri: string; readonly qr: string; readonly password?: string }

/** A refusal with the server's stable code; `signed_out` sends the person back to sign-in, `step_up_required` asks to confirm. */
export class ApiError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

/** When the operator last did something; a background refresh does not count (the server ignores it too). */
export const activity = { last: Date.now() };

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, poll = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (poll) headers["x-kolo-poll"] = "1"; else activity.last = Date.now();
  let response: Response;
  try {
    response = await fetch(`/admin/api${path}`, { method, credentials: "same-origin", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new ApiError("network", 0); }
  if (response.status === 204) return undefined as T;
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = typeof value === "object" && value !== null && "error" in value ? String((value as { error: { code?: unknown } }).error.code ?? "internal") : "internal";
    throw new ApiError(code, response.status);
  }
  return value as T;
}

/** A query string from the defined, non-empty values. */
export function query(values: Readonly<Record<string, string | number | undefined | null>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export const api = {
  me: () => call<Me>("GET", "/me"),
  config: () => call<{ totp: boolean }>("GET", "/config"),
  signIn: (username: string, password: string, code: string) => call<Me>("POST", "/session", code === "" ? { username, password } : { username, password, code }),
  signOut: () => call<void>("DELETE", "/session"),
  /** Step-up: password and a fresh code again; sensitive changes are allowed for a few minutes afterwards. */
  confirm: (password: string, code: string) => call<Me>("POST", "/session/confirm", code === "" ? { password } : { password, code }),
  overview: (poll = false) => call<Overview>("GET", "/overview", undefined, poll),
  health: (poll = false) => call<Health>("GET", "/health", undefined, poll),
  integrity: () => call<Integrity>("GET", "/integrity"),
  codes: (search: string) => call<{ codes: Code[]; total: number; canIssue: boolean; publicUrl: string | null; edition: Edition }>("GET", `/codes${search}`),
  /** `maxTills` null is unlimited; a hosted server requires the choice to be sent. */
  issue: (input: { label: string; days: number; includedMonths?: number; includedDays?: number; maxTills: number | null }) => call<Issued>("POST", "/codes", input),
  /** An owner-recovery code for an existing shop whose tills were all lost (ADR-036). */
  issueRecovery: (shopId: string) => call<Issued>("POST", "/codes", { label: "", days: 1, recoveryShopId: shopId }),
  cancel: (codeId: string) => call<void>("POST", `/codes/${codeId}/cancel`),
  shops: (search: string) => call<{ shops: Shop[]; total: number; edition: Edition }>("GET", `/shops${search}`),
  shop: (shopId: string) => call<ShopDetail>("GET", `/shops/${shopId}`),
  /** `requestId` is generated once per form fill, so a retry records the payment once. */
  pay: (shopId: string, input: { months: number; amountMinor: number; method: Method; reference?: string; requestId: string }) => call<{ paidUntilAfter: string; duplicate: boolean }>("POST", `/shops/${shopId}/payments`, input),
  /** Sets or clears (null) a shop's till limit from the value the operator saw; returns how many waiting tills were released. */
  setTillLimit: (shopId: string, maxTills: number | null, expected: number | null) => call<{ released: number }>("POST", `/shops/${shopId}/till-limit`, { maxTills, expected }),
  shopAction: (shopId: string, action: "suspend" | "resume" | "remove" | "restore") => call<void>("POST", `/shops/${shopId}/${action}`, action === "remove" ? { confirm: shopId } : undefined),
  audit: (search: string) => call<{ entries: AuditEntry[] }>("GET", `/audit${search}`),
  billing: (search: string) => call<Billing>("GET", `/billing${search}`),
  sessions: () => call<{ sessions: SessionView[] }>("GET", "/account/sessions"),
  revokeSession: (id: string) => call<void>("DELETE", `/account/sessions/${id}`),
  signOutOthers: () => call<{ ended: number }>("POST", "/account/sessions/sign-out-others"),
  changePassword: (password: string) => call<void>("POST", "/account/password", { password }),
  operators: () => call<{ operators: Operator[]; totp: boolean }>("GET", "/operators"),
  createOperator: (username: string, role: Role) => call<Enrolment & { adminId: string; password: string }>("POST", "/operators", { username, role }),
  resetOperator: (adminId: string) => call<Enrolment>("POST", `/operators/${adminId}/reset-totp`),
  setRole: (adminId: string, role: Role) => call<void>("POST", `/operators/${adminId}/role`, { role }),
  changeOperator: (adminId: string, action: "deactivate" | "activate" | "unlock") => call<void>("POST", `/operators/${adminId}/${action}`),
};
