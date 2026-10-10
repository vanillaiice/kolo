import { suppliers, statement, purchases } from "@kolo/core/application/queries";
import { saveSupplier, paySupplier as writeSupplierPayment, recordPurchase as writePurchase } from "@kolo/core/application/operations";
import { supplierOf, balanceOfSupplier, type Supplier } from "@kolo/core/data/suppliers/suppliers";
import { productOf } from "@kolo/core/data/products/products";
import type { Queryable } from "@kolo/core/data/database/driver";
import { unlockedActor } from "@kolo/core/identity/workspace";
import { WorkspaceError, type OperationContext } from "@kolo/core/identity/types";
import { purchaseTotals } from "@kolo/core/rules/pricing";
import type { Page } from "@kolo/core/application/queries";
import type { PurchaseSummary, PurchaseView, StatementEntryView, SupplierDetails, SupplierView } from "../shared/service.js";
import { object, text, uuid, whole, boolean, page, optional } from "./validation.ts";
import { CommandError, nextVersion, sameSet, type Host } from "./host.ts";

const supplierFields = ["name", "phone", "address", "contact", "notes"] as const;
function details(data: Record<string, unknown>): SupplierDetails {
  const phone = optional(data["phone"], value => text(value, 40)), address = optional(data["address"], value => text(value, 200));
  const contact = optional(data["contact"], value => text(value, 120)), notes = optional(data["notes"], value => text(value, 500));
  return { name: text(data["name"]), ...(phone === undefined ? {} : { phone }), ...(address === undefined ? {} : { address }),
    ...(contact === undefined ? {} : { contact }), ...(notes === undefined ? {} : { notes }) };
}
function same(stored: Supplier, wanted: SupplierDetails): boolean {
  return stored.name === wanted.name && stored.phone === wanted.phone && stored.address === wanted.address && stored.contact === wanted.contact && stored.notes === wanted.notes;
}
function view(supplier: Supplier, outstandingMinor: number): SupplierView {
  return { id: supplier.id, name: supplier.name, outstandingMinor, active: supplier.active, version: supplier.updatedAt,
    ...(supplier.phone === undefined ? {} : { phone: supplier.phone }), ...(supplier.address === undefined ? {} : { address: supplier.address }),
    ...(supplier.contact === undefined ? {} : { contact: supplier.contact }), ...(supplier.notes === undefined ? {} : { notes: supplier.notes }) };
}
function stored(tx: Queryable, context: OperationContext, id: string): SupplierView {
  const supplier = supplierOf(tx, context.businessId, id);
  if (supplier === undefined) throw new WorkspaceError("scope_mismatch");
  return view(supplier, balanceOfSupplier(tx, context.businessId, id).outstandingMinor);
}

