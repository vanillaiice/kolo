import * as reports from "./reports.ts";
import { stockAlertPage } from "./queries.ts";
import { defaultBucket } from "../data/reports/analytics.ts";
import { multiplyRatio } from "../rules/amounts.ts";
import { WorkspaceError, type OperationContext } from "../identity/types.ts";

/** Report kinds, each read under its own core report permission. */
export type ReportKind = "dashboard" | "sales" | "salesByProduct" | "salesByCategory" | "salesByAccount" | "salesByUser" | "cashFlow" | "valuation" |
  "fastMoving" | "stockAlerts" | "customerDebt" | "supplierDebt" | "purchases";
/** Every report kind, in the order the clients list them. */
export const REPORT_KINDS: readonly ReportKind[] = ["dashboard", "sales", "salesByProduct", "salesByCategory", "salesByAccount", "salesByUser", "cashFlow", "valuation", "fastMoving", "stockAlerts", "customerDebt", "supplierDebt", "purchases"];
/** Reports of the present state (stock and balances owed). They ignore `from`/`until`, which are not validated for them. */
export const UNDATED_REPORT_KINDS: ReadonlySet<ReportKind> = new Set(["valuation", "stockAlerts", "customerDebt", "supplierDebt"]);
/** The permission each report kind is read under. */
export const REPORT_PERMISSION: Readonly<Record<ReportKind, "reports.financial" | "reports.sales" | "reports.inventory" | "reports.customers" | "reports.suppliers">> = {
  dashboard: "reports.financial", sales: "reports.sales", salesByProduct: "reports.sales", salesByCategory: "reports.sales", salesByAccount: "reports.sales",
  salesByUser: "reports.sales", cashFlow: "reports.financial", valuation: "reports.financial", fastMoving: "reports.inventory", stockAlerts: "reports.inventory",
  customerDebt: "reports.customers", supplierDebt: "reports.suppliers", purchases: "reports.suppliers",
};
/** A labelled total; `count` is lines, transactions or entries depending on the report. */
export interface ReportLine { readonly key: string; readonly label: string; readonly totalMinor: number; readonly count: number; }
/** Serializable report results. Row lists are capped; `truncated` says more rows exist. Totals stay exact. */
export type ReportResult =
  | { readonly kind: "dashboard"; readonly salesMinor: number; readonly transactions: number; readonly grossProfitMinor: number; readonly costMinor: number; readonly linesWithoutCost: number;
      readonly expensesMinor: number; readonly netResultMinor: number; readonly customerDebtMinor: number; readonly supplierDebtMinor: number; readonly lowStock: number }
  | { readonly kind: "sales"; readonly totalMinor: number; readonly transactions: number; readonly itemsSoldThousandths: number }
  | { readonly kind: "salesByProduct" | "salesByCategory" | "salesByAccount" | "salesByUser" | "customerDebt" | "supplierDebt"; readonly lines: readonly ReportLine[]; readonly truncated: boolean }
  | { readonly kind: "cashFlow"; readonly accounts: readonly { readonly accountId: string; readonly name: string; readonly inMinor: number; readonly outMinor: number; readonly netMinor: number; readonly closingMinor: number }[] }
  | { readonly kind: "valuation"; readonly totalMinor: number; readonly uncosted: number; readonly truncated: boolean;
      readonly products: readonly { readonly productId: string; readonly name: string; readonly onHandThousandths: number; readonly unitCostMinor?: number; readonly valueMinor?: number }[] }
  | { readonly kind: "fastMoving"; readonly products: readonly { readonly productId: string; readonly name: string; readonly soldThousandths: number; readonly revenueMinor: number; readonly onHandThousandths: number }[] }
  | { readonly kind: "stockAlerts"; readonly products: readonly { readonly productId: string; readonly name: string; readonly onHandThousandths: number }[]; readonly truncated: boolean }
  | { readonly kind: "purchases"; readonly totalMinor: number; readonly deliveries: number; readonly bySupplier: readonly ReportLine[]; readonly truncated: boolean };
/** How an analytics trend is sliced; weeks start on Monday. */
export type AnalyticsBucket = "hour" | "day" | "week" | "month";
/** One trend point keyed by local `YYYY-MM-DDTHH`, `YYYY-MM-DD` (day or week's Monday) or `YYYY-MM`; profit only with reports.financial. */
export interface AnalyticsPoint { readonly key: string; readonly revenueMinor: number; readonly transactions: number; readonly grossProfitMinor?: number }
/** Sales started in one local weekday (0 = Sunday) and hour, summed over the period; empty cells are absent. */
export interface AnalyticsCell { readonly weekday: number; readonly hour: number; readonly transactions: number; readonly revenueMinor: number }
/** A product's net sales over the period, before bill discounts; profit only with reports.financial. */
export interface AnalyticsProduct { readonly productId: string; readonly name: string; readonly soldThousandths: number; readonly revenueMinor: number; readonly grossProfitMinor?: number }
/** A named customer's net buying over the period. */
export interface AnalyticsCustomer { readonly customerId: string; readonly name: string; readonly transactions: number; readonly revenueMinor: number; readonly lastPurchaseAt: string }
/**
 * Light analytics for one period. Sections the actor may not read are absent rather than failing the
 * whole view: `profit` and per-point/product profit need reports.financial, `customers` needs
 * reports.customers; the rest needs reports.sales. `previous` is the equal-length period just before.
 */
