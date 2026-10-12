import type { Queryable } from "../data/database/driver.ts";
import * as analytics from "../data/reports/analytics.ts";
import * as queries from "../data/reports/reports.ts";
import * as tax from "../data/reports/tax.ts";
import { authorizedOperation } from "../identity/internal-authority.ts";
import type { Permission } from "../identity/permissions.ts";
import type { OperationContext } from "../identity/types.ts";

type ReportArgs<F> = F extends (...args: infer P) => unknown
  ? P extends [Queryable, string, ...infer A] ? A : never : never;

function read<Args extends unknown[], Result>(context: OperationContext, permission: Permission,
  query: (tx: Queryable, businessId: string, ...args: Args) => Result, args: Args): Result {
  return authorizedOperation(context, [permission], (_database, tx) => query(tx, context.businessId, ...args));
}

/** Reads salesBetween for the unlocked shop under current reports.sales authority. */
export function salesBetween(context: OperationContext, ...args: ReportArgs<typeof queries.salesBetween>): ReturnType<typeof queries.salesBetween> {
  return read(context, "reports.sales", queries.salesBetween, args);
}

/** Reads salesByProduct for the unlocked shop under current reports.sales authority. */
export function salesByProduct(context: OperationContext, ...args: ReportArgs<typeof queries.salesByProduct>): ReturnType<typeof queries.salesByProduct> {
  return read(context, "reports.sales", queries.salesByProduct, args);
}

/** Reads salesByCategory for the unlocked shop under current reports.sales authority. */
export function salesByCategory(context: OperationContext, ...args: ReportArgs<typeof queries.salesByCategory>): ReturnType<typeof queries.salesByCategory> {
  return read(context, "reports.sales", queries.salesByCategory, args);
}

/** Reads salesByAccount for the unlocked shop under current reports.sales authority. */
export function salesByAccount(context: OperationContext, ...args: ReportArgs<typeof queries.salesByAccount>): ReturnType<typeof queries.salesByAccount> {
  return read(context, "reports.sales", queries.salesByAccount, args);
}

/** Reads salesByUser for the unlocked shop under current reports.sales authority. */
export function salesByUser(context: OperationContext, ...args: ReportArgs<typeof queries.salesByUser>): ReturnType<typeof queries.salesByUser> {
  return read(context, "reports.sales", queries.salesByUser, args);
}

/** Reads profitBetween for the unlocked shop under current reports.financial authority. */
export function profitBetween(context: OperationContext, ...args: ReportArgs<typeof queries.profitBetween>): ReturnType<typeof queries.profitBetween> {
  return read(context, "reports.financial", queries.profitBetween, args);
}

/** Reads inventoryValuation for the unlocked shop under current reports.financial authority. */
export function inventoryValuation(context: OperationContext, ...args: ReportArgs<typeof queries.inventoryValuation>): ReturnType<typeof queries.inventoryValuation> {
  return read(context, "reports.financial", queries.inventoryValuation, args);
}

/** Reads cashFlow for the unlocked shop under current reports.financial authority. */
export function cashFlow(context: OperationContext, ...args: ReportArgs<typeof queries.cashFlow>): ReturnType<typeof queries.cashFlow> {
  return read(context, "reports.financial", queries.cashFlow, args);
}

/** Reads dashboard for the unlocked shop under current reports.financial authority. */
export function dashboard(context: OperationContext, ...args: ReportArgs<typeof queries.dashboard>): ReturnType<typeof queries.dashboard> {
  return read(context, "reports.financial", queries.dashboard, args);
}

/** Reads outstandingDebt for the unlocked shop under current reports.customers authority. */
export function outstandingDebt(context: OperationContext, ...args: ReportArgs<typeof queries.outstandingDebt>): ReturnType<typeof queries.outstandingDebt> {
  return read(context, "reports.customers", queries.outstandingDebt, args);
}

/** Reads customerStatement for the unlocked shop under current reports.customers authority. */
export function customerStatement(context: OperationContext, ...args: ReportArgs<typeof queries.customerStatement>): ReturnType<typeof queries.customerStatement> {
  return read(context, "reports.customers", queries.customerStatement, args);
}

/** Reads customerPurchases for the unlocked shop under current reports.customers authority. */
export function customerPurchases(context: OperationContext, ...args: ReportArgs<typeof queries.customerPurchases>): ReturnType<typeof queries.customerPurchases> {
  return read(context, "reports.customers", queries.customerPurchases, args);
}

/** Reads supplierDebt for the unlocked shop under current reports.suppliers authority. */
export function supplierDebt(context: OperationContext, ...args: ReportArgs<typeof queries.supplierDebt>): ReturnType<typeof queries.supplierDebt> {
  return read(context, "reports.suppliers", queries.supplierDebt, args);
}

