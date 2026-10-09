# Desktop implementation (F5)

## Priority and current state

User direction on 2026-10-06: prioritize desktop/web before further mobile work so
that the operational implementation can be established and tested on a PC first.
F4 software remains available; its Android device/hardware acceptance stays open.
Desktop implementation does not depend on completing those mobile acceptance gates.

The existing desktop uses React/Vite inside Electron. It currently opens a migrated
local SQLite database, selects the active business file, enforces one running instance,
and exposes installation status through an isolated preload. Credential/signature,
encrypted file and snapshot/restore adapters exist. Linux runtime smoke checks cover
boot and OS-vault backup/restore; installed Windows acceptance remains open.

The first desktop workflow is implemented: standalone setup/pending recovery, local
unlock/lock/owner recovery, product creation with optional opening stock, paginated
catalogue and stock, keyboard barcode entry, fractional cash checkout and saved receipt
history. The catalogue work package adds product detail editing, archive/restore,
categories, manual stock additions, damage, shelf counts and stock history. Checkout now
splits payments across accounts and puts balances on customers, with a customer section
for details, payments and statements. The React DOM screens depend on a replaceable `ShopService`; only the entry
point chooses the Electron preload adapter. French/English UI is keyed. The till draft
and product-entry drafts stay mounted while navigating and clear on lock/session change.

Discounts, suppliers and purchases, finance, reports, returns, staff
screens, backup/exchange screens, printers and installers remain to be implemented. A browser app, browser storage/credentials and authenticated
business HTTP API do not exist. Nest still supplies health/readiness/capabilities.

## First usable desktop milestone

Implemented software for the first offline workflow:

1. Named, runtime-validated commands/queries in the main process. Keep the current
   opaque operation context there; validate the caller frame and every request, and
   return sanitized result/error objects. Expose no SQL, filesystem paths, secrets,
   caller-controlled tenant or generic IPC. Business authorization remains in core.
2. Fresh setup, pending-provisioning recovery, unlock/lock and owner recovery screens
   using existing local identity and native credential ports. Restart always boots
   locked. Guard asynchronous credential work against close/lock and actor changes.
3. Product creation/list/search and stock visibility, account selection, keyboard
   barcode entry, cart and cash sale using shared exact rules/application commands.
   Give each submission a stable identity and prevent duplicate checkout on retries.
4. Saved receipt/history and bounded local refresh after committed writes. Preserve
   cart drafts during navigation and discard them on lock. Failures preserve drafts;
   saved receipts are reread from SQLite rather than fabricated from transient values.
5. Real SQLite operation/IPC-boundary tests and actual Electron workflow smoke: fresh
   setup, add product, sell, reopen, unlock, verify receipt/stock/cash. Cover malformed
   calls, locked/revoked actors, foreign IDs, rollback and interrupted provisioning.

Acceptance: a user can create a shop, sell offline, inspect the saved receipt, restart
and verify the same facts through the desktop UI. The actual Linux Electron/OS-vault
DOM workflow and separate real SQLite boundary/failure cases pass. This establishes
the first usable software slice, not Windows/installer/hardware acceptance or the
whole desktop edition.

## Command and refresh contract

`ShopService` is defined in `apps/desktop/src/shared/service.ts`. Named preload methods
map to an explicit main-process handler allowlist. Every call must originate from the
expected local main frame/webContents; object fields, primitive types, identifiers,
array sizes and bounded page cursors are validated before native/database work. No
renderer request chooses a tenant, actor context, event identity, SQL or file path.
Legacy `getStatus()` remains a public diagnostic read. Results expose stable error
codes; raw native failures and secret/key references never cross the bridge.

The host holds the real opaque unlock context. Protected requests include the displayed
session marker, which must still match the current host session. Core commands/queries
recheck current membership and permissions. Setup/unlock/recovery work is single-flight;
lock cancels pending proofs. Shutdown invalidates authority, waits for pending native
work/signing, then closes SQLite. Minimize, OS screen lock/suspend, renderer loss/reload
and application close lock the desktop. Cold boot always starts locked.

Product creation and optional opening stock commit together. A matching creation retry
uses its stable product ID; changed/cross-actor/cross-origin/foreign existing records
are refused. This is a creation endpoint, not product editing. Cash checkout binds
current product snapshots, prices, account, actor/shop/branch and host-generated events
inside the transaction. Whole-unit fractions and stale prices are refused; negative
stock is retained. Stable sale IDs and immutable line/payment facts distinguish matching
retries from changed requests, including across restart. Creation permission is rechecked
on every retry, while revoked receipt-view permission does not duplicate a saved sale.

