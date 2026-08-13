# ADR-006: Event-based synchronization

**Status:** Accepted
**Source:** SPECIFICATION.md §25, §26, §27, §28, §36, §45

## Context

Multiple devices operate independently offline for extended periods. Synchronizing
final state snapshots loses information and silently discards concurrent work: if
two devices each push `{product_id: 123, stock: 47}`, one device's sales vanish.

## Decision

Synchronization is a first-class subsystem with dedicated endpoints, not CRUD
calls scattered through features:

```
POST /api/v1/sync/push
GET  /api/v1/sync/pull
```

Clients push **events**, not state:

```
{event_id, type, payload, timestamp, device_id, business_id, user_id, created_at}
```

Requirements on the protocol: batching, idempotency, acknowledgements, ordering
information, retry, partial failures, authentication, and conflict reporting.

* Every event carries a globally unique, immutable identifier.
* **The server must be idempotent.** Replaying an event must never apply it twice.
* Any sync operation must be safe to retry.
* Each installation has a device identity, used for sync, audit, conflict
  resolution, security, and troubleshooting.
* Payloads are compact and batched; connectivity is assumed slow, intermittent,
  and expensive.
* Synchronization runs automatically; the user should not normally have to start
  it.

## Consequences

* Event payloads are a versioned wire contract. Old devices emit old event
  versions after multi-day gaps, so the server must accept every event version it
  has ever issued.
* Because events are the unit of transfer, a business operation must be
  expressible as one or more events — this shapes the domain model, not only the
  sync layer.
* Conflict policy is per data type and must be explicit (ADR-007, ADR-009):
  financial transactions immutable, inventory movements append-only, product
  descriptions last-write-wins, user permissions server-authoritative.
* Idempotency requires the server to durably remember which event IDs it has
  applied.
