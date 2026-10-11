import { parseEventPayload, type EventType, type JournalEnvelope } from "@kolo/contracts/events";
import { purchaseTotals, saleTotals } from "../../rules/pricing.ts";
import { multiplyRatio, QUANTITY_SCALE, sumAmounts } from "../../rules/amounts.ts";
import type { Permission } from "../../rules/permissions.ts";
import { ExchangeError } from "../../exchange/types.ts";

/** @internal Allowlisted entity tables used for dependency, scope and immutable-ID checks. */
export type EntityTable = "business_returns" | "business_return_items" | "business_return_refunds" | "categories" | "products" | "customers" | "suppliers" | "financial_accounts" | "sales" | "sale_items" | "sale_payments" | "inventory_movements" | "customer_transactions" | "purchases" | "purchase_items" | "account_movements" | "supplier_transactions" | "expenses" | "product_category_sets";
/** @internal Entity ownership and dependencies derived only from strict payload schemas. */
export interface EventModel {
  readonly entities: readonly { readonly table: EntityTable; readonly id: string; readonly mutable: boolean; readonly branch: string | null }[];
  readonly references: readonly { readonly table: EntityTable | "categories" | "branches"; readonly id: string }[];
  readonly permissions: readonly Permission[];
  readonly authority: boolean;
}

