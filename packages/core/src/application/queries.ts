import { categoryOf, type Category } from "../data/products/categories.ts";
import type { Queryable, Row, SqlValue } from "../data/database/driver.ts";
import { productOf, productByBarcode, type Product } from "../data/products/products.ts";
import { customerOf, balanceOf, type Customer } from "../data/customers/customers.ts";
import { supplierOf, balanceOfSupplier, type Supplier } from "../data/suppliers/suppliers.ts";
import { accountOf, type Account } from "../data/finance/accounts.ts";
import { balanceOfAccount } from "../data/finance/cash.ts";
import { stockOf } from "../data/inventory/movements.ts";
import { sqlInteger } from "../data/database/safe-values.ts";
import { authorizedOperation, activeMember, memberPermissions } from "../identity/internal-authority.ts";
import { WorkspaceError, type OperationContext } from "../identity/types.ts";
import type { Permission } from "../identity/permissions.ts";
import { saleTotals, subtotalOf } from "../rules/pricing.ts";

/** Stable keyset continuation for catalogue queries; reset after a domain invalidation. */
export interface Cursor { readonly name: string; readonly id: string; }
/** Bounded page of local records. A missing cursor means the end of the result. */
export interface Page<T> { readonly items: readonly T[]; readonly next?: Cursor | undefined; }
/** Literal prefix search by name or phone/code; limit 1–100, default 30. */
export interface PageQuery { readonly term?: string; readonly after?: Cursor; readonly limit?: number; readonly includeInactive?: boolean; }
function options(query: PageQuery): { limit: number; term: string } {
  const limit = query.limit ?? 30, term = query.term?.trim() ?? "";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || term.length > 120 ||
    (query.after !== undefined && (typeof query.after.name !== "string" || typeof query.after.id !== "string"))) throw new WorkspaceError("invalid_input");
  return { limit, term };
}
function catalogue<T>(tx: Queryable, businessId: string, table: "products" | "categories" | "customers" | "suppliers" | "financial_accounts", query: PageQuery,
  load: (tx: Queryable, shop: string, id: string) => T | undefined): Page<T> {
  const { limit, term } = options(query), values: SqlValue[] = [businessId];
  let where = "business_id=?";
  if (query.includeInactive !== true) where += " AND active=1";
  if (term !== "") {
    const prefix = term.replace(/[\\%_]/g, "\\$&") + "%";
    where += " AND (name LIKE ? ESCAPE '\\'"; values.push(prefix);
    if (table === "products") { where += " OR barcode=? OR sku LIKE ? ESCAPE '\\'"; values.push(term, prefix); }
    if (table === "customers" || table === "suppliers") { where += " OR phone LIKE ? ESCAPE '\\'"; values.push(prefix); }
    where += ")";
  }
  if (query.after !== undefined) { where += " AND (name,id)>(?,?)"; values.push(query.after.name, query.after.id); }
  values.push(limit + 1);
  const rows = tx.all(`SELECT id,name FROM ${table} WHERE ${where} ORDER BY name,id LIMIT ?`, values);
  const shown = rows.slice(0, limit), last = shown.at(-1);
  return { items: shown.map(row => load(tx, businessId, String(row["id"]))!),
    next: rows.length > limit && last !== undefined ? { name: String(last["name"]), id: String(last["id"]) } : undefined };
}

