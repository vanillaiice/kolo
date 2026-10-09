# backend/CLAUDE.md

Guidance for the Go backend. The repository root `CLAUDE.md` holds the rules that apply everywhere; this file loads when working under `backend/`.

## Packages

`backend/internal/kernel/` — primitives shared by every domain:

- `money` — integer minor units, currency-checked arithmetic, explicit rounding, remainder-preserving allocation
- `id` — UUIDv7 via `github.com/google/uuid`, generated offline, sortable by creation time. `id.Typed[Tag]` gives phantom-typed identifiers so a sale ID cannot be passed where a product ID belongs; `id/idtest` gives deterministic identifiers for tests
- `clock` — injectable UTC time source
- `quantity` — exact stock amounts as thousandths of a unit. Fractional (half a kilo) but never floating point, for the same reason money is not: a tenth added ten times must be exactly one
- `phone` — E.164 telephone numbers via `github.com/nyaruka/phonenumbers`, default region CM. Login identity (ADR-012) and customer/supplier contact detail
- `validate` — value rules shared by more than one domain (`Name`, `Timestamps`). A rule moves here only once a second domain needs it

`backend/internal/domain/`:

- `authz` — granular permissions, roles, and the configurable role→permission matrix (§38). Effective permissions are role defaults + grants − revocations, revocation last
- `business` — the tenant. `Business` and `Branch` entities, and `Scope`, which is the required argument that makes tenant isolation structural rather than a filter a caller can forget
- `users` — who operates a business, their tenant/branch, and their permissions. Deliberately holds **no credentials**: §5 separates "Authentication" from "Users & Roles", so PINs and tokens live in `auth`, keyed by user ID
- `auth` — proves who a user is (ADR-012). `PINHash` (bcrypt, slow, for a low-entropy secret), `Token`/`TokenHash` (32 random bytes, SHA-256, fast — checked on every request), and `Session`, bound to one user/business/device and renewed on sync
- `inventory` — the stock ledger (§7, ADR-009). **Stock is never stored; it is the sum of append-only movements.** Two devices selling the last unit offline both stand, and the total goes to −1 — a true statement, surfaced rather than hidden
- `products` — what a business sells (§6). Only a name, unit, and selling price are required; SKU, barcode, category, brand, and purchase price are filled in as the business learns them. Carries **no stock level** — that is the ledger's job
- `sales` — what was sold and what was paid (§9–§11). A sale that leaves a balance also produces a `customers.Transaction`, built in `app/syncing` from the sale's own arithmetic rather than from a figure on the wire, and written in the same database transaction as the sale. A sale is immutable and holds its lines; **it has no payment method and no paid amount**, because §11 gives a sale many payments and what has been paid is their sum. Line totals are `price × quantity/1000` rounded half up, since quantity is thousandths and XAF has no subunit. `Settle` derives where a sale stands, and refuses an unpaid balance with no customer to owe it
- `expenses` — what a business spends that is not stock (§19). A purchase raises inventory and an expense does not, and confusing the two makes the shop's goods look dearer than they were. **Categories are a fixed list**, the one §19 enumerates, because free text groups nothing in a report — "Transport", "transport" and "Transpor" read as three costs. Making them configurable is an ADR, not a quiet change: §10 requires *providers* to be configurable and says nothing about this
- `finance` — where money sits (§17). `Account` is a place money is held: the till, the safe, an MTN wallet, an Orange wallet. **Mobile Money providers are accounts, not kinds** — that is what makes adding Orange a row rather than a release (§10). An account holds **no balance**: what is in it is the sum of what moved through it, and §18's job is comparing that against the drawer, which a stored figure would make meaningless. Only `Cash` needs reconciling — an electronic balance cannot be miscounted, only disagreed with
- `customers` — who a business sells to, and what they owe (§12, §13). The `Customer` entity needs only a name; everything else is filled in as the shopkeeper learns it. **Credit is an append-only ledger**, exactly like stock: a balance is the sum of transactions and is never stored. A customer's record is state and settles by last-write-wins like a product's, which is what `UpdatedByDevice` is for. `CheckCreditLimit` is a *question*, not a rule the ledger enforces — letting a regular go over their limit is the shopkeeper's decision to make. A limit of zero and no limit at all are deliberately distinct
- `suppliers` — who a business buys from, and what it owes them (§14, §16). The mirror of `customers`, and deliberately its own domain rather than a flag on that one: what a customer owes the shop and what the shop owes a wholesaler are opposite obligations, and one type with a sign would make it possible to settle a customer's debt with a supplier's payment. A `Supplier` needs only a name; the `Contact` is the person to ask for, which for a wholesaler is not the business's name and is what a shopkeeper actually remembers. **The ledger is append-only** and a balance is never stored, exactly as a customer's is. A supplier's record is state and settles by last-write-wins (ADR-015). Only a `PAYMENT` names a financial account: goods going back reduce the bill without a franc leaving the till
- `purchases` — stock coming in and what it cost (§15). **A purchase is not an inventory operation.** It raises stock and *either* lowers a financial account or raises what the business owes — treating it as a single-table write is the mistake §59 names. The shape mirrors a sale, upside down: what a sale leaves unpaid becomes a customer's debt, what a purchase leaves unpaid becomes the shop's debt to a wholesaler. A line's cost is **required**, unlike a sale line's price, because this is where a cost is *learned* (§8). The supplier is **optional**: a shopkeeper buying a crate at the market has nobody to name, and requiring one would stop them recording the stock at all. `Settle` derives where a delivery stands and refuses an unpaid balance with no supplier to owe it
- `sync` — what devices send each other (§26). Events, not state: two devices pushing "three were sold" lose nothing, while two pushing "stock is 47" must lose one
- `devices` — an installation of the app (§28): its business, optional branch, label, and platform. A session binds to one, and an audit record names one. Its sync-specific state arrives with the sync phase

