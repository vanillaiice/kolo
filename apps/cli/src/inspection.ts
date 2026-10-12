import type { Queryable, Row } from "@kolo/core/data/database/driver";
import { LATEST_VERSION, schemaVersion } from "@kolo/core/data/database/migrations";
import * as reports from "@kolo/core/data/reports/reports";

export const reportNames = ["sales", "profit", "purchases", "inventory", "cash", "customers", "suppliers"] as const;
export type ReportName = typeof reportNames[number];
export function report(db: Queryable, name: ReportName, businessId: string, from: string, to: string): unknown {
  switch (name) {
    case "sales": return reports.salesBetween(db, businessId, from, to);
    case "profit": return reports.profitBetween(db, businessId, from, to);
    case "purchases": return reports.purchasesBetween(db, businessId, from, to);
    case "inventory": return reports.inventoryValuation(db, businessId);
    case "cash": return reports.cashFlow(db, businessId, from, to);
    case "customers": return reports.outstandingDebt(db, businessId);
    case "suppliers": return reports.supplierDebt(db, businessId);
  }
}

// Explicit portable business exports: vault references and server sessions never leave here.
export const exportTables = ["products", "customers", "suppliers", "sales", "sale_items", "sale_payments", "purchases", "purchase_items", "account_movements", "customer_transactions", "supplier_transactions", "inventory_movements", "financial_accounts", "expenses"] as const;
export type ExportTable = typeof exportTables[number];
export function exportRows(db: Queryable, table: ExportTable, businessId: string): Row[] {
  return db.all(`SELECT * FROM ${table} WHERE business_id=? ORDER BY id`, [businessId]);
}
export function csv(rows: readonly Row[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]!);
  const cell = (value: unknown): string => {
    let text = value === null || value === undefined ? "" : String(value);
    // Keep spreadsheet applications from treating business text as executable formulas.
    if (/^[=+@\t\r]/.test(text) || (text.startsWith("-") && typeof value === "string")) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [columns.map(cell).join(","), ...rows.map(row => columns.map(column => cell(row[column])).join(","))].join("\r\n") + "\r\n";
}
export function shop(db: Queryable, id?: string): string {
  const shops = db.all("SELECT id FROM businesses ORDER BY id");
  if (id) {
    if (!shops.some(row => row["id"] === id)) throw new Error("Unknown business ID");
    return id;
  }
  if (shops.length !== 1) throw new Error("Specify --business for a database with multiple shops");
  return String(shops[0]!["id"]);
}

export function check(db: Queryable, now = new Date(), stuckHours = 24): { ok: boolean; schemaVersion: number; issues: { code: string; count: number }[]; sync: Record<string, unknown> } {
  const issues: { code: string; count: number }[] = [];
  const add = (code: string, count: number): void => { if (count > 0) issues.push({ code, count }); };
  add("sqlite_integrity", db.all("PRAGMA integrity_check").filter(row => Object.values(row)[0] !== "ok").length);
  add("foreign_keys", db.all("PRAGMA foreign_key_check").length);
  const version = schemaVersion(db);
  if (version !== LATEST_VERSION) {
    add("unsupported_schema", 1);
    return { ok: false, schemaVersion: version, issues, sync: {} };
  }
  const count = (sql: string): number => Number(db.get(sql)?.["n"] ?? 0);
  for (const [table, reference, kind, sign] of [["sale_items", "sale_id", "SALE", -1], ["purchase_items", "purchase_id", "PURCHASE", 1]] as const) {
    add(`${kind.toLowerCase()}_stock_mismatch`, count(`WITH quantities AS (
      SELECT business_id,${reference} AS reference_id,product_id,quantity*${sign} AS expected,0 AS actual FROM ${table}
      UNION ALL SELECT business_id,reference_id,product_id,0,quantity FROM inventory_movements WHERE type='${kind}' AND reference_kind='${kind}'
    ) SELECT count(*) AS n FROM (SELECT 1 FROM quantities GROUP BY business_id,reference_id,product_id HAVING sum(expected)<>sum(actual))`));
  }
  for (const [child, foreignKey, parent] of [
    ["sale_items", "sale_id", "sales"], ["sale_items", "product_id", "products"],
    ["sale_payments", "account_id", "financial_accounts"], ["sales", "customer_id", "customers"],
    ["purchase_items", "purchase_id", "purchases"], ["purchase_items", "product_id", "products"],
    ["purchases", "supplier_id", "suppliers"], ["inventory_movements", "product_id", "products"],
    ["account_movements", "account_id", "financial_accounts"], ["customer_transactions", "customer_id", "customers"],
    ["supplier_transactions", "supplier_id", "suppliers"],
  ]) {
    add(`${child}_${foreignKey}_scope`, count(`SELECT count(*) AS n FROM ${child} c JOIN ${parent} p ON p.id=c.${foreignKey} WHERE c.business_id<>p.business_id`));
  }
  add("journal_application_missing", count(`SELECT count(*) AS n FROM event_journal e LEFT JOIN applied_events a ON a.event_id=e.event_id WHERE a.event_id IS NULL`));
  add("journal_origin_sequence", count(`SELECT count(*) AS n FROM journal_origins o WHERE o.next_sequence <=
    (SELECT coalesce(max(e.origin_sequence),0) FROM event_journal e WHERE e.business_id=o.business_id AND e.origin_device_id=o.device_id)`));
  const cutoff = new Date(now.getTime() - stuckHours * 3_600_000).toISOString();
  const application = db.all("SELECT status,count(*) AS count FROM applied_events GROUP BY status ORDER BY status");
  const delivery = db.all("SELECT state,count(*) AS count FROM event_deliveries GROUP BY state ORDER BY state");
  const stuck = Number(db.get("SELECT count(*) AS n FROM applied_events WHERE status IN ('stored','deferred') AND updated_at<?", [cutoff])!["n"]);
  const quarantined = count("SELECT count(*) AS n FROM applied_events WHERE status='quarantined'");
  const unsupported = count("SELECT count(*) AS n FROM applied_events WHERE status='unsupported'");
  const oldDeliveries = Number(db.get("SELECT count(*) AS n FROM event_deliveries WHERE state<>'applied' AND coalesce(acknowledged_at,offered_at)<?", [cutoff])!["n"]);
  add("stuck_application", stuck); add("quarantined_events", quarantined); add("unsupported_events", unsupported); add("stuck_delivery", oldDeliveries);
  const outbox = db.all("SELECT state,count(*) AS count FROM sync_outbox GROUP BY state ORDER BY state");
  add("rejected_outbox", count("SELECT count(*) AS n FROM sync_outbox WHERE state='rejected'"));
  add("stuck_outbox", Number(db.get("SELECT count(*) AS n FROM sync_outbox WHERE state='pending' AND attempts>0 AND occurred_at<?", [cutoff])!["n"]));
  return { ok: issues.length === 0, schemaVersion: version, issues, sync: { application, delivery, outbox, stuckHours } };
}
