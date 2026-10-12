import type { Queryable, Row } from "@kolo/core/data/database/driver";
import { checkIntegrity, type IntegrityReport } from "@kolo/core/data/database/integrity";
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

/** `kolo check`: core's integrity report (corruption and attention findings) for one database copy. */
export function check(db: Queryable, now = new Date(), stuckHours = 24): IntegrityReport {
  return checkIntegrity(db, { now, stuckHours });
}
