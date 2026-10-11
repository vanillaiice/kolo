# ADR-012: Phone-and-PIN authentication with cached sessions

**Status:** Accepted
**Source:** SPECIFICATION.md §4, §37, §51, §63; ADR-001, ADR-008

## Context

`SPECIFICATION.md` fixes that authentication is token-based (§63) and that the
system must be secure (§37), but does not say how a user identifies themselves
or where a credential is checked. Both questions had to be answered before the
authentication domain could be built, because they determine the credential
model, the uniqueness constraints, and the login path on a device with no
network.

Two properties of the target market shape the answer. Staff operate a till and
re-enter their credential many times a day, so entry must be fast. Email is not
universal among shop staff in Cameroon, while a mobile number effectively is.

## Decision

### Identity is a phone number; the secret is a PIN

A user logs in with their **phone number and a numeric PIN**.

* Phone numbers are stored normalised to E.164, parsed by
  `github.com/nyaruka/phonenumbers` (the Go port of libphonenumber) with
  Cameroon as the default region. Normalisation must be identical everywhere or
  lookup silently fails, so the value type lives in `internal/kernel/phone` and
  is shared with customers (§12) and suppliers (§14).
* A phone number is unique **within a business**, not globally. One person may
  legitimately work for two businesses on the same number, and a global
  constraint would let one tenant discover another's staff by registration
  collision, which ADR-008 forbids.

### Credentials are verified by the server; sessions are cached long

First login contacts the server. Afterwards the device holds a cached session
and operates offline.

```
first login  →  POST /api/v1/auth  →  token  →  cached on device
thereafter   →  local session check, no network
```

* PIN hashes never leave the server.
* A session is bound to a device identity (§28) and renews on every successful
  sync, so a device that reaches the network even occasionally never expires.
* Sessions are long-lived deliberately. A session that lapsed mid-trading would
  lock a shop out of its own till, which is exactly the failure ADR-001 exists
  to prevent.

## Consequences

* **A brand-new device cannot be onboarded without network.** This is a real
  gap and is accepted knowingly. It is within the specification's letter: §4
  enumerates the operations that must work offline (product lookup and
  creation, inventory, sales, returns, customers, payments, purchases,
  expenses, cash, local reports), and first-time login is not among them. It
  remains a limitation to state plainly in onboarding material rather than one
  to discover in the field.
* **Revocation is not immediate.** Suspending a user takes effect on that
  device at its next sync. Anything needing instant lockout must be enforced
  server-side, on the sync and API endpoints, where the server is authoritative
  (ADR-006 already makes user permissions server-authoritative).
* **A PIN has very little entropy.** A four-digit PIN is one of ten thousand
  values, so the hash alone is not a meaningful barrier. What protects it is
  that hashes stay server-side and that the server rate-limits and locks out
  after repeated failures. Server-side throttling is therefore a requirement of
  this decision, not a later hardening step.
* PIN hashing uses a slow, salted password hash rather than a general-purpose
  digest, so that a database disclosure does not immediately yield every PIN.
* Because identity is a phone number, changing a number is an identity change
  and is audited (§39), not an ordinary profile edit.
