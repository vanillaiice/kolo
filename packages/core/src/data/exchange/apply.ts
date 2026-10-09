import { applyReturn } from "../returns/returns.ts";
import { upsertCategory } from "../products/categories.ts";
import { parseEventPayload, type EventType, type JournalEnvelope } from "@kolo/contracts/events";
import type { Queryable, SqlValue } from "../database/driver.ts";
import { ExchangeError } from "../../exchange/types.ts";
import { memberPermissions } from "../../identity/internal-authority.ts";
import { type Permission } from "../../rules/permissions.ts";
import { eventModel } from "./model.ts";
import { claimEntities } from "./journal.ts";
import { productApplier } from "../sync/product-applier.ts";
import { customerApplier } from "../sync/customer-applier.ts";
import { supplierApplier, supplierPaymentApplier } from "../sync/supplier-applier.ts";
import { accountApplier } from "../sync/account-applier.ts";
import { saleApplier } from "../sync/sale-applier.ts";
import { purchaseApplier } from "../sync/purchase-applier.ts";
import { paymentApplier } from "../sync/payment-applier.ts";
import { stockApplier } from "../sync/stock-applier.ts";
import { cashApplier } from "../sync/cash-applier.ts";
import { expenseApplier } from "../sync/expense-applier.ts";

const appliers = [productApplier, customerApplier, supplierApplier, supplierPaymentApplier, accountApplier, saleApplier, purchaseApplier, paymentApplier, stockApplier, cashApplier, expenseApplier];

/** @internal Strict v2 policy followed by the shared persistence implementation, inside a caller-owned transaction. */
export function applyBusinessFact(tx: Queryable, event: JournalEnvelope, reviewed: boolean, recordedAt: string): void {
  const model = eventModel(event);
  const actor = tx.get(`SELECT m.*,u.active AS user_active FROM local_memberships m JOIN users u ON u.id=m.user_id AND u.business_id=m.business_id WHERE m.business_id=? AND m.user_id=?`, [event.business_id,event.actor_id]);
  if (actor === undefined) throw new ExchangeError("missing_dependency");
  if (!reviewed) {
    if (actor["active"] !== 1 || actor["user_active"] !== 1) throw new ExchangeError("permission_denied");
    const manifest = ["WORKSPACE_CREATED","LEGACY_WORKSPACE_ADOPTED"].includes(event.event_type);
    if (!manifest && event.authority_revision > Number(actor["revision"])) throw new ExchangeError("missing_dependency");
    if (!manifest && event.authority_revision !== actor["revision"]) throw new ExchangeError("authority_revision");
    const permissions = memberPermissions(actor);
    if (![...event.required_permissions,...model.permissions].every(p => permissions.includes(p))) throw new ExchangeError("permission_denied");
  }
  if (model.authority) { applyAuthority(tx,event); return; }
  for (const reference of [...model.references, ...(event.branch_id === null ? [] : [{ table: "branches", id: event.branch_id }])]) {
    const row = tx.get(`SELECT business_id FROM ${reference.table} WHERE id=?`, [reference.id]);
    if (row === undefined) throw new ExchangeError("missing_dependency");
    if (row["business_id"] !== event.business_id) throw new ExchangeError("scope_mismatch");
  }
  for (const entity of model.entities) {
    const row = tx.get(`SELECT business_id FROM ${entity.table} WHERE id=?`, [entity.id]);
    if (row === undefined) continue;
    if (row["business_id"] !== event.business_id) throw new ExchangeError("scope_mismatch");
    if (!entity.mutable) throw new ExchangeError("conflict");
  }
  const require = (permission: Permission): void => { if (!reviewed && (!event.required_permissions.includes(permission) || !memberPermissions(actor).includes(permission))) throw new ExchangeError("permission_denied"); };
  if (event.event_type === "SALE_RETURNED" || event.event_type === "PURCHASE_RETURNED") {
    applyReturn(tx,event,recordedAt); claimEntities(tx,event,model); return;
  }
  if (event.event_type === "CATEGORY_SAVED") {
    const { category } = parseEventPayload("CATEGORY_SAVED",2,event.payload);
    const old = tx.get(`SELECT * FROM categories WHERE id=?`, [category.id]);
    if (old !== undefined && (category.updated_at > String(old["updated_at"]) || category.updated_at === old["updated_at"] && event.origin_device_id > String(old["updated_by_device"] ?? ""))) require("products.edit");
    upsertCategory(tx, { id: category.id, businessId: event.business_id, name: category.name, active: category.active, createdAt: category.created_at, updatedAt: category.updated_at }, event.origin_device_id);
    claimEntities(tx,event,model); return;
  }
  if (event.event_type === "SALE_COMPLETED") {
    const { sale } = parseEventPayload("SALE_COMPLETED",2,event.payload);
    if (tx.get(`SELECT id FROM sales WHERE business_id=? AND number=?`,[event.business_id,sale.number]) !== undefined) throw new ExchangeError("conflict");
    for (const line of sale.items) {
      const product = tx.get(`SELECT selling_price_minor FROM products WHERE id=? AND business_id=?`, [line.product_id,event.business_id])!;
      if (line.unit_price_minor !== product["selling_price_minor"]) require("sales.price_override");
    }
  }
  if (event.event_type === "PRODUCT_SAVED") {
    const { product } = parseEventPayload("PRODUCT_SAVED",2,event.payload);
    const old = tx.get(`SELECT selling_price_minor,purchase_price_minor,updated_at,updated_by_device FROM products WHERE id=?`, [product.id]);
    if (old !== undefined && (product.updated_at > String(old["updated_at"]) || product.updated_at === old["updated_at"] && event.origin_device_id > String(old["updated_by_device"]))) {
      require("products.edit");
      if (product.selling_price_minor !== old["selling_price_minor"] || (product.purchase_price_minor ?? null) !== old["purchase_price_minor"]) require("products.price");
    }
  }
  if (event.event_type === "ACCOUNT_SAVED") {
    const { account } = parseEventPayload("ACCOUNT_SAVED",2,event.payload);
    if ((account.branch_id ?? null) !== event.branch_id) throw new ExchangeError("invalid_payload");
  }
  if (event.event_type === "EXPENSE_RECORDED") {
    const { expense } = parseEventPayload("EXPENSE_RECORDED",2,event.payload);
    if (expense.reverses_id !== undefined) {
      const old = tx.get(`SELECT * FROM expenses WHERE id=? AND business_id=?`, [expense.reverses_id,event.business_id])!;
      if (old["reverses_id"] !== null || expense.amount_minor !== -Number(old["amount_minor"]) || expense.account_id !== old["account_id"] || expense.category !== old["category"] || event.branch_id !== old["branch_id"] || tx.get(`SELECT id FROM expenses WHERE reverses_id=?`,[expense.reverses_id]) !== undefined) throw new ExchangeError("invalid_payload");
    }
  }
  const applier = appliers.find(a => a.types.includes(event.event_type));
  if (applier === undefined) throw new ExchangeError("unsupported_event");
  applier.apply(strictWriter(tx,event.branch_id,recordedAt),{ eventId:event.event_id,businessId:event.business_id,deviceId:event.origin_device_id,userId:event.actor_id,type:event.event_type,payload:event.payload,occurredAt:event.occurred_at,serverSequence:0,state:"deferred",attempts:0,lastError:null });
  claimEntities(tx,event,model);
}

