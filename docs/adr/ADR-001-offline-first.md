# ADR-001: Offline-first architecture

**Status:** Accepted
**Source:** SPECIFICATION.md §4, §23, §45, §53

## Context

The target market is small and medium businesses in Cameroon, where internet
connectivity is unavailable, slow, intermittent, or expensive. A shop cannot stop
selling because a network request failed. Synchronization gaps of hours or days
are expected.

## Decision

Every core business operation completes locally with no network:

* product lookup and creation
* inventory changes
* sales and returns
* customer and supplier management
* customer and supplier payments
* purchases and expenses
* cash management
* reports over local data

The mandated shape of a business action is:

```
action() → validate locally → SQLite transaction → show success → queue sync event
```

Never `action() → POST → await server → show success`.

Connectivity is an enhancement enabling synchronization, backup, multi-device
operation, and remote management. It is never a precondition for operating the
business.

## Consequences

* The client carries real domain logic and validation; it is not a thin view over
  a server API.
* Business rules must be expressed so that they can be evaluated against local
  state alone. Rules requiring a global view (for example, a hard cross-device
  stock reservation) cannot be enforced synchronously and must be handled as
  reconciliation after the fact (see ADR-006 and ADR-009).
* Some validation is necessarily duplicated between client and server. The server
  still validates everything it receives (it cannot trust a client), but the
  client's copy is authoritative for the offline user experience.
* Sync failure must never surface as business-operation failure. It surfaces as
  sync status.
