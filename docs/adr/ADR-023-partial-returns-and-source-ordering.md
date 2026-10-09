# ADR-023: Partial returns and source ordering

Date: 2026-10-06. Status: proposed policy, implemented for review against specification §41 and F4.

A return is an immutable fact referencing one original sale/purchase and original items.
Partial and full returns append stock movements, account refunds and customer/supplier
credit entries. They never delete/edit the original or invent a negative sale line.
Sale returns require `sales.refund`; purchase returns require `purchases.create` plus
`purchases.pay`. The source branch and current actor/device scope must match. Historical
product names/prices/costs are used; an archived product/counterparty can receive a return.

A whole-sale discount is allocated over historical net lines by largest remainder,
with item-ID ordering breaking ties. An item's returned value is the change in its
cumulative rounded entitlement. The last partial return therefore consumes every
remaining franc, even where individual tiny quantities round to zero. Costs compensate
by cumulative quantity rounding as well. Refunded XAF allocations are explicit and
positive; their account movements point out for sales and in for purchases. The
unrefunded amount reduces the original counterparty's debt, possibly creating a credit
balance after prior collection/payment. An anonymous transaction must refund the entire
return value. No financial amount may exceed the return entitlement.

Returns for one source form a predecessor chain. Preview reads remaining quantity and
current predecessor; commit must still match them. This prevents duplicate taps, over-
returns and changes to rounding entitlements between preview and commit. Replay retains
out-of-order successors as dependencies until their predecessor arrives. IDs/proofs and
all business effects are atomic and duplicate delivery is harmless.

Two disconnected tills can independently return against the same predecessor. Both
physical actions cannot safely be assumed to have happened once. The second competing
chain encountered by an installation is retained as `return_conflict`, with no additional
effects. Each installation keeps its already committed local chain. They require owner
comparison/reconciliation before being considered converged for that source; no automatic
winner or silent over-refund is advertised. Ordinary independent sales still stand. Owner
stale-authority review cannot override the predecessor/quantity validation. Until dedicated
conflict resolution is provided, staff should coordinate returns for the same original
transaction across tills; diagnostics direct the owner to compare goods/refunds and use
explicit authorized compensating counts/movements. IDs and rejected history remain retained.

Migration 20 adds append-only return headers/items/refund mappings. Signed v2 event types
`SALE_RETURNED` and `PURCHASE_RETURNED` carry original-item quantities, predecessor,
refund allocations and immutable effect IDs. Replay computes the same exact entitlements
from original facts. Older clients durably retain unsupported signed events; they must
upgrade before applying these types or reading schema-20 backups.

Net period summaries subtract returns on return occurrence time. Original-sale/purchase
receipts and detailed historical sale breakdowns remain original facts, with return totals
separately identified. Account balances/cash flow already include the compensating account
movements; counterpart ledgers include the new RETURN facts.
