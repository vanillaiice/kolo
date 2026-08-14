# ADR-013: Server persistence — driver, migrations, and tenant enforcement

**Status:** Accepted
**Source:** SPECIFICATION.md §30, §31, §37, §40, §43, §51; ADR-003, ADR-008

## Context

ADR-003 fixes PostgreSQL as the server database but not how the backend reaches
it, how the schema evolves, or how the tenant boundary from ADR-008 is enforced
once queries are real SQL rather than in-memory checks.

The layering in ADR-005 constrains the answer: the domain must not depend on a
database driver. Whatever is chosen lives at the repository edge and must not
leak inward.

## Decision

### Driver

`github.com/jackc/pgx/v5`, used through its native interface rather than
`database/sql`. It is the maintained PostgreSQL driver for Go, and the native
interface gives typed access to PostgreSQL's own types — `uuid`, `timestamptz`,
`text[]` — which the schema below relies on.

### Migrations

`github.com/pressly/goose/v3`, with plain SQL migrations under
`backend/migrations/` embedded into the binary.

* Migrations are **forward-only in production**. Down migrations exist so a
  developer can step back locally; they are not a rollback strategy for a
  database holding financial history that §40 says is never destroyed.
* SQL rather than Go migrations, so the schema's history is readable as schema.
* Embedded, so a deployed binary carries the migrations it expects and cannot
  drift from the files on some other machine.

The client's SQLite schema (ADR-002) has a separate migration history. The two
databases are related but not identical, and only the event contract between
them has to stay compatible (ADR-006).

### Tenant enforcement

Every business-owned table carries `business_id NOT NULL REFERENCES
businesses(id)`, and **every repository method takes a `business.Scope`** whose
value is bound into the query's `WHERE` clause. A query that could be written
without a tenant predicate is a defect, as ADR-008 states.

Row-level security is deliberately **not** used at this stage. It would be a
genuine second layer, but it requires setting a per-transaction session variable
on every connection, which is easy to get wrong with a pool and would put the
tenant boundary somewhere the tests cannot see it. Scoped queries plus tests
that attempt cross-tenant reads keep the boundary in one visible place. RLS
remains available later as defence in depth, and this decision should be
revisited before the platform hosts businesses that do not trust each other's
operators.

### Schema conventions

* Primary keys are `uuid`, holding the UUIDv7 values from ADR-011. Their time
  ordering gives insert locality, so the index does not fragment.
* Money is `BIGINT` minor units with the currency stored alongside (ADR-010).
  No `numeric`, no floating point.
* Timestamps are `timestamptz`, written in UTC.
* `updated_at` is set by the domain, not by a trigger. The entity already owns
  when it changed, and a trigger would overwrite that with the moment the row
  happened to be written — which for a synced record is the wrong time entirely.
* Constraints that protect an invariant are declared in the schema as well as
  the domain. The domain is the place rules are expressed; the schema is what
  holds when a bad migration, a manual fix, or a future service gets it wrong.

## Consequences

* Integration tests need a real PostgreSQL. Mocked SQL would not prove tenant
  isolation holds, which is the property most worth proving, so the repository
  tests run against a live database and skip loudly when one is not configured.
* Repositories translate between domain types and driver types at the edge:
  typed identifiers become `uuid`, `authz.Set` becomes `text[]`. The domain
  keeps its own vocabulary.
* Because migrations are embedded, adding one means rebuilding — which is the
  intent, since a schema change and the code that depends on it ship together.
