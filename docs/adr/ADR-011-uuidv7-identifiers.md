# ADR-011: UUIDv7 identifiers from a standard library

**Status:** Accepted
**Source:** SPECIFICATION.md §6, §27, §40, §46; ADR-001, ADR-006

## Context

Every business record and every sync event needs a globally unique, immutable
identifier (§27, §40). The constraints are set by offline-first operation:

* Identifiers must be generated **on the device**, with no network round trip
  and no server-assigned sequence (ADR-001).
* Two devices generating identifiers independently, offline, for days, must
  never collide (ADR-006).
* Identifiers are the primary keys of large local tables on cheap Android
  hardware, so index locality matters (§46).

A monotonic integer key is unavailable: it requires coordination the system does
not have. Random UUIDv4 is collision-safe but scatters inserts across the index,
which costs on exactly the hardware being targeted.

## Decision

Identifiers are **UUID version 7** (RFC 9562): a 48-bit Unix millisecond
timestamp followed by a counter and random bits. They are collision-safe without
coordination and they sort by creation time, so lexicographic order is time
order — giving index locality in both SQLite and PostgreSQL, and a natural
ordering hint for sync batches.

Generation uses the established library, `github.com/google/uuid`, rather than a
project implementation. The library also handles monotonicity within a single
millisecond, so a burst of sales at the till still produces ordered identifiers.

The project wraps it in `internal/kernel/id`, which is deliberately thin:

* `id.ID` is an alias for `uuid.UUID`, so values interoperate directly with the
  library and with drivers that already understand UUIDs.
* `id.Generator` is an interface, so services can be tested against a
  deterministic sequence (`internal/kernel/id/idtest`) instead of real
  timestamps and randomness.

The wrapper exists for dependency direction and testability. It does not
reimplement any part of the format.

## Consequences

* Identifiers leak an approximate creation time. This is business data on a
  business's own records, not a secret, and it is already carried explicitly by
  the `created_at` fields the spec requires. Any future identifier that must not
  reveal timing needs a different scheme, decided in its own ADR.
* Parsing is normalising, not strict: the canonical, braced, URN, and
  unhyphenated spellings of one identifier all decode to the same 16 bytes.
  **Idempotency depends on keying by the parsed value, never by the received
  string.** A server that deduplicated on raw text could store one event twice.
* Identifiers are 16 bytes rather than 8. On the sync wire they are the compact
  binary or 36-character text form; payload size is bounded by batching (§45),
  not by key width.
* `id.New` panics if the system entropy source fails. There is no correct way to
  continue without randomness, and a fallback would produce identifiers unsafe
  to sync. Callers that must handle the failure use `id.V7.New`.