export interface AnalyticsResult {
  readonly bucket: AnalyticsBucket;
  readonly sales: { readonly revenueMinor: number; readonly transactions: number; readonly itemsSoldThousandths: number; readonly averageBasketMinor: number };
  readonly previous: { readonly revenueMinor: number; readonly transactions: number; readonly grossProfitMinor?: number };
  readonly profit?: { readonly grossProfitMinor: number; readonly costMinor: number; readonly marginBasisPoints?: number; readonly linesWithoutCost: number; readonly expensesMinor: number; readonly netResultMinor: number };
  readonly trend: readonly AnalyticsPoint[];
  readonly activity: readonly AnalyticsCell[];
  readonly products: readonly AnalyticsProduct[];
  readonly productsTruncated: boolean;
  readonly categories: readonly ReportLine[];
  readonly accounts: readonly ReportLine[];
  readonly customers?: readonly AnalyticsCustomer[];
}
/** Row cap for client views. Desktop shows up to 500 rows; phones pass a smaller cap. */
export interface ViewOptions { readonly rows?: number }

const DEFAULT_ROWS = 500;
const BUCKETS: readonly AnalyticsBucket[] = ["hour", "day", "week", "month"];

function period(from: string, until: string): void {
  const start = Date.parse(from), end = Date.parse(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 3700 * 86_400_000) throw new WorkspaceError("invalid_input");
}
function cap(options: ViewOptions): number {
  const rows = options.rows ?? DEFAULT_ROWS;
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > DEFAULT_ROWS) throw new WorkspaceError("invalid_input");
  return rows;
}
function capped(lines: readonly ReportLine[], rows: number): { lines: ReportLine[]; truncated: boolean } {
  return { lines: lines.slice(0, rows).map(({ key, label, totalMinor, count }) => ({ key, label, totalMinor, count })), truncated: lines.length > rows };
}

/**
 * One report under its core permission over `[from, until)` (ISO instants from shared local-day
 * rules; empty or decade-plus periods are refused). {@link UNDATED_REPORT_KINDS} ignore the period. Row lists are bounded by `options.rows`
 * (default and maximum 500, stock alerts 100) with a `truncated` flag; totals stay exact.
 */
export function reportView(context: OperationContext, kind: ReportKind, from: string, until: string, options: ViewOptions = {}): ReportResult {
  if (!REPORT_KINDS.includes(kind)) throw new WorkspaceError("invalid_input");
  if (!UNDATED_REPORT_KINDS.has(kind)) period(from, until);
  const rows = cap(options);
  switch (kind) {
    case "dashboard": {
      const value = reports.dashboard(context, from, until);
      return { kind, salesMinor: value.sales.totalMinor, transactions: value.sales.transactions, grossProfitMinor: value.profit.grossProfitMinor, costMinor: value.profit.costMinor,
        linesWithoutCost: value.profit.linesWithoutCost, expensesMinor: value.expensesMinor, netResultMinor: value.netResultMinor,
        customerDebtMinor: value.customerDebtMinor, supplierDebtMinor: value.supplierDebtMinor, lowStock: value.lowStock };
    }
    case "sales": { const value = reports.salesBetween(context, from, until); return { kind, totalMinor: value.totalMinor, transactions: value.transactions, itemsSoldThousandths: value.itemsSoldThousandths }; }
    case "salesByProduct": return { kind, ...capped(reports.salesByProduct(context, from, until), rows) };
    case "salesByCategory": return { kind, ...capped(reports.salesByCategory(context, from, until), rows) };
    case "salesByAccount": return { kind, ...capped(reports.salesByAccount(context, from, until), rows) };
    case "salesByUser": return { kind, ...capped(reports.salesByUser(context, from, until), rows) };
    case "customerDebt": return { kind, ...capped(reports.outstandingDebt(context), rows) };
    case "supplierDebt": return { kind, ...capped(reports.supplierDebt(context), rows) };
    case "cashFlow": return { kind, accounts: reports.cashFlow(context, from, until).map(({ accountId, name, inMinor, outMinor, netMinor, closingMinor }) => ({ accountId, name, inMinor, outMinor, netMinor, closingMinor })) };
    case "valuation": {
      const value = reports.inventoryValuation(context);
      return { kind, totalMinor: value.totalMinor, uncosted: value.uncosted, truncated: value.products.length > rows, products: value.products.slice(0, rows).map(item => ({ productId: item.productId, name: item.name,
        onHandThousandths: item.onHandThousandths, ...(item.unitCostMinor === undefined ? {} : { unitCostMinor: item.unitCostMinor }), ...(item.valueMinor === undefined ? {} : { valueMinor: item.valueMinor }) })) };
    }
    case "fastMoving": return { kind, products: reports.fastMoving(context, from, until, Math.min(20, rows)).map(({ productId, name, soldThousandths, revenueMinor, onHandThousandths }) => ({ productId, name, soldThousandths, revenueMinor, onHandThousandths })) };
    case "stockAlerts": {
      const page = stockAlertPage(context, { limit: Math.min(100, rows) });
      return { kind, truncated: page.next !== undefined, products: page.items.map(item => ({ productId: item.id, name: item.name, onHandThousandths: item.quantity })) };
    }
    case "purchases": {
      const summary = reports.purchasesBetween(context, from, until), { lines, truncated } = capped(reports.purchasesBySupplier(context, from, until), rows);
      return { kind, totalMinor: summary.totalMinor, deliveries: summary.deliveries, bySupplier: lines, truncated };
    }
  }
}