/** @internal Validates complete financial fan-out, exact arithmetic, signs and required capabilities. */
export function eventModel(event: JournalEnvelope): EventModel {
  const entities: { table: EntityTable; id: string; mutable: boolean; branch: string | null }[] = [];
  const references: { table: EntityTable | "categories" | "branches"; id: string }[] = [];
  const permissions: Permission[] = [];
  const add = (table: EntityTable, id: string, mutable = false): void => { entities.push({ table, id, mutable, branch: event.branch_id }); };
  const ref = (table: EntityTable | "categories" | "branches", id?: string): void => { if (id !== undefined) references.push({ table, id }); };
  const fail = (): never => { throw new ExchangeError("invalid_payload"); };
  const checkTime = (value: string | undefined): void => { if (value !== undefined && value !== event.occurred_at) fail(); };
  const manual = ["ADJUSTMENT", "STOCK_COUNT", "DAMAGE", "OPENING_BALANCE"];
  switch (event.event_type as EventType) {
    case "SALE_RETURNED": case "PURCHASE_RETURNED": {
      const { returned } = parseEventPayload(event.event_type as "SALE_RETURNED" | "PURCHASE_RETURNED",event.event_version,event.payload);
      const sale = event.event_type === "SALE_RETURNED";
      permissions.push(...(sale ? ["sales.refund" as const] : ["purchases.create" as const, "purchases.pay" as const]));
      add("business_returns",returned.id); ref(sale ? "sales" : "purchases",returned.original_id); ref("business_returns",returned.prior_id);
      for (const item of returned.items) { add("business_return_items",item.id); add("inventory_movements",item.movement_id); ref(sale ? "sale_items" : "purchase_items",item.original_item_id); }
      // Refund mapping shares the immutable movement ID, so claim the movement once.
      for (const refund of returned.refunds) { add("account_movements",refund.id); ref("financial_accounts",refund.account_id); }
      if (returned.debt_transaction_id !== undefined) add(sale ? "customer_transactions" : "supplier_transactions",returned.debt_transaction_id);
      break;
    }
    case "CATEGORY_SAVED": {
      const { category } = parseEventPayload("CATEGORY_SAVED", event.event_version, event.payload);
      add("categories", category.id, true);
      permissions.push(event.required_permissions.includes("products.edit") ? "products.edit" : "products.create");
      if (!category.active) permissions.push("products.archive");
      if (category.updated_at < category.created_at) fail();
      break;
    }
    case "PRODUCT_SAVED": {
      const { product } = parseEventPayload("PRODUCT_SAVED", event.event_version, event.payload);
      add("products", product.id, true); ref("categories", product.category_id);
      const claim = event.required_permissions.includes("products.edit") ? "products.edit" : "products.create";
      permissions.push(claim); if (product.active === false) permissions.push("products.archive");
      if (product.updated_at < product.created_at) fail();
      break;
    }
    case "PRODUCT_CATEGORIES_SET": {
      const set = parseEventPayload("PRODUCT_CATEGORIES_SET", event.event_version, event.payload);
      add("product_category_sets", set.product_id, true); ref("products", set.product_id);
      for (const id of set.category_ids) ref("categories", id);
      permissions.push("products.edit");
      break;
    }
    case "CUSTOMER_SAVED": { const { customer } = parseEventPayload("CUSTOMER_SAVED", event.event_version, event.payload); add("customers", customer.id, true); permissions.push("customers.manage"); if (customer.updated_at < customer.created_at) fail(); break; }
    case "SUPPLIER_SAVED": { const { supplier } = parseEventPayload("SUPPLIER_SAVED", event.event_version, event.payload); add("suppliers", supplier.id, true); permissions.push("suppliers.manage"); if (supplier.updated_at < supplier.created_at) fail(); break; }
    case "ACCOUNT_SAVED": { const { account } = parseEventPayload("ACCOUNT_SAVED", event.event_version, event.payload); add("financial_accounts", account.id, true); permissions.push("finance.accounts.manage"); ref("branches", account.branch_id); if (account.updated_at < account.created_at) fail(); break; }
    case "SALE_COMPLETED": {
      const { sale, payments, movements } = parseEventPayload("SALE_COMPLETED", event.event_version, event.payload);
      checkTime(sale.occurred_at); add("sales", sale.id); ref("customers", sale.customer_id); permissions.push("sales.create");
      const totals = saleTotals({ lines: sale.items.map(item => ({ unitPriceMinor: item.unit_price_minor, quantity: item.quantity, discountMinor: item.discount_minor })), payments: payments.map(payment => ({ amountMinor: payment.amount_minor })), discountMinor: sale.discount_minor, customerId: sale.customer_id });
      if (totals.outstandingMinor > 0) { if (sale.credit_transaction_id === undefined) fail(); add("customer_transactions", sale.credit_transaction_id!); permissions.push("customers.credit"); }
      else if (sale.credit_transaction_id !== undefined) fail();
      if ((sale.discount_minor ?? 0) > 0 || sale.items.some(item => (item.discount_minor ?? 0) > 0)) permissions.push("sales.discount");
      if (movements.length !== sale.items.length) fail();
      for (const [index, item] of sale.items.entries()) {
        const movement = movements[index]!;
        if (movement.type !== "SALE" || movement.product_id !== item.product_id || movement.quantity !== -item.quantity || movement.reference_kind !== "SALE" || movement.reference_id !== sale.id || movement.unit_cost_minor !== item.unit_cost_minor) fail();
        if (item.unit_cost_minor !== undefined) multiplyRatio(item.unit_cost_minor, item.quantity, QUANTITY_SCALE);
        add("sale_items", item.id); ref("products", item.product_id); add("inventory_movements", movement.id); checkTime(movement.occurred_at);
      }
      for (const payment of payments) { add("sale_payments", payment.id); ref("financial_accounts", payment.account_id); checkTime(payment.occurred_at); }
      break;
    }
    case "PURCHASE_RECORDED": {
      const { purchase, payments, movements } = parseEventPayload("PURCHASE_RECORDED", event.event_version, event.payload);
      checkTime(purchase.occurred_at); add("purchases", purchase.id); ref("suppliers", purchase.supplier_id); permissions.push("purchases.create");
      const totals = purchaseTotals({ lines: purchase.items.map(item => ({ unitCostMinor: item.unit_cost_minor, quantity: item.quantity })), payments: payments.map(payment => ({ amountMinor: -payment.amount_minor })), supplierId: purchase.supplier_id });
      if (totals.outstandingMinor > 0) { if (purchase.supplier_transaction_id === undefined) fail(); add("supplier_transactions", purchase.supplier_transaction_id!); }
      else if (purchase.supplier_transaction_id !== undefined) fail();
      if (payments.length > 0) permissions.push("purchases.pay");
      if (movements.length !== purchase.items.length) fail();
      for (const [index, item] of purchase.items.entries()) {
        const movement = movements[index]!;
        if (movement.type !== "PURCHASE" || movement.product_id !== item.product_id || movement.quantity !== item.quantity || movement.reference_kind !== "PURCHASE" || movement.reference_id !== purchase.id || movement.unit_cost_minor !== item.unit_cost_minor) fail();
        add("purchase_items", item.id); ref("products", item.product_id); add("inventory_movements", movement.id); checkTime(movement.occurred_at);
      }
      for (const payment of payments) { add("account_movements", payment.id); ref("financial_accounts", payment.account_id); checkTime(payment.occurred_at); }
      break;
    }
    case "CUSTOMER_PAYMENT": { const { payment } = parseEventPayload("CUSTOMER_PAYMENT", event.event_version, event.payload); add("customer_transactions", payment.id); ref("customers", payment.customer_id); ref("financial_accounts", payment.account_id); checkTime(payment.occurred_at); permissions.push("customers.pay"); break; }
    case "SUPPLIER_PAYMENT": { const { payment } = parseEventPayload("SUPPLIER_PAYMENT", event.event_version, event.payload); add("supplier_transactions", payment.id); ref("suppliers", payment.supplier_id); ref("financial_accounts", payment.account_id); checkTime(payment.occurred_at); permissions.push("purchases.pay"); break; }
    case "STOCK_MOVED": {
      const { movements } = parseEventPayload("STOCK_MOVED", event.event_version, event.payload);
      for (const movement of movements) {
        if (!manual.includes(movement.type) || movement.reference_id !== undefined || movement.reference_kind !== undefined || (movement.type === "DAMAGE" && movement.quantity > 0) || (movement.type === "OPENING_BALANCE" && movement.quantity < 0)) fail();
        add("inventory_movements", movement.id); ref("products", movement.product_id); checkTime(movement.occurred_at);
        permissions.push(movement.type === "STOCK_COUNT" ? "inventory.count" : "inventory.adjust");
      }
      break;
    }
    case "CASH_MOVED": {
      const { movements } = parseEventPayload("CASH_MOVED", event.event_version, event.payload);
      permissions.push("cash.move");
      for (const movement of movements) {
        add("account_movements", movement.id); ref("financial_accounts", movement.account_id); ref("financial_accounts", movement.counterpart_id); checkTime(movement.occurred_at);
        if (["OPENING_BALANCE", "CASH_IN", "TRANSFER_IN"].includes(movement.type) && movement.amount_minor < 0) fail();
        if (["CASH_OUT", "TRANSFER_OUT"].includes(movement.type) && movement.amount_minor > 0) fail();
        if (["CASH_OUT", "ADJUSTMENT"].includes(movement.type) && (movement.reason ?? "").trim() === "") fail();
        if (movement.type === "ADJUSTMENT") permissions.push("cash.reconcile");
        if (movement.type.startsWith("TRANSFER_")) {
          if (movement.counterpart_id === undefined || movement.counterpart_id === movement.account_id) fail();
          const reciprocal = movements.filter(other => other !== movement && other.type === (movement.type === "TRANSFER_IN" ? "TRANSFER_OUT" : "TRANSFER_IN") && other.account_id === movement.counterpart_id && other.counterpart_id === movement.account_id && other.amount_minor === -movement.amount_minor);
          if (reciprocal.length !== 1) fail();
        } else if (movement.counterpart_id !== undefined) fail();
      }
      sumAmounts(movements.map(movement => movement.amount_minor)); break;
    }
    case "EXPENSE_RECORDED": {
      const { expense } = parseEventPayload("EXPENSE_RECORDED", event.event_version, event.payload);
      add("expenses", expense.id); ref("financial_accounts", expense.account_id); ref("expenses", expense.reverses_id); checkTime(expense.occurred_at);
      if ((expense.amount_minor < 0) !== (expense.reverses_id !== undefined)) fail(); permissions.push("expenses.create"); break;
    }
    case "DEVICE_ENCRYPTION_KEY": {
      // A device fact, not an owner fact: any active member on a trusted device may announce that device's own key.
      parseEventPayload("DEVICE_ENCRYPTION_KEY", event.event_version, event.payload);
      return { entities, references, permissions, authority: false };
    }
    default: {
      parseEventPayload(event.event_type as EventType, event.event_version, event.payload);
      permissions.push("users.manage");
      return { entities, references, permissions, authority: true };
    }
  }
  const identifiers = entities.map(entity => entity.id);
  if (new Set(identifiers).size !== identifiers.length) fail();
  if (!permissions.every(required => event.required_permissions.includes(required))) throw new ExchangeError("permission_denied");
  return { entities, references, permissions: [...new Set(permissions)], authority: false };
}
