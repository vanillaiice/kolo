import { parseEventPayload } from "@kolo/contracts/events";
import { upsertCategory, type Category } from "../data/products/categories.ts";
import { enqueue } from "../data/sync/outbox.ts";
import { sumAmounts } from "../rules/amounts.ts";
import type { Queryable } from "../data/database/driver.ts";
import { saveProduct as writeProduct, type SaveProduct } from "../data/products/products.ts";
import { saveCustomer as writeCustomer, recordCustomerPayment, customerOf, wouldExceedCreditLimit, type SaveCustomer, type CustomerPayment } from "../data/customers/customers.ts";
import { saveSupplier as writeSupplier, recordSupplierPayment, type SaveSupplier, type SupplierPayment } from "../data/suppliers/suppliers.ts";
import { saveAccount as writeAccount, type SaveAccount } from "../data/finance/accounts.ts";
import { completeSale as writeSale, totalsOf, type Cart, type SaleTotals } from "../data/sales/sales.ts";
import { recordPurchase as writePurchase, type Delivery, type DeliveryTotals } from "../data/purchases/purchases.ts";
import { recordMovement, stockOf, type NewMovement } from "../data/inventory/movements.ts";
import { moveCash as writeCash, reconcile, type CashMovement, type Reconciliation } from "../data/finance/cash.ts";
import { recordExpense as writeExpense, type Expense } from "../data/expenses/expenses.ts";
import { appendLocalAudit, authorizedOperation, nextId } from "../identity/internal-authority.ts";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "../identity/types.ts";
import type { Permission } from "../identity/permissions.ts";

/** Application inputs carry facts/IDs; authority and persistence time come from unlock ports. */
export type CommandInput<T> = Omit<T, "businessId" | "userId" | "deviceId" | "recordedAt">;

/**
 * Records a sale under local authority: sales.create, conditional discount/price
 * override/credit permissions and credit-limit enforcement. All related records
 * must belong to the installation's shop. Effects, v1 outbox and audit commit
 * together; any failure commits nothing. IDs/time of occurrence are caller facts.
 */
export function completeSale(context: OperationContext, input: CommandInput<Cart>): SaleTotals {
  return authorizedOperation(context, ["sales.create"], (database, tx, ports, revision) => {
    const cart = bind(context, input, ports);
    checkBranch(tx, context, cart.branchId);
    let priceOverride = false;
    for (const line of cart.lines) {
      const product = related(tx, context, "products", line.productId);
      if (product?.["divisible"] === 0 && line.quantity % 1000 !== 0) throw new WorkspaceError("invalid_input");
      if (product?.["selling_price_minor"] !== line.unitPriceMinor) priceOverride = true;
    }
    for (const payment of cart.payments) related(tx, context, "financial_accounts", payment.accountId);
    related(tx, context, "customers", cart.customerId);
    const required: Permission[] = [];
    if (priceOverride) required.push("sales.price_override");
    if ((cart.discountMinor ?? 0) > 0 || cart.lines.some(line => (line.discountMinor ?? 0) > 0)) required.push("sales.discount");
    const totals = totalsOf(cart);
    if (totals.outstandingMinor > 0) {
      required.push("customers.credit");
      const customer = cart.customerId === undefined ? undefined : customerOf(tx, context.businessId, cart.customerId);
      if (customer !== undefined && wouldExceedCreditLimit(tx, context.businessId, customer, totals.outstandingMinor)) {
        required.push("customers.credit_override");
      }
    }
    return authorizedOperation(context, required, () => {
      const result = writeSale(database, cart);
      appendLocalAudit(tx, context, ports, revision, "SALE_COMPLETED", cart.id, { eventId: cart.eventId });
      return result;
    });
  });
}

