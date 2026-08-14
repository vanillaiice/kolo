# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

KOLO is an offline-first business management platform (inventory, POS, customer credit, cash, reports) for small and medium businesses in Cameroon. It is early: the monorepo skeleton (spec §52), the ADRs (spec §55), and the first backend domains exist. There is no client, no API, no repositories, and no database code yet.

`backend/internal/kernel/` — primitives shared by every domain:

- `money` — integer minor units, currency-checked arithmetic, explicit rounding, remainder-preserving allocation
- `id` — UUIDv7 via `github.com/google/uuid`, generated offline, sortable by creation time. `id.Typed[Tag]` gives phantom-typed identifiers so a sale ID cannot be passed where a product ID belongs; `id/idtest` gives deterministic identifiers for tests
- `clock` — injectable UTC time source

`backend/internal/domain/`:

- `authz` — granular permissions, roles, and the configurable role→permission matrix (§38). Effective permissions are role defaults + grants − revocations, revocation last
- `business` — the tenant. `Business` and `Branch` entities, and `Scope`, which is the required argument that makes tenant isolation structural rather than a filter a caller can forget

Entities keep their fields unexported behind accessors and cross the persistence boundary as a validating `Snapshot`/`Restore` pair, so a repository cannot construct one that skipped validation. Stored data is re-validated on the way in — a record written by an older version or synced from another device is not trusted.

### Commands

Run from the repository root:

```sh
make check          # fmt + lint + test
make test           # go test ./... -race -cover
make lint           # go vet + gofmt check
make fuzz-backend   # run every fuzz target (FUZZTIME=30s by default)
```

Backend-only, from `backend/`: `go test ./... -race -cover`, `go vet ./...`, `gofmt -l .`.

### Testing expectations

Tests must pass under `-race`, and the kernel is held at 100% statement coverage. Comprehensiveness is not satisfied by covering the spec's worked examples — those are a floor. Also cover boundary and overflow values, degenerate and malformed input, concurrency, and the invalid zero-value surface of each type. Prefer property-based tests, Go native fuzz targets, and — where a correct answer is independently computable — an oracle built a structurally different way from the implementation (see `money/oracle_test.go`).

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
