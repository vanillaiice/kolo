# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

KOLO is an offline-first business management platform (inventory, POS, customer credit, cash, reports) for small and medium businesses in Cameroon.

Progress against the Foundation phase (spec §51): project structure, authentication, the business/tenant model, the user model, PostgreSQL, migrations, the basic API, and the client's SQLite layer are done: `cmd/api` serves login, logout, and `/auth/me` end to end. The React Native shell now exists too: an Expo app (ADR-016) whose till completes a sale offline, and which now **logs in**: phone and PIN against the server, the session cached on the device and its token in the platform keystore (ADR-012, §37). It bundles and typechecks, but **has never run on a device**; neither the native SQLite module nor the keystore has been loaded once, and nothing short of running it proves that they work. Still to come: a way to create a business, a user and a PIN on the server, since without one there is nothing for a real device to log in to; and wiring the sync engine into the app, so an enrolled till receives the catalogue and the accounts it was enrolled for.

Per-directory guidance lives beside the code it describes: `backend/CLAUDE.md` for the Go server, `apps/mobile/CLAUDE.md` for the client. Each loads automatically when working in that tree.

### Commands

Run `make help` from the repository root for every target and what it does.

### Testing expectations

Tests must pass under `-race`. `kernel/` and `domain/` are held at **100% statement coverage**, except `domain/sales` at ~97%, where the remainder is error propagation from money arithmetic that `Record` has already proved cannot fail, unreachable because the entity's fields are unexported; `platform/postgres` sits at ~92%, the remainder being driver-error branches that cannot be reached with constants we control. Comprehensiveness is not satisfied by covering the spec's worked examples; those are a floor. Also cover boundary and overflow values, degenerate and malformed input, concurrency, and the invalid zero-value surface of each type. Prefer property-based tests, Go native fuzz targets, and, where a correct answer is independently computable, an oracle built a structurally different way from the implementation (see `money/oracle_test.go`).

The client is tested the same way and for the same reason: `node:sqlite` is real SQLite, so the schema, constraints, and queries are exercised rather than simulated. What that does not cover is the native driver the app loads, which needs a device.

**Repository tests run against a real PostgreSQL, never a mock.** A mock passes just as happily against a repository that forgot its `WHERE business_id = $1`, so it cannot prove the property most worth proving. `make db-up` starts one; `make test-integration` runs against it; plain `make test` skips those tests loudly. Closing the pool is the standard way to exercise "the database went away" paths.

Prefer established third-party libraries over hand-rolled implementations of solved problems; wrap them thinly if the project needs extra guarantees.

Add new commands to this file as tooling lands, rather than leaving them to be inferred.

`SPECIFICATION.md` is the source of truth. Read the relevant sections before implementing anything; the spec's own hierarchy is: product spec → architecture spec → ADRs → domain specs → implementation → tests. If implementation ends up conflicting with the spec, surface the conflict instead of quietly normalizing it.

## Baseline technology decisions

These are fixed (spec §63) and may only change through an explicit ADR, never through an ad-hoc implementation change:

| Layer | Choice |
|---|---|
| Client | React Native + TypeScript (Android-first) |
| Local database | SQLite, the *primary operational* DB, not a cache |
| Backend | Go |
| Server database | PostgreSQL |
| Sync | Event/transaction-based, versioned HTTP API (`/api/v1/...`) |
| Auth | Token-based |
| Currency / locale | XAF (FCFA), French + English |

Intended monorepo layout (spec §52); place new code accordingly: `apps/{mobile,web,desktop}/`, `backend/{cmd,internal,migrations}/`, `packages/{shared-types,shared-validation}/`, `docs/`, `scripts/`, `infrastructure/`.

## The one architectural rule everything else follows from

> **Business events create immutable transactions; current state is derived from those transactions.**

Concretely, this means:

