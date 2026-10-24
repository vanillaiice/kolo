# ADR-041: Two tills returning the same sale offline

**Status:** Accepted, 2026-10-24. Amends [ADR-023](ADR-023-partial-returns-and-source-ordering.md).

## Context

Returns of one original are serialized by a signed predecessor link (`prior_id`). Two tills returning the same sale
while offline both sign the same predecessor. The till that made each return has already paid out the refund and
moved the stock, but every other till quarantined it with `return_conflict`, the owner could not approve it, and any
later return built on it waited forever. Simply applying it later is not exact: refund amounts come from cumulative
entitlement, so recomputing a return after the other one can differ by a franc (three bags for 1000: one bag is 333,
the second 334), and a cash refund then no longer matches.

## Decision

- **Owner approval.** A return held back with `return_conflict` may be approved by the owner by its exact digest
  (`event_exception_reviews`, kind `return_conflict`).
- **Exact amounts.** Every received return is computed against exactly the returns it was signed against: its signed
  predecessor and that one's predecessors (`returnSource(…, basis)`). Without a split this is every return, as before.
  An approved concurrent return is linked locally after the latest return (so the unique chain holds) and keeps its
  signed predecessor in `return_fork_links` (client migration 34). Every till therefore records the same amounts
  the till that made it did, in whatever order the two arrive.
- **No further returns after a split.** Once a sale's chain has split, a new return could count only one side of it,
  so the sale takes no more returns (`return_conflict`, shown as the stale-return message).
- **Unknown predecessor.** A return whose predecessor has not arrived now waits (`missing_dependency`) instead of
  being quarantined as a conflict.

## Consequences

- Both refunds stay recorded everywhere and the tills agree. If the two returns together exceed what was sold, the
  stock and cash movements are still the physical truth; the owner approved them knowingly.
- A sale whose returns split cannot be returned again on any till; corrections go through stock and cash movements.
- The full fix, returns carrying their computed amounts so forks never need approval, needs a new payload version.
