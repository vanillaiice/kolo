# Mobile operations

The Expo app was reorganized on 2026-10-10 to reach parity with the desktop's business
capabilities on a small screen. SQLite and the shared core operations stay the foundation;
the [parity checklist](mobile-parity.md) maps every desktop action to its mobile screen.
Installed Android acceptance (F1/F3/F4 and the parity checks) has not run.

## Structure

- `app/App.tsx` owns boot, the active database and the lock lifecycle. Every unlock starts a
  session **generation**; `SessionProvider` is keyed by it, so lock, actor change and database
  replacement unmount screens, drafts, subscriptions and previews together.
- `app/session.tsx` exposes the session, `useRevision` (frozen while a screen is hidden),
  `usePermissions` and `useDraft` (backed by `app/draft-store.ts`).
- `app/navigation*.ts(x)` and `features/shell` provide four destinations (**Sell, Products,
  Activity, More**) as stacks (list → detail → action). Phones use a bottom bar; from 600 dp
  (adjusted for font scale) a side rail with list/detail side by side. Hidden stack screens stay
  mounted (search and scroll survive) but do not query. Back closes a sheet, pops the stack with a
  discard confirmation for edited forms, returns to the landing destination, then leaves the app.
- `components/theme.ts` translates the desktop tokens (light and dark); `components/ui.tsx`
  holds the shared primitives (screen header/footer, buttons, fields, rows, notices, segmented
  choices, searchable picker sheet, confirmation dialog, bounded paged list, stat tiles).
- Language and appearance (system/light/dark) live in the device preference database, outside
  backups and events; both are available before setup.

## Session and lock contract

**Stay signed in** (Settings, on by default, as on the desktop; user decision 2026-10-10): the
phone does not lock in the background and a cold boot reopens the last unlocked user without a
code. Unlock saves the remembered member (business, user, credential reference) only in the
Android keystore; the on/off flag is a device preference. Core `resumeWorkspace` reopens it only
if business, device and member are active, not locked out and the credential reference is
unchanged, so a code reset, owner recovery, restore or pairing makes it stale; a stale or
unreadable record is forgotten and grants nothing. **Lock** forgets the remembered user, and
turning the option off forgets it and restores locking on background and cold boot. Anyone with
the phone can open a remembered till, so turn it off on shared phones.

With the option off, leaving the app locks it at once. Android screens KOLO opens itself through
`session.systemUi` (file and photo pickers, share sheet, print dialog) count as staying in the app
and never lock, with no time limit (user decision 2026-10-10). A result that returns after a lock
or session change is refused (`locked`), and the actor must still be active. Unsigned events are sealed after commits (coalesced, single-flight) with a
60-second recovery retry, instead of the previous three-second loop.

## Workflows

- **Entry:** Create a shop (shop details, then owner access; default till/cash names with an
  optional customization; the recovery key needs an explicit acknowledgement) or Import a file,
  recognized from its structure (`@kolo/core/backup/file-kind`) as a backup or pairing invite.
  A shop on the phone offers unlock, owner recovery and backup import. Replacing a shop names it
  and needs typed confirmation; the restore goes into an empty stage bound to the current slot
  (`SlotControl.alias`), so the active pointer moves only on success. Pending setup, pending
  joining and legacy migration remain recoverable steps.
- **Selling:** product selection (exact barcode on Enter with unknown/archived feedback, debounced
  name search, category filter, cart bar), cart (quantities, customer, permitted discount) and
  payment (cash with change calculation, split across named accounts, credit naming who owes).
  The draft carries stable sale/event/credit IDs: a repeated tap resolves to the recorded sale;
  failure keeps the draft; success clears it and opens the receipt reread from SQLite.
- **Records:** product detail/edit/archive with version checks (`changedMeanwhile`), a main
  category plus other categories (ADR-028), stock
  additions, damage, opening stock, counts and history, photos; categories; customers and
  suppliers with statements, collections and payments; purchases in three steps with door
  payment and supplier debt; accounts with money in/out, transfers, count comparison and an
  explicit reasoned correction; expenses with compensating reversal; returns through quantities,
  preview, refund bounded by what was settled, confirmation, and reload on a stale predecessor.
- **Reports and analytics:** every desktop report kind and the analytics view come from core
  `application/report-views` (shared with desktop), bounded to 100 rows (50 for analytics lists)
  with exact totals. Phones show KPI tiles first and open trend, busy hours, product ranking,
  category/payment shares and top customers on demand; every chart has a figures table.
  Expensive reads run after the screen paints (`useDeferredRecord`).
- **Photos:** `data/photos/photos-on-device.ts` uses Android's square crop, then native decode,
  orientation, centre crop, 320 px resize and WebP re-encoding; only the final file, checked
  against 64 KiB, is read into JavaScript. Thumbnails use batched digests and a session LRU cache.
- **Backup & devices:** separate screens for backup (photos optional), restore, recovery key,
  adding a till, sending and receiving changes, confirmations both ways, and exchange status with
  deferred retry and diagnostics. Mobile stays on the standard transfer profile.
- **Receipts:** OS share (text) and Android printing/PDF (`expo-print`) from saved facts;
  cancellation never changes the sale. Direct thermal-printer adapters remain hardware work.
- **Staff:** effective permissions by group, grants/revocations, suspension, code replacement;
  editing is limited to the owner on a device whose pairing allows staff management.

## Read/refresh contract

Queries take the current opaque context and recheck authority. Lists are bounded (30 rows per
page, at most 10 pages loaded) and re-read their loaded pages after a commit so position is kept.
Search uses the FTS5 word index (migration 24) beside name prefixes and exact barcodes;
statements show the running balance. Core additions for mobile: `application/records` single-record reads, `stockLevels` and
`productPhotoDigests` batch reads (≤ 100 IDs), a product `categoryId` page filter, and
`product_photos` commits now invalidate the `products` domain.

## Verification

`npm run test -w @kolo/mobile` covers preferences, localization, file recognition, drafts,
destination rules, failure mapping, edit versions and receipt output; core tests cover the new
reads and report views. `npm run benchmark:mobile:host` builds the large fixture (10 000
products, 100 000 movements, 2 000-entry statement and event backlog) and times the core calls
on the host: a baseline, not an Android measurement. Rendering, native pickers, printing,
keystore, scanners, TalkBack and device performance need the installed procedures in
[F4 native validation](f4-native-validation.md) and [mobile parity](mobile-parity.md).
