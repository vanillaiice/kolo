import type { Queryable } from "../data/database/driver.ts";
import { sqlInteger } from "../data/database/safe-values.ts";
import { agedParties } from "../data/finance/terms.ts";
import { activeMember, authorizedOperation, memberPermissions } from "../identity/internal-authority.ts";
import { WorkspaceError, type OperationContext } from "../identity/types.ts";
import type { Permission } from "../identity/permissions.ts";

/**
 * Local notifications (ADR-033, spec §49).
 *
 * Derived on demand from this device's SQLite: nothing is stored about a condition except this user's read and
 * announced marks, keyed by a stable key and the fingerprint of the facts that made it. A changed fingerprint makes a
 * notification unread (and unannounced) again; a condition that clears simply disappears. Each kind is included only
 * for actors holding its permission, so a cashier is not told about supplier debts. Clients localize from `kind` and
 * `facts`; no display text is produced here.
 */

/** What a notification is about. */
export type NotificationKind = "stock_low" | "stock_negative" | "customer_overdue" | "supplier_overdue" | "supplier_due_soon" | "cash_difference" | "sync_refused" | "sync_stalled" | "service_grace" | "service_paused";

/** One current notification. Amounts are XAF, quantities thousandths, times ISO instants. */
export interface ShopNotification {
  /** Stable for the subject: `<kind family>:<subject id>`. */
  readonly key: string;
  readonly kind: NotificationKind;
  readonly severity: "warning" | "critical";
  /** The product, customer, supplier, account or sync destination concerned. */
  readonly subjectId: string;
  /** Its display name (product, customer, supplier or account name; server address for sync). */
  readonly name: string;
  readonly facts: {
    readonly onHandThousandths?: number; readonly minimumThousandths?: number;
    readonly overdueMinor?: number; readonly dueSoonMinor?: number; readonly balanceMinor?: number; readonly oldestDueAt?: string; readonly nextDueAt?: string;
    readonly expectedMinor?: number; readonly countedMinor?: number; readonly differenceMinor?: number; readonly countedAt?: string;
    readonly error?: string; readonly lastSuccessAt?: string; readonly graceUntil?: string;
  };
  readonly fingerprint: string;
  readonly read: boolean;
  readonly announced: boolean;
}

/** Sync failures that retrying alone will not fix, so they are worth telling someone about straight away. */
const REFUSALS = new Set(["shop_suspended", "shop_removed", "invalid_session", "untrusted_device", "permission_denied", "scope_mismatch", "invalid_signature", "something_new", "key_missing"]);
/** How long a till may go without a successful pass, with facts waiting, before it says so. */
const STALL_MS = 24 * 3_600_000;
const SEVERITY: Readonly<Record<NotificationKind, ShopNotification["severity"]>> = {
  stock_low: "warning", stock_negative: "critical", customer_overdue: "warning", supplier_overdue: "critical", supplier_due_soon: "warning",
  cash_difference: "critical", sync_refused: "critical", sync_stalled: "warning", service_grace: "warning", service_paused: "critical",
};
const ORDER: readonly NotificationKind[] = ["service_paused", "sync_refused", "cash_difference", "stock_negative", "supplier_overdue", "customer_overdue", "supplier_due_soon", "service_grace", "sync_stalled", "stock_low"];

type Draft = Omit<ShopNotification, "read" | "announced" | "severity">;

function stock(tx: Queryable, businessId: string): Draft[] {
  return tx.all(`SELECT p.id, p.name, p.minimum_stock, coalesce(sum(m.quantity), 0) AS on_hand
      FROM products p LEFT JOIN inventory_movements m ON m.business_id = p.business_id AND m.product_id = p.id
     WHERE p.business_id = ? AND p.active = 1
     GROUP BY p.id, p.name, p.minimum_stock
    HAVING on_hand < 0 OR (p.minimum_stock > 0 AND on_hand <= p.minimum_stock)`, [businessId]).map(row => {
    const onHand = sqlInteger(row["on_hand"]), negative = onHand < 0, id = String(row["id"]);
    // Further sales of a low product do not re-raise it; falling below zero does.
    return { key: `stock:${id}`, kind: negative ? "stock_negative" : "stock_low", subjectId: id, name: String(row["name"]),
      facts: { onHandThousandths: onHand, minimumThousandths: sqlInteger(row["minimum_stock"]) }, fingerprint: negative ? "negative" : "low" };
  });
}

