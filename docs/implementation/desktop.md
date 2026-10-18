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

Installer tooling and Windows acceptance automation are now provided; passing Windows
evidence remains required. Physical hardware testing is deferred. See
[desktop release](desktop-release.md). A browser app, browser storage/credentials and authenticated
business HTTP API do not exist. The Fastify server still supplies health/readiness/capabilities.

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

## Forgotten codes and replacing the shop

The locked screen offers "Forgot your code?" for owner recovery with the saved recovery
key. When neither the code nor the key is available, **Import a backup** replaces the
computer's shop (see "Desktop entry flow"). Legacy installations can import a backup or
start a new shop, which confirms the displayed name (`KOLO` when none is configured) and
activates a migrated empty slot. Existing files and credential records stay separate and
protected; neither path unlocks or modifies the old shop.
The command is refused while unlocked and must be used after locking. Durable slot
activation and single-flight identity handling reuse the restore/pairing infrastructure.

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
work/signing, then closes SQLite. Renderer loss/reload and application close always lock
the running session.

**Stay signed in** (Settings, on by default per user decision 2026-10-09) lets a cold
boot reopen the last unlocked user without a code. Unlock saves a remembered member
(business, user, current credential reference) only in the OS-protected vault under
`userData/session`; the on/off flag is a plain file there. Core `resumeWorkspace`
reopens it only if the business, device and member are active, the member is not
locked out and the credential reference is unchanged, so a code reset, owner recovery,
restore or pairing makes it stale; a stale or unreadable record is forgotten and grants
nothing. While on, minimize and OS screen lock/suspend do not lock. The **Lock** button
and owner recovery forget the remembered user; turning the option off forgets it and
restores locking on minimize, OS lock/suspend and cold boot. Anyone with access to the
computer's user account can open a remembered till, so it should be off on shared PCs.

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
never balances. A whole-sale discount (`discountMinor`) needs `sales.discount`, is taken
before settlement, may not exceed the subtotal and is part of retry identity; receipts
show it. Per-line discounts and price overrides are not offered on desktop.

Customers are created with a stable request ID and edited/archived from their displayed
version, as products are. Archived customers cannot buy or pay. A payment's request ID is
its ledger entry ID; paying more than is owed leaves the customer in advance. Statements
are newest-first, bounded and signed (sales positive, payments negative).

The till offers **Set as debt** with a labelled money-received field (zero means no
payment), and **Pay now** with split payments. A selected customer's prepaid balance
reduces the automatic amount to collect. Posting a sale to the account consumes an
advance before adding debt; no cash movement is invented for the credit used. The
preview, receipt and statement distinguish credit used, new debt and the resulting
signed balance. Customer statements also show the originating receipt, full sale total
and money received at checkout; receipt history shows total, received and posted to the
account. Receipt account balances use the same chronological ledger order as statements
and require `customers.view`. They describe that sale, independently of later payments.
The optional `expectedCustomerBalanceMinor` checkout hint rejects a new command with
`request_conflict` if the displayed balance changed, but matching saved retries still
return the original sale. The till refreshes the selected balance after a conflict.

The pairing panel defaults to local QR joins over the same Wi-Fi/hotspot, without
internet or a separate server (ADR-034). The owner shows a code, the phone scans it (a
new PC pastes the copied link), and the owner allows the named till. The desktop app
hosts only an authenticated join mailbox and encrypted direct exchange. Local access
stops on lock, shutdown or shop switch and resumes on the saved port while unlocked
if enabled. Both devices must stay on the same network; Windows may ask to allow KOLO
on the private network. The panel shows paired-device delivery status and can stop
local access. A new desktop can choose **Join a nearby shop** on its entry screen.

Connected-server joining remains under its own disclosure, and file pairing remains
available. Server connection/disconnection explicitly notifies the shell after
persistence. The join component survives read refreshes while its QR is active.
QR generation failures show a message and retain the short code/address as a fallback.

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

Edits cover name, unit, barcode, prices, main category, other categories (`otherCategoryIds`,
ADR-028) and low-stock level of an active product. Whole/fractional quantity is fixed after creation. Archived products cannot be
edited, sold, scanned or stocked until restored; archiving needs both edit and archive
authority, and price changes still need `products.price` inside core.

Manual stock uses `inventory.adjust` for additions (`ADJUSTMENT`) and damage/loss
(`DAMAGE`), each with a reason; the request ID becomes the movement ID, so a matching
retry records nothing and a changed one is refused. Supplier deliveries remain the
purchase workflow. Counts use `inventory.count`; the core `countStock` request ID names
the movement and the local audit, so a retried count returns its original difference
and never recounts against sales recorded after it, including counts that matched the
shelf and moved nothing. History is newest-first and bounded under `inventory.view`.

