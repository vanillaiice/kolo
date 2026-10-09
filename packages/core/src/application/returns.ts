import type { EventPayload } from "@kolo/contracts/events";
import { parseEventPayload } from "@kolo/contracts/events";
import { authorizedOperation, appendLocalAudit } from "../identity/internal-authority.ts";
import { WorkspaceError, type OperationContext } from "../identity/types.ts";
import { enqueue } from "../data/sync/outbox.ts";
import { applyReturn, planReturn, returnSource, type ReturnKind, type ReturnSelection, type ReturnSource } from "../data/returns/returns.ts";

/** IDs and predecessor belong to one immutable return attempt; refunds are positive XAF allocations. */
export interface ReturnCommand {
  readonly eventId: string; readonly originalId: string; readonly priorId?: string | undefined; readonly id: string; readonly reason: string;
  readonly items: readonly (ReturnSelection & { readonly id: string; readonly movementId: string })[];
  readonly refunds: readonly { readonly id: string; readonly accountId: string; readonly amountMinor: number }[];
  readonly debtTransactionId?: string | undefined;
}
function permissions(kind: ReturnKind): readonly ("sales.refund" | "purchases.create" | "purchases.pay")[] {
  if (kind !== "SALE" && kind !== "PURCHASE") throw new WorkspaceError("invalid_input");
  return kind === "SALE" ? ["sales.refund"] : ["purchases.create", "purchases.pay"];
}
/** Authorized immutable source/remaining quantities for a sale or purchase return; original prices are preserved. */
export function returnableItems(context: OperationContext, kind: ReturnKind, originalId: string): ReturnSource {
  return authorizedOperation(context, permissions(kind), (_db, tx) => returnSource(tx,context.businessId,kind,originalId));
}
/** Calculates exact discounted partial/full return value from current SQLite source facts and current predecessor. */
export function previewReturn(context: OperationContext, kind: ReturnKind, originalId: string, items: readonly ReturnSelection[]): ReturnType<typeof planReturn> & { source: ReturnSource } {
  return authorizedOperation(context, permissions(kind), (_db, tx) => {
    const source = returnSource(tx,context.businessId,kind,originalId); return { source, ...planReturn(source,items) };
  });
}
function record(context: OperationContext, kind: ReturnKind, input: ReturnCommand): void {
  authorizedOperation(context, permissions(kind), (_db, tx, ports, revision) => {
    const source = returnSource(tx,context.businessId,kind,input.originalId);
    const branch = tx.get(`SELECT u.branch_id AS user_branch,d.branch_id AS device_branch FROM users u JOIN devices d ON d.business_id=u.business_id AND d.id=? WHERE u.business_id=? AND u.id=?`, [context.deviceId,context.businessId,context.userId]);
    if ([branch?.["user_branch"],branch?.["device_branch"]].some(value => typeof value === "string" && value !== source.branchId)) throw new WorkspaceError("scope_mismatch");
    for (const refund of input.refunds) if (tx.get(`SELECT id FROM financial_accounts WHERE business_id=? AND id=? AND active=1`, [context.businessId,refund.accountId])===undefined) throw new WorkspaceError("scope_mismatch");
    const returned: EventPayload<"SALE_RETURNED">["returned"] = { id: input.id, original_id: input.originalId, reason: input.reason,
      ...(input.priorId === undefined ? {} : { prior_id: input.priorId }),
      items: input.items.map(item => ({ id: item.id, original_item_id: item.originalItemId, quantity: item.quantity, movement_id: item.movementId })),
      refunds: input.refunds.map(refund => ({ id: refund.id, account_id: refund.accountId, amount_minor: refund.amountMinor })),
      ...(input.debtTransactionId === undefined ? {} : { debt_transaction_id: input.debtTransactionId }) };
    const type = kind === "SALE" ? "SALE_RETURNED" : "PURCHASE_RETURNED", payload = { returned }, at = ports.now();
    parseEventPayload(type,2,payload);
    applyReturn(tx,{ event_type: type, business_id: context.businessId, actor_id: context.userId, origin_device_id: context.deviceId, branch_id: source.branchId ?? null, occurred_at: at, payload },at);
    enqueue(tx,{ eventId: input.eventId, ...context, type, payload, occurredAt: at });
    appendLocalAudit(tx,context,ports,revision,type,input.id,{ originalId: input.originalId, eventId: input.eventId });
  });
}
/** Partial/full sale return under sales.refund: stock in, cash refund out, remainder as customer credit; stale predecessor commits nothing. */
export function returnSale(context: OperationContext, input: ReturnCommand): void { record(context,"SALE",input); }
/** Partial/full purchase return under purchases.create/pay: stock out, refund cash in, remainder reduces supplier debt; no original facts are edited. */
export function returnPurchase(context: OperationContext, input: ReturnCommand): void { record(context,"PURCHASE",input); }
