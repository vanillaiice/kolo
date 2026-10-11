# ADR-007: Immutable financial transactions

**Status:** Accepted
**Source:** SPECIFICATION.md §4, §13, §16, §20, §29, §40, §41, §59

## Context

The system's central rule is:

> **Business events create immutable transactions; current state is derived from
> those transactions.**

In an offline multi-device system, destructive updates to financial history are
unrecoverable: there is no single ordering of edits, and an overwritten record
cannot be reconciled after the fact.

## Decision

Financial history is append-only.

* Financial transactions are never silently deleted or overwritten.
* Corrections, returns, and refunds are **new compensating transactions that
  reference the original**, not edits or deletes.
* Historical transactions retain their original timestamps.
* Balances are **derived**, never stored as mutable fields and never manually
  edited:
  * customer balance = sum of that customer's transactions
  * supplier balance = sum of that supplier's transactions
  * financial account balance = sum of that account's transactions
* A completed sale is not directly edited without an audit trail.
* Payments are modelled independently of sales: a sale has *many* payments, so
  there is no single `payment_method` column on a sale. Mobile Money providers
  (MTN, Orange) are configurable financial accounts, not hard-coded types.
* Sensitive operations write audit records carrying actor, business, device,
  timestamp, action, entity, entity ID, and metadata.

## Consequences

* Reads that need a balance either aggregate transactions or use a derived
  projection that can be rebuilt from them. A cached balance is a projection, never
  a source of truth, and must be reproducible by replaying the transactions.
* Deriving balances on every read has a cost that grows with history; where that
  cost matters, the answer is a rebuildable projection or periodic snapshot, not a
  mutable running total.
* "Undo" is not available as a user primitive. The UI expresses corrections as
  reversals.
* Conflict resolution for financial data never merges or picks a winner: both
  records stand, and any discrepancy is surfaced for human reconciliation.
