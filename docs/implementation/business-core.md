# Business operations and methods

## Existing implementation

These functions were moved from mobile into `packages/core/src/data`. Extraction does
not add permission checks or make them transport-independent. Exact signatures/types,
classes and methods are in the [generated reference](../reference/typescript-api.md).

| Domain/module | Main methods | Effects and invariant |
|---|---|---|
| Database | `migrate`, `schemaVersion`, `openDatabase`, `openNativeDatabase` | Schema before queries; synchronous transaction; FK enforcement |
| Products | `saveProduct`, `searchProducts` | Last-write-wins details; event and write together; exact barcode before name |
| Inventory | `recordMovement`, `stockOf` | Signed append-only movements; stock derived by sum |
| Sales | `completeSale`, `totalsOf`, `subtotalOf` | Sale/items/stock/payments/customer debt/outbox atomic |
| Customers | `saveCustomer`, `recordCustomerPayment`, `balanceOf`, `wouldExceedCreditLimit` | Details resolve conflicts; debt appends; payments independent of sales |
| Suppliers | `saveSupplier`, `recordSupplierPayment`, `balanceOfSupplier` | Payable ledger separate from receivables |
| Purchases | `recordPurchase`, `totalsOfDelivery` | Delivery/items/stock/door payment/payable/outbox atomic |
| Accounts/cash | `saveAccount`, `balanceOfAccount`, `reconcile` | Balances derive from five sources; count alone does not move money |
| Expenses | `recordExpense`, `reverseExpense`, `expensesBetween`, `totalsByCategory` | Spending and compensating reversal; no history edits |
| Reports | `salesBetween`, `profitBetween`, `inventoryValuation`, `cashFlow`, `dashboard`, customer/supplier reports | Local query-only derived figures; half-open periods |
| HTTP sync v1 | `SyncEngine.sync`, `HttpTransport.push/pull`, inbox/outbox helpers | Existing single-server retries/deferred dependencies; not peer exchange |
| Legacy auth | `logIn`, `enrol`, `storedSession`, `signOut` | Legacy migration proof and optional cloud session; local authority in core/identity |

Some names are lower-level helpers, not the future authorized operation surface. Use
the generated catalog as the source for available methods rather than inventing calls.

## Invariants that apply to every adapter

- Money: integer XAF; amounts and API numeric values must be safe integers. Quantity:
  integer thousandths. Fractional pricing uses exact BigInt intermediates, safe result boundaries and
  half-away-from-zero rounding. Shared rules have independent arithmetic oracles.
- Stock: sum inventory movements; negative stock is visible, never clamped.
- Debt: customer and supplier ledgers are separate and never netted. Only payment
  entries name financial accounts. A credit sale/purchase must name its counterparty.
- Financial history: append-only by SQLite/PostgreSQL constraints/triggers. Returns,
  refunds, write-offs and corrections create referencing compensating entries.
- Payment facts are recorded once where they happen. Account balance sums sale
  payments, customer PAYMENT rows (negated), account movements, expenses (outflow),
  and supplier PAYMENT rows (as stored). New money sources must update cash/report
  queries together. A transfer writes both account legs atomically.
- Sale references: every line/movement/payment/credit ID is drawn once for a command;
  retry preserves it. No string-composed UUIDs or newly generated IDs on rerender.
- Time: `occurred_at` is when business happened; `recorded_at` is persistence time.
  Reports use occurrence and half-open `[from, until)` periods with defined timezone.
- Scope: installation holds one shop. Every query/mutation references its business;
  composite FK/scoping tests stop cross-shop related records. Never trust UI IDs.

## Application operation surface (F1)

`@kolo/core/application/operations` implements authorized `completeSale`,
`recordPurchase`, `receiveCustomerPayment`, `paySupplier`, `adjustStock`, `moveCash`,
`reconcileCash`, `recordExpense`, `saveProduct`, `saveCustomer`, `saveSupplier` and
`saveAccount`. Each takes an opaque `OperationContext` returned by local unlock.
`CommandInput<T>` removes actor/shop/device/persistence time; commands supply those
from the context and ports. Permission/suspension/reference-scope checks, existing
SQLite writes, outbox and immutable audit share a synchronous transaction. Repository
functions above remain primitives used by legacy app paths and event appliers.

`@kolo/core/application/reports` exposes named report queries requiring current
granular report permission and deriving the business ID from the unlock context.
Cashiers cannot read financial reports by default; revocations apply immediately.
Mobile POS now uses authorized sale/product commands.

`core/rules/amounts` and `pricing` implement exact multiply/divide, signed sums,
credit-limit comparison, line pricing, subtotal, settlement and sale/purchase totals.
`contracts/permissions` defines pure role/grant rules; core compatibility paths re-export
those definitions. Cart, local operations and replay use the same arithmetic with no
platform SDK/database dependency in the pure rules. HTTP v1 replay also uses exact
shared arithmetic, but its engine is restricted to unconverted legacy workspaces.

New authorized writes stage immutable v2 journal facts atomically with business effects;
protected native signing completes afterward without blocking a sale. Strict signed
replay and per-destination receipts are implemented; see [exchange](exchange.md).

`OperationContext` exposes only shop/actor/device IDs and is an in-memory capability;
its registered ports bind clock, ID generator and database. Effective permissions are
resolved from current local memberships on every operation, not trusted from a caller
or cached role. Callers cannot select an arbitrary tenant or
claim an owner role. Application operation verifies authority, validates immutable
inputs, writes facts and event in one transaction, then returns recorded identifiers
and figures. Pure calculations do not import context/DB/network; SQLite/PostgreSQL
orchestration is distinct while both call the same pure rules.

## Error and retry contract

Planned operation errors have a stable code, optional field/domain reference, and
retry classification. Validation/permission errors commit nothing. Missing import
dependencies are deferred; malformed/unauthorized events are quarantined. Storage
errors preserve the original failure and do not show success. UI localizes codes.
Logs carry event/operation IDs, never raw PIN/token/full customer payload.

Existing `SaleError`, `MigrationError`, `DatabaseError`, `EnrolmentError`, and transport
errors remain during migration; do not silently replace them with different behavior.
Importers must distinguish duplicate same-content events from conflicting reused IDs.

## Documentation method

Every public function/method documents: purpose, units/ranges, input scope, actor
requirements, transaction ownership, emitted events, returned persisted values,
failure codes and retry semantics. Ports document sync/async and resource ownership.
Use explicit return types on new boundaries. Examples must execute or be labeled
planned. Run `npm run docs:api` and check it in alongside source changes.


## F4 operational adapters and returns

`application/queries` provides bounded, scoped catalogues, balances, source statements,
receipt/purchase/expense/stock histories and report-only debt/stock alert pages. Current
permission checks also govern reads; till account pickers cannot expose balances.
`data/database/changes` supplies committed domain revisions/subscriptions on both SQLite
adapters. [Mobile operations](mobile.md) documents the read/refresh and UI contracts.

`operations` adds `saveCategory`, `countStock` and `adjustCashToCount`. Counts derive
current deltas inside the authorized transaction; matching counts record audit only.
`application/returns` adds `returnableItems`, `previewReturn`, `returnSale` and
`returnPurchase`. `rules/returns` supplies deterministic discount allocation and
cumulative partial entitlements. [ADR-023](../adr/ADR-023-partial-returns-and-source-ordering.md)
specifies allocations, stock/debt/cash compensation and competing predecessor handling.
Period sales/profit/purchase summaries are net of returns; original receipts and
existing detailed original-sales breakdowns remain gross historical transaction facts.