- **Never store derived state as a mutable field.** Stock is not `product.stock = 47`; it is the sum of inventory movements (`+100 purchase`, `-3 sale`, `-2 damage`, …). Customer balances, supplier balances, and financial-account balances are likewise derived from their transactions, never directly written.
- **Never destructively update financial history.** Returns, refunds, and corrections are new compensating transactions that reference the original, not edits or deletes.
- **A business event fans out across domains.** A sale produces a sale record + sale items + inventory movements + one or more payments + (if credit) a customer transaction + financial effects. A purchase is not merely an inventory operation: it raises inventory and either lowers cash or raises supplier payable. Do not implement any of these as a single-table write.
- **Payments are independent of sales.** A sale has *many* payments (split cash + Mobile Money is a normal case), so there is no single `payment_method` column on a sale. Mobile Money providers (MTN, Orange) are configurable financial accounts, not hard-coded types.

## Offline-first is non-negotiable

Every core operation (product lookup and creation, inventory changes, sales, returns, customer and supplier management, payments, expenses, cash management, local reports) must complete with no network. The correct shape is:

```
action() → validate locally → SQLite transaction → show success → queue sync event
```

Never `action() → POST → await server → show success`. The app must not block business operations because sync failed. UI reads observe local SQLite; the flow is UI → application action → repository → SQLite transaction → UI observes updated local data. Keep transient UI state in React; do not mirror the business database into a global in-memory store.

## Sync engine constraints

Sync is a first-class subsystem with dedicated endpoints (`POST /api/v1/sync/push`, `GET /api/v1/sync/pull`), not CRUD calls sprinkled through features. Requirements: batching, acknowledgements, ordering, retry, partial failures, conflict reporting.

- Push **events** (`{event_id, type, payload, timestamp, device_id, business_id, user_id}`), not final state snapshots.
- Every event carries a globally unique immutable ID, and the **server must be idempotent**: replaying an event must never apply it twice. Any sync operation must be safe to retry.
- Each installation has a device identity, used for sync, audit, conflict resolution, and troubleshooting.
- Conflict policy is per-data-type and must be explicit: financial transactions immutable, inventory movements append-only, product descriptions last-write-wins, user permissions server-authoritative. Two devices selling the last unit offline is expected; resolve by accepting both movements, never by picking one device's stock number.
- Assume slow, intermittent, expensive connectivity and multi-day sync gaps; keep payloads compact.

## Multi-tenancy and authorization

Every business-owned record belongs to a business/organization, and tenant isolation is enforced at the **data/service layer**, not by UI checks: a user in Business A must never reach Business B's data. The data model must accommodate `Organization → Branch → {Devices, Users, Inventory}` even though the MVP ships single-branch.

Roles (OWNER, MANAGER, CASHIER, INVENTORY, ACCOUNTANT) resolve to granular, configurable permissions such as `sales.create`, `sales.refund`, `inventory.adjust`, `reports.financial`. Cashiers do not get financial reports by default. Sensitive operations (price changes, manual stock adjustments, refunds, debt modification, permission changes, cash reconciliation) write audit records carrying actor, business, device, timestamp, action, entity, and metadata.

## Other standing constraints

- **Money is never floating point.** Use integer minor units; XAF amounts are whole FCFA.
- **Backend layering:** HTTP/API → application/service → domain → repository. The domain layer must not depend on HTTP.
- **Business rules live in domain/application services**, not duplicated across React Native screens, Go API handlers, DB triggers, and report queries.
- **Keep domains separate** (auth, business, users, products, inventory, sales, customers, suppliers, purchases, payments, finance, expenses, reports, sync, notifications). A product feature should not need to touch sync, auth, and finance. Avoid one catch-all "business" module.
- **Abstract devices behind services**: printing (thermal/PDF/digital receipts) and barcode input (camera, Bluetooth, USB) must not leak into sales logic. The POS must work with a hardware scanner and no camera.
- **Tests are required** for new business logic, especially inventory, sales, payments, customer/supplier balances, financial calculations, sync, conflict handling, and authorization.
- Target cheap Android hardware: fast product search, fast POS, efficient large-list rendering, minimal startup delay, zero server round trips for inventory and POS.

