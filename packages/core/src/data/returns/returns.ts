import type { EventPayload, JournalEnvelope } from "@kolo/contracts/events";
import { parseEventPayload } from "@kolo/contracts/events";
import type { Queryable, Row } from "../database/driver.ts";
import { sqlInteger } from "../database/safe-values.ts";
import { discountedLineTotals, incrementalReturnMinor } from "../../rules/returns.ts";
import { multiplyRatio, sumAmounts } from "../../rules/amounts.ts";
import { ExchangeError } from "../../exchange/types.ts";

/** A return is serialized per original transaction through an immutable predecessor link. */
export type ReturnKind = "SALE" | "PURCHASE";
/** Requested original item quantities in thousandths. */
export interface ReturnSelection { readonly originalItemId: string; readonly quantity: number; }
/** Source facts and currently remaining quantities; mutable product prices are never used. */
export interface ReturnSource { readonly originalId: string; readonly priorId?: string | undefined; readonly branchId?: string | undefined;
  readonly counterpartyId?: string | undefined;
  /**
   * Money that may still change hands for this original: what it settled when it was recorded (sale payments,
   * or a delivery's total less what it left owing) less the refunds of earlier returns. Value beyond this goes to
   * the counterparty's ledger, so cash never leaves (or arrives) for goods that were never paid for. It is derived
   * from the original's own immutable facts and the serialized return chain, so every replica agrees on it.
   */
  readonly refundableMinor: number;
  readonly items: readonly { id: string; productId: string; name: string; originalQuantity: number; returnedQuantity: number; netMinor: number; unitCostMinor?: number | undefined }[]; }
/**
 * The returns a return was signed against: its predecessor and that one's predecessors, following the signed links
 * (an approved concurrent return keeps its signed predecessor in `return_fork_links`). `null` means the first return.
 */
function signedAncestry(tx: Queryable, shop: string, basis: string | null): readonly string[] {
  const ids: string[] = [];
  for (let id = basis; id !== null && id !== "";) {
    if (ids.includes(id) || ids.length > 10_000) throw new ExchangeError("invalid_payload");
    ids.push(id);
    const row = tx.get(`SELECT coalesce(f.signed_prior_key,r.prior_key) AS prior FROM business_returns r LEFT JOIN return_fork_links f ON f.business_id=r.business_id AND f.return_id=r.id WHERE r.business_id=? AND r.id=?`, [shop,id]);
    if (row === undefined) throw new ExchangeError("missing_dependency");
    id = String(row["prior"]);
  }
  return ids;
}
/** @internal True once an owner-approved concurrent return split this original's chain; no further returns are taken on it. */
export function returnsForked(tx: Queryable, shop: string, kind: ReturnKind, originalId: string): boolean {
  return tx.get(`SELECT 1 AS forked FROM return_fork_links f JOIN business_returns r ON r.business_id=f.business_id AND r.id=f.return_id WHERE r.business_id=? AND r.kind=? AND r.original_id=? LIMIT 1`, [shop,kind,originalId]) !== undefined;
}
/**
 * Reads immutable source/return facts within the caller's scoped transaction; missing prerequisites are retriable.
 * Remaining quantities and refunds count every return of the original, or with `basis` only the returns that one was
 * signed against (`null`: none), so every till computes a received return exactly as the till that made it did.
 */