/** Reads a bounded product catalogue under current products.view authority. */
export function products(context: OperationContext, query: PageQuery = {}): Page<Product> {
  return authorizedOperation(context, ["products.view"], (_db, tx) => catalogue(tx, context.businessId, "products", query, productOf));
}
/** Exact barcode lookup for keyboard scanners. An ambiguous/absent code is never guessed. */
export function scannedProduct(context: OperationContext, barcode: string): Product | undefined {
  return authorizedOperation(context, ["products.view"], (_db, tx) => {
    const product = productByBarcode(tx, context.businessId, barcode.trim());
    return product?.active === true ? product : undefined;
  });
}
/** Reads customer details and balances under customers.view, including archived rows on request. */
export function customers(context: OperationContext, query: PageQuery = {}): Page<Customer & { outstandingMinor: number }> {
  return authorizedOperation(context, ["customers.view"], (_db, tx) => catalogue(tx, context.businessId, "customers", query,
    (db, shop, id) => { const item = customerOf(db, shop, id); return item === undefined ? undefined : { ...item, ...balanceOf(db, shop, id) }; }));
}
/** Reads supplier details and payable balances under suppliers.view. */
export function suppliers(context: OperationContext, query: PageQuery = {}): Page<Supplier & { outstandingMinor: number }> {
  return authorizedOperation(context, ["suppliers.view"], (_db, tx) => catalogue(tx, context.businessId, "suppliers", query,
    (db, shop, id) => { const item = supplierOf(db, shop, id); return item === undefined ? undefined : { ...item, ...balanceOfSupplier(db, shop, id) }; }));
}
/** Payment account names only, with no balances; available to currently authorized payment/checkout actors. */
export function paymentAccounts(context: OperationContext, query: PageQuery = {}): Page<Account> {
  return authorizedOperation(context, [], (_db, tx) => {
    const permissions = memberPermissions(activeMember(tx, context, context.userId));
    if (!["sales.create", "sales.refund", "customers.pay", "purchases.pay", "expenses.create", "finance.accounts.view"].some(p => permissions.includes(p as Permission))) throw new WorkspaceError("permission_denied");
    return catalogue(tx, context.businessId, "financial_accounts", query, accountOf);
  });
}
/** Finance account balances require cash.view as well as finance.accounts.view. */
export function accounts(context: OperationContext, query: PageQuery = {}): Page<Account & { onHandMinor: number }> {
  return authorizedOperation(context, ["finance.accounts.view", "cash.view"], (_db, tx) => catalogue(tx, context.businessId, "financial_accounts", query,
    (db, shop, id) => { const item = accountOf(db, shop, id); return item === undefined ? undefined : { ...item, ...balanceOfAccount(db, shop, id) }; }));
}
/** Reads actual signed stock under inventory.view; refuses a foreign/missing product. */
export function productStock(context: OperationContext, productId: string): ReturnType<typeof stockOf> {
  return authorizedOperation(context, ["inventory.view"], (_db, tx) => {
    if (productOf(tx, context.businessId, productId) === undefined) throw new WorkspaceError("scope_mismatch");
    return stockOf(tx, context.businessId, productId);
  });
}

