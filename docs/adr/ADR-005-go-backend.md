# ADR-005: Go backend

**Status:** Accepted
**Source:** SPECIFICATION.md §30, §35, §63

## Context

The backend serves authentication, synchronization, remote management, and
centralized reporting over a versioned HTTP API.

## Decision

The backend is written in Go and layered strictly:

```
HTTP/API layer → application/service layer → domain layer → repository/data layer
```

Dependencies point inward. **The domain layer must not depend on HTTP**, nor on
any database driver. The API is versioned and explicit: `/api/v1/...`.

## Consequences

* Domain code is tested without a server or a database.
* HTTP concerns (status codes, headers, JSON shapes) are confined to the API layer;
  domain errors are translated there rather than being HTTP-aware at the source.
* Repository interfaces are declared by the layers that consume them, and
  implemented against PostgreSQL (ADR-003) at the edge.
* Business rules live in domain/application services, never duplicated into HTTP
  handlers, database triggers, or report queries (§53).
