import type { Queryable } from "../data/database/driver.ts";
import { sqlInteger } from "../data/database/safe-values.ts";
import { productOf, type Product } from "../data/products/products.ts";
import { customerOf, balanceOf, type Customer } from "../data/customers/customers.ts";
import { supplierOf, balanceOfSupplier, type Supplier } from "../data/suppliers/suppliers.ts";
import { accountOf, type Account } from "../data/finance/accounts.ts";
import { balanceOfAccount } from "../data/finance/cash.ts";
import { authorizedOperation, activeMember, memberPermissions } from "../identity/internal-authority.ts";
import { WorkspaceError, type OperationContext } from "../identity/types.ts";
import { purchaseTotals } from "../rules/pricing.ts";

/** One product of this shop under products.view, archived or not; undefined when absent or foreign. */
export function product(context: OperationContext, id: string): Product | undefined {
  return authorizedOperation(context, ["products.view"], (_db, tx) => productOf(tx, context.businessId, id));
}

/** One customer with the derived balance under customers.view, archived or not. */
export function customer(context: OperationContext, id: string): (Customer & { outstandingMinor: number }) | undefined {
  return authorizedOperation(context, ["customers.view"], (_db, tx) => {
    const item = customerOf(tx, context.businessId, id);
    return item === undefined ? undefined : { ...item, outstandingMinor: balanceOf(tx, context.businessId, id).outstandingMinor };
  });
}

/** One supplier with the derived payable under suppliers.view, archived or not. */
export function supplier(context: OperationContext, id: string): (Supplier & { outstandingMinor: number }) | undefined {
  return authorizedOperation(context, ["suppliers.view"], (_db, tx) => {
    const item = supplierOf(tx, context.businessId, id);
    return item === undefined ? undefined : { ...item, outstandingMinor: balanceOfSupplier(tx, context.businessId, id).outstandingMinor };
  });
}

/**
 * One financial account. Its derived balance is included only for actors holding both
 * finance.accounts.view and cash.view; otherwise the account is readable under cash.move
 * or finance.accounts.view without a balance.
 */
export function account(context: OperationContext, id: string): (Account & { onHandMinor?: number }) | undefined {
  return authorizedOperation(context, [], (_db, tx) => {
    const permissions = memberPermissions(tx, activeMember(tx, context, context.userId));
    const balance = permissions.includes("finance.accounts.view") && permissions.includes("cash.view");
    if (!balance && !permissions.includes("cash.move") && !permissions.includes("finance.accounts.view")) throw new WorkspaceError("permission_denied");
    const item = accountOf(tx, context.businessId, id);
    if (item === undefined) return undefined;
    return balance ? { ...item, onHandMinor: balanceOfAccount(tx, context.businessId, id).onHandMinor } : item;
  });
}

/** A received delivery with historical lines, door payment and what it left owing. */
export interface PurchaseDetail {
  readonly id: string; readonly occurredAt: string; readonly supplierId?: string; readonly supplierName: string; readonly reference: string;
  readonly lines: readonly { readonly id: string; readonly productId: string; readonly name: string; readonly quantity: number; readonly unitCostMinor: number }[];
  readonly totalMinor: number; readonly paidMinor: number; readonly outstandingMinor: number; readonly returnedMinor: number;
}
function doorPayments(tx: Queryable, businessId: string, purchaseId: string): { accountId: string; amountMinor: number }[] {
  // Door payments carry no purchase reference; they are the account movements claimed by the purchase's event.
  return tx.all(`SELECT m.account_id,m.amount_minor FROM journal_entity_claims p JOIN journal_entity_claims c ON c.event_id=p.event_id AND c.table_name='account_movements'
    JOIN account_movements m ON m.id=c.entity_id AND m.business_id=? WHERE p.table_name='purchases' AND p.entity_id=?`, [businessId, purchaseId])
    .map(row => ({ accountId: String(row["account_id"]), amountMinor: -sqlInteger(row["amount_minor"]!) }));
}
/** One purchase under purchases.view; undefined when absent or foreign. */
export function purchase(context: OperationContext, id: string): PurchaseDetail | undefined {
  return authorizedOperation(context, ["purchases.view"], (_db, tx) => {
    const row = tx.get(`SELECT p.*,s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON s.business_id=p.business_id AND s.id=p.supplier_id WHERE p.business_id=? AND p.id=?`, [context.businessId, id]);
    if (row === undefined) return undefined;
    const lines = tx.all(`SELECT i.id,i.product_id,i.quantity,i.unit_cost_minor,p.name FROM purchase_items i LEFT JOIN products p ON p.business_id=i.business_id AND p.id=i.product_id
      WHERE i.business_id=? AND i.purchase_id=? ORDER BY i.id`, [context.businessId, id]).map(item => ({ id: String(item["id"]), productId: String(item["product_id"]), name: String(item["name"] ?? ""),
      quantity: sqlInteger(item["quantity"]!), unitCostMinor: sqlInteger(item["unit_cost_minor"]!) }));
    const supplierId = typeof row["supplier_id"] === "string" ? row["supplier_id"] : undefined;
    const totals = purchaseTotals({ lines, payments: doorPayments(tx, context.businessId, id), supplierId });
    const returned = tx.get(`SELECT coalesce(sum(total_minor),0) AS total FROM business_returns WHERE business_id=? AND kind='PURCHASE' AND original_id=?`, [context.businessId, id])!;
    return { id, occurredAt: String(row["occurred_at"]), ...(supplierId === undefined ? {} : { supplierId }), supplierName: String(row["supplier_name"] ?? ""), reference: String(row["reference"] ?? ""),
      lines, totalMinor: totals.totalMinor, paidMinor: totals.paidMinor, outstandingMinor: totals.outstandingMinor, returnedMinor: sqlInteger(returned["total"]!) };
  });
}