/** Receives stock under purchases.create, and purchases.pay when money is paid at the door. */
export function recordPurchase(context: OperationContext, input: CommandInput<Delivery>): DeliveryTotals {
  return authorizedOperation(context, ["purchases.create", ...(input.payments.length > 0 ? ["purchases.pay" as const] : [])], (database, tx, ports, revision) => {
    const delivery = bind(context, input, ports);
    checkBranch(tx, context, delivery.branchId);
    related(tx, context, "suppliers", delivery.supplierId);
    for (const line of delivery.lines) {
      const product = related(tx, context, "products", line.productId);
      if (product?.["divisible"] === 0 && line.quantity % 1000 !== 0) throw new WorkspaceError("invalid_input");
    }
    for (const payment of delivery.payments) related(tx, context, "financial_accounts", payment.accountId);
    const result = writePurchase(database, delivery);
    appendLocalAudit(tx, context, ports, revision, "PURCHASE_RECORDED", delivery.id, { eventId: delivery.eventId });
    return result;
  });
}

/** Receives customer payments under customers.pay; shop/account/customer and actor are checked atomically. */
export function receiveCustomerPayment(context: OperationContext, input: CommandInput<CustomerPayment>): void {
  authorizedOperation(context, ["customers.pay"], (database, tx, ports, revision) => {
    const payment = bind(context, input, ports);
    checkBranch(tx, context, payment.branchId);
    related(tx, context, "customers", payment.customerId);
    related(tx, context, "financial_accounts", payment.accountId);
    recordCustomerPayment(database, payment);
    appendLocalAudit(tx, context, ports, revision, "CUSTOMER_PAYMENT", payment.id, { eventId: payment.eventId });
  });
}

/** Pays a supplier under purchases.pay; effects, event and audit roll back together. */
export function paySupplier(context: OperationContext, input: CommandInput<SupplierPayment>): void {
  authorizedOperation(context, ["purchases.pay"], (database, tx, ports, revision) => {
    const payment = bind(context, input, ports);
    checkBranch(tx, context, payment.branchId);
    related(tx, context, "suppliers", payment.supplierId);
    related(tx, context, "financial_accounts", payment.accountId);
    recordSupplierPayment(database, payment);
    appendLocalAudit(tx, context, ports, revision, "SUPPLIER_PAYMENT", payment.id, { eventId: payment.eventId });
  });
}

/**
 * Records a manual stock adjustment/count under the respective permission.
 * Sale/purchase/return movements must use their business workflow; they cannot
 * be forged through this command. Existing reference fields are refused here.
 */
export function adjustStock(context: OperationContext, input: CommandInput<NewMovement>, eventId: string): void {
  if (!["ADJUSTMENT", "STOCK_COUNT", "DAMAGE", "OPENING_BALANCE"].includes(input.type) || input.reference !== undefined) {
    throw new WorkspaceError("invalid_input");
  }
  const permission = input.type === "STOCK_COUNT" ? "inventory.count" : "inventory.adjust";
  authorizedOperation(context, [permission], (database, tx, ports, revision) => {
    const movement = bind(context, input, ports);
    checkBranch(tx, context, movement.branchId);
    const product = related(tx, context, "products", movement.productId);
    if (product?.["divisible"] === 0 && movement.quantity % 1000 !== 0) throw new WorkspaceError("invalid_input");
    recordMovement(database, movement, { eventId, type: "STOCK_MOVED" });
    appendLocalAudit(tx, context, ports, revision, "STOCK_ADJUSTED", movement.id, { eventId });
  });
}

/**
 * Records cash movement/transfer under cash.move; ADJUSTMENT also requires
 * cash.reconcile. Every leg is bound to the local actor/shop and checked for
 * account/branch scope before writing. Money and outbox remain atomic.
 */
