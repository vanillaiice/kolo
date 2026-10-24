# ADR-043: Only a vouched fact holds its origin position on the server

**Status:** Accepted, 2026-10-24. Amends [ADR-030](ADR-030-end-to-end-encryption-and-connection-codes.md).

## Context

The server cannot verify a sealed fact's origin proof, so it accepts a sealed fact from any trusted till for any
origin on the roster (ADR-030). Its journal also made `(origin_device_id, origin_sequence)` unique. Sequence numbers
are predictable, so a compromised or malicious till could push junk sealed facts claiming the owner's next 10,000
positions; the owner's real facts then became `event_identity_conflict`, were refused for good and reached the other
tills only by file. The review proposed having the origin sign the header. That changes every signed fact on the
wire, which older tills and servers refuse outright.

## Decision

- A journal row is **vouched** when the server can stand behind its position: a clear fact (its signature is checked
  here) or a sealed fact pushed by its own origin (`journal.vouched`, generated; server migration `0009`).
- Position uniqueness applies only to vouched rows (partial unique index). A forwarded sealed fact may share a
  position, but is refused as a conflict when a vouched fact already holds it.
- Pull and status skip a forwarded sealed fact once a vouched fact holds its position, or when the till that forwarded
  it is no longer trusted. Tills open whatever they are offered and refuse what does not verify, as before.

## Consequences

- Junk can no longer block a till's own facts: they always take their positions, and the junk stops being offered.
- Until the origin itself pushes, junk at its positions is still offered and refused by every till (`locked`). Facts
  that only ever reach the server through another till, and collide with junk, still need file exchange, as before.
- No wire format changes; every release keeps working.
- Origin-signed headers remain the complete fix and need a format version.
