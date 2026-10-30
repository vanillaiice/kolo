# ADR-045: Operator dashboard v2: Preact, strict requests, step-up and a chained audit log

**Status:** Accepted, 2026-10-30. Amends the F6c dashboard (ADR-030, ADR-031).

## Context

The operator dashboard (`apps/admin`) was a single React view with no addresses for its pages, lists capped at 200 rows,
operator accounts only through the CLI and a 225 KB script. Its API coerced input with `Number()`/`String()`, a retried
payment was recorded twice, two operators editing a till limit overwrote each other silently, and the audit log was
append-only but gave no way to notice rows edited or deleted around the server. The user asked for a better
interface, more features and more integrity, staying fast and light.

## Decision

- **Client:** Preact 10 with `preact-iso` routing (real `/admin/...` addresses, filters and pages in the query string,
  lazily loaded pages). The JSON API stays the only interface. A build check fails above 40 KiB gzip for the entry
  script or 80 KiB in total (now 24 and 35).
- **Strict requests:** every route declares a JSON schema; unknown fields and wrong types are refused without
  coercion. A malformed field earns the same stable code as the field out of range (`invalid_months`, …); anything
  else is `invalid_request`. Origin, session, role and step-up are checked before the body is validated.
- **Idempotent writes:** a payment carries a `requestId` generated once per form fill and stored as
  `external_id = manual:<id>`; a replay returns the original and is not audited again. `recordPayment` locks the shop
  row before its replay check, so parallel deliveries (dashboard or webhook) cannot both pass it. A till-limit change
  names the value it replaces (`expected`) and is refused `stale` if it moved.
- **Step-up:** removing a shop, issuing an owner-recovery code, changing one's password and every operator change
  need the password and a fresh authenticator step from the last 5 minutes (`POST /admin/api/session/confirm`,
  `admin_sessions.confirmed_at`). Failures count toward the sign-in lockout.
- **Operators in the dashboard:** admins create operators (generated password and authenticator QR shown once),
  change roles, deactivate, reactivate, unlock and reset authenticators. Nobody changes their own account there, and
  the last active admin can be neither demoted nor deactivated (active admin rows are locked first). Every operator can
  list and end their own sessions and change their password.
- **Chained audit log (server migration `0010_audit_chain`):** a `BEFORE INSERT` trigger takes a transaction advisory
  lock, links the entry to the previous one by `seq`, and stores `hash = sha256([prev_hash, at (UTC, µs), admin_id,
  username, action, target, address, detail])` (`kolo_audit_hash`). The database does it, so CLI, dashboard and direct
  inserts chain alike. Existing entries were chained in ID order by the migration.
- **Consistency checks** (`GET /admin/api/integrity`, summarised on the overview): the audit chain recomputes and is
  gapless; each shop's payments chain (dates compared to the millisecond, as they pass through JavaScript) and its
  paid-until is the last one's end; no till waits while a place is free; no sync session survives a suspension or
  removal; nothing removed waits more than two hours past its purge date.
- **Background refreshes** send `x-kolo-poll: 1` and do not keep a session alive, so an unattended dashboard still
  signs out after 30 idle minutes.

## Consequences

- The chain detects edits and deletions made around the server (the append-only trigger already refuses them through
  it). It does not stop a database superuser rewriting the whole chain or dropping its newest entries; the dashboard
  shows the head's number and seal so an operator can note it and compare later.
- `POST /admin/api/shops/:id/payments` now requires `requestId`; there are no other API clients.
- Migration `0010` adds an index on `journal.received_at` (built in the migration's transaction; writes to the journal
  wait while it builds).
