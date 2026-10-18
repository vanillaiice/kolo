import type { Queryable, Row } from "./driver.ts";
import { LATEST_VERSION, schemaVersion } from "./migrations.ts";
import { LINE_TOTAL } from "../reports/reports.ts";

/**
 * Read-only consistency checks over one local database: the invariants every write path must keep, plus sync states
 * that need a person's attention. Used by `kolo check` and asserted after replay, sync and property tests.
 *
 * `corruption` findings must never occur: SQLite damage, broken references, fan-out that disagrees with its source
 * (stock movements vs sale/purchase lines, credit-sale debt vs the sale's own arithmetic, returns beyond the original),
 * cross-shop references and journal bookkeeping. `attention` findings are legitimate operational states (quarantined
 * or unsupported facts, work stuck for longer than `stuckHours`) that tests may create on purpose. Negative stock is
 * valid offline history and never reported.
 */
export interface IntegrityFinding { readonly code: string; readonly count: number; readonly severity: "corruption" | "attention" }
export interface IntegrityReport {
  /** No findings of either kind. */
  readonly ok: boolean;
  /** No corruption; attention findings may remain. */
  readonly consistent: boolean;
  readonly schemaVersion: number;
  readonly issues: readonly IntegrityFinding[];
  readonly sync: { readonly application: readonly Row[]; readonly delivery: readonly Row[]; readonly outbox: readonly Row[]; readonly stuckHours: number } | Record<string, never>;
}

