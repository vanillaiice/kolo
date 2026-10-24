# ADR-039: Till limits per shop and trial days on codes

**Status:** Accepted, 2026-10-24. Amends [ADR-031](ADR-031-hosted-subscriptions-manual-billing.md).

## Context

Hosted plans need a till count the operator can sell and enforce, and a way to let a shop try sync for a few days.
Plan entries from 2026-10-21 fixed the scope. The server cannot see staff: users, roles and memberships travel inside
sealed facts (ADR-030). So a per-user limit cannot be enforced, and staff stay unlimited. What it can count is the
shop's trusted tills (`shop_devices`), which it learns from owner-signed `DEVICE_TRUSTED` / `DEVICE_REVOKED` facts.

A till also becomes trusted without the server: file pairing and same-Wi-Fi pairing (ADR-034) happen offline, and the
server only hears of the new till when the owner's till next syncs. The server cannot refuse a signed owner fact,
because the tills have already accepted it. So it can only refuse that till's sync.

## Decision

- **Limit.** `shops.max_tills` (1–1000, `NULL` = unlimited). Shops that existed before server migration `0008` are
  unlimited, so an upgrade never locks anyone out. A connection code may carry `max_tills`; the shop it creates starts
  with it. The dashboard and CLI set or clear it per shop, audited as `shop.till_limit`. The limit is enforced on every
  edition: the operator of a self-hosted server simply leaves it unlimited, which is the default there.
- **What counts.** Active, non-held tills of the shop. The server's own `SERVER` device never counts.
- **Held tills.** When a roster fact makes a till active (new, or trusted again after a revocation) and the shop is
  at its limit, the till is stored `held`. It cannot open a sync session (`till_limit_reached`, 403). Everything
  already stored stays, and it keeps trading locally. The check runs in the same transaction as the roster update,
  with the shop row locked, so two tills racing for the last place cannot both get it.
- **Freeing places.** Revoking a till, or raising or clearing the limit, releases held tills, oldest first, up to the
  free places. Lowering the limit below current use holds nobody: enrolled tills keep syncing, and new tills wait.
- **Early refusal.** Join by code (ADR-032) refuses `createJoin` and `enrollJoin` with `till_limit_reached` while the
  shop is full, so the owner learns it before the new till is set up. File and local pairing cannot be refused, so
  those tills are held as above.
- **Owner recovery** (ADR-036) is exempt. An operator-issued recovery code attaches the restored owner device even
  when the shop is full, because the lost tills usually still count until the owner revokes them.
- **Plan endpoint.** `GET /plan` (signed-in till, also while sync is paused) returns `{ max_tills, tills }`. It is a
  new endpoint because existing tills parse `/entitlements` strictly and would reject an added field. Tills record
  it beside the hosted service status (client SQLite migration 33, display only) and show "Your plan allows N tills
  (M in use)". A server without the endpoint is ignored.
- **Trial days.** A code may include `included_days` (0–90) as well as `included_months`. When the code creates
  the shop, they are recorded together as one `code` payment, which moves `paid_until` by both. Manual and webhook
  payments stay in whole calendar months. `payments.days` records the days; `months` may now be 0 for a code
  payment that carries days only.

## Consequences

- The limit counts tills, not people or devices of a kind; a phone and a computer count the same.
- A till paired offline at a full shop learns about the limit only when it first tries to sync. Its error names the
  limit, and it keeps working locally.
- Old tills see `till_limit_reached` as an unknown sync error code until they update. The refusal itself still works.
- The dashboard must ask for a limit or "unlimited" when issuing a hosted code. Nothing picks a commercial
  default for the operator.
