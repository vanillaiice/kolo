import { returnableItems, previewReturn as plan, returnSale, returnPurchase } from "@kolo/core/application/returns";
import { ExchangeError } from "@kolo/core/exchange/types";
import { WorkspaceError, type OperationContext } from "@kolo/core/identity/types";
import type { ReturnPreview, ReturnSourceView } from "../shared/service.js";
import { object, text, uuid, whole, optional } from "./validation.ts";
import { CommandError, sameSet, type Host } from "./host.ts";

function kind(value: unknown): "SALE" | "PURCHASE" { if (value !== "SALE" && value !== "PURCHASE") throw new WorkspaceError("invalid_input"); return value; }
function selection(value: unknown): { originalItemId: string; quantity: number }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new WorkspaceError("invalid_input");
  const items = value.map(entry => { const item = object(entry, ["originalItemId", "quantity"]); return { originalItemId: uuid(item["originalItemId"]), quantity: whole(item["quantity"], 1) }; });
  if (new Set(items.map(item => item.originalItemId)).size !== items.length) throw new WorkspaceError("invalid_input");
  return items;
}
/** Core return rules speak exchange codes; the bridge speaks stable desktop failures. */
function translated<T>(work: () => T): T {
  try { return work(); }
  catch (error) {
    if (!(error instanceof ExchangeError)) throw error;
    if (error.code === "return_conflict") throw new CommandError("stale_return");
    if (error.code === "missing_dependency" || error.code === "scope_mismatch") throw new WorkspaceError("scope_mismatch");
    if (error.code === "permission_denied") throw new WorkspaceError("permission_denied");
    throw new WorkspaceError("invalid_input");
  }
}
/** Returnable lines and remaining quantities at original net values. */
export function returnSource(host: Host, input: unknown): ReturnSourceView {
  const data = object(input, ["sessionId", "kind", "originalId"]), context = host.actor(data), returnKind = kind(data["kind"]), originalId = uuid(data["originalId"]);
  const source = translated(() => returnableItems(context, returnKind, originalId));
  return { kind: returnKind, originalId, hasCounterparty: source.counterpartyId !== undefined, ...(source.priorId === undefined ? {} : { priorId: source.priorId }),
    items: source.items.map(({ id, name, originalQuantity, returnedQuantity }) => ({ id, name, originalQuantity, returnedQuantity })) };
}
/** Exact return value against the current predecessor; nothing is written. */
export function previewReturn(host: Host, input: unknown): ReturnPreview {
  const data = object(input, ["sessionId", "kind", "originalId", "items"]), context = host.actor(data);
  const preview = translated(() => plan(context, kind(data["kind"]), uuid(data["originalId"]), selection(data["items"])));
  return { totalMinor: preview.totalMinor, lines: preview.lines.map(({ originalItemId, quantity, amountMinor }) => ({ originalItemId, quantity, amountMinor })) };
}
function sameReturn(host: Host, context: OperationContext, id: string, wanted: { kind: string; originalId: string; reason: string; items: { originalItemId: string; quantity: number }[]; refunds: { accountId: string; amountMinor: number }[] }): boolean {
  const tx = host.ports.database, saved = tx.get(`SELECT * FROM business_returns WHERE id=?`, [id])!;
  return saved["business_id"] === context.businessId && saved["user_id"] === context.userId && saved["device_id"] === context.deviceId && saved["kind"] === wanted.kind &&
    saved["original_id"] === wanted.originalId && saved["reason"] === wanted.reason &&
    sameSet(tx.all(`SELECT original_item_id,quantity FROM business_return_items WHERE return_id=?`, [id]).map(row => ({ originalItemId: row["original_item_id"], quantity: row["quantity"] })), wanted.items) &&
    sameSet(tx.all(`SELECT account_id,amount_minor FROM business_return_refunds WHERE return_id=?`, [id]).map(row => ({ accountId: row["account_id"], amountMinor: row["amount_minor"] })), wanted.refunds);
}
/** Records a compensating return named by the request ID; stale predecessors are refused as stale_return. */
export function recordReturn(host: Host, input: unknown): { readonly returnId: string } {
  const data = object(input, ["sessionId", "requestId", "kind", "originalId", "priorId", "reason", "items", "refund"]), context = host.actor(data);
  const id = uuid(data["requestId"]), returnKind = kind(data["kind"]), originalId = uuid(data["originalId"]), priorId = optional(data["priorId"], uuid), reason = text(data["reason"], 200);
  const items = selection(data["items"]);
  const refund = optional(data["refund"], value => { const item = object(value, ["accountId", "amountMinor"]); return { accountId: uuid(item["accountId"]), amountMinor: whole(item["amountMinor"], 1) }; });
  const refunds = refund === undefined ? [] : [refund];
  return host.ports.database.transaction(tx => {
    if (tx.get(`SELECT 1 FROM business_returns WHERE id=?`, [id]) !== undefined) {
      if (!sameReturn(host, context, id, { kind: returnKind, originalId, reason, items, refunds })) throw new CommandError("request_conflict");
      return { returnId: id };
    }
    const preview = translated(() => plan(context, returnKind, originalId, items));
    if ((preview.source.priorId ?? undefined) !== priorId) throw new CommandError("stale_return");
    const refunded = refund?.amountMinor ?? 0;
    if (refunded > preview.totalMinor) throw new WorkspaceError("invalid_input");
    const command = { id, eventId: host.ports.newId(), originalId, ...(priorId === undefined ? {} : { priorId }), reason,
      items: preview.lines.map(line => ({ id: host.ports.newId(), movementId: host.ports.newId(), originalItemId: line.originalItemId, quantity: line.quantity })),
      refunds: refunds.map(item => ({ id: host.ports.newId(), ...item })),
      ...(preview.totalMinor > refunded ? { debtTransactionId: host.ports.newId() } : {}) };
    translated(() => returnKind === "SALE" ? returnSale(context, command) : returnPurchase(context, command));
    return { returnId: id };
  });
}
