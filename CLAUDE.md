# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

KOLO is an offline-first business management platform (inventory, POS, customer credit, cash, reports) for small and medium businesses in Cameroon.

Progress against the Foundation phase (spec §51): project structure, authentication, the business/tenant model, the user model, PostgreSQL, migrations, the basic API, and the client's SQLite layer are done — `cmd/api` serves login, logout, and `/auth/me` end to end. Still to come: the React Native shell (no UI code exists yet).

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
- `sales` — what was sold and what was paid (§9–§11). A sale is immutable and holds its lines; **it has no payment method and no paid amount**, because §11 gives a sale many payments and what has been paid is their sum. Line totals are `price × quantity/1000` rounded half up, since quantity is thousandths and XAF has no subunit. `Settle` derives where a sale stands, and refuses an unpaid balance with no customer to owe it
- `finance` — where money sits (§17). `AccountKind` and `AccountID` so far. **Mobile Money providers are accounts, not kinds** — that is what makes adding Orange a row rather than a release (§10)
- `customers` — who a business buys from us (§12). The identifier only; the entity arrives with §12–§13
- `sync` — what devices send each other (§26). Events, not state: two devices pushing "three were sold" lose nothing, while two pushing "stock is 47" must lose one
- `devices` — an installation of the app (§28): its business, optional branch, label, and platform. A session binds to one, and an audit record names one. Its sync-specific state arrives with the sync phase

`backend/internal/app/` — application services, between HTTP and the domain (ADR-005):

- `syncing` — push and pull (§36). Owns what happens to an event the server cannot use: a replay is a success, a bad event fails alone, a rejection is kept
- `authn` — login, authenticate, logout. Owns what a failure reveals: an unknown number and a wrong PIN are the same error and cost the same time; a suspended account is distinguished only *after* the PIN is right

`apps/mobile/src/data/` — the client's SQLite layer (ADR-002, ADR-014):

- `database/` — a deliberately narrow driver interface, a `node:sqlite` adapter for tests, and forward-only migrations that catch a device up across any number of versions
- `sync/outbox.ts` — the queue of events waiting for the server. **A business write and its event commit in one transaction, or neither does.** `enqueue` takes a transaction, not a database, so it cannot be called on its own
- `inventory/movements.ts` — recording stock on the device. Every write records the movement and queues its event together; the ledger is append-only here too, enforced by SQLite triggers, and stock is derived by SQL sum
- `sync/inbox.ts` — the mirror of the outbox: events pulled from other devices, **stored durably before they are applied**. An event can arrive before what it depends on (a movement before its product), so arrival advances the cursor and applying is retried on later syncs. One holds what has not left, the other what has not landed
- `sync/transport.ts` — the HTTP contract plus an implementation. The engine takes the interface, so its failure behaviour is testable without a network
- `sync/engine.ts` — drains both queues. An event leaves the outbox only when the server says it has it; anything else keeps it queued. A rejection is set aside rather than retried forever, since retrying blocks everything behind it
- `sync/stock-applier.ts` — applies a pulled `STOCK_MOVED` to the local ledger, `INSERT OR IGNORE` on the movement ID so re-applying cannot double stock
- `sync/product-applier.ts` — applies a pulled `PRODUCT_SAVED`, which is what unblocks movements deferred waiting on their product
- `products/products.ts` — products on the device, with the last-write-wins upsert. A losing edit is a `false` return, never an error

There is no UI yet. The data layer is plain TypeScript so it runs under Node against real SQLite; React Native types arrive with the screens.

`backend/internal/api/` — the HTTP edge (§35). Stdlib `net/http` routing under `/api/v1`, one JSON error shape with stable machine-readable codes, and `RequireAuthentication`/`RequirePermission` middleware. `classify` is the single place errors become statuses — a new service's errors must be added there or they fall through to 500. An internal error never echoes its cause to a client.

Endpoints: `/auth/login`, `/auth/logout`, `/auth/me`, `/sync/push`, `/sync/pull`. A push answers **200 even when some events were rejected** — the request succeeded, and per-event results say what happened to each; a non-2xx would make a client resend what landed.

`backend/cmd/api/` — the binary: read config from the environment, connect, migrate, serve, drain on SIGTERM.

`backend/internal/platform/postgres/` — the driver edge (ADR-013). pgx v5, goose migrations embedded from `backend/migrations/`, and repositories that take a `business.Scope` bound into the query. `pgtest` gives tests a migrated database. Domain types cross into driver types here and nowhere else.

