# ADR-010: Integer minor units for money

**Status:** Accepted
**Source:** SPECIFICATION.md §20, §44, §53

## Context

§44 requires that currency is never represented internally as floating point, and
that integer minor units are used. XAF (FCFA) has no subdivision in practice;
amounts are whole francs.

This ADR fixes the concrete representation, because every financial type in the
system depends on it and an inconsistent choice cannot be corrected later without
touching all financial history.

## Decision

Money is a dedicated value type carrying an **integer amount in minor units** plus
its **currency**. It is never a bare number and never a float.

* Minor units, not major: XAF has an exponent of 0, so one minor unit is one FCFA.
  Storing minor units regardless keeps the type correct for currencies with
  subdivisions, so multi-currency support later is not a data migration.
* `int64` is the amount type. It is exact, and its range is far beyond any
  realistic business total.
* **Currency is part of the value.** Arithmetic across different currencies is an
  error, not a silent coercion.
* Money is immutable. Operations return new values.
* Addition and subtraction that would exceed `int64` return an overflow error
  rather than wrapping silently.
* Division is not offered as a plain operation. Splitting an amount uses explicit
  allocation that distributes the remainder deterministically, so that the parts
  always sum back to the whole and no fraction of a franc is invented or lost.
* Parsing and formatting are separate from the type's arithmetic, and formatting
  is locale-aware (French and English, §44) at the presentation edge only.

## Consequences

* Percentage-based calculations (discounts, tax, margins) must round explicitly at
  a defined point, and the rounding rule is part of the business logic rather than
  an accident of float arithmetic.
* Storage is `INTEGER` in SQLite and `BIGINT` in PostgreSQL, with the currency
  stored alongside wherever an amount is not unambiguously business currency.
* The same value semantics must exist on the TypeScript client. JavaScript numbers
  are IEEE-754 doubles and are exact only to 2^53, so the shared client type
  mirrors this decision deliberately rather than using bare `number` arithmetic
  where large totals or accumulation are involved.
* Any code that reaches for `float64` on a monetary value is a defect.