export function moveCash(context: OperationContext, input: { readonly movements: readonly CommandInput<CashMovement>[]; readonly eventId: string }): void {
  authorizedOperation(context, ["cash.move", ...(input.movements.some(m => m.type === "ADJUSTMENT") ? ["cash.reconcile" as const] : [])], (database, tx, ports, revision) => {
    const movements = input.movements.map(m => bind(context, m, ports));
    for (const movement of movements) {
      checkBranch(tx, context, movement.branchId);
      related(tx, context, "financial_accounts", movement.accountId);
      related(tx, context, "financial_accounts", movement.counterpartId);
      if (movement.type === "TRANSFER_IN" || movement.type === "TRANSFER_OUT") {
        const oppositeType = movement.type === "TRANSFER_IN" ? "TRANSFER_OUT" : "TRANSFER_IN";
        const partners = movements.filter(other => other.type === oppositeType &&
          other.accountId === movement.counterpartId && other.counterpartId === movement.accountId &&
          other.amountMinor === -movement.amountMinor && other.branchId === movement.branchId);
        if (partners.length !== 1) throw new WorkspaceError("invalid_input");
      }
    }
    writeCash(database, { movements, eventId: input.eventId });
    appendLocalAudit(tx, context, ports, revision, "CASH_MOVED", input.eventId, { eventId: input.eventId });
  });
}

/** Authorized count comparison in XAF under cash.count; records audit, moves no money. */
export function reconcileCash(context: OperationContext, accountId: string, countedMinor: number): Reconciliation {
  return authorizedOperation(context, ["cash.count"], (_database, tx, ports, revision) => {
    related(tx, context, "financial_accounts", accountId);
    const result = reconcile(tx, context.businessId, accountId, countedMinor);
    appendLocalAudit(tx, context, ports, revision, "CASH_COUNTED", accountId, { ...result });
    return result;
  });
}

/** Records an expense/reversal under expenses.create; reversal source must belong to this shop. */
export function recordExpense(context: OperationContext, input: CommandInput<Expense>): void {
  authorizedOperation(context, ["expenses.create"], (database, tx, ports, revision) => {
    const expense = bind(context, input, ports);
    checkBranch(tx, context, expense.branchId);
    related(tx, context, "financial_accounts", expense.accountId);
    const original = related(tx, context, "expenses", expense.reversesId, false);
    if (original !== undefined && (Number(original["amount_minor"]) <= 0 ||
      expense.amountMinor !== -Number(original["amount_minor"]) || expense.accountId !== original["account_id"] ||
      expense.category !== original["category"] || (expense.branchId ?? null) !== original["branch_id"])) {
      throw new WorkspaceError("invalid_input");
    }
    writeExpense(database, expense);
    appendLocalAudit(tx, context, ports, revision, "EXPENSE_RECORDED", expense.id, { eventId: expense.eventId });
  });
}

/** Saves a product under create/edit plus price/archive checks; refuses cross-shop upsert/category. */
export function saveProduct(context: OperationContext, input: CommandInput<SaveProduct>): boolean {
  return authorizedOperation(context, [], (database, tx, ports, revision) => {
    const existing = existingScoped(tx, context, "products", input.id);
    related(tx, context, "categories", input.categoryId, existing?.["category_id"] !== input.categoryId);
    const permissions: Permission[] = [existing === undefined ? "products.create" : "products.edit"];
    if (existing !== undefined && (existing["selling_price_minor"] !== input.sellingPriceMinor || existing["purchase_price_minor"] !== (input.purchasePriceMinor ?? null))) permissions.push("products.price");
    if (!input.active) permissions.push("products.archive");
    return authorizedOperation(context, permissions, () => {
      const result = writeProduct(database, bind(context, input, ports), nextId(ports));
      appendLocalAudit(tx, context, ports, revision, "PRODUCT_SAVED", input.id);
      return result;
    });
  });
}

/** Saves customer details under customers.manage; prevents global-ID upsert into another shop. */
export function saveCustomer(context: OperationContext, input: CommandInput<SaveCustomer>): boolean {
  return authorizedOperation(context, ["customers.manage"], (database, tx, ports, revision) => {
    existingScoped(tx, context, "customers", input.id);
    const result = writeCustomer(database, bind(context, input, ports), nextId(ports));
    appendLocalAudit(tx, context, ports, revision, "CUSTOMER_SAVED", input.id);
    return result;
  });
}

