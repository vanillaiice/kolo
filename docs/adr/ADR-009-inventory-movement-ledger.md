# ADR-009: Inventory movement ledger

**Status:** Accepted
**Source:** SPECIFICATION.md §7, §8, §29, §40, §59

## Context

Stock stored as a mutable field cannot survive offline multi-device operation. If
Device A and Device B both hold `stock = 1` and each sells the last unit, any
attempt to reconcile two competing values of `stock` must discard a real sale.

## Decision

Inventory is an append-only ledger of stock movements. Current stock is derived
by summing them.

```
Purchase        +100
Sale              -3
Sale Return       +1
Customer Return   +1
Damage            -2
Adjustment        +5
Stock Count       -3
Transfer         -10
```

A movement records: movement ID, product ID, quantity, movement type, reference
ID, timestamp, user ID, device ID, and reason.

`product.stock = 47` is never written.

On the conflicting-sale case: **both movements are accepted**. Stock goes to `-1`,
which is a true statement about the business — two units were sold and one
existed — and is surfaced for human resolution. The system never resolves this by
choosing one device's stock number.

Purchase cost information is retained rather than assuming selling price equals
inventory value. The MVP may use a simple valuation strategy, but the ledger must
be able to support FIFO or weighted average later, and valuation stays decoupled
from the UI.

The model distinguishes available stock and leaves room for reserved stock,
separately tracked damaged stock, and stock at multiple locations.

## Consequences

* Derived stock costs a query. Fast product lists and a fast POS (§46) therefore
  need indices and, where justified, a rebuildable projection — never a mutable
  stock column.
* Negative stock is representable and must be handled by the UI and reports rather
  than treated as corrupt data.
* A stock count is recorded as an adjusting movement with a reason, preserving what
  the count found and what it corrected.
* Because movements carry cost information, valuation methods can be added later
  without a data migration.