function debts(tx: Queryable, businessId: string, now: string, party: "CUSTOMER" | "SUPPLIER"): Draft[] {
  const result: Draft[] = [];
  for (const aged of agedParties(tx, businessId, party, now)) {
    const facts = { balanceMinor: aged.balanceMinor, overdueMinor: aged.overdueMinor, dueSoonMinor: aged.dueSoonMinor,
      ...(aged.oldestDueAt === undefined ? {} : { oldestDueAt: aged.oldestDueAt }), ...(aged.nextDueAt === undefined ? {} : { nextDueAt: aged.nextDueAt }) };
    if (aged.overdueMinor > 0) {
      // Payments do not re-raise it; another debt falling due does.
      result.push({ key: `${party === "CUSTOMER" ? "customer" : "supplier"}:${aged.partyId}`, kind: party === "CUSTOMER" ? "customer_overdue" : "supplier_overdue",
        subjectId: aged.partyId, name: aged.name, facts, fingerprint: `overdue:${aged.lastPassedDueAt ?? aged.oldestDueAt ?? ""}` });
    } else if (party === "SUPPLIER" && aged.dueSoonMinor > 0) {
      result.push({ key: `supplier:${aged.partyId}`, kind: "supplier_due_soon", subjectId: aged.partyId, name: aged.name, facts, fingerprint: `soon:${aged.nextDueAt ?? ""}` });
    }
  }
  return result;
}

/** The latest count or correction of each account on this device; a count that differed and was not corrected since. */
function cash(tx: Queryable, businessId: string): Draft[] {
  const rows = tx.all(`SELECT a.event_id, a.entity_id, a.action, a.payload, a.occurred_at, f.name
      FROM local_audit a JOIN financial_accounts f ON f.business_id = a.business_id AND f.id = a.entity_id
     WHERE a.business_id = ? AND a.action IN ('CASH_COUNTED', 'CASH_RECONCILED') AND f.active = 1
       AND a.sequence = (SELECT max(b.sequence) FROM local_audit b WHERE b.business_id = a.business_id AND b.entity_id = a.entity_id AND b.action IN ('CASH_COUNTED', 'CASH_RECONCILED'))`, [businessId]);
  const result: Draft[] = [];
  for (const row of rows) {
    if (row["action"] !== "CASH_COUNTED") continue;
    let facts: { expectedMinor?: unknown; countedMinor?: unknown; differenceMinor?: unknown };
    try { facts = JSON.parse(String(row["payload"])) as typeof facts; } catch { continue; }
    if (typeof facts.differenceMinor !== "number" || facts.differenceMinor === 0) continue;
    const id = String(row["entity_id"]);
    result.push({ key: `cash:${id}`, kind: "cash_difference", subjectId: id, name: String(row["name"]), fingerprint: String(row["event_id"]),
      facts: { differenceMinor: sqlInteger(facts.differenceMinor), expectedMinor: sqlInteger(facts.expectedMinor), countedMinor: sqlInteger(facts.countedMinor), countedAt: String(row["occurred_at"]) } });
  }
  return result;
}

function sync(tx: Queryable, businessId: string, now: string): Draft[] {
  const result: Draft[] = [], nowMs = Date.parse(now);
  for (const row of tx.all(`SELECT s.*, x.receiver_device_id FROM server_endpoints s JOIN exchange_destinations x ON x.id = s.destination_id AND x.business_id = s.business_id
      WHERE s.business_id = ? AND x.active = 1`, [businessId])) {
    const id = String(row["destination_id"]), name = String(row["url"]), error = typeof row["last_error"] === "string" ? row["last_error"] : undefined;
    const lastSuccessAt = typeof row["last_success_at"] === "string" ? row["last_success_at"] : undefined;
    const since = lastSuccessAt === undefined ? {} : { lastSuccessAt };
    if (row["service_status"] === "inactive" || error === "hosted_service_inactive") {
      result.push({ key: `service:${id}`, kind: "service_paused", subjectId: id, name, facts: { ...since }, fingerprint: `paused:${String(row["paid_until"] ?? "")}` });
      continue;
    }
    if (row["service_status"] === "grace") {
      const graceUntil = typeof row["grace_until"] === "string" ? { graceUntil: row["grace_until"] } : {};
      result.push({ key: `service:${id}`, kind: "service_grace", subjectId: id, name, facts: { ...graceUntil }, fingerprint: `grace:${String(row["paid_until"] ?? "")}` });
    }
    if (error !== undefined && REFUSALS.has(error)) {
      result.push({ key: `sync:${id}`, kind: "sync_refused", subjectId: id, name, facts: { error, ...since }, fingerprint: `refused:${error}` });
      continue;
    }
    // Offline is normal; only a long silence with facts still waiting to leave is worth a word.
    const reference = Date.parse(lastSuccessAt ?? String(row["connected_at"]));
    if (Number.isFinite(reference) && nowMs - reference >= STALL_MS) {
      const waiting = tx.get(`SELECT 1 AS n FROM event_journal e JOIN applied_events a ON a.event_id = e.event_id AND a.status <> 'quarantined'
          LEFT JOIN event_deliveries d ON d.event_id = e.event_id AND d.destination_id = ?
         WHERE e.business_id = ? AND e.origin_device_id <> ? AND (d.state IS NULL OR d.state = 'offered') LIMIT 1`, [id, businessId, String(row["receiver_device_id"])]);
      if (waiting !== undefined) result.push({ key: `sync:${id}`, kind: "sync_stalled", subjectId: id, name, facts: { ...since, ...(error === undefined ? {} : { error }) }, fingerprint: `stalled:${lastSuccessAt ?? "never"}` });
    }
  }
  return result;
}