/** Reads purchasesBySupplier for the unlocked shop under current reports.suppliers authority. */
export function purchasesBySupplier(context: OperationContext, ...args: ReportArgs<typeof queries.purchasesBySupplier>): ReturnType<typeof queries.purchasesBySupplier> {
  return read(context, "reports.suppliers", queries.purchasesBySupplier, args);
}

/** Reads purchasesBetween for the unlocked shop under current reports.suppliers authority. */
export function purchasesBetween(context: OperationContext, ...args: ReportArgs<typeof queries.purchasesBetween>): ReturnType<typeof queries.purchasesBetween> {
  return read(context, "reports.suppliers", queries.purchasesBetween, args);
}

/** Reads supplierPaymentsBetween for the unlocked shop under current reports.suppliers authority. */
export function supplierPaymentsBetween(context: OperationContext, ...args: ReportArgs<typeof queries.supplierPaymentsBetween>): ReturnType<typeof queries.supplierPaymentsBetween> {
  return read(context, "reports.suppliers", queries.supplierPaymentsBetween, args);
}

/** Reads productMovement for the unlocked shop under current reports.inventory authority. */
export function productMovement(context: OperationContext, ...args: ReportArgs<typeof queries.productMovement>): ReturnType<typeof queries.productMovement> {
  return read(context, "reports.inventory", queries.productMovement, args);
}

/** Reads fastMoving for the unlocked shop under current reports.inventory authority. */
export function fastMoving(context: OperationContext, ...args: ReportArgs<typeof queries.fastMoving>): ReturnType<typeof queries.fastMoving> {
  return read(context, "reports.inventory", queries.fastMoving, args);
}

/** Reads slowMoving for the unlocked shop under current reports.inventory authority. */
export function slowMoving(context: OperationContext, ...args: ReportArgs<typeof queries.slowMoving>): ReturnType<typeof queries.slowMoving> {
  return read(context, "reports.inventory", queries.slowMoving, args);
}

/** Reads deadStock for the unlocked shop under current reports.inventory authority. */
export function deadStock(context: OperationContext, ...args: ReportArgs<typeof queries.deadStock>): ReturnType<typeof queries.deadStock> {
  return read(context, "reports.inventory", queries.deadStock, args);
}

/** Reads lowStock for the unlocked shop under current reports.inventory authority. */
export function lowStock(context: OperationContext, ...args: ReportArgs<typeof queries.lowStock>): ReturnType<typeof queries.lowStock> {
  return read(context, "reports.inventory", queries.lowStock, args);
}


/** Reads salesTrend for the unlocked shop under current reports.sales authority. */
export function salesTrend(context: OperationContext, ...args: ReportArgs<typeof analytics.salesTrend>): ReturnType<typeof analytics.salesTrend> {
  return read(context, "reports.sales", analytics.salesTrend, args);
}

/** Reads profitTrend for the unlocked shop under current reports.financial authority. */
export function profitTrend(context: OperationContext, ...args: ReportArgs<typeof analytics.profitTrend>): ReturnType<typeof analytics.profitTrend> {
  return read(context, "reports.financial", analytics.profitTrend, args);
}

/** Reads salesActivity for the unlocked shop under current reports.sales authority. */
export function salesActivity(context: OperationContext, ...args: ReportArgs<typeof analytics.salesActivity>): ReturnType<typeof analytics.salesActivity> {
  return read(context, "reports.sales", analytics.salesActivity, args);
}

/** Reads productSales for the unlocked shop under current reports.sales authority. */
export function productSales(context: OperationContext, ...args: ReportArgs<typeof analytics.productSales>): ReturnType<typeof analytics.productSales> {
  return read(context, "reports.sales", analytics.productSales, args);
}

/** Reads productProfit for the unlocked shop under current reports.financial authority. */
export function productProfit(context: OperationContext, ...args: ReportArgs<typeof analytics.productProfit>): ReturnType<typeof analytics.productProfit> {
  return read(context, "reports.financial", analytics.productProfit, args);
}

/** Reads topCustomers for the unlocked shop under current reports.customers authority. */
export function topCustomers(context: OperationContext, ...args: ReportArgs<typeof analytics.topCustomers>): ReturnType<typeof analytics.topCustomers> {
  return read(context, "reports.customers", analytics.topCustomers, args);
}

/** Reads the period's tax by rate (ADR-033) for the unlocked shop under current reports.financial authority. */
export function taxBetween(context: OperationContext, ...args: ReportArgs<typeof tax.taxBetween>): ReturnType<typeof tax.taxBetween> {
  return read(context, "reports.financial", tax.taxBetween, args);
}
