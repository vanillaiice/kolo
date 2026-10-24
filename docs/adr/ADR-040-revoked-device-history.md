# ADR-040: A revoked till's history stays accepted up to a cutoff

**Status:** Accepted, 2026-10-24. Amends [ADR-021](ADR-021-signed-journal-and-late-event-policy.md),
[ADR-029](ADR-029-sync-server-relay.md) and [ADR-030](ADR-030-end-to-end-encryption-and-connection-codes.md).

## Context

An external review (2026-10-24) found that revoking a till silently dropped its earlier facts on any till that had
not received them yet. The server's pull skipped facts whose origin was no longer active, and the tills refused
facts from a revoked key (`untrusted_device`) without storing them, so the owner could not review them either.
Example: till B sells on credit all day and pushes in the evening; the owner revokes B the next morning; till C,
offline overnight, never receives B's sales, cash or customer debts, while till A, which pulled first, has them.
The books diverge and nothing tells the owner. Wall clocks cannot be trusted, so a revocation cannot say "facts
signed before 09:00 count".

## Decision

- **Cutoff fact.** Revoking a device on the owner's authority till first signs `DEVICE_HISTORY_ACCEPTED
  { device_id, through_sequence, revision }`, then the usual `DEVICE_REVOKED` at the same roster revision.
  `through_sequence` is the highest origin sequence the owner's till holds from that device: everything it already
  had stays accepted. The fact is sealed like business facts; the server never needs it. The higher revision wins,
  an equal revision must agree, and revoking an already revoked device keeps the recorded cutoff, so it is never
  widened over facts that arrived while revoked. `publishDeviceRoster` republishes the recorded cutoff.
- **Tills keep a revoked key.** Origin verification uses the pinned key whether or not it is still trusted
  (`originDevice`). A revoked device's fact is stored; it applies if its origin sequence is at or below the cutoff
  (`trusted_exchange_devices.accepted_through`, client migration 34) and is otherwise held back with reason
  `device_revoked`. A fact held back only because the cutoff had not arrived yet is released when it does.
  Reinstating the device releases everything it signed meanwhile. Unknown keys are still refused.
- **Owner review.** The owner may approve a `device_revoked` fact by its exact digest
  (`event_exception_reviews`, kind `device_revoked`); every other check still applies. Authority facts are never
  reviewable. Desktop lists held-back facts for the owner under the journal.
- **Server.** Pull and the backlog count no longer filter on the origin being active. Each till decides.
  Revoked tills still cannot open sessions, so nothing new arrives from them through the server.

## Consequences

- Revoking a till never silently drops its history; facts beyond the cutoff are visible and reviewable.
- Facts signed by the revoked device that the owner's till had not received are held for review on every till,
  which is noise when the device was revoked because it was stolen. That is intended: the owner decides.
- Older releases ignore `DEVICE_HISTORY_ACCEPTED` (kept as an unsupported fact, applied after upgrade) and still
  apply `DEVICE_REVOKED`, so mixing versions loses nothing new.
- Devices revoked before migration 34 have no recorded cutoff; republishing their roster uses what this till holds.