/** Bounded suppliers with payables under suppliers.view. */
export function listSuppliers(host: Host, input: unknown): Page<SupplierView> {
  const data = object(input, ["sessionId", "term", "after", "limit", "includeInactive"]), context = host.actor(data);
  const result = suppliers(context, page(data)); return { ...result, items: result.items.map(item => view(item, item.outstandingMinor)) };
}
/** One scoped supplier under suppliers.view, archived or not. */
export function getSupplier(host: Host, input: unknown): SupplierView {
  const data = object(input, ["sessionId", "supplierId"]), context = host.actor(data, ["suppliers.view"]);
  return stored(host.ports.database, context, uuid(data["supplierId"]));
}
/** Creates a supplier named by its request ID; only this actor's identical creation counts as a retry. */
export function createSupplier(host: Host, input: unknown): SupplierView {
  const data = object(input, ["sessionId", "requestId", ...supplierFields]), context = host.actor(data, ["suppliers.manage", "suppliers.view"]);
  const id = uuid(data["requestId"]), wanted = details(data), at = host.ports.now();
  return host.ports.database.transaction(tx => {
    if (tx.get(`SELECT 1 FROM suppliers WHERE id=?`, [id]) !== undefined) {
      const original = supplierOf(tx, context.businessId, id);
      const actor = tx.get(`SELECT user_id FROM local_audit WHERE business_id=? AND device_id=? AND action='SUPPLIER_SAVED' AND entity_id=? ORDER BY occurred_at LIMIT 1`, [context.businessId, context.deviceId, id]);
      if (original === undefined || actor?.["user_id"] !== context.userId || original.createdAt !== original.updatedAt || !same(original, wanted)) throw new CommandError("request_conflict");
      return stored(tx, context, id);
    }
    saveSupplier(context, { id, ...wanted, active: true, createdAt: at, updatedAt: at });
    return stored(tx, context, id);
  });
}
/** Edits, archives or restores a supplier from the displayed version; identical requests write nothing. */
export function updateSupplier(host: Host, input: unknown): SupplierView {
  const data = object(input, ["sessionId", "supplierId", "version", "active", ...supplierFields]), context = host.actor(data, ["suppliers.manage", "suppliers.view"]);
  const id = uuid(data["supplierId"]), version = text(data["version"], 64), active = boolean(data["active"]), wanted = details(data);
  return host.ports.database.transaction(tx => {
    const current = supplierOf(tx, context.businessId, id);
    if (current === undefined) throw new WorkspaceError("scope_mismatch");
    if (same(current, wanted) && current.active === active) return stored(tx, context, id);
    if (current.updatedAt !== version) throw new CommandError("request_conflict");
    if (!saveSupplier(context, { id, ...wanted, active, createdAt: current.createdAt, updatedAt: nextVersion(host, current.updatedAt) })) throw new CommandError("request_conflict");
    return stored(tx, context, id);
  });
}
/** Pays an active supplier from one account; the request ID is the ledger entry ID. */
export function paySupplier(host: Host, input: unknown): SupplierView {
  const data = object(input, ["sessionId", "requestId", "supplierId", "accountId", "amountMinor", "note"]), context = host.actor(data, ["purchases.pay", "suppliers.view"]);
  const id = uuid(data["requestId"]), supplierId = uuid(data["supplierId"]), accountId = uuid(data["accountId"]), amountMinor = whole(data["amountMinor"], 1);
  const note = optional(data["note"], value => text(value, 200));
  return host.ports.database.transaction(tx => {
    const saved = tx.get(`SELECT * FROM supplier_transactions WHERE id=?`, [id]);
    if (saved !== undefined) {
      if (saved["business_id"] !== context.businessId || saved["user_id"] !== context.userId || saved["device_id"] !== context.deviceId || saved["supplier_id"] !== supplierId ||
        saved["account_id"] !== accountId || saved["amount_minor"] !== -amountMinor || (saved["reason"] ?? undefined) !== note) throw new CommandError("request_conflict");
    } else writeSupplierPayment(context, { id, supplierId, accountId, amountMinor, ...(note === undefined ? {} : { note }),
      occurredAt: host.ports.now(), eventId: host.ports.newId(), branchId: unlockedActor(context).branchId });
    return stored(tx, context, supplierId);
  });
}
/** Newest-first bounded supplier ledger with signed amounts. */
export function supplierStatement(host: Host, input: unknown): Page<StatementEntryView> {
  const data = object(input, ["sessionId", "supplierId", "after", "limit"]), context = host.actor(data);
  const result = statement(context, "supplier", uuid(data["supplierId"]), page(data));
  return { ...result, items: result.items.map(row => ({ id: String(row["id"]), occurredAt: String(row["occurred_at"]), type: String(row["type"]), amountMinor: Number(row["amount_minor"]), balanceMinor: Number(row["balance_minor"]),
    ...(row["reference_kind"] === "PURCHASE" && typeof row["reference_id"] === "string" ? { purchaseId: row["reference_id"] } : {}),
    ...(typeof row["reason"] === "string" && row["reason"] !== "" ? { note: row["reason"] } : {}) })) };
}
/** Door payments are found through the purchase event's claimed entities; they carry no purchase reference. */
function doorPayments(tx: Queryable, context: OperationContext, purchaseId: string): { accountId: string; amountMinor: number }[] {
  return tx.all(`SELECT m.account_id,m.amount_minor FROM journal_entity_claims p JOIN journal_entity_claims c ON c.event_id=p.event_id AND c.table_name='account_movements'
    JOIN account_movements m ON m.id=c.entity_id AND m.business_id=? WHERE p.table_name='purchases' AND p.entity_id=?`, [context.businessId, purchaseId])
    .map(row => ({ accountId: String(row["account_id"]), amountMinor: -Number(row["amount_minor"]) }));
}
/**
 * Records a delivery: stock in at the given costs, an optional door payment and any payable, in
 * one transaction. A matching retry (actor, supplier, reference, lines, payment) returns the same ID.
 */
