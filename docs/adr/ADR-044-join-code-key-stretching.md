# ADR-044: The join code is stretched with Argon2id

**Status:** Accepted, 2026-10-24. Amends [ADR-032](ADR-032-join-by-code.md).

## Context

A join code is 10 Crockford base32 characters (50 bits). The mailbox handle was `sha256(label ‖ code)` and the MAC
key an HKDF of the code itself. The design treats the server as untrusted, and a desktop's local listener runs over
plain HTTP on the shop network. Whoever sees the handle could search 2⁵⁰ SHA-256 values offline (about 15 hours on
one current GPU, minutes on a rented cluster: inside the ten-minute window), then hold back the real request and
forge one with the genuine till's label. The owner would approve it and the shop snapshot would be sealed to the
attacker's key.

## Decision

- Both tills derive one key per code with Argon2id (64 MiB, 3 passes, 1 lane: the parameters every platform's
  startup check already proves), salt `kolo.join-key.v2`. The mailbox handle and the MAC key are HKDF outputs of
  that key (`kolo.join-id.v2`, `kolo.join-mac.v2`). The key is cached in memory while a join is polled.
- Codes, links, mailbox messages and the server are unchanged.

## Consequences

- A search now costs about 2⁴⁹ Argon2id evaluations at 64 MiB each, far outside ten minutes.
- Deriving costs about a second on a phone, once per join.
- Tills from before this change compute a different handle, so a code from a newer owner's till is "not found" on
  an older new till (and the reverse): update both. A PAKE (CPace, SPAKE2) remains the stronger option.