`inventory_movements`, `sales`, `sale_items`, and `sale_payments` are append-only **in the database**, not just the domain: triggers refuse UPDATE and DELETE, so a correction has to be a compensating transaction even for a migration or a support script. Stock and sale totals are derived, never stored.

`SaleRepository.Record` is §9's fan-out: the sale, its lines, its payments, and the stock it released, in one transaction. Half of it landing describes something that did not happen — money taken for goods still on the shelf, or stock gone with nobody recorded as paying.

A record belonging to another tenant is reported as **not found**, never as forbidden — saying "you may not see this" confirms it exists to someone who may not know of it.

Where a helper has both a fallible and a total form (`business.NewScope`/`ScopeOf`, `authz.Resolve`/`Effective`), the fallible one is for untrusted input and the total one is for callers holding already-validated values. Total forms **fail closed** — a missing tenant yields a scope that permits nothing, an unknown role contributes no permissions. Prefer this over an unreachable `panic` guard, which is untestable dead code.

Entities keep their fields unexported behind accessors and cross the persistence boundary as a validating `Snapshot`/`Restore` pair, so a repository cannot construct one that skipped validation. Stored data is re-validated on the way in — a record written by an older version or synced from another device is not trusted.

### Commands

Run from the repository root:

```sh
make check            # fmt + lint + test (backend and client)
make test             # unit tests; integration tests skip without a database
make test-client      # client tests, against real SQLite via node:sqlite
make install-client   # npm install for apps/mobile
make test-integration # start PostgreSQL and run every test against it
make lint             # go vet + gofmt check
make fuzz-backend     # run every fuzz target (FUZZTIME=30s by default)
make db-up            # start the local PostgreSQL (port 5433)
make db-down          # stop it, keeping the data
make db-reset         # stop it and discard the data
```

Backend-only, from `backend/`: `go test ./... -race -cover`, `go vet ./...`, `gofmt -l .`.

### Testing expectations

Tests must pass under `-race`. `kernel/` and `domain/` are held at **100% statement coverage** — except `domain/sales` at ~97%, where the remainder is error propagation from money arithmetic that `Record` has already proved cannot fail, unreachable because the entity's fields are unexported; `platform/postgres` sits at ~96%, the remainder being driver-error branches that cannot be reached with constants we control. Comprehensiveness is not satisfied by covering the spec's worked examples — those are a floor. Also cover boundary and overflow values, degenerate and malformed input, concurrency, and the invalid zero-value surface of each type. Prefer property-based tests, Go native fuzz targets, and — where a correct answer is independently computable — an oracle built a structurally different way from the implementation (see `money/oracle_test.go`).

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
| Local database | SQLite — the *primary operational* DB, not a cache |
| Backend | Go |
| Server database | PostgreSQL |
| Sync | Event/transaction-based, versioned HTTP API (`/api/v1/...`) |
| Auth | Token-based |
| Currency / locale | XAF (FCFA), French + English |

Intended monorepo layout (spec §52) — place new code accordingly: `apps/{mobile,web,desktop}/`, `backend/{cmd,internal,migrations}/`, `packages/{shared-types,shared-validation}/`, `docs/`, `scripts/`, `infrastructure/`.

## The one architectural rule everything else follows from

> **Business events create immutable transactions; current state is derived from those transactions.**

Concretely, this means:

- **Never store derived state as a mutable field.** Stock is not `product.stock = 47`; it is the sum of inventory movements (`+100 purchase`, `-3 sale`, `-2 damage`, …). Customer balances, supplier balances, and financial-account balances are likewise derived from their transactions, never directly written.
- **Never destructively update financial history.** Returns, refunds, and corrections are new compensating transactions that reference the original — not edits or deletes.
- **A business event fans out across domains.** A sale produces a sale record + sale items + inventory movements + one or more payments + (if credit) a customer transaction + financial effects. A purchase is not merely an inventory operation: it raises inventory and either lowers cash or raises supplier payable. Do not implement any of these as a single-table write.
- **Payments are independent of sales.** A sale has *many* payments (split cash + Mobile Money is a normal case), so there is no single `payment_method` column on a sale. Mobile Money providers (MTN, Orange) are configurable financial accounts, not hard-coded types.

## Offline-first is non-negotiable