/** The profit field of a row read under reports.financial, and nothing for a sales-only row. */
function profitOf(row: object): { grossProfitMinor?: number } {
  return "grossProfitMinor" in row && typeof row.grossProfitMinor === "number" ? { grossProfitMinor: row.grossProfitMinor } : {};
}
/** A section the actor may not read is left out; any other failure fails the whole view. */
function permitted<T>(read: () => T): T | undefined {
  try { return read(); } catch (error) { if (error instanceof WorkspaceError && error.code === "permission_denied") return undefined; throw error; }
}

/**
 * Light analytics for one period under reports.sales, with profit and customer sections only for
 * actors holding reports.financial and reports.customers. The period is at most about ten years; the
 * offset is the shop's local minutes east of UTC (at most ±840); an explicit bucket must keep the
 * trend to 1,000 points. Product and share lists are bounded by `options.rows`.
 */
export function analyticsView(context: OperationContext, input: { readonly from: string; readonly until: string; readonly offsetMinutes: number; readonly bucket?: AnalyticsBucket | undefined },
  options: ViewOptions = {}): AnalyticsResult {
  const { from, until, offsetMinutes: offset } = input;
  period(from, until);
  const rows = cap(options);
  if (!Number.isSafeInteger(offset) || Math.abs(offset) > 840) throw new WorkspaceError("invalid_input");
  if (input.bucket !== undefined && !BUCKETS.includes(input.bucket)) throw new WorkspaceError("invalid_input");
  const bucket = input.bucket ?? defaultBucket(from, until);
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
  const lines = (list: readonly ReportLine[]): ReportLine[] => capped(list, rows).lines;

  return {
    bucket,
    sales: { revenueMinor: summary.totalMinor, transactions: summary.transactions, itemsSoldThousandths: summary.itemsSoldThousandths,
      averageBasketMinor: summary.transactions === 0 ? 0 : multiplyRatio(summary.totalMinor, 1, summary.transactions) },
    previous: { revenueMinor: earlier.totalMinor, transactions: earlier.transactions, ...(earlierProfit === undefined ? {} : { grossProfitMinor: earlierProfit.grossProfitMinor }) },
    ...(dashboard === undefined ? {} : { profit: { grossProfitMinor: dashboard.profit.grossProfitMinor, costMinor: dashboard.profit.costMinor,
      ...(dashboard.profit.revenueMinor > 0 ? { marginBasisPoints: multiplyRatio(dashboard.profit.grossProfitMinor, 10_000, dashboard.profit.revenueMinor) } : {}),
      linesWithoutCost: dashboard.profit.linesWithoutCost, expensesMinor: dashboard.expensesMinor, netResultMinor: dashboard.netResultMinor } }),
    trend: (profitTrend ?? sales).map(point => ({ key: point.key, revenueMinor: point.revenueMinor, transactions: point.transactions, ...profitOf(point) })),
    activity: reports.salesActivity(context, from, until, offset).map(({ weekday, hour, transactions, revenueMinor }) => ({ weekday, hour, transactions, revenueMinor })),
    products: products.slice(0, rows).map(row => ({ productId: row.productId, name: row.name, soldThousandths: row.soldThousandths, revenueMinor: row.revenueMinor, ...profitOf(row) })),
    productsTruncated: products.length > rows,
    categories: lines(reports.salesByCategory(context, from, until)),
    accounts: lines(reports.salesByAccount(context, from, until)),
    ...(customers === undefined ? {} : { customers: customers.map(({ customerId, name, transactions, revenueMinor, lastPurchaseAt }) => ({ customerId, name, transactions, revenueMinor, lastPurchaseAt })) }),
  };
}
