import * as reports from "@kolo/core/application/reports";
import { stockAlertPage } from "@kolo/core/application/queries";
import { WorkspaceError } from "@kolo/core/identity/types";
import type { ReportKind, ReportLine, ReportResult } from "../shared/service.js";
import { object, text } from "./validation.ts";
import type { Host } from "./host.ts";

/** Row lists sent to the renderer are bounded; core reports themselves are exact over all rows. */
const ROWS = 500;
const kinds: readonly ReportKind[] = ["dashboard", "sales", "salesByProduct", "salesByCategory", "salesByAccount", "salesByUser", "cashFlow", "valuation", "fastMoving", "stockAlerts", "customerDebt", "supplierDebt", "purchases"];
function instant(value: unknown): string {
  const raw = text(value, 32, false);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new WorkspaceError("invalid_input");
  return new Date(raw).toISOString();
}
function capped(lines: readonly { key: string; label: string; totalMinor: number; count: number }[]): { lines: ReportLine[]; truncated: boolean } {
  return { lines: lines.slice(0, ROWS).map(({ key, label, totalMinor, count }) => ({ key, label, totalMinor, count })), truncated: lines.length > ROWS };
}

/** One report under its core permission; the period is at most about ten years and must not be empty. */
export function report(host: Host, input: unknown): ReportResult {
  const data = object(input, ["sessionId", "kind", "from", "until"]), context = host.actor(data);
  if (!kinds.includes(data["kind"] as ReportKind)) throw new WorkspaceError("invalid_input");
  const kind = data["kind"] as ReportKind, from = instant(data["from"]), until = instant(data["until"]);
  if (from >= until || Date.parse(until) - Date.parse(from) > 3700 * 86_400_000) throw new WorkspaceError("invalid_input");
  switch (kind) {
    case "dashboard": {
      const value = reports.dashboard(context, from, until);
      return { kind, salesMinor: value.sales.totalMinor, transactions: value.sales.transactions, grossProfitMinor: value.profit.grossProfitMinor, costMinor: value.profit.costMinor,
        linesWithoutCost: value.profit.linesWithoutCost, expensesMinor: value.expensesMinor, netResultMinor: value.netResultMinor,
        customerDebtMinor: value.customerDebtMinor, supplierDebtMinor: value.supplierDebtMinor, lowStock: value.lowStock };
    }
    case "sales": { const value = reports.salesBetween(context, from, until); return { kind, totalMinor: value.totalMinor, transactions: value.transactions, itemsSoldThousandths: value.itemsSoldThousandths }; }
    case "salesByProduct": return { kind, ...capped(reports.salesByProduct(context, from, until)) };
    case "salesByCategory": return { kind, ...capped(reports.salesByCategory(context, from, until)) };
    case "salesByAccount": return { kind, ...capped(reports.salesByAccount(context, from, until)) };
    case "salesByUser": return { kind, ...capped(reports.salesByUser(context, from, until)) };
    case "customerDebt": return { kind, ...capped(reports.outstandingDebt(context)) };
    case "supplierDebt": return { kind, ...capped(reports.supplierDebt(context)) };
    case "cashFlow": return { kind, accounts: reports.cashFlow(context, from, until).map(({ accountId, name, inMinor, outMinor, netMinor, closingMinor }) => ({ accountId, name, inMinor, outMinor, netMinor, closingMinor })) };
    case "valuation": {
      const value = reports.inventoryValuation(context);
      return { kind, totalMinor: value.totalMinor, uncosted: value.uncosted, truncated: value.products.length > ROWS, products: value.products.slice(0, ROWS).map(item => ({ productId: item.productId, name: item.name,
        onHandThousandths: item.onHandThousandths, ...(item.unitCostMinor === undefined ? {} : { unitCostMinor: item.unitCostMinor }), ...(item.valueMinor === undefined ? {} : { valueMinor: item.valueMinor }) })) };
    }
    case "fastMoving": return { kind, products: reports.fastMoving(context, from, until, 20).map(({ productId, name, soldThousandths, revenueMinor, onHandThousandths }) => ({ productId, name, soldThousandths, revenueMinor, onHandThousandths })) };
    case "stockAlerts": {
      const page = stockAlertPage(context, { limit: 100 });
      return { kind, truncated: page.next !== undefined, products: page.items.map(item => ({ productId: item.id, name: item.name, onHandThousandths: item.quantity })) };
    }
    case "purchases": {
      const summary = reports.purchasesBetween(context, from, until);
      return { kind, totalMinor: summary.totalMinor, deliveries: summary.deliveries, ...(({ lines, truncated }) => ({ bySupplier: lines, truncated }))(capped(reports.purchasesBySupplier(context, from, until))) };
    }
  }
}