/** One immutable expense entry with its account name and reversal state. */
export interface ExpenseDetail {
  readonly id: string; readonly occurredAt: string; readonly category: string; readonly amountMinor: number; readonly accountId: string; readonly accountName: string;
  readonly branchId?: string; readonly description?: string; readonly reference?: string; readonly reversesId?: string; readonly reversedBy?: string;
}
/** One expense under expenses.view; undefined when absent or foreign. */
export function expense(context: OperationContext, id: string): ExpenseDetail | undefined {
  return authorizedOperation(context, ["expenses.view"], (_db, tx) => {
    const row = tx.get(`SELECT e.*,a.name AS account_name,(SELECT r.id FROM expenses r WHERE r.business_id=e.business_id AND r.reverses_id=e.id LIMIT 1) AS reversed_by
      FROM expenses e LEFT JOIN financial_accounts a ON a.business_id=e.business_id AND a.id=e.account_id WHERE e.business_id=? AND e.id=?`, [context.businessId, id]);
    if (row === undefined) return undefined;
    const text = (key: string): string | undefined => typeof row[key] === "string" && row[key] !== "" ? row[key] : undefined;
    const optional = (key: string, value: string | undefined): Record<string, string> => value === undefined ? {} : { [key]: value };
    return { id, occurredAt: String(row["occurred_at"]), category: String(row["category"]), amountMinor: sqlInteger(row["amount_minor"]!), accountId: String(row["account_id"]),
      accountName: String(row["account_name"] ?? ""), ...optional("branchId", text("branch_id")), ...optional("description", text("description")), ...optional("reference", text("reference")),
      ...optional("reversesId", text("reverses_id")), ...optional("reversedBy", text("reversed_by")) } as ExpenseDetail;
  });
}

/**
 * A product's additional categories (not its main one), named, with the version of the set an edit
 * must advance past, under products.view.
 */
export function productCategories(context: OperationContext, productId: string): { readonly categories: readonly { readonly id: string; readonly name: string; readonly active: boolean }[]; readonly updatedAt?: string } {
  return authorizedOperation(context, ["products.view"], (_db, tx) => {
    if (productOf(tx, context.businessId, productId) === undefined) return { categories: [] };
    const version = tx.get(`SELECT updated_at FROM product_category_sets WHERE business_id = ? AND id = ?`, [context.businessId, productId]);
    const categories = tx.all(`SELECT c.id, c.name, c.active FROM product_categories pc JOIN categories c ON c.business_id = pc.business_id AND c.id = pc.category_id
      WHERE pc.business_id = ? AND pc.product_id = ? ORDER BY c.name, c.id`, [context.businessId, productId]).map(row => ({ id: String(row["id"]), name: String(row["name"]), active: row["active"] === 1 }));
    return version === undefined ? { categories } : { categories, updatedAt: String(version["updated_at"]) };
  });
}