export function returnSource(tx: Queryable, shop: string, kind: ReturnKind, originalId: string, basis?: string | null): ReturnSource {
  if (kind !== "SALE" && kind !== "PURCHASE") throw new ExchangeError("invalid_payload");
  const sale = kind === "SALE", header = tx.get(`SELECT * FROM ${sale ? "sales" : "purchases"} WHERE business_id=? AND id=?`, [shop, originalId]);
  if (header === undefined) throw new ExchangeError("missing_dependency");
  const rows = tx.all(`SELECT i.*,p.name AS product_name FROM ${sale ? "sale_items" : "purchase_items"} i JOIN products p ON p.business_id=i.business_id AND p.id=i.product_id
    WHERE i.business_id=? AND i.${sale ? "sale_id" : "purchase_id"}=? ORDER BY i.id`, [shop, originalId]);
  const pricing = rows.map(row => ({ id: String(row["id"]), unitPriceMinor: sqlInteger(row[sale ? "unit_price_minor" : "unit_cost_minor"]!), quantity: sqlInteger(row["quantity"]!), discountMinor: sale ? sqlInteger(row["discount_minor"]!) : 0 }));
  const net = discountedLineTotals(pricing, sale ? sqlInteger(header["discount_minor"]!) : 0);
  const prior = tx.get(`SELECT id FROM business_returns WHERE business_id=? AND kind=? AND original_id=? ORDER BY rowid DESC LIMIT 1`, [shop, kind, originalId]);
  const counted = basis === undefined ? undefined : signedAncestry(tx, shop, basis);
  const within = counted === undefined ? "" : ` AND r.id IN (${counted.map(() => "?").join(",") || "NULL"})`;
  const items = rows.map(row => ({ id: String(row["id"]), productId: String(row["product_id"]), name: String(row[sale ? "name" : "product_name"]),
    originalQuantity: sqlInteger(row["quantity"]!), returnedQuantity: sqlInteger(tx.get(`SELECT coalesce(sum(i.quantity),0) AS quantity FROM business_return_items i JOIN business_returns r ON r.business_id=i.business_id AND r.id=i.return_id
      WHERE i.business_id=? AND r.kind=? AND r.original_id=? AND i.original_item_id=?${within}`, [shop, kind, originalId, row["id"]!, ...(counted ?? [])])!["quantity"]!), netMinor: net.get(String(row["id"]))!,
    unitCostMinor: typeof row["unit_cost_minor"] === "number" ? sqlInteger(row["unit_cost_minor"]) : undefined }));
  const counterparty = header[sale ? "customer_id" : "supplier_id"];
  const settled = sale
    ? sqlInteger(tx.get(`SELECT coalesce(sum(amount_minor),0) AS paid FROM sale_payments WHERE business_id=? AND sale_id=?`, [shop, originalId])!["paid"]!)
    : sumAmounts([...net.values(), -sqlInteger(tx.get(`SELECT coalesce(sum(amount_minor),0) AS owed FROM supplier_transactions
        WHERE business_id=? AND type='PURCHASE' AND reference_kind='PURCHASE' AND reference_id=?`, [shop, originalId])!["owed"]!)]);
  const refunded = sqlInteger(tx.get(`SELECT coalesce(sum(f.amount_minor),0) AS refunded FROM business_return_refunds f JOIN business_returns r ON r.business_id=f.business_id AND r.id=f.return_id
    WHERE r.business_id=? AND r.kind=? AND r.original_id=?${within}`, [shop, kind, originalId, ...(counted ?? [])])!["refunded"]!);
  return { originalId, priorId: typeof prior?.["id"] === "string" ? prior["id"] : undefined, branchId: typeof header["branch_id"] === "string" ? header["branch_id"] : undefined, counterpartyId: typeof counterparty === "string" ? counterparty : undefined,
    refundableMinor: Math.max(0, sumAmounts([settled, -refunded])), items };
}
/** Exact cumulative entitlement and stock quantities for a partial/full return; over-return is refused. */
export function planReturn(source: ReturnSource, selection: readonly ReturnSelection[]): { totalMinor: number; costMinor: number; lines: readonly { originalItemId: string; productId: string; quantity: number; amountMinor: number; costMinor: number }[] } {
  if (selection.length === 0 || selection.length > 200 || new Set(selection.map(item => item.originalItemId)).size !== selection.length) throw new ExchangeError("invalid_payload");
  const lines = selection.map(item => {
    const original = source.items.find(line => line.id === item.originalItemId); if (original === undefined) throw new ExchangeError("invalid_payload");
    const amountMinor = incrementalReturnMinor(original.netMinor, original.originalQuantity, original.returnedQuantity, item.quantity);
    const costMinor = original.unitCostMinor === undefined ? 0 : sumAmounts([multiplyRatio(original.unitCostMinor, sumAmounts([original.returnedQuantity,item.quantity]), 1000), -multiplyRatio(original.unitCostMinor, original.returnedQuantity, 1000)]);
    return { ...item, productId: original.productId, amountMinor, costMinor };
  });
  return { totalMinor: sumAmounts(lines.map(line => line.amountMinor)), costMinor: sumAmounts(lines.map(line => line.costMinor)), lines };
}
/**
 * @internal Shared return fan-out for authorized command and verified replay. Caller owns transaction/event identity.
 * A return signed against a predecessor that is no longer the latest raced another return (`return_conflict`); once
 * the owner approves it (`approvedConflict`, ADR-041) it is linked after the latest locally, keeps its signed
 * predecessor in `return_fork_links`, and is still computed against exactly the returns it was signed against.
 */