/** Runs every check; refuses nothing and changes nothing. Databases at another schema version report only that. */
export function checkIntegrity(db: Queryable, options: { readonly now?: Date; readonly stuckHours?: number } = {}): IntegrityReport {
  const now = options.now ?? new Date(), stuckHours = options.stuckHours ?? 24;
  const issues: IntegrityFinding[] = [];
  const add = (code: string, count: number, severity: IntegrityFinding["severity"] = "corruption"): void => { if (count > 0) issues.push({ code, count, severity }); };
  const count = (sql: string, args: readonly (string | number)[] = []): number => Number(db.get(sql, args)?.["n"] ?? 0);
  const finish = (sync: IntegrityReport["sync"]): IntegrityReport => ({ ok: issues.length === 0, consistent: !issues.some(issue => issue.severity === "corruption"),
    schemaVersion: version, issues, sync });
  add("sqlite_integrity", db.all("PRAGMA integrity_check").filter(row => Object.values(row)[0] !== "ok").length);
  add("foreign_keys", db.all("PRAGMA foreign_key_check").length);
  const version = schemaVersion(db);
  if (version !== LATEST_VERSION) { add("unsupported_schema", 1); return finish({}); }

  for (const [table, reference, kind, sign] of [["sale_items", "sale_id", "SALE", -1], ["purchase_items", "purchase_id", "PURCHASE", 1]] as const) {
    add(`${kind.toLowerCase()}_stock_mismatch`, count(`WITH quantities AS (
      SELECT business_id,${reference} AS reference_id,product_id,quantity*${sign} AS expected,0 AS actual FROM ${table}
      UNION ALL SELECT business_id,reference_id,product_id,0,quantity FROM inventory_movements WHERE type='${kind}' AND reference_kind='${kind}'
    ) SELECT count(*) AS n FROM (SELECT 1 FROM quantities GROUP BY business_id,reference_id,product_id HAVING sum(expected)<>sum(actual))`));
  }
  // What a sale left owing is its lines less its discount and payments; exactly that sits on the customer's ledger.
  add("credit_sale_mismatch", count(`WITH owed AS (
      SELECT s.id, s.business_id,
             coalesce((SELECT sum(${LINE_TOTAL}) FROM sale_items i WHERE i.sale_id=s.id),0) - s.discount_minor
             - coalesce((SELECT sum(p.amount_minor) FROM sale_payments p WHERE p.sale_id=s.id),0) AS outstanding,
             coalesce((SELECT sum(c.amount_minor) FROM customer_transactions c WHERE c.business_id=s.business_id AND c.type='CREDIT_SALE' AND c.reference_kind='SALE' AND c.reference_id=s.id),0) AS ledger
        FROM sales s)
    SELECT count(*) AS n FROM owed WHERE outstanding<>ledger`));
  // Returns never take back more than was sold or bought on a line, however many partial returns there were.
  for (const [kind, items] of [["SALE", "sale_items"], ["PURCHASE", "purchase_items"]] as const) {
    add(`${kind.toLowerCase()}_return_exceeds_original`, count(`SELECT count(*) AS n FROM (
      SELECT ri.original_item_id, sum(ri.quantity) AS returned, max(o.quantity) AS original
        FROM business_return_items ri JOIN business_returns r ON r.business_id=ri.business_id AND r.id=ri.return_id AND r.kind='${kind}'
        JOIN ${items} o ON o.id=ri.original_item_id GROUP BY ri.original_item_id HAVING returned>original)`));
  }
  for (const [child, foreignKey, parent] of [
    ["sale_items", "sale_id", "sales"], ["sale_items", "product_id", "products"],
    ["sale_payments", "account_id", "financial_accounts"], ["sales", "customer_id", "customers"],
    ["purchase_items", "purchase_id", "purchases"], ["purchase_items", "product_id", "products"],
    ["purchases", "supplier_id", "suppliers"], ["inventory_movements", "product_id", "products"],
    ["account_movements", "account_id", "financial_accounts"], ["customer_transactions", "customer_id", "customers"],
    ["supplier_transactions", "supplier_id", "suppliers"], ["product_tax_rules", "id", "products"], ["category_names", "id", "categories"],
  ] as const) {
    add(`${child}_${foreignKey}_scope`, count(`SELECT count(*) AS n FROM ${child} c JOIN ${parent} p ON p.id=c.${foreignKey} WHERE c.business_id<>p.business_id`));
  }
  add("journal_application_missing", count(`SELECT count(*) AS n FROM event_journal e LEFT JOIN applied_events a ON a.event_id=e.event_id WHERE a.event_id IS NULL`));
  // Only this till's own counter allocates; another device's row copied in by pairing or backup goes stale harmlessly,
  // because a restored or re-paired till always receives a new device ID.
  add("journal_origin_sequence", count(`SELECT count(*) AS n FROM journal_origins o JOIN local_installation l ON l.business_id=o.business_id AND l.device_id=o.device_id
    WHERE o.next_sequence <= (SELECT coalesce(max(e.origin_sequence),0) FROM event_journal e WHERE e.business_id=o.business_id AND e.origin_device_id=o.device_id)`));

  const cutoff = new Date(now.getTime() - stuckHours * 3_600_000).toISOString();
  add("stuck_application", count("SELECT count(*) AS n FROM applied_events WHERE status IN ('stored','deferred') AND updated_at<?", [cutoff]), "attention");
  add("quarantined_events", count("SELECT count(*) AS n FROM applied_events WHERE status='quarantined'"), "attention");
  add("unsupported_events", count("SELECT count(*) AS n FROM applied_events WHERE status='unsupported'"), "attention");
  add("stuck_delivery", count("SELECT count(*) AS n FROM event_deliveries WHERE state<>'applied' AND coalesce(acknowledged_at,offered_at)<?", [cutoff]), "attention");
  add("rejected_outbox", count("SELECT count(*) AS n FROM sync_outbox WHERE state='rejected'"), "attention");
  add("stuck_outbox", count("SELECT count(*) AS n FROM sync_outbox WHERE state='pending' AND attempts>0 AND occurred_at<?", [cutoff]), "attention");
  return finish({
    application: db.all("SELECT status,count(*) AS count FROM applied_events GROUP BY status ORDER BY status"),
    delivery: db.all("SELECT state,count(*) AS count FROM event_deliveries GROUP BY state ORDER BY state"),
    outbox: db.all("SELECT state,count(*) AS count FROM sync_outbox GROUP BY state ORDER BY state"), stuckHours,
  });
}

/** Throws with the findings when a database holds any corruption; attention findings are allowed. For tests and tools. */
export function assertConsistent(db: Queryable, label = "database"): void {
  const report = checkIntegrity(db);
  const corruption = report.issues.filter(issue => issue.severity === "corruption");
  if (corruption.length > 0) throw new Error(`${label} is inconsistent: ${corruption.map(issue => `${issue.code}×${issue.count}`).join(", ")}`);
}

/**
 * Test teardown: asserts every database is consistent, then closes them all (also when one fails). A database left at
 * another schema version on purpose (upgrade tests) is only closed. Reports every inconsistent database at once.
 */
export function closeConsistent(databases: readonly { close(): void; get: Queryable["get"]; all: Queryable["all"]; run: Queryable["run"] }[]): void {
  const failures: string[] = [];
  for (const [index, db] of databases.entries()) {
    try {
      if (schemaVersion(db) === LATEST_VERSION) assertConsistent(db, `database ${index + 1}`);
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    finally { db.close(); }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}