/** Saves supplier details under suppliers.manage and checks existing identifier scope. */
export function saveSupplier(context: OperationContext, input: CommandInput<SaveSupplier>): boolean {
  return authorizedOperation(context, ["suppliers.manage"], (database, tx, ports, revision) => {
    existingScoped(tx, context, "suppliers", input.id);
    const result = writeSupplier(database, bind(context, input, ports), nextId(ports));
    appendLocalAudit(tx, context, ports, revision, "SUPPLIER_SAVED", input.id);
    return result;
  });
}

/** Saves financial account details under finance.accounts.manage with shop-isolated identifiers. */
export function saveAccount(context: OperationContext, input: CommandInput<SaveAccount>): boolean {
  return authorizedOperation(context, ["finance.accounts.manage"], (database, tx, ports, revision) => {
    existingScoped(tx, context, "financial_accounts", input.id);
    checkBranch(tx, context, input.branchId);
    const result = writeAccount(database, bind(context, input, ports), nextId(ports));
    appendLocalAudit(tx, context, ports, revision, "ACCOUNT_SAVED", input.id);
    return result;
  });
}

function bind<T extends object>(context: OperationContext, input: T, ports: WorkspacePorts): T & OperationContext & { recordedAt: string } {
  // Context fields deliberately come last, including for untyped/runtime callers.
  const at = ports.now();
  if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) throw new WorkspaceError("invalid_input");
  return { ...input, businessId: context.businessId, userId: context.userId, deviceId: context.deviceId, recordedAt: at };
}

type ScopedTable = "products" | "customers" | "suppliers" | "financial_accounts" | "categories" | "branches" | "expenses";

function existingScoped(tx: Queryable, context: OperationContext, table: ScopedTable, id: string): ReturnType<Queryable["get"]> {
  // table is an internal allowlist, never a user-provided identifier.
  const row = tx.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (row !== undefined && row["business_id"] !== context.businessId) throw new WorkspaceError("scope_mismatch");
  return row;
}

function related(tx: Queryable, context: OperationContext, table: ScopedTable, id: string | undefined, active = true): ReturnType<Queryable["get"]> {
  if (id === undefined) return undefined;
  const row = existingScoped(tx, context, table, id);
  if (row === undefined || (active && row["active"] !== 1)) throw new WorkspaceError("scope_mismatch");
  return row;
}

function checkBranch(tx: Queryable, context: OperationContext, branchId: string | undefined): void {
  related(tx, context, "branches", branchId);
  const actor = tx.get(`SELECT u.branch_id AS user_branch, d.branch_id AS device_branch
    FROM users u JOIN devices d ON d.id = ? AND d.business_id = u.business_id WHERE u.id = ? AND u.business_id = ?`,
  [context.deviceId, context.userId, context.businessId]);
  for (const bound of [actor?.["user_branch"], actor?.["device_branch"]]) {
    if (typeof bound === "string" && bound !== branchId) throw new WorkspaceError("scope_mismatch");
  }
}

/**
 * Counts actual stock in thousandths under inventory.count. Computes a compensating
 * delta against current stock inside the write transaction; a matching count records
 * audit only. Negative observed quantities and fractional indivisible units are refused.
 * An optional caller request ID becomes the movement ID and is kept in the local audit,
 * so adapters can recognise a retried count instead of recounting against later sales.
 */