export function recordPurchase(host: Host, input: unknown): { readonly purchaseId: string } {
  const data = object(input, ["sessionId", "requestId", "supplierId", "reference", "lines", "payment"]);
  const context = host.actor(data, ["purchases.create", ...(data["payment"] === undefined ? [] : ["purchases.pay" as const])]);
  const id = uuid(data["requestId"]), supplierId = optional(data["supplierId"], uuid), reference = optional(data["reference"], value => text(value, 120));
  if (!Array.isArray(data["lines"]) || data["lines"].length < 1 || data["lines"].length > 200) throw new WorkspaceError("invalid_input");
  const lines = data["lines"].map(value => { const item = object(value, ["productId", "quantity", "unitCostMinor"]);
    return { productId: uuid(item["productId"]), quantity: whole(item["quantity"], 1), unitCostMinor: whole(item["unitCostMinor"]) }; });
  if (new Set(lines.map(line => line.productId)).size !== lines.length) throw new WorkspaceError("invalid_input");
  const payment = optional(data["payment"], value => { const item = object(value, ["accountId", "amountMinor"]); return { accountId: uuid(item["accountId"]), amountMinor: whole(item["amountMinor"], 1) }; });
  const payments = payment === undefined ? [] : [payment], totals = purchaseTotals({ lines, payments, supplierId });
  return host.ports.database.transaction(tx => {
    const saved = tx.get(`SELECT business_id,user_id,device_id,supplier_id,reference FROM purchases WHERE id=?`, [id]);
    if (saved !== undefined) {
      const items = tx.all(`SELECT product_id,quantity,unit_cost_minor FROM purchase_items WHERE business_id=? AND purchase_id=?`, [context.businessId, id]);
      if (saved["business_id"] !== context.businessId || saved["user_id"] !== context.userId || saved["device_id"] !== context.deviceId ||
        saved["supplier_id"] !== (supplierId ?? null) || saved["reference"] !== (reference ?? null) ||
        !sameSet(items.map(item => ({ productId: item["product_id"], quantity: item["quantity"], unitCostMinor: item["unit_cost_minor"] })), lines) ||
        !sameSet(doorPayments(tx, context, id), payments)) throw new CommandError("request_conflict");
      return { purchaseId: id };
    }
    writePurchase(context, { id, ...(supplierId === undefined ? {} : { supplierId }), ...(reference === undefined ? {} : { reference }),
      branchId: unlockedActor(context).branchId, occurredAt: host.ports.now(), eventId: host.ports.newId(),
      lines: lines.map(line => ({ ...line, id: host.ports.newId(), movementId: host.ports.newId() })),
      payments: payments.map(item => ({ ...item, id: host.ports.newId(), reason: reference ?? "Purchase" })),
      ...(totals.outstandingMinor > 0 ? { supplierTransactionId: host.ports.newId() } : {}) });
    return { purchaseId: id };
  });
}
/** Bounded newest-first purchase history under purchases.view. */
export function listPurchases(host: Host, input: unknown): Page<PurchaseSummary> {
  const data = object(input, ["sessionId", "after", "limit"]), context = host.actor(data);
  return purchases(context, page(data));
}
/** One recorded purchase with lines, door payments and payable. */
export function getPurchase(host: Host, input: unknown): PurchaseView {
  const data = object(input, ["sessionId", "purchaseId"]), context = host.actor(data, ["purchases.view"]), id = uuid(data["purchaseId"]);
  const tx = host.ports.database, row = tx.get(`SELECT p.*,s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON s.business_id=p.business_id AND s.id=p.supplier_id WHERE p.business_id=? AND p.id=?`, [context.businessId, id]);
  if (row === undefined) throw new WorkspaceError("scope_mismatch");
  const lines = tx.all(`SELECT id,product_id,quantity,unit_cost_minor FROM purchase_items WHERE business_id=? AND purchase_id=? ORDER BY id`, [context.businessId, id]).map(item => ({
    id: String(item["id"]), productId: String(item["product_id"]), name: productOf(tx, context.businessId, String(item["product_id"]))?.name ?? "", quantity: Number(item["quantity"]), unitCostMinor: Number(item["unit_cost_minor"]) }));
  const supplierId = typeof row["supplier_id"] === "string" ? row["supplier_id"] : undefined;
  const totals = purchaseTotals({ lines, payments: doorPayments(tx, context, id), supplierId });
  return { id, occurredAt: String(row["occurred_at"]), supplierName: String(row["supplier_name"] ?? ""), reference: String(row["reference"] ?? ""), lines,
    totalMinor: totals.totalMinor, paidMinor: totals.paidMinor, outstandingMinor: totals.outstandingMinor, ...(supplierId === undefined ? {} : { supplierId }) };
}