/** Immutable receipt facts with historical line names/prices and exact totals. */
export interface Receipt {
  readonly id: string; readonly number: string; readonly occurredAt: string; readonly customerName?: string | undefined;
  readonly lines: readonly { id: string; productId: string; name: string; quantity: number; unitPriceMinor: number; discountMinor: number }[];
  readonly payments: readonly { id: string; accountId: string; name: string; amountMinor: number }[];
  readonly returnedMinor: number; readonly discountMinor: number; readonly totalMinor: number; readonly paidMinor: number; readonly outstandingMinor: number;
}
function salesAuthority(tx: Queryable, context: OperationContext): boolean {
  const permissions = memberPermissions(activeMember(tx, context, context.userId));
  if (permissions.includes("sales.view")) return false;
  if (permissions.includes("sales.view_own")) return true;
  throw new WorkspaceError("permission_denied");
}
/** Reads one persisted receipt. sales.view_own enforces the creating actor inside the query. */
export function receipt(context: OperationContext, saleId: string): Receipt {
  return authorizedOperation(context, [], (_db, tx) => {
    const own = salesAuthority(tx, context), row = tx.get(`SELECT s.*,c.name AS customer_name FROM sales s
      LEFT JOIN customers c ON c.business_id=s.business_id AND c.id=s.customer_id WHERE s.business_id=? AND s.id=?${own ? " AND s.user_id=?" : ""}`,
      [context.businessId, saleId, ...(own ? [context.userId] : [])]);
    if (row === undefined) throw new WorkspaceError("scope_mismatch");
    const lines = tx.all(`SELECT * FROM sale_items WHERE business_id=? AND sale_id=? ORDER BY id`, [context.businessId, saleId]).map(item => ({
      id: String(item["id"]), productId: String(item["product_id"]), name: String(item["name"]), quantity: sqlInteger(item["quantity"]!),
      unitPriceMinor: sqlInteger(item["unit_price_minor"]!), discountMinor: sqlInteger(item["discount_minor"]!),
    }));
    const payments = tx.all(`SELECT p.*,a.name AS account_name FROM sale_payments p LEFT JOIN financial_accounts a ON a.business_id=p.business_id AND a.id=p.account_id
      WHERE p.business_id=? AND p.sale_id=? ORDER BY p.id`, [context.businessId, saleId]).map(item => ({
      id: String(item["id"]), accountId: String(item["account_id"]), name: String(item["account_name"] ?? item["account_id"]), amountMinor: sqlInteger(item["amount_minor"]!),
    }));
    const discountMinor = sqlInteger(row["discount_minor"]!);
    return { id: saleId, number: String(row["number"]), occurredAt: String(row["occurred_at"]), customerName: typeof row["customer_name"] === "string" ? row["customer_name"] : undefined,
      returnedMinor: sqlInteger(tx.get(`SELECT coalesce(sum(total_minor),0) AS total FROM business_returns WHERE business_id=? AND kind='SALE' AND original_id=?`,[context.businessId,saleId])!["total"]!),
      lines, payments, discountMinor, ...saleTotals({ lines, payments, discountMinor, customerId: typeof row["customer_id"] === "string" ? row["customer_id"] : undefined }) };
  });
}
/** Keyset receipt history, newest first, bounded 1–100 and scoped to current sales authority. */
export function receipts(context: OperationContext, query: PageQuery = {}): Page<{ id: string; number: string; occurredAt: string }> {
  return authorizedOperation(context, [], (_db, tx) => {
    const own = salesAuthority(tx, context), { limit } = options(query), values: SqlValue[] = [context.businessId];
    let where = "business_id=?";
    if (own) { where += " AND user_id=?"; values.push(context.userId); }
    if (query.after !== undefined) { where += " AND (occurred_at,id)<(?,?)"; values.push(query.after.name, query.after.id); }
    values.push(limit + 1);
    const rows = tx.all(`SELECT id,number,occurred_at FROM sales WHERE ${where} ORDER BY occurred_at DESC,id DESC LIMIT ?`, values), shown = rows.slice(0, limit), last = shown.at(-1);
    return { items: shown.map(row => ({ id: String(row["id"]), number: String(row["number"]), occurredAt: String(row["occurred_at"]) })),
      next: rows.length > limit && last !== undefined ? { name: String(last["occurred_at"]), id: String(last["id"]) } : undefined };
  });
}
/** Bounded customer/supplier ledger page, newest first; preserves signs and references for statements. */
export function statement(context: OperationContext, kind: "customer" | "supplier", id: string, query: PageQuery = {}): Page<Row> {
  if (kind !== "customer" && kind !== "supplier") throw new WorkspaceError("invalid_input");
  return authorizedOperation(context, [kind === "customer" ? "customers.view" : "suppliers.view"], (_db, tx) => {
    const { limit } = options(query), values: SqlValue[] = [context.businessId, id];
    if ((kind === "customer" ? customerOf : supplierOf)(tx, context.businessId, id) === undefined) throw new WorkspaceError("scope_mismatch");
    let where = `business_id=? AND ${kind}_id=?`;
    if (query.after !== undefined) { where += " AND (occurred_at,id)<(?,?)"; values.push(query.after.name, query.after.id); }
    values.push(limit + 1);
    const rows = tx.all(`SELECT * FROM ${kind}_transactions WHERE ${where} ORDER BY occurred_at DESC,id DESC LIMIT ?`, values), shown = rows.slice(0, limit), last = shown.at(-1);
    return { items: shown, next: rows.length > limit && last !== undefined ? { name: String(last["occurred_at"]), id: String(last["id"]) } : undefined };
  });
}

/** Current effective UI capabilities, re-read from local membership; commands still authorize independently. */
export function capabilities(context: OperationContext): readonly Permission[] {
  return authorizedOperation(context, [], (_db, tx) => memberPermissions(activeMember(tx, context, context.userId)));
}

