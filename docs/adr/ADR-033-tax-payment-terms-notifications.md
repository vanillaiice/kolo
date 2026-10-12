# ADR-033: Tax included in prices, payment terms and local notifications

Date: 2026-10-12. Status: accepted by the user (choices "prices include tax", "payment terms in days", "in-app +
desktop system notifications", all four first notification kinds) and implemented.

## Context

The MVP had a per-product `tax_rate_basis_points` column and a per-line rate carried by `SALE_COMPLETED`, but nothing
set or used them (both apps wrote 0). Customer and supplier debts had no due dates, so "overdue" could not be said.
Low stock, debts and sync state were only visible to someone who opened a report (spec §49 asks for notifications).
Mixed-version tills must keep converging: v2 payloads are strict, so a new field on an existing event would quarantine
it on an older till, while an unknown event type is kept "unsupported" and applied after the upgrade.

## Decision

### Tax (VAT/TVA) is included in prices

- **Prices are tax-inclusive (TTC).** What the customer pays is unchanged; tax is a breakdown of it. Sale, payment,
  debt, return and report totals and their shared arithmetic are untouched, so older tills still agree on every total.
- **Shop tax settings** (`TAX_SETTINGS_SET`, last write wins, `business.settings`): enabled, label (e.g. "TVA"),
  standard rate in basis points (1925 = 19.25 %), optional registration number (NIU) printed on receipts.
- **Product tax rule** (`PRODUCT_TAX_SET`, last write wins per product, `products.edit`): `STANDARD` (the default when
  none is stored), `EXEMPT`, or `RATE` with its own rate. The legacy product column stays untouched; a non-zero legacy
  value with no rule counts as `RATE`.
- **Rate frozen at sale time.** The authorized sale operation stamps each line with the effective rate (0 when tax is
  disabled), ignoring a caller's value; replicas keep the rate carried by the event. Changing a rate never rewrites
  history.
- **Arithmetic.** Lines are reduced by their own discount and their deterministic share of the bill discount
  (`discountedLineTotals`, as returns use), grouped by rate, and the tax of a group is
  `amount × rate / (10000 + rate)` rounded half away from zero, exactly in BigInt. Receipts show one line per rate.
  The tax report groups a period's sales net of returns by rate and rounds once per rate; it can differ by a few
  francs from the sum of rounded receipts, which is the usual per-period VAT computation.
- **Not in scope:** tax added on top of prices, input VAT on purchases, tax-adjusted profit (profit stays gross of tax
  and says so), filing exports.

### Payment terms in days

- `PAYMENT_TERMS_SET` (last write wins per key): party `CUSTOMER` or `SUPPLIER`, optional party ID (absent = the shop
  default), days 0–3650, or `null` on a party to fall back to the shop default. Defaults require `business.settings`,
  a customer `customers.manage`, a supplier `suppliers.manage`. With nothing stored the shop default is 30 days.
- **Due dates are derived, never stored on immutable ledgers.** Payments, returns, write-offs and negative adjustments
  settle the oldest debt first; each remaining debt (credit sale, purchase, opening balance, positive adjustment) is due
  at its occurrence time plus the party's terms. Overdue = remaining debt past due; "due soon" = due within 3 days.
  The remaining debts are exactly the newest debts that cover the balance, which keeps the query bounded.

### Notifications

- **Derived, local and permission-scoped.** `application/notifications` computes the current list from local data;
  nothing is synced. Kinds: low or negative stock (`inventory.view`), overdue customer debt (`customers.view`), supplier
  balances overdue or due soon (`suppliers.view`), an unresolved cash count difference on this device (`cash.view`),
  and sync trouble (`business.settings`): a refusal that will not fix itself, hosted grace/pause, or no successful pass
  for 24 hours while facts wait to be sent. Being offline alone is normal and is not a notification.
- Each notification has a stable key and a fingerprint of its facts. Per-device, per-user read and announced marks
  (migration 28, `notification_state`, cleared from snapshots) make a changed fact unread again.
- **Delivery.** Desktop and mobile show an in-app list with an unread count. The desktop main process also raises
  Windows/Linux system notifications for unannounced items while a user is signed in, switchable per computer.
  Android raises them through `expo-notifications` (local notifications only, no push service) while KOLO is open,
  with a per-phone switch; a tap opens Alerts. There is no background task, so a closed app raises nothing.

## Consequences

Migration 28 adds `shop_tax_settings`, `product_tax_rules`, `payment_terms` and `notification_state`. Older tills keep
the three new events unsupported until upgraded; meanwhile they still record sales, at rate 0 because they lack the
settings, and those sales show no tax. Cash count differences are local audit facts, so only the counting device
raises that notification; the correction itself still syncs.
