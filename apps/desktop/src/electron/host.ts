import type { OperationContext, WorkspacePorts } from "@kolo/core/identity/types";
import type { Permission } from "@kolo/core/identity/permissions";
import type { FailureCode } from "../shared/service.js";

/** A stable command failure the host returns as-is; native and storage errors never cross the bridge. */
export class CommandError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(code); this.code = code; }
}
/** What feature modules need from the desktop host: ports and the current actor, never the session itself. */
export interface Host {
  readonly ports: WorkspacePorts;
  /** Validates the session marker and the actor's current permissions, returning the opaque context. */
  actor(data: Record<string, unknown>, required?: readonly Permission[]): OperationContext;
}
/** Local edits of the displayed version win locally even when this clock is behind the stored edit. */
export function nextVersion(host: Host, stored: string): string {
  const now = host.ports.now(); return now > stored ? now : new Date(Date.parse(stored) + 1).toISOString();
}
/** Order-insensitive comparison of retried facts. */
export function sameSet(left: readonly Record<string, unknown>[], right: readonly Record<string, unknown>[]): boolean {
  const key = (items: readonly Record<string, unknown>[]): string => JSON.stringify(items.map(item => JSON.stringify(item)).sort());
  return key(left) === key(right);
}