/** Bounded expense history under expenses.view; reversal status derives from referencing immutable entries. */
export function expenses(context: OperationContext, query: PageQuery = {}): Page<Row> {
  return authorizedOperation(context, ["expenses.view"], (_db, tx) => {
    const { limit } = options(query), values: SqlValue[] = [context.businessId]; let where = "e.business_id=?";
    if (query.after !== undefined) { where += " AND (e.occurred_at,e.id)<(?,?)"; values.push(query.after.name, query.after.id); }
    values.push(limit + 1);
    const rows = tx.all(`SELECT e.*,EXISTS(SELECT 1 FROM expenses r WHERE r.business_id=e.business_id AND r.reverses_id=e.id) AS reversed
      FROM expenses e WHERE ${where} ORDER BY e.occurred_at DESC,e.id DESC LIMIT ?`, values), shown = rows.slice(0, limit), last = shown.at(-1);
    return { items: shown, next: rows.length > limit && last !== undefined ? { name: String(last["occurred_at"]), id: String(last["id"]) } : undefined };
  });
}

/** Bounded manual inventory history under inventory.view, including negative movements. */
export function stockHistory(context: OperationContext, productId: string, query: PageQuery = {}): Page<Row> {
  return authorizedOperation(context, ["inventory.view"], (_db, tx) => {
    if (productOf(tx, context.businessId, productId) === undefined) throw new WorkspaceError("scope_mismatch");
    const { limit } = options(query), values: SqlValue[] = [context.businessId, productId]; let where = "business_id=? AND product_id=?";
    if (query.after !== undefined) { where += " AND (occurred_at,id)<(?,?)"; values.push(query.after.name, query.after.id); }
    values.push(limit + 1);
    const rows = tx.all(`SELECT * FROM inventory_movements WHERE ${where} ORDER BY occurred_at DESC,id DESC LIMIT ?`, values), shown = rows.slice(0, limit), last = shown.at(-1);
    return { items: shown, next: rows.length > limit && last !== undefined ? { name: String(last["occurred_at"]), id: String(last["id"]) } : undefined };
  });
}

/** Bounded purchase history under purchases.view, with exact totals from historical costs. */
export function purchases(context: OperationContext, query: PageQuery = {}): Page<{ id: string; occurredAt: string; supplierName: string; reference: string; totalMinor: number }> {
  return authorizedOperation(context, ["purchases.view"], (_db, tx) => {
    const { limit } = options(query), values: SqlValue[] = [context.businessId]; let where = "p.business_id=?";
    if (query.after !== undefined) { where += " AND (p.occurred_at,p.id)<(?,?)"; values.push(query.after.name, query.after.id); }
    values.push(limit + 1);
    const rows = tx.all(`SELECT p.*,s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON s.business_id=p.business_id AND s.id=p.supplier_id
      WHERE ${where} ORDER BY p.occurred_at DESC,p.id DESC LIMIT ?`, values), shown = rows.slice(0, limit), last = shown.at(-1);
    return { items: shown.map(row => ({ id: String(row["id"]), occurredAt: String(row["occurred_at"]), supplierName: String(row["supplier_name"] ?? ""), reference: String(row["reference"] ?? ""),
      totalMinor: subtotalOf(tx.all(`SELECT unit_cost_minor,quantity FROM purchase_items WHERE business_id=? AND purchase_id=?`, [context.businessId, row["id"]!])
        .map(item => ({ unitPriceMinor: sqlInteger(item["unit_cost_minor"]!), quantity: sqlInteger(item["quantity"]!) }))),
    })), next: rows.length > limit && last !== undefined ? { name: String(last["occurred_at"]), id: String(last["id"]) } : undefined };
  });
}

