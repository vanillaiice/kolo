import { integer } from "../../rules/amounts.ts";

/** Checks SQLite numeric output before exposing money, quantity or counts to JavaScript callers. */
export function sqlInteger(value: unknown): number {
  if (value !== null && value !== undefined && !["number","bigint","string"].includes(typeof value)) throw new Error("invalid SQLite integer");
  const result = Number(value ?? 0);
  integer(result);
  return result;
}