`backend/internal/app/` — application services, between HTTP and the domain (ADR-005):

- `syncing` — push and pull (§36). Owns what happens to an event the server cannot use: a replay is a success, a bad event fails alone, a rejection is kept
- `authn` — login, authenticate, logout. Owns what a failure reveals: an unknown number and a wrong PIN are the same error and cost the same time; a suspended account is distinguished only *after* the PIN is right. A login also **answers with the tenant** — the business, and the branches the user or device name — because a device has no other way to learn them: no event carries a business, since every event already happens inside one, and a branch identifier with no branch behind it names something the device cannot place. The business is loaded only once the PIN is right, so how long a login takes says nothing about which businesses exist. `ErrBusinessSuspended` is checked on **every authenticated request**, not only at login: sessions are deliberately long-lived (ADR-012), so a check at login alone would leave a suspended tenant trading on last month's token

`backend/internal/api/` — the HTTP edge (§35). Stdlib `net/http` routing under `/api/v1`, one JSON error shape with stable machine-readable codes, and `RequireAuthentication`/`RequirePermission` middleware. `classify` is the single place errors become statuses — a new service's errors must be added there or they fall through to 500. An internal error never echoes its cause to a client.

Endpoints: `/auth/login`, `/auth/logout`, `/auth/me`, `/sync/push`, `/sync/pull`. Login and `/auth/me` answer with `business` and `branches` alongside the user, device and session — that is what a device stores to know which shop it is recording sales for. A push answers **200 even when some events were rejected** — the request succeeded, and per-event results say what happened to each; a non-2xx would make a client resend what landed.

`backend/cmd/api/` — the binary: read config from the environment, connect, migrate, serve, drain on SIGTERM.

`backend/internal/platform/postgres/` — the driver edge (ADR-013). pgx v5, goose migrations embedded from `backend/migrations/`, and repositories that take a `business.Scope` bound into the query. `pgtest` gives tests a migrated database. Domain types cross into driver types here and nowhere else.

`inventory_movements`, `sales`, `sale_items`, `sale_payments`, `customer_transactions`, `purchases`, `purchase_items`, and `supplier_transactions` are append-only **in the database**, not just the domain: triggers refuse UPDATE and DELETE, so a correction has to be a compensating transaction even for a migration or a support script. Stock, sale totals, and what a customer owes are derived, never stored.

A balance is a `sum()` in the database rather than a fetch-and-add in Go, for the same reason stock is: a regular who has bought on credit for two years has hundreds of entries, and a cashier asking what they owe must not pay for all of them. The two must agree exactly — `credit_repository_test.go` sums the same ledger both ways and compares, because a shopkeeper and a customer reading different numbers is the failure this domain exists to prevent.

A customer's phone is a lookup, not an identity: the index on `(business_id, phone)` is deliberately **not** unique, because a household shares one number and refusing the second person would leave them out of the credit book they are already in on paper. `FindByPhone` returns everyone on the number and the caller chooses.

