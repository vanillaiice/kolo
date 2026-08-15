# ADR-015: Last-write-wins for products, ordered by (updated_at, device)

**Status:** Accepted
**Date:** 2026-08-14

## Context

The spec fixes conflict policy per data type (§29). Financial transactions are
immutable, inventory movements are append-only, and **product descriptions are
last-write-wins**. The first two are settled and implemented: a movement is
never overwritten, so two devices selling the last unit both stand and the total
goes to −1.

Products are different in kind. A product is *state*, not an event. Two devices
can both edit the price of the same rice while offline, and unlike two sales,
these cannot both stand — the product has one price. One edit has to win.

"Last write wins" sounds like it settles the question. It does not, on its own,
because it leaves two things unspecified, and both matter here:

1. **Last by whose clock?** These are cheap Android devices, often with no
   reliable time source, offline for days (§45). Their clocks disagree.
2. **What breaks a tie?** Two devices can stamp the same millisecond. Rarer:
   they can also stamp the same second if a device's clock has low resolution.

The second is where the real hazard lies. Devices apply events in whatever
order they receive them, and a device that syncs after a week receives them in
a different order from one that syncs hourly. If a tie is broken by arrival
order — "the one I saw last" — then two devices holding the same two edits can
end up with **different prices**, permanently, with no error anywhere and
nothing to detect it. Sync would have converged on disagreement.

## Decision

A product write wins if its `(updated_at, updated_by_device)` pair is greater
than the stored one, compared in that order.

`updated_by_device` is a new column carrying the device that made the edit. It
exists only to break ties, and is compared as text.

This is applied identically on the server (PostgreSQL) and on every device
(SQLite), as one conditional upsert:

```sql
ON CONFLICT (id) DO UPDATE SET ...
WHERE excluded.updated_at > products.updated_at
   OR (excluded.updated_at = products.updated_at
       AND excluded.updated_by_device > products.updated_by_device)
```

An edit that loses is discarded, not queued or reported. It lost; there is
nothing to do about it.

## Why this and not the alternatives

**A total order, not merely a recent one.** Because the comparison is a pure
function of the two rows, applying a set of edits gives the same result in any
order. That is the property that matters: a device that receives A then B and
one that receives B then A agree. Arrival order stops mattering, which is the
only way to converge when devices sync days apart.

**Server-stamped timestamps** were the obvious alternative, and would fix the
unreliable-clock problem outright. They are wrong here for a reason that goes
to the heart of the product: an offline edit would be ordered by *when it
synced*, not when it happened. A shopkeeper corrects a price on Monday, syncs on
Friday, and their correction beats an edit a colleague made on Wednesday and
synced immediately. The later edit loses to the earlier one, and the shop's
price is wrong. Ordering by when the business event happened is the same
principle the ledger already follows in keeping `occurred_at` apart from
`recorded_at`.

**A vector clock or CRDT** converges without trusting clocks at all, and is the
technically superior answer. It is rejected as disproportionate. A per-field
CRDT for a product is a large amount of machinery, and a shopkeeper cannot
interpret its output — "both prices are live" is not an answer a till can act
on. The spec asks for last-write-wins; this is last-write-wins made
deterministic, not replaced.

**Field-level merge** — take the newest name and the newest price separately —
was considered and rejected. It can produce a product that no one ever
entered: one person's name beside another's price. A product edited as a whole
should land as a whole.

## Consequences

A device with a badly wrong clock can win edits it should lose, or lose edits it
should win. This is accepted, and it is the honest tradeoff: the alternative
mis-orders every offline edit rather than only those from a broken device. It
argues for surfacing clock skew to the user, which is not in this decision.

Ties break toward the higher device identifier, which is arbitrary. It must be
*deterministic*, not fair, and no device can influence which it gets — the
identifiers are UUIDv7 generated at registration.

`updated_by_device` is nullable on rows that predate this decision, and a null
sorts below any device, so an edit from a real device always beats one from
before the column existed. That is the right way round: those rows are older.

The rule is written twice, once in SQL for each database. That duplication is
deliberate and load-bearing — the device must be able to resolve a conflict with
no network — and it is exactly the kind of divergence that a test on one side
alone would not catch, so the two are tested against the same table of cases.