export function countStock(context: OperationContext, input: { readonly productId: string; readonly countedThousandths: number; readonly reason: string; readonly branchId?: string | undefined; readonly requestId?: string | undefined }): number {
  return authorizedOperation(context, ["inventory.count"], (database, tx, ports, revision) => {
    const product = related(tx, context, "products", input.productId);
    checkBranch(tx, context, input.branchId);
    if (!Number.isSafeInteger(input.countedThousandths) || input.countedThousandths < 0 || input.reason.trim() === "" ||
      (product?.["divisible"] === 0 && input.countedThousandths % 1000 !== 0)) throw new WorkspaceError("invalid_input");
    const current = stockOf(tx, context.businessId, input.productId).onHandThousandths;
    const delta = sumAmounts([input.countedThousandths, -current]);
    if (delta !== 0) {
      const at = ports.now(), eventId = nextId(ports);
      recordMovement(database, { id: input.requestId ?? nextId(ports), ...context, branchId: input.branchId, productId: input.productId,
        type: "STOCK_COUNT", quantity: delta, reason: input.reason.trim(), occurredAt: at, recordedAt: at }, { eventId, type: "STOCK_MOVED" });
    }
    appendLocalAudit(tx, context, ports, revision, "STOCK_COUNTED", input.productId, { countedThousandths: input.countedThousandths, expectedThousandths: current, delta, reason: input.reason.trim(),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }) });
    return delta;
  });
}

/**
 * Owner-authorized count plus explicit cash correction under cash.count/cash.reconcile/
 * cash.move. Recomputes the expected balance atomically and appends the adjustment and
 * audit. An equal count records audit only; a reason is always required. An optional
 * caller request ID names the adjustment and is kept in the local audit, so adapters can
 * recognise a retried correction instead of correcting again against later movements.
 */
export function adjustCashToCount(context: OperationContext, input: { readonly accountId: string; readonly countedMinor: number; readonly reason: string; readonly branchId?: string | undefined; readonly requestId?: string | undefined }): Reconciliation {
  return authorizedOperation(context, ["cash.count", "cash.reconcile", "cash.move"], (database, tx, ports, revision) => {
    related(tx, context, "financial_accounts", input.accountId); checkBranch(tx, context, input.branchId);
    if (input.reason.trim() === "") throw new WorkspaceError("invalid_input");
    const result = reconcile(tx, context.businessId, input.accountId, input.countedMinor);
    if (result.differenceMinor !== 0) {
      const at = ports.now();
      writeCash(database, { eventId: nextId(ports), movements: [{ id: input.requestId ?? nextId(ports), ...context, branchId: input.branchId,
        accountId: input.accountId, type: "ADJUSTMENT", amountMinor: result.differenceMinor, reason: input.reason.trim(), occurredAt: at, recordedAt: at }] });
    }
    appendLocalAudit(tx, context, ports, revision, "CASH_RECONCILED", input.accountId, { ...result, reason: input.reason.trim(),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }) });
    return result;
  });
}

/** Saves a category under product create/edit/archive authority. LWW details, v2 event and audit commit together. */
export function saveCategory(context: OperationContext, input: Omit<Category, "businessId" | "updatedByDevice">): boolean {
  return authorizedOperation(context, [], (_database, tx, ports, revision) => {
    const existing = existingScoped(tx, context, "categories", input.id);
    const permissions: Permission[] = [existing === undefined ? "products.create" : "products.edit"];
    if (!input.active) permissions.push("products.archive");
    if (input.updatedAt < input.createdAt) throw new WorkspaceError("invalid_input");
    const payload = { category: { id: input.id, name: input.name, active: input.active, created_at: input.createdAt, updated_at: input.updatedAt } };
    try { parseEventPayload("CATEGORY_SAVED", 2, payload); } catch { throw new WorkspaceError("invalid_input"); }
    return authorizedOperation(context, permissions, () => {
      const result = upsertCategory(tx, { ...input, businessId: context.businessId }, context.deviceId);
      enqueue(tx, { eventId: nextId(ports), ...context, type: "CATEGORY_SAVED", payload, occurredAt: input.updatedAt });
      appendLocalAudit(tx, context, ports, revision, "CATEGORY_SAVED", input.id);
      return result;
    });
  });
}
