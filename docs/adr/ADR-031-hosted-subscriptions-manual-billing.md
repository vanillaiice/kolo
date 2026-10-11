# ADR-031: Hosted subscriptions with manual billing

Date: 2026-10-11. Status: accepted by the user and implemented (F7 server part). Extends ADR-024 (licensing) and
ADR-030 (connection codes).

## Context

The plan's F7 adds paid hosted sync while keeping self-hosting free and never letting billing stop a till. The payment
provider and pricing were open. Shops in the target market pay mostly by MTN Mobile Money or Orange Money; no provider
account exists yet.

## Decision

- **Editions.** `KOLO_EDITION=selfhost` (default) never expires a shop. `KOLO_EDITION=hosted` makes each shop's sync
  depend on a paid-until date. One server image serves both.
- **One plan per shop.** A paid shop syncs any number of its tills. Periods are whole calendar months; prices stay out of
  the code (the amount is recorded as paid, in XAF).
- **Manual billing first.** The operator records each payment in the dashboard (months, amount, method — cash,
  MTN MoMo, Orange Money, bank, card, other — and a reference). A payment extends the shop from the end of its paid
  period, or from today if it had lapsed. A connection code may include paid months, recorded as a `code` payment when
  the shop attaches. Payments are append-only rows and audited in the same transaction.
- **Expiry pauses transfer only.** After the paid period, `KOLO_GRACE_DAYS` (default 7) of grace keep sync running;
  then push, pull, receipts and bootstrap answer 403 `hosted_service_inactive`. Sessions, `GET /api/v2/entitlements` and
  status still work, so a till can say why and until when. The server keeps every stored fact, tills keep trading and
  keep their facts, and the next pass after a payment delivers the whole backlog. Self-hosted servers never pause.
- **Provider later, without rework.** A provider-neutral webhook (`POST /internal/billing/webhooks/generic`, HMAC-SHA256
  of `<timestamp>.<raw body>` with `KOLO_BILLING_WEBHOOK_SECRET`, five-minute window) records payments idempotently by
  provider event ID. It exists only on hosted servers with a configured secret. A specific provider (Notch Pay,
  CinetPay, Campay…) is one more `BillingAdapter`, or a small relay that re-signs its callbacks in this format.

## Consequences

- Server migration `0004_hosted` (shop paid-until, code months, append-only `payments`); client migration 27 stores the
  last reported service status so tills warn during grace and explain a pause.
- Self-hosting needs no account, licence check or telemetry; the AGPL terms of ADR-024 apply unchanged.
- No online check ever gates local trading, startup or local data.
- Not built: reminders to owners before expiry, subscription invoices, and refunds or corrections. Payments only extend
  a shop; a mistaken entry is offset by recording less next time, and the audit log keeps both.