`SaleRepository.Record` is §9's fan-out: the sale, its lines, its payments, and the stock it released, in one transaction. Half of it landing describes something that did not happen — money taken for goods still on the shelf, or stock gone with nobody recorded as paying.

`PurchaseRepository.Record` is §15's fan-out on the other side: the delivery, its lines, the stock it brought in, the money handed over at the door, and the ledger entry for what is still owed, in one transaction. Half of it landing describes something that did not happen — stock on the shelf the books never paid for, or a wholesaler owed nothing for a delivery they made.

What an account holds is summed over **five** arms, and `supplier_transactions` is one of them. The signs differ on purpose: a customer's `PAYMENT` is negated into the account (less debt means more cash), while a supplier's is taken as stored (less debt because the money left). Getting that backwards makes paying a wholesaler look like taking money in. See the root `CLAUDE.md` — a new source of money must be added to that query or the drawer reads wrong by exactly what it moved.

A record belonging to another tenant is reported as **not found**, never as forbidden — saying "you may not see this" confirms it exists to someone who may not know of it.

Where a helper has both a fallible and a total form (`business.NewScope`/`ScopeOf`, `authz.Resolve`/`Effective`), the fallible one is for untrusted input and the total one is for callers holding already-validated values. Total forms **fail closed** — a missing tenant yields a scope that permits nothing, an unknown role contributes no permissions. Prefer this over an unreachable `panic` guard, which is untestable dead code.

Entities keep their fields unexported behind accessors and cross the persistence boundary as a validating `Snapshot`/`Restore` pair, so a repository cannot construct one that skipped validation. Stored data is re-validated on the way in — a record written by an older version or synced from another device is not trusted.

## Applying events

A pushed event is **recorded and applied in one transaction** (`SyncRepository.RecordAndApply`, taking an `Effects`). Recording without applying is the failure mode to watch for: the device is told "accepted", stops resending, and the stock never lands — undetectable afterwards, since the log says the event arrived. A new applied event type adds a field to `Effects` and a write inside that transaction, never a second write beside it.

Applied types so far: `STOCK_MOVED`, `CUSTOMER_PAYMENT`, `SUPPLIER_PAYMENT`, `CASH_MOVED` and `EXPENSE_RECORDED` (appends), `PRODUCT_SAVED`, `CUSTOMER_SAVED`, `ACCOUNT_SAVED` and `SUPPLIER_SAVED` (last-write-wins upserts, ADR-015), and `SALE_COMPLETED` and `PURCHASE_RECORDED` (immutable inserts of a whole fan-out, **including the ledger entry for what the sale or delivery left owing**).

`wire_contract_test.go` holds the client and the server together, feeding the literal bytes `suppliers.ts` and `purchases.ts` emit through the real decoder. Those bytes were taken from what the client actually queued rather than written to match the Go structs, which is the only way the test is worth anything. When it fails, change both sides together — never loosen the decoder.

`Effects.Credit` is a list, and the guard is per entry: a `CREDIT_SALE` must be against the sale the event carries, while every other kind stands alone — someone settling their tab is not about any one sale. `Effects.Owed` is the same shape and guarded the same way, with one guard more: a `PURCHASE` entry must be against the delivery the event carries **and owed to the wholesaler that delivery names**, or one supplier's goods land on another's account. Suppliers are applied before the delivery, as customers are before the sale, so an event carrying both does not depend on which arrived first. Only a `PAYMENT` names a financial account, and every payment must: an account records where money went, so one on a write-off would claim a till took money it never saw. Since 00010 both `account_id` columns are real foreign keys: a payment naming an account nobody opened is money no report can place. Conflict policy is per type and deliberately different — two devices' movements both stand, but only one product edit can.

Payload structs live in `app/syncing` (`StockMovedPayload`), not in `postgres` — they are the wire contract, and their JSON names are a protocol version. A movement's tenant, branch, device, and user come from the authenticated envelope; only the movement's own ID comes from the payload, because that ID is what makes a replay a duplicate.

Forward compatibility runs in two directions, and they are opposite on purpose:

- **On the way in**, an unknown event type is **refused** (`sync.Type.Defined`), so a device running ahead of the server finds out rather than being told "accepted" and believing its data arrived. An unknown *field* inside a payload this build applies is refused too (`DisallowUnknownFields`) — ignoring it could half-apply a fact and report success.
- **On the way out**, a stored event of an unknown type is **relayed untouched** (`sync.Restore`), because refusing to read one row an older build accepted would fail the pull for every device.
