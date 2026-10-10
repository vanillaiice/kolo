import * as reports from "@kolo/core/application/reports";
import { stockAlertPage } from "@kolo/core/application/queries";
import { WorkspaceError } from "@kolo/core/identity/types";
import { defaultBucket } from "@kolo/core/data/reports/analytics";
import { multiplyRatio } from "@kolo/core/rules/amounts";
import type { AnalyticsBucket, AnalyticsResult, ReportKind, ReportLine, ReportResult } from "../shared/service.js";
import { object, optional, text } from "./validation.ts";
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

/** The profit field of a row read under reports.financial, and nothing for a sales-only row. */
function profitOf(row: object): { grossProfitMinor?: number } {
  return "grossProfitMinor" in row && typeof row.grossProfitMinor === "number" ? { grossProfitMinor: row.grossProfitMinor } : {};
}
const buckets: readonly AnalyticsBucket[] = ["hour", "day", "week", "month"];
/** A section the actor may not read is left out; any other failure fails the whole view. */
function permitted<T>(read: () => T): T | undefined {
  try { return read(); } catch (error) { if (error instanceof WorkspaceError && error.code === "permission_denied") return undefined; throw error; }
}

/**
 * Light analytics for one period under reports.sales, with profit and customer sections only for
 * actors holding reports.financial and reports.customers. The period is at most about ten years; the
 * offset is the shop's local minutes east of UTC; an explicit bucket must keep the trend to 1,000 points.
 */
export function analytics(host: Host, input: unknown): AnalyticsResult {
  const data = object(input, ["sessionId", "from", "until", "offsetMinutes", "bucket"]), context = host.actor(data);
  const from = instant(data["from"]), until = instant(data["until"]), offset = data["offsetMinutes"];
  if (from >= until || Date.parse(until) - Date.parse(from) > 3700 * 86_400_000) throw new WorkspaceError("invalid_input");
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || Math.abs(offset) > 840) throw new WorkspaceError("invalid_input");
  const bucket = optional(data["bucket"], value => { if (!buckets.includes(value as AnalyticsBucket)) throw new WorkspaceError("invalid_input"); return value as AnalyticsBucket; }) ?? defaultBucket(from, until);
  const before = new Date(2 * Date.parse(from) - Date.parse(until)).toISOString();

  let sales;
  try { sales = reports.salesTrend(context, from, until, bucket, offset); }
  catch (error) { if (error instanceof RangeError) throw new WorkspaceError("invalid_input"); throw error; }
  const summary = reports.salesBetween(context, from, until), earlier = reports.salesBetween(context, before, from);
  const profitTrend = permitted(() => reports.profitTrend(context, from, until, bucket, offset));
  const dashboard = permitted(() => reports.dashboard(context, from, until));
  const earlierProfit = permitted(() => reports.profitBetween(context, before, from));
  const products = permitted(() => reports.productProfit(context, from, until)) ?? reports.productSales(context, from, until);
  const customers = permitted(() => reports.topCustomers(context, from, until, 10));
  const lines = (rows: readonly ReportLine[]): ReportLine[] => rows.slice(0, ROWS).map(({ key, label, totalMinor, count }) => ({ key, label, totalMinor, count }));

  return {
    bucket,
    sales: { revenueMinor: summary.totalMinor, transactions: summary.transactions, itemsSoldThousandths: summary.itemsSoldThousandths,
      averageBasketMinor: summary.transactions === 0 ? 0 : multiplyRatio(summary.totalMinor, 1, summary.transactions) },
    previous: { revenueMinor: earlier.totalMinor, transactions: earlier.transactions, ...(earlierProfit === undefined ? {} : { grossProfitMinor: earlierProfit.grossProfitMinor }) },
    ...(dashboard === undefined ? {} : { profit: { grossProfitMinor: dashboard.profit.grossProfitMinor, costMinor: dashboard.profit.costMinor,
      ...(dashboard.profit.revenueMinor > 0 ? { marginBasisPoints: multiplyRatio(dashboard.profit.grossProfitMinor, 10_000, dashboard.profit.revenueMinor) } : {}),
      linesWithoutCost: dashboard.profit.linesWithoutCost, expensesMinor: dashboard.expensesMinor, netResultMinor: dashboard.netResultMinor } }),
    trend: (profitTrend ?? sales).map(point => ({ key: point.key, revenueMinor: point.revenueMinor, transactions: point.transactions,
      ...profitOf(point) })),
    activity: reports.salesActivity(context, from, until, offset).map(({ weekday, hour, transactions, revenueMinor }) => ({ weekday, hour, transactions, revenueMinor })),
    products: products.slice(0, ROWS).map(row => ({ productId: row.productId, name: row.name, soldThousandths: row.soldThousandths, revenueMinor: row.revenueMinor,
      ...profitOf(row) })),
    productsTruncated: products.length > ROWS,
    categories: lines(reports.salesByCategory(context, from, until)),
    accounts: lines(reports.salesByAccount(context, from, until)),
    ...(customers === undefined ? {} : { customers: customers.map(({ customerId, name, transactions, revenueMinor, lastPurchaseAt }) => ({ customerId, name, transactions, revenueMinor, lastPurchaseAt })) }),
  };
}