function marks(tx: Queryable, context: OperationContext): Map<string, { fingerprint: string; read: boolean; announced: boolean }> {
  return new Map(tx.all(`SELECT key, fingerprint, read_at, announced_at FROM notification_state WHERE business_id = ? AND user_id = ?`, [context.businessId, context.userId])
    .map(row => [String(row["key"]), { fingerprint: String(row["fingerprint"]), read: row["read_at"] !== null, announced: row["announced_at"] !== null }]));
}

function current(tx: Queryable, context: OperationContext, now: string): ShopNotification[] {
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new WorkspaceError("invalid_input");
  const held = memberPermissions(tx, activeMember(tx, context, context.userId)), can = (permission: Permission): boolean => held.includes(permission);
  const drafts = [
    ...(can("inventory.view") ? stock(tx, context.businessId) : []),
    ...(can("customers.view") ? debts(tx, context.businessId, now, "CUSTOMER") : []),
    ...(can("suppliers.view") ? debts(tx, context.businessId, now, "SUPPLIER") : []),
    ...(can("cash.view") ? cash(tx, context.businessId) : []),
    ...(can("business.settings") ? sync(tx, context.businessId, now) : []),
  ];
  const stored = marks(tx, context);
  return drafts.map(draft => {
    const mark = stored.get(draft.key), same = mark?.fingerprint === draft.fingerprint;
    return { ...draft, severity: SEVERITY[draft.kind], read: same && mark.read, announced: same && mark.announced };
  }).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : 1));
}

/**
 * Current notifications for the signed-in user at `now`, most serious first, bounded to `limit` (1–500, default 200)
 * with the unread count over all of them.
 */
export function notifications(context: OperationContext, now: string, limit = 200): { readonly items: readonly ShopNotification[]; readonly unread: number; readonly truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new WorkspaceError("invalid_input");
  return authorizedOperation(context, [], (_db, tx) => {
    const all = current(tx, context, now);
    return { items: all.slice(0, limit), unread: all.filter(item => !item.read).length, truncated: all.length > limit };
  });
}

/**
 * Marks notifications read (and announced) for this user at `now`: the given keys, or every current one. Only current
 * notifications are marked, with their current fingerprint, so a later change raises them again. Marks for conditions
 * that have cleared are dropped. Returns the number marked.
 */
export function markNotificationsRead(context: OperationContext, now: string, keys?: readonly string[]): number {
  return mark(context, now, "read", keys);
}

/**
 * Marks notifications as announced (shown by the system) without reading them, so a desktop raises each changed
 * fact once. Returns the number newly marked.
 */
export function markNotificationsAnnounced(context: OperationContext, now: string, keys: readonly string[]): number {
  return mark(context, now, "announced", keys);
}

function mark(context: OperationContext, now: string, what: "read" | "announced", keys: readonly string[] | undefined): number {
  if (keys !== undefined && (!Array.isArray(keys) || keys.length > 500 || keys.some(key => typeof key !== "string" || key.length < 1 || key.length > 200))) throw new WorkspaceError("invalid_input");
  return authorizedOperation(context, [], (_db, tx) => {
    const all = current(tx, context, now), wanted = keys === undefined ? undefined : new Set(keys);
    let changed = 0;
    for (const item of all) {
      if (wanted !== undefined && !wanted.has(item.key)) continue;
      if (what === "read" ? item.read : item.announced) continue;
      const read = what === "read" ? now : item.read ? now : null;
      tx.run(`INSERT INTO notification_state(business_id, user_id, key, fingerprint, read_at, announced_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(business_id, user_id, key) DO UPDATE SET fingerprint = excluded.fingerprint, read_at = excluded.read_at, announced_at = excluded.announced_at`,
      [context.businessId, context.userId, item.key, item.fingerprint, read, item.announced || what === "announced" || what === "read" ? now : null]);
      changed++;
    }
    const live = new Set(all.map(item => item.key));
    for (const row of tx.all(`SELECT key FROM notification_state WHERE business_id = ? AND user_id = ?`, [context.businessId, context.userId]))
      if (!live.has(String(row["key"]))) tx.run(`DELETE FROM notification_state WHERE business_id = ? AND user_id = ? AND key = ?`, [context.businessId, context.userId, String(row["key"])]);
    return changed;
  });
}