Checkout takes up to eight payments, one per active account of any kind, and an optional
active customer. Anything left unpaid goes on that customer's ledger: it needs
`customers.credit`, and a configured limit is enforced unless the actor holds
`customers.credit_override` (refused as `credit_limit`). Overpayment and credit without a
customer are refused; cash received and change due are computed in the till only and are
not stored. A retry matches on actor, lines, payment set (order-insensitive) and customer.
The legacy single `accountId` request still records the exact total in one cash account.
A zero-priced sale records no payment. Payment-account queries return names and kinds,
never balances. Sale discounts remain subsequent F5 work.

Customers are created with a stable request ID and edited/archived from their displayed
version, as products are. Archived customers cannot buy or pay. A payment's request ID is
its ledger entry ID; paying more than is owed leaves the customer in advance. Statements
are newest-first, bounded and signed (sales positive, payments negative).

Committed domain invalidations send no business data. DOM views reread current bounded
pages and drop obsolete async responses. Failed commands retain forms/cart. After an
ambiguous transport failure, the submitted draft freezes and retry uses the same ID
until its outcome is known. Receipts reread persisted historical facts. React holds
only the bounded view and transient drafts, with no second global business database.

Run `npm run smoke:desktop:workflow` to exercise the actual Electron DOM, preload, local
vault and SQLite using one disposable user-data directory across two processes. It
creates a shop, records product/opening stock, verifies repeated Enter-key scans and
restored input focus, retains product/cart drafts across navigation, sells fractionally, displays
the saved receipt, checks identical/differing retries and malformed calls, then reopens
locked and verifies unlock/receipt/stock. `KOLO_DESKTOP_SMOKE_SCREENSHOT` optionally saves
a fixture-only till screenshot. OS vault refusal remains a failure, never plaintext
fallback. The runner does not touch an existing business installation.

## Catalogue and stock contract

Product and category edits name the stored `version` they were made from. A request
whose content already matches the stored record succeeds without writing again (this is
how a retry after success is recognised); otherwise a different stored version is
refused with `request_conflict`, which the UI shows as "changed in the meantime, reload".
The host advances the version past the stored one, so a local edit wins locally under
last-write-wins even when this clock is behind the edit it replaces.

Edits cover name, unit, barcode, prices, category and low-stock level of an active
product. Whole/fractional quantity is fixed after creation. Archived products cannot be
edited, sold, scanned or stocked until restored; archiving needs both edit and archive
authority, and price changes still need `products.price` inside core.

Manual stock uses `inventory.adjust` for additions (`ADJUSTMENT`) and damage/loss
(`DAMAGE`), each with a reason; the request ID becomes the movement ID, so a matching
retry records nothing and a changed one is refused. Supplier deliveries remain the
purchase workflow. Counts use `inventory.count`; the core `countStock` request ID names
the movement and the local audit, so a retried count returns its original difference
and never recounts against sales recorded after it, including counts that matched the
shelf and moved nothing. History is newest-first and bounded under `inventory.view`.

## Remaining F5 packages

- Operational breadth: discounts, suppliers/purchases/payments, accounts/
  transfers/reconciliation, expenses/reversals, reports and sale/purchase returns.
- Local administration and recovery: staff/grants, backup/restore, pairing/file
  exchange and actionable import/conflict diagnostics through native dialogs.
- Desktop acceptance: keyboard/focus/accessibility, selected printer/scanner adapters,
  crash/close recovery, measured startup/search/report/memory behavior on shop PCs,
  Windows installer and protected storage, signing/update/recovery decisions.

The shared operations, strict event schemas, exact arithmetic and SQLite accounting
fixtures are reused. React Native screen components require a DOM UI implementation;
keep business calculations out of those new components.

## Browser scope

The user confirmed desktop first, with reusable React UI for a later browser version.
Build DOM UI components against a narrow platform service interface; the Electron
adapter invokes the allowlisted preload bridge. This decision changes implementation
order and UI boundaries, and does not claim browser support.

A browser release requires its own storage/identity boundary or an authenticated
server business API. It cannot use the Electron preload/Node SQLite/OS-vault adapters.
Choose that product/runtime explicitly before promising browser offline operation or
moving business writes to a server. Keep standalone desktop behavior independent of
this later choice.