Every core operation — product lookup and creation, inventory changes, sales, returns, customer and supplier management, payments, expenses, cash management, local reports — must complete with no network. The correct shape is:

```
action() → validate locally → SQLite transaction → show success → queue sync event
```

Never `action() → POST → await server → show success`. The app must not block business operations because sync failed. UI reads observe local SQLite; the flow is UI → application action → repository → SQLite transaction → UI observes updated local data. Keep transient UI state in React; do not mirror the business database into a global in-memory store.

## Sync engine constraints

Sync is a first-class subsystem with dedicated endpoints (`POST /api/v1/sync/push`, `GET /api/v1/sync/pull`) — not CRUD calls sprinkled through features. Requirements: batching, acknowledgements, ordering, retry, partial failures, conflict reporting.

- Push **events** (`{event_id, type, payload, timestamp, device_id, business_id, user_id}`), not final state snapshots.
- Every event carries a globally unique immutable ID, and the **server must be idempotent** — replaying an event must never apply it twice. Any sync operation must be safe to retry.
- Each installation has a device identity, used for sync, audit, conflict resolution, and troubleshooting.
- Conflict policy is per-data-type and must be explicit: financial transactions immutable, inventory movements append-only, product descriptions last-write-wins, user permissions server-authoritative. Two devices selling the last unit offline is expected — resolve by accepting both movements, never by picking one device's stock number.
- Assume slow, intermittent, expensive connectivity and multi-day sync gaps; keep payloads compact.

## Multi-tenancy and authorization

Every business-owned record belongs to a business/organization, and tenant isolation is enforced at the **data/service layer**, not by UI checks — a user in Business A must never reach Business B's data. The data model must accommodate `Organization → Branch → {Devices, Users, Inventory}` even though the MVP ships single-branch.

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

### Applying events

A pushed event is **recorded and applied in one transaction** (`SyncRepository.RecordAndApply`, taking an `Effects`). Recording without applying is the failure mode to watch for: the device is told "accepted", stops resending, and the stock never lands — undetectable afterwards, since the log says the event arrived. A new applied event type adds a field to `Effects` and a write inside that transaction, never a second write beside it.

Applied types so far: `STOCK_MOVED` (append), `PRODUCT_SAVED` (last-write-wins upsert, ADR-015), and `SALE_COMPLETED` (immutable insert of the whole fan-out). Conflict policy is per type and deliberately different — two devices' movements both stand, but only one product edit can.

Payload structs live in `app/syncing` (`StockMovedPayload`), not in `postgres` — they are the wire contract, and their JSON names are a protocol version. A movement's tenant, branch, device, and user come from the authenticated envelope; only the movement's own ID comes from the payload, because that ID is what makes a replay a duplicate.

Forward compatibility runs in two directions, and they are opposite on purpose:

- **On the way in**, an unknown event type is **refused** (`sync.Type.Defined`), so a device running ahead of the server finds out rather than being told "accepted" and believing its data arrived. An unknown *field* inside a payload this build applies is refused too (`DisallowUnknownFields`) — ignoring it could half-apply a fact and report success.
- **On the way out**, a stored event of an unknown type is **relayed untouched** (`sync.Restore`), because refusing to read one row an older build accepted would fail the pull for every device.

### The client/server payload contract

`StockMovedPayload` in `app/syncing` and `describe()` in the client's `movements.ts` are two halves of one wire format, and nothing but a test holds them together. The server refuses a payload carrying a field it does not know, so a field added to one side and not the other **rejects every event from that client**.

The payload carries no business, branch, device, or user, and no currency: identity comes from the authenticated envelope (ADR-008) and everything is XAF (§46). Only the movement's own ID travels, because that ID is what makes a replay a duplicate.

### Product conflicts

Products are last-write-wins ordered by **`(updated_at, updated_by_device)`** (ADR-015). The tie-break is not decoration: without it, two devices holding the same two edits could settle on different prices depending on arrival order, permanently and undetectably. Because the comparison reads only the two rows, applying edits in any order gives the same answer everywhere.

The rule is written twice — once in PostgreSQL, once in SQLite — because a device must resolve a conflict with no network. Both sides are tested against the same cases, including the order-independence property itself.

A losing edit is **discarded, not an error**. On the client `saveProduct` returns `false`; treating it as a failure would defer the event forever.

Timestamps come from the device, never the server: an edit made offline on Monday and synced on Friday must not beat one made on Wednesday.
