# ADR-014: Client writes and the sync outbox

**Status:** Accepted
**Source:** SPECIFICATION.md §4, §24, §25, §26, §34, §53; ADR-001, ADR-002, ADR-006

## Context

ADR-001 fixes that every core operation completes with no network, and ADR-002
makes SQLite the client's primary operational database rather than a cache.
ADR-006 fixes that clients push events rather than state.

Those three together imply something neither states outright: a business write
and the event that will eventually carry it to the server have to be **one
atomic act**. The specification writes the sequence as

```
action() → validate locally → SQLite transaction → show success → queue sync event
```

but "queue sync event" cannot be a step *after* the transaction. If the process
dies between the two, the shop has a sale it can see and the server never will —
and nothing afterwards can detect that, because from the device's point of view
the sale looks complete. That failure is silent, permanent, and exactly the one
§62 says the MVP must not have.

## Decision

### Every business write and its event commit together

A write is one SQLite transaction containing both the business rows and the
append to the outbox. Both or neither.

```
BEGIN
  insert sale, sale items, inventory movements, payments, …
  insert into sync_outbox (event_id, type, payload, …)
COMMIT
→ show success
→ the sync engine drains the outbox whenever it can
```

The outbox is the queue. There is no separate in-memory queue that could be lost
on a crash, and no "mark as needing sync" flag that a later pass discovers,
because a flag is a second write that can fail on its own.

### The outbox is an append-only log

Rows are appended, never edited in place except to record delivery. Each carries
the globally unique event identifier the server deduplicates on (ADR-006), so a
retry after an unacknowledged push is safe: the server has either applied it or
not, and either way applying it again is a no-op.

Delivered rows are retained for a period rather than deleted immediately, so a
support question about what a device sent can still be answered.

### Success is local

The UI shows success after the local commit. It never waits for the network, and
a sync failure never surfaces as a business-operation failure — it surfaces as
sync status (ADR-001).

### The driver is behind an interface

The client runs a native SQLite module; tests run `node:sqlite`. The same SQL
executes against both, so a query is exercised for real rather than mocked. Only
the thin driver adapter differs.

This is the same reasoning as the server's repository tests (ADR-013): the
property worth proving is that the SQL does what it claims, and a mock cannot
prove that.

### Client migrations are forward-only and gap-tolerant

A device may have been offline for months and arrive several versions behind, so
migrations run in order from wherever it is. There are no down migrations on a
device: there is no operator there to run one, and a rollback would discard
business records the server has not yet seen.

## Consequences

* Every repository write on the client takes a transaction, not a connection.
  A write that could be issued outside one is a defect, in the same way a query
  without a tenant scope is on the server.
* The outbox grows until it drains. A device offline for a long period
  accumulates rows, which is correct — that is the business's data — but the
  pruning of delivered rows has to be reliable or storage becomes a problem on
  cheap hardware.
* Because the event is written from the same code path as the business rows, the
  event's shape is a domain concern rather than a sync-layer one. The sync engine
  transports events; it does not construct them.
* Ordering within a device is the outbox's insertion order, which UUIDv7 already
  makes time-ordered (ADR-011). Ordering *between* devices is not defined and
  must not be relied on — that is what conflict policy is for (ADR-006).
* Tests can drive the real schema in Node, so the client's data layer is covered
  without an emulator. What that does not cover is the native driver itself,
  which needs a device or emulator and is not exercised here.
