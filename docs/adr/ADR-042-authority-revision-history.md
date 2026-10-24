# ADR-042: Facts are judged by the revision they were signed under

**Status:** Accepted, 2026-10-24. Amends [ADR-021](ADR-021-signed-journal-and-late-event-policy.md).

## Context

ADR-021 required a received business fact's `authority_revision` to equal the actor's current membership revision.
Any PIN reset or permission change while a cashier's sales were still in flight therefore quarantined those sales
on every other till, one at a time, each waiting for the owner. With tills that are often offline this was routine.

## Decision

- Each member's role, overrides, custom role and active state are kept for every earlier revision
  (`membership_revisions`, filled by a trigger whenever `local_memberships.revision` changes; client migration 34).
- A business fact signed under an earlier revision is accepted when that revision was active and allowed it; the
  role matrix and custom roles are read as they stand now, as before. A future revision still waits.
- Authority facts (members, roles, devices, keys) still require the current revision.
- A revision this till never recorded (it changed before migration 34, or this till skipped it) keeps the old rule:
  held back with `authority_revision` for owner review.

## Consequences

- A cashier's offline sales survive a later PIN reset, permission change or suspension.
- Work signed while a member still held a right is accepted after the right is withdrawn. That matches the
  existing rule that independent authorized offline facts both stand (ADR-021); wall clocks are not trusted to say
  otherwise. A stolen device is handled by revoking it (ADR-040), not by changing the member.