## Working style expected by the spec

Inspect existing architecture and files before changing them, and prefer the smallest appropriate domain. Do not introduce a new database, backend framework, state-management architecture, sync strategy, or auth system without explicit approval. Significant architectural decisions get recorded as ADRs under `docs/adr/`.

### The client/server payload contract

`StockMovedPayload` in `app/syncing` and `describe()` in the client's `movements.ts` are two halves of one wire format, and nothing but a test holds them together. The server refuses a payload carrying a field it does not know, so a field added to one side and not the other **rejects every event from that client**.

The same applies to identifiers, and less visibly. Every identifier in a payload is parsed as a UUID on arrival (ADR-011), so a client that *derives* one (a line's identifier with a suffix, say) has its events rejected with the sale already recorded on the till and nothing there to explain it. Identifiers are drawn, never composed. `sales.test.ts` asserts the shape of every identifier a completed sale sends, which is the only thing standing between that rule and a silent one-way sync.

The payload carries no business, branch, device, or user, and no currency: identity comes from the authenticated envelope (ADR-008) and everything is XAF (§46). Only the movement's own ID travels, because that ID is what makes a replay a duplicate.

### What an account holds

**Derived by summing the sources, never by a ledger that repeats them.** A
balance is one query over five arms (`sale_payments`, the `PAYMENT` rows of
`customer_transactions`, `account_movements`, `expenses`, and the `PAYMENT` rows
of `supplier_transactions`), because each of those records its own facts once,
where they happened. A dedicated account ledger would hold a second copy of every
payment, and the two could disagree about the one number §18 exists to check.

The signs are where the care is, because a ledger's sign means "more or less
owed" and an account's means "more or less cash", and the two agree only
sometimes. A customer's payment is negative in their ledger and is **negated**
into the account, where it means more cash. A supplier's payment is negative in
their ledger too and is taken **as stored**, because the money really did leave.
Getting that one backwards makes paying a wholesaler look like taking money in.

The consequence to remember: **a new source of money must be added to that query
or the drawer reads wrong by exactly what it moved.** `BalanceOf` in
`account_movement_repository.go` and `balanceOfAccount` in `cash.ts` are the two
places.

`account_movements` holds what a *person* moved: the float at opening, cash to
the bank, transfers, the correction after a count, and the cash handed to a
delivery driver. A purchase's door payment is one of these rather than a supplier
ledger entry, because a crate bought at the market names no wholesaler and so has
no ledger for it to go in; the money still has to be recorded as gone. A transfer
is two rows, one against each account, each naming the other, written in one
transaction: a balance sums the rows naming an account, so a single row could
only ever be counted by one side, and half a transfer is money genuinely lost.

A cash count changes nothing by itself. `Reconcile` says what the difference is;
correcting it is an `ADJUSTMENT` movement, which is a new record of what was
found rather than an edit to what was believed; that is what leaves an owner
able to see that the drawer was short at all.

### Product, customer, and account conflicts

Products, customers **and financial accounts** are last-write-wins ordered by **`(updated_at, updated_by_device)`** (ADR-015). They are the things here that are *state*: a name or a price has one current value, so one edit has to win. What a customer owes is not state and is never resolved this way: it is a ledger, and both devices' entries stand. The tie-break is not decoration: without it, two devices holding the same two edits could settle on different prices depending on arrival order, permanently and undetectably. Because the comparison reads only the two rows, applying edits in any order gives the same answer everywhere.

The rule is written twice (once in PostgreSQL, once in SQLite) because a device must resolve a conflict with no network. Both sides are tested against the same cases, including the order-independence property itself.

A losing edit is **discarded, not an error**. On the client `saveProduct` and `saveCustomer` return `false`; treating it as a failure would defer the event forever.

Timestamps come from the device, never the server: an edit made offline on Monday and synced on Friday must not beat one made on Wednesday.