## Suppliers and purchases contract

A purchase receives up to 200 distinct active products at whole-franc unit costs, with an
optional supplier and delivery reference. It needs `purchases.create`, plus
`purchases.pay` when a single door payment is taken from one account. Any unpaid
remainder is owed to the named supplier; without a supplier the delivery must be paid in
full. Stock, cost, payment, payable, event and audit commit together. A retry matches on
actor, supplier, reference, line set and door payment (found through the purchase
event's claimed account movements, since door payments carry no purchase reference).
Supplier details, archive and payments follow the customer pattern; supplier statements
show purchases on credit positive and payments negative. Feature commands live in
`electron/purchasing.ts` behind the small `Host` interface in `electron/host.ts`.

## Accounts and expenses contract

Accounts list derived balances under `finance.accounts.view` plus `cash.view`; creation,
renaming, re-kinding and archive need `finance.accounts.manage` and follow the versioned
pattern. Money in/out and two-leg transfers need `cash.move`, carry a reason, and use the
request ID as the (outgoing) movement ID so retries never move money twice; actors without
balance authority get the account without a balance. A count compares expected and
counted amounts and records audit only (`cash.count`). A correction (`cash.count`,
`cash.reconcile`, `cash.move`) passes its request ID to core `adjustCashToCount`, which names
the adjustment and audit, so a retried correction returns its original result instead of
correcting again after later movements. Expenses (`expenses.create`) use the request ID as
the expense ID; "Other" requires a description. An expense is reversed once by an equal
negative entry naming it; reversals cannot be reversed. Core data-layer validation errors
(for example `ExpenseError`) are reported as `invalid_input`, not `storage_failed`.
Commands live in `electron/finance.ts`.

## Tax, payment terms and alerts contract

ADR-033. `taxSettings` (any member) and `updateTaxSettings` (business.settings), `productTax`/`setProductTax`
(products.view/edit), `paymentTerms`/`setShopTerms` (business.settings), `creditStatus` and `setPartyTerms`
(customers.* or suppliers.*), `notifications` and `markNotifications`. Edits name the version they were made from: an
identical retry returns the stored value and a newer stored version is refused with `request_conflict`. Checkout no
longer chooses a tax rate; core stamps the rate in force on each line. Settings shows the tax and terms panels to
business.settings holders and a per-computer switch for system notifications. Product, customer and supplier details
show the product's tax rule and the party's due dates. Receipts print one "incl." line per rate and the tax number;
Reports adds "Tax collected". The topbar's Alerts button lists the member's alerts and opens the screen that resolves
each one. The renderer rereads them on every change and every five minutes, and raises new unread ones once through the
web Notification API (native Windows/Linux notifications in Electron), then marks them announced. Commands live in
`electron/settings.ts`.

## Reports contract

`report` takes a report kind and a period `[from, until)` of ISO instants that the UI
derives from local calendar days with the shared `localDayPeriod` rule (empty or
decade-plus periods are refused). Each kind is read through the existing core report
function under its own permission: summary/profit/cash flow/stock value under
`reports.financial`, sales breakdowns under `reports.sales`, best sellers and stock alerts
under `reports.inventory`, customer debts under `reports.customers`, purchases and
supplier debts under `reports.suppliers`. Results are serializable and row lists are
capped at 500 (stock alerts at 100) with a `truncated` flag; totals stay exact. Report and
analytics assembly lives in core `application/report-views`, shared with mobile. The
Reports section shows stat tiles and tables only. Commands live in `electron/reports.ts`.
`KOLO_DESKTOP_SMOKE_REPORT_SCREENSHOT` optionally saves the fixture summary screen.

## Analytics contract

`analytics` takes a period `[from, until)` like `report`, the shop's local offset in minutes
east of UTC (at most ±840) and an optional bucket (`hour`, `day`, `week` from Monday,
`month`; defaulting to hours up to two days, days up to about two months, weeks up to about a
year, months beyond, and at most 1,000 points). It requires `reports.sales`. Sections the
actor cannot read are left out rather than failing the view: KPI profit, expenses, net
result and per-point/per-product profit need `reports.financial`; top customers need
`reports.customers`. `previous` is the equal-length period just before, for deltas.

Figures come from core `data/reports/analytics.ts` over the same lines and returns as the
reports: a trend summed over its buckets equals `profitBetween`; product figures are net
of bill discounts (allocated per line as returns refund them) and of returns, and sum to the
period's revenue; busy hours count sales where they were rung up;
top customers are named customers only. The Analytics section (Recharts) shows KPI tiles
with deltas, a revenue/profit line chart, a weekday × hour heatmap, best-seller bars,
category and payment-method donuts (five slices plus "Others") and a customer table;
each chart has a figures table or legend table as its accessible twin. Commands live in
`electron/reports.ts`.

## Operation journal contract

`journal` reads one newest-first page (1–200 entries, default 50) of the operation journal under
`audit.view` (spec §39). Filters are all optional: a period `[from, until)` as ISO instants, a
member `actorId`, a `deviceId`, a family `group` (`sales`, `purchases`, `stock`, `money`,
`catalogue`, `people`, `staff`, `devices`, `settings`, `other`), a record `subjectId` (every fact
naming it: a product's saves, sales and counts), and the `after` cursor from the previous page.
Unknown fields, non-UUID IDs and malformed instants are refused.

Entries come from core `application/audit`, shared with mobile: the signed event journal (this
till's facts and every other till's once synced, with the member and device that made them and,
for a fact held back, its application status), plus the checks only this till records because
they changed nothing (a cash count, a correction or stock count that matched). Summaries carry
codes and figures, never key material; a product save shows the previous price and cost when
they changed. Owners and accountants hold `audit.view` by default; an owner can grant it to anyone
else (for example a manager who is a shareholder). The Journal section filters by days (with
Today, 7 and 30 days, All), member, device and type; choosing a record narrows to its history.
Commands live in `electron/reports.ts`.

## Product photos and large files

`setProductPhoto` takes a product ID and the bytes of a WebP or JPEG (at most 64 KiB and
512 px a side) under `products.edit`; the renderer crops to a 320 px square WebP with EXIF
orientation applied and metadata dropped. `ProductView.photo` is the photo's SHA-256;
`productPhoto` returns a data URL (the CSP allows only `data:` images); `removeProductPhoto`
and `photoUsage` complete the set. `invalid_photo` and `photo_storage_full` are the failures.
`saveBackup` takes `includePhotos` (default true). `setLargeFiles` (owner, business.settings)
switches this computer between the standard and large transfer profiles and photo limits;
`sessionPreferences` reports `largeFiles`. See [ADR-027](../adr/ADR-027-large-files-and-product-photos.md).

## Returns contract

Sale returns need `sales.refund`; purchase returns need `purchases.create` and
`purchases.pay`. The UI reads returnable lines and remaining quantities, previews the exact
value with core `previewReturn`, then records against the predecessor (`priorId`) it was
shown. A return recorded meanwhile is refused as `stale_return` with a reload, never
double-returned. The refund (one account) is at most the value and at most
`ReturnSourceView.refundableMinor` (what the original settled (sale payments, or a
delivery's total less what it left owing) less earlier refunds), so cash never changes hands
for goods that were not paid for; the remainder is credited to the customer or deducted from
the supplier debt, and without a counterparty the refund must cover the whole value. The request ID names the return; a retry matches kind,
original, reason, item set and refund set. Core `ExchangeError` codes are translated to
desktop failures. Receipts show returned value. Commands live in `electron/returns.ts`.

## Staff contract

The Staff section lists members with effective permissions (role defaults plus grants
minus revocations) under `users.view`. Only the owner changes staff; core rechecks owner
authority. Member creation and code replacement run through the native vault and are
single-flight with setup/unlock. Core draws member identities, so a retried creation is
recognised by name: a member with the same name (case-insensitive) is refused as
`request_conflict` instead of duplicated. Grants/revokes and suspension requested for the
current state change nothing; the owner cannot suspend themselves or replace their own code
here (owner recovery stays on the recovery-key flow). Commands live in `electron/staff.ts`;
permission labels are copied from the mobile keyed strings.

## Backup, pairing and exchange contract

Native open/save dialogs run in the main process (`transfer-files.ts`); paths and file
contents never cross IPC. Opening a file checks it and keeps one host-side staged file
(backup preview, invite, pairing request or exchange bundle); checking another, discarding,
or locking (for session-bound kinds) forgets it, and staged backup snapshots are discarded.
The renderer only sees previews: shop/owner/date/operation counts, fingerprints, pairing
codes and bundle assessments. Saving reports `saved:false` when the user cancels.

Owner commands (`business.settings`): encrypted backup; restore over this shop (typed shop
name, new local code, owner session as recovery context); pairing invite with fingerprint;
checking a new till's request and approving it with the compared code into an enrollment
file; exchange files per destination, import with preview, import receipts both ways,
retrying deferred events and localized diagnostics. Without a session an empty
installation can restore a backup or join a shop (check invite, accept with the typed
fingerprint and a new code, then complete with the activation file and code), or cancel an
unfinished pairing. File work is single-flight with setup/unlock.

Restore and pairing completion activate a new database slot. The main process migrates it,
creates a new `DesktopApplication` serving it, routes IPC to it (handlers resolve the
current application lazily), notifies the renderer, then disposes the old application and
closes its database after the activating command answers. The previous workspace file is
kept on disk. The new shop opens locked. Core `TransferError`/`ExchangeError` codes become
bridge failure codes with localized messages. Commands live in `electron/transfer.ts`.

## Receipt printing

Saved receipts print through the operating system's print dialog (`window.print()`), so
any printer with an OS driver works, including thermal printers. A print stylesheet prints
only the receipt at 72 mm with the shop name, hiding actions and app chrome. The workflow
smoke renders the receipt to PDF through the same stylesheet. Direct ESC/POS printer
adapters, cash-drawer kick and paper-width settings are not implemented.

## Remaining F5 work: acceptance, not software packages

The planned desktop software packages are implemented. F5 stays open for acceptance that
cannot be proven from Linux Node/Electron runs:

- Windows: run the supplied NSIS/portable build and installed upgrade/native-vault
  acceptance jobs; verify signing and the manual installer update procedure. Install the
  Microsoft Store package from a Partner Center submission and run a shop day; its data lives
  in the package's virtualized `%APPDATA%` (see [releasing](../releasing.md#microsoft-store-windows)).
- Hardware: physical barcode scanners and receipt printers on shop PCs; optional ESC/POS
  adapter and cash drawer if the user wants them.
- Measured startup/search/report/memory budgets on target hardware, crash/close recovery
  drills, keyboard/focus/screen-reader passes.
- Cross-device exchange with Android/Windows tills (desktop-to-desktop is covered).

The shared operations, strict event schemas, exact arithmetic and SQLite accounting
fixtures are reused. React Native screen components require a DOM UI implementation;
keep business calculations out of those new components.

## Current priority and browser scope

On 2026-10-09 the user selected packaging, Windows credentials, crash/recovery,
performance/accessibility and documentation work, then mobile. Physical hardware and
cross-device acceptance are deferred. Bluetooth and optional paid-server sync remain
shared roadmap work, independent of standalone operation.


The user confirmed desktop first, with reusable React UI for a later browser version.
Build DOM UI components against a narrow platform service interface; the Electron
adapter invokes the allowlisted preload bridge. This decision changes implementation
order and UI boundaries, and does not claim browser support.

A browser release requires its own storage/identity boundary or an authenticated
server business API. It cannot use the Electron preload/Node SQLite/OS-vault adapters.
Choose that product/runtime explicitly before promising browser offline operation or
moving business writes to a server. Keep standalone desktop behavior independent of
this later choice.

### Safety copies

One computer holds one shop. Replacing it (importing a backup over it, or starting a new
shop from a legacy till) only moves the durable active-database pointer: the previous
database and its credentials stay on disk as a safety copy. The entry screens do not list
safety copies; `savedShops`/`openSavedShop` remain in the bridge for support recovery.

### Desktop entry flow

One shop per computer, three tasks (user decision 2026-10-09):

- **New computer:** *Create a shop* (two steps: shop details, then owner access; details are kept when going back and till/cash names have defaults) or *Import a file*.
- **Computer with a shop:** the login (user and code; "Stay signed in" skips it), *Forgot your code?* (recovery key), and *Import a backup*.
- **Import:** one native dialog (`chooseImportFile`) reads the file and recognizes a backup or a pairing invite by its structure; the next `openBackup`/`openInvite` uses that file without asking again. A backup asks for its password, shows the shop, then the typed shop name and a new code for this computer. An invite continues with the joining steps and needs a computer without a shop. Over an existing shop, the confirmation names the shop being replaced; `restoreBackup` requires `replace: true`, validates the new code before switching, moves the current shop aside as a safety copy, restores into a fresh slot, and selects the previous shop again if the restore fails.

Saved-shop pickers and "start a new shop" on the login page were removed. Adding another till is started by the owner from Backup & devices.

The welcome screen presents three explained choices: create a shop, restore a backup file, or join another till’s shop. Retained shops appear alongside these choices and open with their original code. New setup has two steps (shop details, then owner access), keeps details when going back, and supplies default till/cash account names under an optional customization section. Login names the selected shop, groups the user/code fields together, and keeps shop switching in the side panel. Owner-code recovery explains the saved recovery key and returns to login with a confirmation after replacement. Backup and joining screens share the same desktop task/guidance layout and explain their file requirements before opening native pickers.
