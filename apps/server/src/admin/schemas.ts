/**
 * JSON schemas for the operator dashboard API (ADR-045). They check shape and types only: unknown fields are refused,
 * nothing is coerced, and ranges stay with the operations so their stable error codes do not change. Query strings
 * arrive as text and are declared as patterned strings, then parsed by the route.
 */

const object = (properties: Record<string, unknown>, required: readonly string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const text = (maxLength: number) => ({ type: "string", maxLength });
const digits = (max: number) => ({ type: "string", pattern: `^\\d{1,${max}}$` });
const instant = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?(Z|[+-]\\d{2}:\\d{2}))?$" };
const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const tills = { type: ["integer", "null"] };

/** Path parameters: an ID that is not a UUID is simply not found. */
export const idParams = object({ id: uuid }, ["id"]);
export const actionParams = object({ id: uuid, action: text(20) }, ["id", "action"]);
export const sessionParams = object({ id: { type: "string", pattern: "^[a-f0-9]{16}$" } }, ["id"]);

export const signInBody = object({ username: text(200), password: text(1024), code: text(12) }, ["username", "password"]);
export const confirmBody = object({ password: text(1024), code: text(12) }, ["password"]);
export const passwordBody = object({ password: text(1024) }, ["password"]);
export const issueBody = object({ label: text(500), days: { type: "integer" }, includedMonths: { type: "integer" }, includedDays: { type: "integer" }, maxTills: tills, recoveryShopId: text(64) }, ["label", "days"]);
export const paymentBody = object({ months: { type: "integer" }, amountMinor: { type: "integer" }, method: text(40), reference: text(500), requestId: uuid }, ["months", "amountMinor", "method", "requestId"]);
export const tillLimitBody = object({ maxTills: tills, expected: tills }, ["maxTills"]);
export const operatorBody = object({ username: text(200), role: { enum: ["admin", "viewer"] } }, ["username", "role"]);
export const roleBody = object({ role: { enum: ["admin", "viewer"] } }, ["role"]);

export const shopsQuery = object({ search: text(120), status: { enum: ["active", "suspended", "removed"] }, service: { enum: ["active", "grace", "inactive"] },
  sort: { enum: ["lastSeen", "name", "enrolled", "facts", "bytes", "paidUntil"] }, dir: { enum: ["asc", "desc"] }, offset: digits(7), limit: digits(4) });
export const codesQuery = object({ state: { enum: ["unused", "used", "expired", "cancelled"] }, offset: digits(7), limit: digits(3) });
export const auditQuery = object({ before: digits(19), action: text(64), username: text(64), target: text(200), from: instant, to: instant, limit: digits(4) });
export const billingQuery = object({ from: instant, to: instant, offset: digits(7), limit: digits(4) });

/** The stable code a malformed field earns, so a wrong type reads like the same field out of range. */
export const FIELD_CODES: Readonly<Record<string, string>> = {
  label: "invalid_label", days: "invalid_expiry", includedMonths: "invalid_months", months: "invalid_months", includedDays: "invalid_trial_days",
  maxTills: "invalid_till_limit", expected: "invalid_till_limit", amountMinor: "invalid_amount", method: "invalid_method", reference: "invalid_reference",
  role: "invalid_role", username: "invalid_username",
};
