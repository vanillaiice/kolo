# ADR-002: SQLite as the local operational database

**Status:** Accepted
**Source:** SPECIFICATION.md §4, §24, §34, §63

## Context

Offline-first (ADR-001) requires durable local storage that can hold the full
working set of a business: products, inventory movements, sales, customers,
suppliers, purchases, payments, expenses, financial accounts, and sync metadata,
and query it fast on inexpensive Android hardware.

## Decision

SQLite is the **primary operational database** on the client, not a cache.

* The application performs real transactions against SQLite; a multi-domain
  business event is written in a single SQLite transaction.
* The local database is durable application state. It is not disposable and must
  not be rebuilt from the server as a matter of routine.
* UI reads observe local SQLite. The flow is:
  `UI → application action → repository → SQLite transaction → UI observes updated local data`.
* The business database is not mirrored into a global in-memory store. Transient
  UI state lives in React state.

## Consequences

* Schema migrations must run on the client, on devices that may be many versions
  behind. Client migrations are forward-only and must tolerate large version gaps.
* Client and server schemas evolve separately and need not be identical, but the
  event contract between them (ADR-006) must stay compatible.
* Query performance work (indices, pagination, list virtualisation) happens
  against SQLite, and is a product requirement rather than an optimisation:
  §46.
* Local data at rest is sensitive business information and is protected as such.
