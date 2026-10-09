import type { Queryable } from "../database/driver.ts";
import type { Permission } from "../../rules/permissions.ts";

/** @internal Transaction-bound claims issued only by authorized application operations. */
export interface JournalContext { readonly businessId: string; readonly userId: string; readonly deviceId: string; readonly revision: number; readonly permissions: readonly Permission[]; }
const scopes = new WeakMap<Queryable, JournalContext>();
/** @internal Nested authority checks accumulate required capabilities for the resulting event. */
export function journalContext(tx: Queryable): JournalContext | undefined { return scopes.get(tx); }
/** @internal Restored synchronously after the command; async work cannot retain this transaction capability. */
export function withinJournalContext<T>(tx: Queryable, context: JournalContext, work: () => T): T {
  const previous = scopes.get(tx);
  scopes.set(tx, { ...context, permissions: [...new Set([...(previous?.permissions ?? []), ...context.permissions])].sort() });
  try { return work(); } finally { if (previous === undefined) scopes.delete(tx); else scopes.set(tx, previous); }
}