export function applyReturn(tx: Queryable, event: Pick<JournalEnvelope, "event_type" | "business_id" | "actor_id" | "origin_device_id" | "branch_id" | "occurred_at"> & { readonly payload: Record<string, unknown> }, recordedAt: string, options: { readonly approvedConflict?: boolean } = {}): void {
  const kind: ReturnKind = event.event_type === "SALE_RETURNED" ? "SALE" : "PURCHASE";
  const { returned }: EventPayload<"SALE_RETURNED"> = parseEventPayload(event.event_type as "SALE_RETURNED" | "PURCHASE_RETURNED", 2, event.payload);
  if (returned.prior_id !== undefined) {
    const prior = tx.get(`SELECT kind,original_id FROM business_returns WHERE business_id=? AND id=?`,[event.business_id,returned.prior_id]);
    if (prior === undefined) throw new ExchangeError("missing_dependency");
    if (prior["kind"] !== kind || prior["original_id"] !== returned.original_id) throw new ExchangeError("invalid_payload");
  }
  const latest = returnSource(tx,event.business_id,kind,returned.original_id).priorId;
  const forked = latest !== returned.prior_id;
  if (forked && options.approvedConflict !== true) throw new ExchangeError("return_conflict");
  const source = returnSource(tx,event.business_id,kind,returned.original_id,returned.prior_id ?? null);
  if ((source.branchId ?? null) !== event.branch_id) throw new ExchangeError("scope_mismatch");
  const priorId = forked ? latest : returned.prior_id;
  const plan = planReturn(source, returned.items.map(item => ({ originalItemId: item.original_item_id, quantity: item.quantity })));
  const paid = sumAmounts(returned.refunds.map(refund => refund.amount_minor)), debt = sumAmounts([plan.totalMinor,-paid]);
  if (source.counterpartyId !== undefined) {
    const counterparty = tx.get(`SELECT business_id FROM ${kind === "SALE" ? "customers" : "suppliers"} WHERE id=?`,[source.counterpartyId]);
    if (counterparty === undefined) throw new ExchangeError("missing_dependency");
    if (counterparty["business_id"] !== event.business_id) throw new ExchangeError("scope_mismatch");
  }
  if (debt < 0 || paid > source.refundableMinor || (debt > 0) !== (returned.debt_transaction_id !== undefined) || debt > 0 && source.counterpartyId === undefined) throw new ExchangeError("invalid_payload");
  for (const refund of returned.refunds) if (tx.get(`SELECT id FROM financial_accounts WHERE business_id=? AND id=?`,[event.business_id,refund.account_id])===undefined) throw new ExchangeError("missing_dependency");
  tx.run(`INSERT INTO business_returns(id,business_id,branch_id,kind,original_id,prior_id,prior_key,reason,total_minor,cost_minor,debt_minor,debt_transaction_id,user_id,device_id,occurred_at,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [returned.id,event.business_id,event.branch_id,kind,returned.original_id,priorId ?? null,priorId ?? "",returned.reason,plan.totalMinor,plan.costMinor,debt,returned.debt_transaction_id ?? null,event.actor_id,event.origin_device_id,event.occurred_at,recordedAt]);
  if (forked) tx.run(`INSERT INTO return_fork_links(business_id,return_id,signed_prior_key) VALUES (?,?,?)`,[event.business_id,returned.id,returned.prior_id ?? ""]);
  for (const [index,item] of returned.items.entries()) {
    const line = plan.lines[index]!;
    tx.run(`INSERT INTO inventory_movements(id,business_id,branch_id,product_id,type,quantity,reference_kind,reference_id,reason,user_id,device_id,occurred_at,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [item.movement_id,event.business_id,event.branch_id,line.productId,kind === "SALE" ? "SALE_RETURN" : "PURCHASE_RETURN",kind === "SALE" ? line.quantity : -line.quantity,kind,returned.original_id,returned.reason,event.actor_id,event.origin_device_id,event.occurred_at,recordedAt]);
    tx.run(`INSERT INTO business_return_items(id,business_id,return_id,original_item_id,product_id,quantity,amount_minor,cost_minor,movement_id) VALUES (?,?,?,?,?,?,?,?,?)`,
      [item.id,event.business_id,returned.id,item.original_item_id,line.productId,line.quantity,line.amountMinor,line.costMinor,item.movement_id]);
  }
  for (const refund of returned.refunds) {
    tx.run(`INSERT INTO account_movements(id,account_id,business_id,branch_id,type,amount_minor,currency,reason,user_id,device_id,occurred_at,recorded_at) VALUES (?,?,?,?,?,?,'XAF',?,?,?,?,?)`,
      [refund.id,refund.account_id,event.business_id,event.branch_id,kind === "SALE" ? "CASH_OUT" : "CASH_IN",kind === "SALE" ? -refund.amount_minor : refund.amount_minor,returned.reason,event.actor_id,event.origin_device_id,event.occurred_at,recordedAt]);
    tx.run(`INSERT INTO business_return_refunds(id,business_id,return_id,account_id,amount_minor) VALUES (?,?,?,?,?)`,[refund.id,event.business_id,returned.id,refund.account_id,refund.amount_minor]);
  }
  if (debt > 0) tx.run(`INSERT INTO ${kind === "SALE" ? "customer_transactions" : "supplier_transactions"}(id,${kind === "SALE" ? "customer_id" : "supplier_id"},business_id,branch_id,type,amount_minor,currency,reference_kind,reference_id,reason,user_id,device_id,occurred_at,recorded_at)
    VALUES (?,?,?,?,'RETURN',?,'XAF',?,?,?,?,?,?,?)`, [returned.debt_transaction_id!,source.counterpartyId!,event.business_id,event.branch_id,-debt,kind,returned.original_id,returned.reason,event.actor_id,event.origin_device_id,event.occurred_at,recordedAt]);
}

/** Bounded return list for a source transaction; shared by receipt/purchase presentation. */
export function returnsFor(tx: Queryable, shop: string, kind: ReturnKind, id: string): Row[] {
  return tx.all(`SELECT * FROM business_returns WHERE business_id=? AND kind=? AND original_id=? ORDER BY rowid DESC LIMIT 100`,[shop,kind,id]);
}