/** Bounded categories under products.view. Inactive categories can remain attached to historic products. */
export function categories(context: OperationContext, query: PageQuery = {}): Page<Category> {
  return authorizedOperation(context, ["products.view"], (_db, tx) => catalogue(tx, context.businessId, "categories", query, categoryOf));
}
/** Current receivable/payable summary under the domain view permission, refreshed independently of a selected row. */
export function personBalance(context: OperationContext, kind: "customer" | "supplier", id: string): number {
  if (kind !== "customer" && kind !== "supplier") throw new WorkspaceError("invalid_input");
  return authorizedOperation(context, [kind === "customer" ? "customers.view" : "suppliers.view"], (_db, tx) => {
    if ((kind === "customer" ? customerOf : supplierOf)(tx, context.businessId, id) === undefined) throw new WorkspaceError("scope_mismatch");
    return (kind === "customer" ? balanceOf : balanceOfSupplier)(tx, context.businessId, id).outstandingMinor;
  });
}

/** One category within current products.view scope, including inactive retained associations. */
export function category(context: OperationContext, id: string): Category | undefined {
  return authorizedOperation(context, ["products.view"], (_db, tx) => categoryOf(tx, context.businessId, id));
}

/** Paginated positive receivables/payables for report-only actors, including archived counterparty debts. */
export function debtPage(context: OperationContext, kind: "customer" | "supplier", query: PageQuery = {}): Page<{ id: string; name: string; amountMinor: number }> {
  if (kind !== "customer" && kind !== "supplier") throw new WorkspaceError("invalid_input");
  return authorizedOperation(context,[kind === "customer" ? "reports.customers" : "reports.suppliers"],(_db,tx)=>{
    const {limit,term}=options(query),values:SqlValue[]=[context.businessId];let where="c.business_id=?";
    if(term!==""){where+=" AND c.name LIKE ? ESCAPE '\\'";values.push(term.replace(/[\\%_]/g,"\\$&")+"%");}
    if(query.after!==undefined){where+=" AND (c.name,c.id)>(?,?)";values.push(query.after.name,query.after.id);}values.push(limit+1);
    const rows=tx.all(`SELECT c.id,c.name,sum(t.amount_minor) AS amount FROM ${kind === "customer" ? "customers" : "suppliers"} c
      JOIN ${kind}_transactions t ON t.business_id=c.business_id AND t.${kind}_id=c.id WHERE ${where} GROUP BY c.id,c.name HAVING sum(t.amount_minor)>0 ORDER BY c.name,c.id LIMIT ?`,values),shown=rows.slice(0,limit),last=shown.at(-1);
    return {items:shown.map(row=>({id:String(row["id"]),name:String(row["name"]),amountMinor:sqlInteger(row["amount"]!)})),next:rows.length>limit&&last!==undefined?{name:String(last["name"]),id:String(last["id"])}:undefined};
  });
}
/** Bounded stock alerts include negative stock and configured reorder thresholds under reports.inventory. */
export function stockAlertPage(context: OperationContext, query: PageQuery = {}): Page<{ id: string; name: string; quantity: number }> {
  return authorizedOperation(context,["reports.inventory"],(_db,tx)=>{
    const {limit,term}=options(query),values:SqlValue[]=[context.businessId];let where="p.business_id=? AND p.active=1";
    if(term!==""){where+=" AND p.name LIKE ? ESCAPE '\\'";values.push(term.replace(/[\\%_]/g,"\\$&")+"%");}
    if(query.after!==undefined){where+=" AND (p.name,p.id)>(?,?)";values.push(query.after.name,query.after.id);}values.push(limit+1);
    const rows=tx.all(`SELECT p.id,p.name,coalesce(sum(m.quantity),0) AS quantity FROM products p LEFT JOIN inventory_movements m ON m.business_id=p.business_id AND m.product_id=p.id
      WHERE ${where} GROUP BY p.id,p.name,p.minimum_stock HAVING quantity<0 OR (p.minimum_stock>0 AND quantity<=p.minimum_stock) ORDER BY p.name,p.id LIMIT ?`,values),shown=rows.slice(0,limit),last=shown.at(-1);
    return {items:shown.map(row=>({id:String(row["id"]),name:String(row["name"]),quantity:sqlInteger(row["quantity"]!)})),next:rows.length>limit&&last!==undefined?{name:String(last["name"]),id:String(last["id"])}:undefined};
  });
}