// All SQL here originates in the fixed appliers above. Preserve scoped branch and
// local receive time, and turn financial INSERT OR IGNORE into strict inserts.
function strictWriter(tx: Queryable, branch: string | null, at: string): Queryable {
  return { get: (sql,args) => tx.get(sql,args), all: (sql,args) => tx.all(sql,args), run(sql,args = []) {
    const match = /^(\s*INSERT(?: OR IGNORE)? INTO \w+\s*\()([^)]*)(\)\s*VALUES\s*\()([^)]*)(\))([\s\S]*)$/i.exec(sql);
    if (match === null) return tx.run(sql,args);
    const columns = match[2]!.split(",").map(c => c.trim()), values = match[4]!.split(",").map(v => v.trim()), parameters: SqlValue[] = [];
    let position = 0;
    for (const [index,column] of columns.entries()) {
      const original = values[index]!;
      const value = original === "?" ? args[position++]! : undefined;
      if (column === "branch_id" || column === "recorded_at") { values[index] = "?"; parameters.push(column === "branch_id" ? branch : at); }
      else if (original === "?") parameters.push(value!);
    }
    if (position !== args.length) throw new ExchangeError("invalid_payload");
    return tx.run(`${match[1]!.replace(/ OR IGNORE/i,"")}${match[2]}${match[3]}${values.join(", ")}${match[5]}${match[6]}`,parameters);
  } };
}

