# Mobile operations (F4)

The unlocked app now opens permission-aware operational navigation. The till draft
stays mounted while browsing the other operational tabs; lock/background/cold boot
clears this transient draft. Saved facts remain in SQLite. Staff and file-transfer
screens retain their existing F1/F3 lifecycle.

## Delivered software

- Product and category create/edit/archive/reactivation, barcode, cost/price, fractional
  quantity and reorder settings; signed category detail exchange uses the product LWW rule.
- Stock levels/history, opening stock, damage, manual additions and actual shelf counts.
  Negative stock stays visible. `countStock` computes its compensation in the transaction.
- Cash/split/credit till, named customer selection, whole-sale discount, decimal quantities,
  exact hardware-keyboard barcode submit and removal of recorded payment allocations.
  Credit/discount permissions are independent; default cashiers cannot extend credit.
- Customer/supplier details, archived counterparties, derived balances, bounded statements,
  customer collections, supplier payments and multi-line stock purchases with door payment.
- Accounts, cash in/out, two-leg transfers, count comparison and explicit reasoned cash
  adjustment. Comparing alone records audit and changes no money; an adjustment recomputes
  its expected balance inside the transaction.
- Expense creation/history and compensating reversal; originals are never edited.
- Saved receipts/history, original price/name snapshots, original settlement, recorded
  return total and optional OS text sharing. Printer output is a remaining hardware gate.
- Partial/full sale/purchase return previews and compensating stock/refund/debt entries.
  See [ADR-023](../adr/ADR-023-partial-returns-and-source-ordering.md).
- Net sales/profit/purchase period summaries and paginated stock/debt alerts. Calendar-day
  ranges use the device timezone and half-open UTC instants, including DST. Unknown costs
  remain visible as a count; profit is labeled an estimate. Existing detailed original-sale
  breakdown reports remain gross transaction history and are not presented as net returns.
- Keyed French/English text throughout active setup/unlock/recovery, staff, operations
  and transfer screens, including roles, permissions, error codes and exchange counts.
  Language selection is available before setup and persists across cold boots in a
  separate device preference database; replacing/restoring a shop preserves this setting.
  Failed preference reads/writes leave offline work available and show a retry action.
  Status messages retain keys/values so changing language also updates existing feedback.
  Business names, device labels, fingerprints and recovery keys remain literal data.
  The unused legacy server-login screen is outside the active navigation.

## Read/refresh contract

`application/queries` takes the current opaque operation context. Every query rechecks
current authority and derives the shop from that context. Catalogue, ledger, expense,
purchase and receipt pages are bounded (default 30, maximum 100), with keyset continuation.
Search uses literal name prefixes plus exact barcode/SKU or phone prefixes where relevant.
Forward migration 19 adds operational indexes/category device ordering; 20 adds immutable
returns. Migrations 1–18 remain unchanged.

Both SQLite adapters publish conservative changed-domain revisions only after the outer
commit, with transaction depth already reset. Nested financial fan-out sends one revision
notification; a rollback sends none. Savepoint work may conservatively invalidate a domain
whose changes were rolled back inside a successful outer transaction. Direct repository
writes/import appliers use the same driver. Observer errors cannot turn durable success
into command failure. React subscribes to revisions and rereads SQLite; only the current
bounded page and transient form/cart values are retained in the view. No global store
mirrors the database. Active-database replacement unmounts subscriptions and old handles.

Payment selectors expose names/details without balances under the corresponding payment
capability. Financial balances require `finance.accounts.view` and `cash.view`. Receipt
history/details enforce `sales.view_own` by creating actor when `sales.view` is absent.
Report-only debt/stock readers enforce report capabilities independently of catalogue
view rights. Every command still enforces its own permissions/reference scope.

## Verification and acceptance

Real SQLite tests cover a shop day and restart, whole-unit entry, exact partial returns,
rollback after financial fan-out, literal/bounded search, duplicate-name pagination,
query-plan index use, direct cashier/owner permissions, foreign IDs, revocation and lock.
Real SQLite behind the synchronous native interface checks commit notifications. Real
Ed25519 replica tests cover category dependencies and reordered/duplicate/conflicting
return chains. These checks do not prove installed React Native rendering or native hardware.

See [F4 native validation](f4-native-validation.md). F4 remains in progress until the
installed full-day workflow, chosen receipt hardware/scanner, accessibility and
measured low-cost-device budgets pass. No unsupported latency/memory
budget is claimed from desktop SQLite or Metro export.
