import { WorkspaceError } from "@kolo/core/identity/types";
import type { PageQuery } from "@kolo/core/application/queries";

/** Strict IPC object parser: rejects unknown fields, arrays and exotic prototypes. */
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Object.keys(value).some(key => !keys.includes(key))) throw new WorkspaceError("invalid_input");
  return value as Record<string, unknown>;
}
/** Bounded strings are checked before any database/native call; secrets retain intentional whitespace. */
export function text(value: unknown, maximum = 120, trim = true): string {
  if (typeof value !== "string" || value.length > maximum || value.trim() === "") throw new WorkspaceError("invalid_input");
  return trim ? value.trim() : value;
}
/** Lowercase RFC UUIDs are portable record/request identities; native event IDs use the host UUIDv7 port. */
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new WorkspaceError("invalid_input");
  return value;
}
/** Numbers crossing IPC never coerce strings, fractional values, NaN or unsafe integers. */
export function whole(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new WorkspaceError("invalid_input");
  return value;
}
/** Explicit boolean input, never truthiness. */
export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new WorkspaceError("invalid_input");
  return value;
}
/** Absent optional fields stay absent; present ones must pass their own parser. */
export function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}
/** Bounded pagination/search, with no renderer-selected tenant or SQL. */
export function page(input: Record<string, unknown>): PageQuery {
  const result: { term?: string; after?: { name: string; id: string }; limit?: number; includeInactive?: boolean } = {};
  if (input["includeInactive"] !== undefined) result.includeInactive = boolean(input["includeInactive"]);
  if (input["term"] !== undefined) {
    if (typeof input["term"] !== "string" || input["term"].length > 120) throw new WorkspaceError("invalid_input");
    result.term = input["term"];
  }
  if (input["limit"] !== undefined) { result.limit = whole(input["limit"], 1); if (result.limit > 100) throw new WorkspaceError("invalid_input"); }
  if (input["after"] !== undefined) {
    const cursor = object(input["after"], ["name", "id"]);
    result.after = { name: text(cursor["name"], 120, false), id: uuid(cursor["id"]) };
  }
  return result;
}