function applyAuthority(tx: Queryable, event: JournalEnvelope): void {
  const installation = tx.get(`SELECT owner_id FROM local_installation WHERE id=1`)!;
  const pin = tx.get(`SELECT authority_allowed,public_key FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`, [event.business_id,event.origin_device_id]);
  if (installation["owner_id"] !== event.actor_id || pin?.["authority_allowed"] !== 1 || !event.required_permissions.includes("users.manage")) throw new ExchangeError("permission_denied");
  const payload = parseEventPayload(event.event_type as EventType,event.event_version,event.payload);
  if (event.event_type === "WORKSPACE_CREATED") {
    const root = parseEventPayload("WORKSPACE_CREATED",2,payload);
    if (root.business.id !== event.business_id || root.owner.id !== event.actor_id || root.device.id !== event.origin_device_id || root.device.public_key !== pin["public_key"]) throw new ExchangeError("scope_mismatch");
    return; // Existing approved baseline identity only; no untrusted bootstrap.
  }
  if (event.event_type === "LEGACY_WORKSPACE_ADOPTED") {
    const root = parseEventPayload("LEGACY_WORKSPACE_ADOPTED",2,payload);
    if (root.business_id !== event.business_id || root.owner_id !== event.actor_id || root.device_id !== event.origin_device_id || root.public_key !== pin["public_key"]) throw new ExchangeError("scope_mismatch");
    return;
  }
  if (!("user_id" in payload) || !("revision" in payload)) throw new ExchangeError("unsupported_event");
  const target = tx.get(`SELECT * FROM local_memberships WHERE business_id=? AND user_id=?`,[event.business_id,payload.user_id]);
  if (event.event_type === "MEMBER_CREATED") {
    const member = parseEventPayload("MEMBER_CREATED",2,payload);
    if (target !== undefined) {
      const user = tx.get(`SELECT name FROM users WHERE business_id=? AND id=?`,[event.business_id,member.user_id]);
      if (target["revision"] !== 1 || target["role"] !== member.role || user?.["name"] !== member.name) throw new ExchangeError("conflict");
      return;
    }
    if (tx.get(`SELECT id FROM users WHERE id=?`,[member.user_id]) !== undefined) throw new ExchangeError("scope_mismatch");
    tx.run(`INSERT INTO users(id,business_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)`,[member.user_id,event.business_id,member.name,member.role,event.occurred_at,event.occurred_at]);
    tx.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,?)`,[event.business_id,member.user_id,`remote.${event.origin_device_id}.${member.user_id}`,member.role]);
    return;
  }
  if (target === undefined) throw new ExchangeError("missing_dependency");
  if (payload.revision > Number(target["revision"]) + 1) throw new ExchangeError("missing_dependency");
  if (payload.revision !== Number(target["revision"]) + 1) throw new ExchangeError("conflict");
  if (event.event_type === "PERMISSION_GRANTED" || event.event_type === "PERMISSION_REVOKED") {
    const change = parseEventPayload(event.event_type,2,payload);
    if (change.user_id === installation["owner_id"] && change.permission === "users.manage" && event.event_type === "PERMISSION_REVOKED") throw new ExchangeError("permission_denied");
    const granted = new Set(JSON.parse(String(target["granted"])) as string[]), revoked = new Set(JSON.parse(String(target["revoked"])) as string[]);
    if (event.event_type === "PERMISSION_GRANTED") { granted.add(change.permission); revoked.delete(change.permission); }
    else { granted.delete(change.permission); revoked.add(change.permission); }
    tx.run(`UPDATE local_memberships SET granted=?,revoked=?,revision=? WHERE business_id=? AND user_id=?`,[JSON.stringify([...granted].sort()),JSON.stringify([...revoked].sort()),change.revision,event.business_id,change.user_id]);
  } else if (["MEMBER_SUSPENDED","MEMBER_REINSTATED"].includes(event.event_type)) {
    if (payload.user_id === installation["owner_id"]) throw new ExchangeError("permission_denied");
    tx.run(`UPDATE local_memberships SET active=?,revision=? WHERE business_id=? AND user_id=?`,[event.event_type === "MEMBER_REINSTATED" ? 1 : 0,payload.revision,event.business_id,payload.user_id]);
  } else if (["MEMBER_ACCESS_RESET","OWNER_ACCESS_RECOVERED"].includes(event.event_type)) {
    if ((event.event_type === "OWNER_ACCESS_RECOVERED") !== (payload.user_id === installation["owner_id"])) throw new ExchangeError("permission_denied");
    tx.run(`UPDATE local_memberships SET revision=? WHERE business_id=? AND user_id=?`,[payload.revision,event.business_id,payload.user_id]);
  } else throw new ExchangeError("unsupported_event");
}
