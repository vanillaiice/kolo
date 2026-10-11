# Implementation progress

## 2026-10-05: F0 foundations

Accepted standalone mobile/desktop, optional hosted/self-hosted server, shared TypeScript
rules, and event exchange. ADR-017–019 and the product specification record supersession.

Implemented in this change:

- npm workspaces and root dependency lock; strict shared TS configuration.
- Existing SQLite/domain logic and tests moved into `packages/core`; app-native Expo
  SQLite/keystore wiring stays in mobile. Existing financial behavior is preserved.
- Runtime-validated exchange envelope/bundle codecs with limits, tenant/duplicate checks
  and stable errors; trust/payload/signature verification remains planned.
- Electron local database/migration/persistence/status bridge and boot page scaffold.
- Nest HTTP liveness, real PostgreSQL readiness, honest capability advertisement.
- Development/self-host scaffolding, API/JSDoc generation, boundary/link checks and CI.
- Go server and prior mobile lock preserved under `archive`; historical guidance saved.
- Detailed F0–F9 plan and architecture/domain/identity/exchange/API/testing/upgrade guides.

### Verification

- `npm run check`: passed boundaries, all workspace typechecks, 534 tests
  (526 existing core, 5 contracts, 1 desktop persistence, 2 server unit/HTTP),
  generated API/link checks, and server/desktop builds. A later PostgreSQL test
  is gated by `KOLO_TEST_DATABASE_URL` in ordinary runs.
- `npm run bundle:mobile`: Metro Android export passed with the moved core.
- `npm run smoke:desktop`: actual Linux Electron boot, migrated SQLite and
  sandboxed preload IPC passed using disposable user data. This caught and fixed
  top-level ESM readiness deadlock; it does not prove Windows installers or full POS.
- Server image: clean root-lock install/build and reduced production runtime HTTP
  tests passed. Runtime installs 116 packages; its npm audit reported zero advisories.
- `npm run smoke:server`: image build and all 3 HTTP/config/readiness tests passed
  against a fresh private PostgreSQL container; disposable database/network cleaned up.
- `git diff --check`: passed. Changes remain uncommitted; existing source work preserved.

### Dependency follow-up

The full existing Expo/Metro dependency graph reports 26 production-tagged advisories
(19 high, 7 moderate) in the root audit; the full build graph reports 27 including dev.
These are not present in the server-only production graph. Resolve through SDK-compatible
upstream/patch updates and re-run native/Metro gates before mobile release. Do not apply
`npm audit fix --force` blindly: the audit suggested older Expo/React Native major versions,
which conflict with the accepted native SDK matrix.

### Platform limits

Android/iOS native storage/keystore and installed shop workflows remain unverified.
Windows installer, printing/scanners, backup encryption, pairing and Bluetooth are not
implemented/verified. CI workflow is written but has not run on GitHub in this change.

### Remaining work

F1 standalone setup/unlock and operation authorization; F2 pure rule extraction/journal/
payload schemas/authority signatures; F3 trusted file exchange/backup; F4/F5 complete
mobile/desktop screens and native tests; F6 Nest parity and real sync; F7 hosted/self-host
shipping; F8 Bluetooth; F9 packaged releases and maintenance gates.

Mobile still has remote-login/demo boot. Desktop is not a sales app yet. Nest cannot
ingest business events yet. No native Bluetooth/backup/signature implementation is implied
by schema parsing, and no installed-platform readiness is implied by TypeScript tests.

## 2026-10-06: F1 shared setup and local authority started

Implemented:

- Forward migration 15; migrations 1–14 remain unchanged. Setup intent, public
  installation identity/key references, local memberships, persistent retry state,
  composite membership/installation scope constraints and append-only local audit.
- Offline `createWorkspace`, `recoverWorkspaceSetup`, `currentInstallation`,
  `unlockWorkspace`, `lockWorkspace`, owner `grantPermission`/`revokePermission`.
  Durable native provisioning is a required injected port; passwords/private keys
  and verifier bytes are never stored in SQLite or bootstrap events.
- Setup recovers the native-secret/SQLite crash gap with reserved IDs, and refuses
  to relabel/adopt existing demo/server-enrolled shops. Upgrade retains legacy data,
  session metadata and pending outbox unchanged.
- Opaque local contexts with current membership/grant/suspension checks. Shared
  application commands authorize sales, purchases, customer/supplier payments,
  stock, cash, expenses and product/customer/supplier/account edits inside their
  SQLite transaction. Related IDs/global upserts are shop scoped; discount/price/
  credit overrides have separate permissions. Effects, v1 event and audit roll
  back together. Cash transfers require both legs; expense reversals compensate
  their original fact. Legacy repository APIs are still lower-level primitives.
- Mobile demo seed requires an explicit developer opt-in:
  `npm run dev:mobile:demo`. Normal boot no longer creates a demo shop.
- Identity/business/development/plan/API guidance updated.

### Verification

- `node --experimental-strip-types packages/core/src/identity/workspace.test.ts`:
  37 tests passed using real SQLite. Includes file close/reopen → locked → unlock
  → sale, setup/native crash gaps, SQL failpoints, wrong credentials/retry/recovery
  thresholds, in-flight/concurrent unlocks, forged contexts, suspension/revocation,
  credit/discount/price permission checks, cross-shop related records/upserts,
  append-only audit, transfer/reversal semantics and schema 14→15 preservation.
- `npm run typecheck -w @kolo/core`: passed.
- `node scripts/dev-mobile-demo.mjs --help`: explicit Expo launcher resolves/runs.
- `npm run check`: passed boundaries, all workspace typechecks/tests, generated
  API/link checks and package/server/desktop builds. Existing server HTTP tests
  needed localhost access outside the sandbox; the PostgreSQL readiness test
  skipped because `KOLO_TEST_DATABASE_URL` was unset.
- `npm run bundle:mobile`: Metro Android export passed (643 modules).
- Private authority orchestration is blocked by package exports; app boundary
  checks also reject it. Public API generation omits `@internal` helpers.
- `git diff --check`: passed. Changes remain uncommitted.

### Limits at the first checkpoint (superseded by the continuation below)

At this checkpoint F1 was in progress. The credential port has only a test fixture, not a production
PIN verifier/KDF/key adapter. Android and Windows native security/benchmark spikes
must select reviewed credential/key storage, including devices without screen locks.
Native create/unlock/restore UI and POS/desktop command adoption are pending; mobile
still uses legacy login/session/repository paths and desktop remains a scaffold.

Staff enrollment/provisioning, owner recovery after ten failures, lost-key/device
replacement, protected report adapters and owner-proof legacy migration are pending.
Raw access to SQLite is not a security boundary against a device owner; clock/app-data
manipulation needs native protection. Native airplane-mode F1 acceptance is unverified.
Authority bootstrap/grant/revoke facts are local audit only until F2 supplies signed
v2 payloads, peer trust/revisions and late-event policy; they are not sent as v1 events.


## 2026-10-06: F1 native integration and application flows

The first core checkpoint stopped before completing the remaining feasible F1 work.
This continuation implements:

- Shared protected native credentials: asynchronous PBKDF2-HMAC-SHA256, random salts,
  Ed25519 device keys, separate 256-bit owner recovery codes, idempotent writes and
  manifest-last provisioning. SQL receives only public keys/opaque references.
- Mobile QuickCrypto/Nitro and Expo SecureStore adapter plus native plugin config;
  desktop Node/OpenSSL and atomic Electron safeStorage vault adapter. Missing native
  encryption fails closed. Node minimum is 24.16 for standard-library UUIDv7.
- Migration 16 for credential-recovery/staff intents. Owner access recovery rotates
  credential reference/code, persists separate retries and resumes the native/SQL gap.
  Owner staff credential reset preserves IDs, roles, grants and suspension.
- Staff provisioning, active/suspended membership management, grant/revoke controls
  and owner recovery-code retrieval. Staff native/SQL gaps resume after owner unlock.
- Mobile offline create/unlock/pending setup/access recovery/explicit legacy migration
  screens; always-locked boot, background/in-flight lock, authorized POS/product writes
  and quick product entry so a fresh offline shop can sell. No cached cloud-session
  unlock or required server login for a fresh local shop. Developer demo stays opt-in.
- Explicit fresh online owner-proof conversion for legacy shops: exact shop/device,
  owner role/permission and unexpired proof; all old IDs, data, sessions and pending
  events retained. Failed native conversion resumes its original proven intent.
- Named report adapters with current granular permission and context-derived shop.
  Financial dashboard/valuation are unavailable to default cashiers. Application
  product/customer/supplier/account saves supply native UUIDv7 event IDs rather
  than relying on legacy repository randomUUID defaults.
- Credential decision/security limits, platform validation procedure and updated
  identity/application guidance; public API regenerated.

### Verification

- 37 workspace authority/transaction/SQLite tests, 16 credential/recovery/staff/legacy
  lifecycle tests using real SQLite and OpenSSL, and 3 desktop vault/crypto/rotation tests.
  The desktop OS encryption API is simulated in unit tests; DPAPI is not claimed.
- Native credential benchmark on the Linux host: PBKDF2 600,000 iterations,
  median 81.85 ms over five samples; Node 24.18.1, AMD Ryzen 7 7730U. No secrets output.
- Expo prebuild configuration resolves native plugins. Android Metro export resolves
  the new native-module bindings and screens; neither proves installed-device behavior.
- `npm run check`: passed boundaries, typechecks, all workspace tests, API/link
  checks and builds: 590 tests passed; PostgreSQL readiness skipped without
  `KOLO_TEST_DATABASE_URL`.
- `npm run bundle:mobile`: Android Metro export passed (808 modules).
- `npm run smoke:credentials`: actual Linux Electron/OpenSSL and OS vault passed
  provisioning, reopen, correct/wrong PIN verification and encrypted-file checks.
  This does not establish Windows DPAPI behavior.
- Electron adapter types are bound to the installed safeStorage API; async decryption
  reads its `{ result, shouldReEncrypt }` response and rewrites rotated records.

### Remaining acceptance gates and later-phase dependencies

F1 native acceptance remains open: `adb` detected `emulator-5554 offline`; get-state
failed, and reconnecting removed the stale connection with no devices attached.
Android airplane-mode create/restart/unlock/sale and actual
SecureStore behavior could not run. Windows KDF/DPAPI and Android hardware measurements
plus the native security review remain required before accepting the candidate policy.
See [native validation](f1-native-validation.md) and
[ADR-020](../adr/ADR-020-local-credential-policy.md).

Owner recovery restores access on the intact original device. Encrypted backup restore,
lost-vault/device replacement and trusted pairing depend on F2/F3 and are not implemented.
Desktop setup/POS UI remains F5. Signed membership/permission exchange remains F2;
current authority facts are local immutable audit, never fabricated v1 server events.

## 2026-10-06: F2 exact shared rules and signed journal

Continued to F2 at the user's request; F1 Android/Windows acceptance checks are deferred
for a later session. This milestone implements:

- Framework/database-independent exact money/quantity/pricing/settlement/credit rules,
  with safe integer boundaries, BigInt intermediates and half-away rounding. Pure
  permission defaults live in contracts with core compatibility exports. Cart,
  local writes, valuation and replay share rules. SQLite balances/report outputs
  reject unsafe aggregates instead of exposing rounded native numbers.
- Strict payloads for all current business and setup/membership/permission events;
  bounded canonical JSON, immutable v2 envelopes, native SHA-256/Ed25519 ports and
  domain-separated event/batch/receipt signatures. No JS crypto fallback or exported
  installation private key. Desktop signing tests reopen the protected adapter.
- Forward migration 17: journal, origin sequences, immutable proofs, permanent applied
  identities/financial entity claims, scoped key pins, destinations/delivery state,
  outgoing/incoming batches, receipts, conflict records, reviews and unsigned v1 archive/
  baseline provenance. Migrations 1–16 and existing cloud queues are preserved.
- Authorized business effects stage their v2 fact atomically. Native signing finishes
  outside SQL; interrupted/locked signing stays pending. Mobile seals on unlock and
  retries while unlocked. Mobile receipt numbers include the sale UUID to avoid
  independent tills colliding on the same second.
- Context-bound verification, complete fan-out validation, current authority/reference
  checks, durable receive then atomic application, rollback savepoints, bounded fair
  dependency retries, unsupported retention and exact-digest owner review. Same ID or
  origin position with changed content is preserved as a conflict without replacing
  prior effects. Authority imports advance explicit revisions; credentials never copy.
- Signed forwarding batches and exact batch-bound receiver receipts. Relay preserves
  origin proof; lost acknowledgments permit harmless resends. Deferred receipt state
  means durable storage, not application. Each destination progresses independently;
  a peer receipt cannot clear another peer/server or the retained v1 cloud queue.
- HTTP v1 sync restricted to unconverted legacy workspaces; configured installations
  require signed v2 exchange. No pruning of journal/proof/applied/archive identities.
- [ADR-021](../adr/ADR-021-signed-journal-and-late-event-policy.md), updated implementation
  contracts and regenerated public API reference.

### Verification

- 18 signed exchange integration cases use real SQLite and real Node/OpenSSL Ed25519
  with approved fixture baselines. They cover both offline sales/negative stock,
  duplicate/reordered imports, lost receipts, onward relay, exact branch preservation,
  purchases/debt/payments/transfers/expense compensation, payload/ID/position conflicts,
  proof mutations/forged tokens, lock during verification, SQL failpoints, file close/
  reopen/retry, membership ordering, denied staff writes, stale-authority review,
  future versions, retry fairness, scoped receipts and unchanged legacy cloud state.
- Independent arithmetic oracle cases and canonical Unicode/key-order/schema failures;
  SQLite numeric boundary checks and an unsafe aggregate from safe individual facts.
- `npm run check`: 617 tests passed (603 core, 8 contracts, 4 desktop, 2 server),
  all boundaries/typechecks, API/link checks and builds passed. The real-PostgreSQL
  readiness test remains skipped without `KOLO_TEST_DATABASE_URL`.
- `npm run bundle:mobile`: Android Metro export passed with the signed journal modules.
  This proves bundling, not installed-device signing or keystore behavior.
- `git diff --check`: passed. Work remains uncommitted; prior workspace changes preserved.

### Limits and next milestone

F2 core replay/receipt acceptance is covered by the fixture replicas; fixtures do not
prove native pairing or production transfer files. F3 still needs key confirmation,
approved baseline/enrollment, encrypted native files, backup/restore and transfer UI.
Nest business ingestion is F6. Desktop setup/POS screens remain F5. Android/Windows
native credential/crypto acceptance remains open as documented under F1.

Late actor revisions, revoked permissions or receiver catalog price discrepancies can
quarantine legitimate offline business facts pending an audited owner decision. No
secure wall-clock revocation cutoff is asserted. Concurrent authority revisions conflict;
owner review cannot approve malformed/cross-shop facts, identity collisions, authority
changes or revoked device keys. Refer to ADR-021 for the implemented policy.

## 2026-10-06: F2 interruption audit and F3 encrypted recovery/transfer

At the user's request, rechecked F2 before continuing. All 18 signed replay integration
cases passed independently; the full 617 F2 tests passed along with the three initial
F3 cases. Workspace typechecks/builds, boundaries, API/link checks and Metro passed.
The interrupted F3 work had an adjustment test missing its mandatory reason and a
schema-14 upgrade expectation missing new migration 18; both were corrected. No F2
replay regression was found. Existing uncommitted repository work was preserved.

F3 now implements:

- Native AES-256-GCM authenticated files with independent password policy, fixed
  PBKDF2-SHA256/600,000 KDF, fresh salt/nonce, authenticated metadata/purpose/length and
  bounded formats. No compression, JS crypto fallback or private-key export.
- WAL-consistent sanitized SQLite snapshots and signed identity/history manifests.
  Credentials, installation, session and provisioning references are removed before
  compaction. Exact shipped schema, integrity, foreign keys, one-shop authority and
  derived boundary are validated in a private candidate before forward migration.
- Opaque backup previews, owner/shop confirmation, fresh native installation/device/key,
  new origin sequence, atomic durable active-slot switch and retained old business file.
  Active-handle retirement blocks stale contexts, setup, unlock and access recovery.
  Explicit existing-device rollback requires the current owner; lost-vault replacement
  uses an empty target and authenticated encrypted backup.
- Expiring identity-only invitations, independent key fingerprints, durable reserved
  IDs/native possession requests, owner comparison-code confirmation and recipient-bound
  encrypted baseline initialization. Secondary membership authority is separately
  approved. Re-pairing active restored shops updates trust without replacing newer
  local history. Secondary PIN recovery stays local instead of inventing shared revisions.
- Encrypted batch preview/import/export and independently encrypted, regenerable receipts;
  exports stay offered until exact receiver acknowledgment. French/English diagnostics
  retain event IDs and recovery actions. Existing origin proofs and cloud queues stay intact.
- Mobile native selected-file workflows for backup/explicit restore, pairing, encrypted
  events/receipts and diagnostics; current database handles follow the durable slot.
  App background lock still applies, including fresh proof after native file dialogs.
  SDK-matched FileSystem is explicitly recorded in the root workspace lock.
- Desktop active-slot boot and native bounded file-dialog/AES adapters. Renderer commands/
  setup/till/transfer screens remain F5. [ADR-022](../adr/ADR-022-encrypted-files-and-approved-snapshots.md),
  [native validation](f3-native-validation.md), implementation guides and public API updated.

### Verification

- `npm run check`: 627 tests passed (612 core, 8 contracts, 5 desktop, 2 server),
  all workspace typechecks/boundaries, generated API/link checks and builds passed.
  One real-PostgreSQL readiness test remains skipped without `KOLO_TEST_DATABASE_URL`.
- Eight F3 cases use real SQLite/OpenSSL to cover full pairing, two offline credit sales,
  duplicate encrypted transfers/receipts, stock/debt/cash/report convergence, new-origin
  restore/re-pair, malformed authentication/schema/scope, provisioning interruption,
  original-reference removal and rejected active-pointer commit. Secondary recovery
  policy is separately verified with the real protected-credential implementation.
- `npm run bundle:mobile`: Android export passed (966 modules).
- `npm run smoke:credentials`: actual Linux Electron/OS-vault encrypted backup, fresh
  restore and new sale passed, including origin sequence 1 and distinct native key.
- `npm run smoke:desktop`: actual Electron boot, SQLite active slot and preload/status
  IPC passed. `git diff --check`: passed. No commits or publishing performed.

### Remaining acceptance gates

Android/Windows native credentials/crypto/KDF, installed file dialogs, low-cost memory
budgets and power-loss activation drills remain deferred by the user. Linux runtime,
TypeScript, Metro and SQLite tests do not establish those gates. Snapshot size is
explicitly capped at 16 MiB; larger-shop capacity needs measured bounded support before
release. Desktop renderer workflows remain F5, Nest ingestion F6 and Bluetooth F8.
F4 is the next implementation milestone for the complete mobile shop workflow.

## 2026-10-06: F4 mobile operational workflows

Implemented:

- Permission-aware mobile navigation for till, products/categories/stock, customers,
  suppliers, purchases, finance, expenses, reports and receipts. Operational text is
  keyed French/English; drafts stay mounted across operational tabs and clear on lock.
- Bounded authorized SQLite queries with stable keyset continuation, literal prefix/
  phone search, exact barcode submission, archived records, current derived balances,
  saved receipt/source history, report-only debt/negative-stock alerts and cashier
  own-receipt enforcement. Forward migration 19 adds indexes/category conflict ordering.
- Committed domain revisions in both SQLite adapters. Nested writes/imports notify once
  after commit; rollback notifies nothing; broken observers cannot fail a saved command.
  Views reread local pages rather than holding a second global database copy.
- Product/category editing/archive, stock opening/damage/history/count, cash/split/credit
  checkout, fractional entry and whole-sale discount, customer collections, supplier
  payments, multi-line purchases/door payments, financial accounts/transfers/counts,
  expense reversal, local net summaries, persisted receipt rereading and OS text sharing.
- Authorized atomic `countStock` and `adjustCashToCount` operations; current differences
  are calculated inside the transaction. Matching counts record audit only. Whole-unit
  product rules also apply to local sale/purchase/manual-stock commands.
- Shared partial/full sale and purchase return previews/commands. Historical line prices,
  deterministic largest-remainder sale discount allocation and cumulative rounded
  entitlements conserve every franc; over-return/refund and stale predecessors fail.
  Stock, refund account movements, counterparty credits, journal and audit commit together.
  Forward migration 20 protects the immutable referencing return facts.
- Strict signed `CATEGORY_SAVED`, `SALE_RETURNED`, `PURCHASE_RETURNED` event schemas,
  scope/permission/dependency/identity policy and replay. Successor returns defer until
  predecessors arrive; duplicate deliveries are harmless. Competing offline source chains
  retain local facts and quarantine incoming competition as actionable `return_conflict`;
  those sources require owner reconciliation before convergence is claimed.
- Net period sales/profit/purchase summaries include returns at their occurrence time.
  Receipts show original settlement and separately recorded return total. Unknown costs
  remain visible; detailed original-sales breakdowns retain gross historical semantics.
- [Mobile guide](mobile.md), [ADR-023](../adr/ADR-023-partial-returns-and-source-ordering.md),
  [F4 native validation](f4-native-validation.md), application/reference documentation
  and phase status updated. Existing work remains uncommitted.

### Verification

- `npm run check`: passed boundaries, all workspace typechecks/builds, generated API/
  links and tests: 645 passed (630 core, 8 contracts, 5 desktop, 2 server). Real PostgreSQL
  readiness skipped without `KOLO_TEST_DATABASE_URL`. The initial sandbox run blocked
  the HTTP test's ephemeral localhost listener (`EPERM`); the permitted rerun passed.
- Nine new real-SQLite operational cases cover a full accounting day and file-backed
  restart; split/credit collections/payables; negative stock and counts; transfers/
  reconciliation; expense compensation; bounded literal searches/duplicate-name pages/
  query-plan index use; foreign IDs; cashier own receipts; revocation/lock; rollback;
  schema 18→20; report-only authority and exact partial sale/purchase returns.
- Two native-interface commit-notification cases use real SQLite behind the synchronous
  native port. They do not exercise installed expo-sqlite. Two added real Ed25519 replica
  cases cover category dependencies/LWW and reordered/duplicate/competing return chains.
- Independent BigInt rounding checks for partial return entitlement, deterministic
  allocation, exact money/quantity entries and calendar report boundaries pass.
- `npm run bundle:mobile`: Metro Android export passed (989 modules). After final UI-only
  validation/filter fixes, mobile typecheck and Android export were repeated successfully.
- `npm run docs:check` and `git diff --check`: passed. No commits/deployment/publication.

### Remaining acceptance gates

F4 remains in progress. Android full-day installed rendering, actual native SQLite/
keystore/share/file behavior, hardware scanner and chosen receipt-printer adapter,
accessibility/large-text drills and measured low-cost startup/search/list/report/memory
budgets remain open. No printed receipt support or performance budget is inferred from
text sharing, host SQLite or Metro. F1/F3 Android/Windows gates remain deferred.
Earlier setup/staff/transfer forms still need full keyed English localization; the app
language currently resets to French on cold boot. Competing returns for the same source
need explicit owner comparison/correction; automatic conflict resolution is not claimed.
See the native validation procedure before accepting F4 or declaring device readiness.


## 2026-10-06: F4 localization and operational UI follow-up

Implemented:

- Keyed French/English setup/unlock/owner-recovery, staff and transfer screens, including
  every role/permission label, stable failures, retry time, file/pairing instructions
  and exchange counts. Existing feedback updates when the language changes; business
  data, fingerprints and recovery keys remain literal values. The unused legacy HTTP
  login screen is outside the active navigation.
- Language choice before setup and on operational/staff/transfer screens. A dedicated
  `device-preferences.db` persists it across restarts independently of business snapshots,
  restore and active-slot replacement. Unsupported values default to French. Failed
  reads/writes show localized feedback and explicit retry while keeping work available.
- Staff controls now provide 48 dp touch targets and explicit button/radio/selection
  states; staff mutation/navigation controls are disabled during credential work.
  Transfer destination and authority controls expose selection/accessibility labels.
- The first-page local picker retry now forces a new query even when no pagination
  cursor exists. Earlier retry could leave the failed chooser unchanged.
- Seven mobile host test cases cover French/English interpolation/permission coverage,
  literal substitution, localized identity/transfer errors without secret disclosure,
  file-backed preference restart and business replacement, unsupported/read failures,
  and rejected writes retaining the prior language until successful retry.

### Verification

- Mobile localization and real SQLite preference tests passed (seven cases).
- `npm run check`: passed all dependency boundaries, workspace typechecks, builds,
  generated API/link checks and 652 tests (630 core, 8 contracts, 5 desktop, 7 mobile,
  2 server). One real-PostgreSQL readiness case skipped without its test database URL.
- `npm run bundle:mobile`: Metro Android export passed (992 modules).
- `npm run docs:api` and `git diff --check`: passed. No commits or publication.
- Android device discovery succeeded outside the sandbox and found no connected devices.

### Remaining acceptance gates

F4 remains in progress until an installed Android shop day, native storage/keystore/file/
share behavior, physical scanner, selected receipt-printer adapter, TalkBack/large-text
checks and measured low-cost-device budgets pass. The initial sandbox root check
encountered the existing server HTTP test’s localhost-listener `EPERM`; the permitted
full rerun passed. F1/F3 Android/Windows acceptance and competing-return owner
reconciliation remain as previously recorded.


## 2026-10-06: Desktop/web-first priority

User direction: establish a solid desktop/web implementation before returning to
mobile. F5 is now the next active phase; F4 Android acceptance remains open.

The desktop assessment confirms a working Electron/SQLite/active-slot foundation and
native credentials/file adapters, but only a boot/status renderer and `getStatus()`
IPC. No browser app or authenticated server business API exists. Shared accounting,
authorization, exact rules, returns and backup/exchange remain reusable.

The [desktop implementation guide](desktop.md) defines the first usable milestone:
validated command boundary, offline setup/unlock/recovery, product/catalogue, cash
till, saved receipt and restart verification. Broader management, transfer UI and
Windows/hardware/performance acceptance follow. The user confirmed desktop first
with reusable React UI for a later browser version. Browser runtime/storage versus
server API remains a later architecture choice. This entry changes implementation
priority, not delivered capability.


## 2026-10-06: First usable desktop workflow (F5)

Implemented:

- Reusable React DOM screens against an injected, platform-neutral `ShopService`.
  The composition root selects Electron; French/English labels and errors are keyed,
  with locally persisted language choice. No browser runtime is claimed.
- Named, validated preload/main commands with trusted-frame checks, bounded queries,
  sanitized failures and host-held authority. No generic IPC, SQL, filesystem paths
  or caller-selected tenant context crosses the bridge. Session markers and core
  permission checks reject stale, locked, revoked and foreign-tenant requests.
- Standalone setup, interrupted-provisioning resume, unlock/lock and owner recovery.
  Credentials use the existing native vault. Restart boots locked; minimize, OS
  screen lock/suspend and renderer loss/reload invalidate authority. Shutdown waits
  for pending native work before closing SQLite.
- Product creation with optional atomic opening stock, paginated catalogue/search,
  stock visibility, exact barcode lookup, keyboard cash till, fractional quantities,
  persisted receipt and history. Shared rules provide exact totals and quantities;
  the host validates current prices and accounts. Negative stock remains visible.
- Stable creation/checkout identities and immutable-fact retry comparisons prevent
  duplicate stock, cash and receipts. Ambiguous transport failures freeze the submitted
  draft for retry. A cashier can confirm an already-saved sale after receipt-view
  revocation; sales-creation authority is still required. Navigation retains the
  till and product-entry drafts; lock/session change discards them.
- Nine real-SQLite host/dispatcher cases cover file-backed restart, cash/stock/receipt
  consistency, matching/conflicting retries, malformed input, tenant isolation,
  direct bridge bypass, cashier scope/revocation/suspension, rollback failpoints,
  lock during credential proof, shutdown during provisioning and recovery failures.
- A disposable actual Electron DOM/preload/OS-vault workflow creates a shop and
  product/opening stock, scans and records a fractional cash sale, checks its saved
  receipt, then reopens a second process and verifies unlock/receipt/stock.
  The runner never opens an existing business installation.

### Verification

- `npm run check`: passed boundaries, workspace typechecks/builds, generated API/link
  checks and 661 tests (630 core, 8 contracts, 14 desktop, 7 mobile, 2 server).
  One real-PostgreSQL readiness case remains skipped without its test database URL.
- `npm run smoke:desktop:workflow`: actual Linux Electron/native-vault setup, repeated
  Enter-key barcode scans with restored input focus, fractional checkout,
  identical/differing retries, receipt and process restart passed.
- After the final draft-preservation adjustment, desktop typecheck/build and the
  actual Electron workflow passed again, including product/cart navigation checks.
- `npm run bundle:mobile`: Metro Android export passed (992 modules).
- The actual rendered till was visually inspected. `git diff --check` passed.
  No commits or publication.

### Remaining acceptance gates

The first offline desktop software slice is delivered; F5 remains in progress.
Product editing and wider stock workflows, split/credit sales, customers/suppliers,
finance/expenses/reports/returns, staff and backup/exchange screens still follow.
Physical scanner/printer integration, accessibility/performance measurements and
Windows protected storage/installer acceptance remain open. Mobile native gates stay
deferred behind the desktop priority. A browser release still needs its own runtime
storage/identity boundary or authenticated business API.


## 2026-10-09: Desktop catalogue and stock (F5)

The F0–F5 work was verified (`npm run check`, `npm run bundle:mobile`, actual Electron
workflow) and committed as `4da32b3`. Releases will follow the Rebar Studio style
(conventional commits, gover version tags, tag-built draft releases); the release
pipeline itself is deferred.

Implemented:

- Product detail view with stock, prices, unit, barcode and low-stock level; editing of
  active products from their displayed version; archive and restore. Identical retries
  write nothing; edits over a newer stored version are refused and offer a reload.
- Categories: create (stable request ID), rename, archive/restore, archived listing, and
  product category selection that keeps an archived current category visible.
- Manual stock additions, damage/loss and shelf counts with reasons, stable request IDs
  and frozen drafts after an uncertain transport failure; bounded stock history.
- Core `countStock` accepts an optional request ID that names its movement and audit.
  A retried count returns its original difference instead of recounting after later
  sales. No migration or event payload change.
- Nine new named, validated IPC commands (`getProduct`, `updateProduct`, `setProductActive`,
  `listCategories`, `createCategory`, `updateCategory`, `moveStock`, `countStock`,
  `stockHistory`) plus archived listing on `listProducts`. French/English text keyed.

### Verification

- New real-SQLite host cases cover version conflicts, idempotent retries, clock-behind
  LWW, price authority for the inventory role, archived/foreign categories, archived
  products leaving the till/scanner/stock workflows, cashier refusals, retry-safe moves
  and counts across later sales, rollback failpoints, malformed input and history paging.
  A core case covers request-named counts, including zero-difference counts.
- The actual Electron workflow additionally adds stock, counts the shelf, checks history,
  edits the product and creates a category, then verifies stock after restart. Product
  detail and category screens were visually inspected.
- `npm run check`: 665 tests passed (631 core, 8 contracts, 17 desktop, 7 mobile,
  2 server); the real-PostgreSQL readiness case remains skipped without its database URL.
  `npm run bundle:mobile` (992 modules) and `npm run smoke:desktop:workflow` passed.

### Remaining

Split/credit checkout, customers, suppliers/purchases, finance, reports, returns, staff
and backup/exchange screens; printers/scanners, accessibility/performance measurement and
Windows packaging remain as previously recorded.


## 2026-10-09: Desktop split/credit checkout and customers (F5)

Implemented:

- Checkout with up to eight payments (one per active account of any kind) and an optional
  customer. The unpaid remainder goes on the customer's ledger under `customers.credit`;
  configured limits are enforced unless the actor holds `customers.credit_override`, with
  a dedicated `credit_limit` failure. Retries match lines, payment set and customer. The
  legacy single cash `accountId` request is still accepted.
- Till: payment rows where the first untouched row takes the remainder, customer search
  showing balance and limit, remainder/credit display, and cash received with change due
  (computed in the UI only, not stored). Receipts show the customer and what is left owing.
- Customers section: list with balances and archived filter, creation with a stable
  request ID, versioned edits, archive/restore, payments with stable ledger IDs and
  frozen drafts after uncertain failures, and a bounded signed statement.
- Seven new named, validated IPC commands (`listPaymentAccounts`, `listCustomers`,
  `getCustomer`, `createCustomer`, `updateCustomer`, `receiveCustomerPayment`,
  `customerStatement`) and the extended `checkout`. Change subscriptions include customers.

### Verification

- Real-SQLite host cases cover split payments across account kinds, order-insensitive
  retries, conflicting retries (customer/payments), credit receipts and statements,
  overpayment, credit without a customer, duplicate/zero/too many payments, foreign
  accounts, limit and zero-limit refusals for a manager without override, owner override,
  cashier credit refusal, customer versioning/archive, payment retries/conflicts/advance
  balances, rollback failpoint and statement paging.
- The actual Electron workflow adds a customer with a limit, sells partly on credit with
  change due, checks the receipt and balance, takes a payment and checks the statement,
  then verifies stock and the credit receipt after restart. Till and customer screens were
  visually inspected.
- `npm run check`: 668 tests passed (631 core, 8 contracts, 20 desktop, 7 mobile,
  2 server); the real-PostgreSQL readiness case remains skipped without its database URL.
  `npm run bundle:mobile` (992 modules) and `npm run smoke:desktop:workflow` passed.

### Remaining

Suppliers/purchases, finance, reports, returns, staff and backup/exchange screens;
printers/scanners, accessibility/performance measurement and Windows packaging.

### Follow-up: sale discounts

The till offers a whole-sale discount to actors with `sales.discount`, showing subtotal,
discount and total; receipts show the discount. The host validates it against the
subtotal before settlement and includes it in retry identity; legacy single-account
requests cannot carry one. A host case covers authority, bounds, malformed values,
overpayment after discount and conflicting retries.


## 2026-10-09: Desktop suppliers and purchases (F5)

Implemented:

- Purchases section with a purchase history and detail (lines, total, paid, owed), and a
  delivery form: supplier search, delivery reference, product search adding lines with
  editable quantity and unit cost (defaulting to the product cost), total, an amount paid
  now from one account (defaulting to the total) and the remainder owed to the supplier.
- Suppliers tab: list with payables and archived filter, versioned details with contact,
  archive/restore, payments with stable ledger IDs and a signed statement shared with the
  customer statement component.
- Nine new named, validated IPC commands in `electron/purchasing.ts`, introduced with a
  small `Host` interface so feature groups no longer grow `application.ts`.

### Verification

- Real-SQLite host cases cover stock received at cost, door payment plus payable,
  order-insensitive retries, conflicts on door account/amount/reference/lines (door
  payments located via the event's claimed movements), supplier payments and statements,
  market purchases without a supplier, overpayment, missing supplier for a payable,
  malformed/duplicate/fractional lines, foreign products, rollback failpoint, archived
  supplier refusals, and inventory-role/cashier authority.
- The actual Electron workflow creates a supplier, records a part-paid delivery through the
  DOM, checks the supplier payable, and verifies the received stock after restart.
- `npm run check` and `npm run smoke:desktop:workflow` passed.

### Remaining

Finance (accounts, transfers, reconciliation, expenses), reports, returns, staff and
backup/exchange screens; receipt printing; hardware, accessibility/performance and
Windows packaging acceptance.

## 2026-10-09: Desktop accounts, money movements and expenses (F5)

Implemented:

- "Accounts & expenses" section. Accounts: balances, archived filter, versioned
  create/rename/re-kind/archive, money in/out and transfers with reasons, and a count that
  compares expected and counted amounts before an explicit correction with a reason.
- Expenses: record from any account by category (description required for "Other"),
  newest-first history with reversal status, and one-time compensating reversal.
- Core `adjustCashToCount` accepts an optional request ID naming its adjustment and audit,
  mirroring `countStock`; no migration or event payload change.
- Ten new named, validated IPC commands in `electron/finance.ts`. Core data-layer
  validation errors now surface as `invalid_input` rather than `storage_failed`.

### Verification

- Core case: request-named cash corrections, including a matching count.
- Real-SQLite host cases: deposits, transfers, retries/conflicts, count and correction
  retried after a later movement, versioned account edits, archived account refusals,
  malformed kinds/names; expenses recorded, retried, reversed once, reversal of a reversal
  refused, balances restored; cashier refusals; OTHER without description as invalid input.
- The actual Electron workflow takes money in, counts short, corrects, records an expense
  and checks each balance. The runner now prints visible alerts when a step times out.
- `npm run check`, `npm run bundle:mobile` and `npm run smoke:desktop:workflow` passed.

### Remaining

Reports, returns, staff and backup/exchange screens; receipt printing; hardware,
accessibility/performance and Windows packaging acceptance.

## 2026-10-09: Desktop reports (F5)

Implemented a Reports section with a permission-filtered report choice, local-day period
inputs with Today/Last 7 days/This month presets, and results for summary (sales, sales
count, gross profit, expenses, net result, customer and supplier debts, stock alerts and
uncosted-line warning), sales totals and breakdowns by product/category/account/seller,
account cash flow, stock value, best sellers, stock alerts, customer and supplier debts,
and purchases by supplier. One validated `report` IPC command (`electron/reports.ts`)
reads the existing core report functions under their permissions.

### Verification

- A real-SQLite host case checks exact dashboard, product, cash-flow, valuation, debt,
  purchase and empty-period figures against a purchased, part-credit-sold and expensed
  fixture; malformed kinds/periods and inventory-role/cashier authority are refused.
- The actual Electron workflow checks today's summary sales and expenses after the earlier
  steps; the summary screen was visually inspected.
- `npm run check` and `npm run smoke:desktop:workflow` passed.

### Remaining

Returns, staff and backup/exchange screens; receipt printing; hardware,
accessibility/performance and Windows packaging acceptance.

## 2026-10-09: Desktop sale and purchase returns (F5)

Implemented a shared return form opened from a saved receipt ("Return items") or a
purchase ("Return to supplier"): returnable lines with remaining quantities, "Return
everything", exact preview, refund amount and account, counterparty credit for the
remainder, a required reason, stale-return reload and frozen drafts after uncertain
failures. Receipts show the returned value. Three validated IPC commands
(`returnSource`, `previewReturn`, `recordReturn`) in `electron/returns.ts`; new failure
code `stale_return`.

### Verification

- A real-SQLite host case covers partial sale return with part refund and customer credit,
  stock/cash/ledger/receipt effects, content retries and conflicts, stale predecessor,
  over-return and over-refund, empty and malformed requests, a second return without refund,
  purchase return requiring full refund without a supplier, and cashier refusal.
- The actual Electron workflow returns one unit of the credit sale from its receipt and
  verifies the returned stock after restart.
- `npm run check` and `npm run smoke:desktop:workflow` passed.

### Remaining

Staff and backup/exchange screens; receipt printing; hardware, accessibility/performance
and Windows packaging acceptance.

## 2026-10-09: Desktop staff (F5)

Implemented a Staff section: member list with role and status, owner-only member creation
with role and confirmed code, a grouped permission checklist showing effective permissions
with per-permission grant/revoke, suspend/reinstate, and code replacement. Five validated
IPC commands in `electron/staff.ts`. The smoke runner now waits for click targets and, in
smoke mode only, prints the failure message.

### Verification

- A real-SQLite host case covers creation, duplicate names, malformed roles/codes/names,
  grant/revoke with no-op repeats (no authority revision change), cashier refusal,
  suspension blocking unlock, owner self-suspension refusal, reinstatement, code
  replacement and old-code refusal.
- The actual Electron workflow adds a cashier through the OS vault and grants credit
  sales; five consecutive workflow runs passed after making clicks wait for their targets.
- `npm run check` and `npm run smoke:desktop:workflow` passed.

### Remaining

Backup/restore and pairing/file-exchange screens; receipt printing; hardware,
accessibility/performance and Windows packaging acceptance.

## 2026-10-09: Desktop backup, pairing and file exchange (F5)

Implemented:

- "Backup & devices" section for the owner: encrypted backup save, restore over this shop
  after typing the shop name, pairing invite with fingerprint, request check and approval
  with the compared code, per-destination exchange files, exchange import with assessment,
  import receipts both ways, deferred retry and localized diagnostics.
- Setup screen links to restore a backup or join a shop from another till (invite check,
  fingerprint confirmation, activation file and code, cancel).
- Eighteen validated IPC commands in `electron/transfer.ts`; native dialogs stay in the main
  process and only previews cross the bridge. Activation swaps the served application to the
  new database slot; handlers resolve the current application lazily.

### Verification

- Real-SQLite/OS-vault-adapter host cases on actual workspace slots: backup with short and
  correct passwords, cancelled dialog, missing staged file, wrong password, wrong shop name,
  restore into an empty installation and unlock with the new code showing the original
  stock and receipt; two desktops pairing by fingerprint and code (wrong code refused),
  completing into the owner's shop, selling on the second till, exporting, previewing and
  importing on the first (stock follows), and import receipts clearing pending delivery.
- The actual Electron workflow saves a backup and restores it over the running shop through
  the DOM; the restored shop opens locked and the restart phase unlocks the restored slot
  with the same facts. Screenshots of this screen were not usable in the headless capture
  (stale frames after the vault prompt); its behaviour is verified through DOM checks.
- `npm run check` and repeated `npm run smoke:desktop:workflow` runs passed.

### Remaining

Receipt printing; hardware, accessibility/performance and Windows packaging acceptance;
Android/Windows cross-device exchange acceptance.

## 2026-10-09: Desktop receipt printing; F5 software complete (F5)

Saved receipts gain a "Print receipt" action using the OS print dialog, with a print
stylesheet that prints only the receipt at 72 mm under the shop name. The workflow smoke
renders the receipt to PDF through that stylesheet (output inspected).

With this, the planned F5 desktop software packages are implemented: setup/unlock/recovery,
catalogue and stock, split/credit/discounted checkout, customers, suppliers and purchases,
accounts/cash/expenses, reports, returns, staff, backup/restore, pairing/file exchange and
receipt printing. F5 remains open for Windows packaging, hardware, performance,
accessibility and cross-device acceptance listed in the desktop guide.

### Verification

- `npm run check`, `npm run bundle:mobile` and `npm run smoke:desktop:workflow` passed.

## 2026-10-09: Desktop shipping, recovery and accessibility; mobile next

User manually tested desktop and reported LGTM. Product scope reaffirmed: two installed
clients with independent local SQLite, shared rules and event exchange, and an optional
paid hosted event-sync server. Physical hardware and cross-device acceptance are deferred.

Implemented Rebar Studio-style electron-builder packaging: self-contained production
staging, ASAR/fuses, Windows x64 NSIS/portable, stable existing app-data location, retained
shop data on uninstall, Windows acceptance CI and draft-release artifacts/checksums.
Initial updates use full installers; background automatic updating and production
signing credentials/provider are not configured. Windows CI exercises real Electron
credentials and a baseline-to-current installer version transition with disposable data.

Extended the Electron workflow with native owner-code recovery, minimize lock, renderer
termination/locked reload, and a forced main-process kill after checkout. The sale must
survive once with expected stock. Shutdown now refuses incoming IPC and avoids sending
notifications into a disposed renderer. Added localized keyboard skip navigation,
scrollable sidebar, readable secondary text and axe WCAG audits. Windows shell quoting
and path normalization in test/documentation/boundary tools were corrected. Overview
docs now describe the completed desktop software and current two-client priority.

### Verification and limits

- `npm run check` and final packaged Linux workflow pass, including native owner
  recovery, accessibility audits and forced-termination persistence.
- Actual and packaged Linux workflows passed, including native vault, backup/restore,
  keyboard scanner, axe setup/till/reports/transfer, renderer kill and durable checkout kill.
- Windows NSIS and portable artifacts build successfully on Linux; Windows acceptance CI
  has been configured but has not run here. Cross-compilation is not a DPAPI/installer result.
- Production archive inspection finds core/contracts/Zod and excludes axe, builder,
  mobile and server application code.
- Large fixture: 10k products/100k movements on Ryzen 7 7730U, ~15 GiB RAM. First
  runtime sample: startup-to-renderer 268 ms, search p95 30.6 ms, barcode p95 0.9 ms,
  stock-value report p95 626.8 ms, checkout p95 27.6 ms; main RSS ~245 MiB and renderer
  working set ~121 MiB. A second sample during Android compilation had search p95
  65.1 ms and checkout p95 270.9 ms. These are host measurements, not target-PC budgets.
- Clean Windows-user default data/uninstall retention, interactive dialogs/OS locking,
  assistive technology, low-cost-PC budgets and signing remain pending evidence.

See [desktop release](desktop-release.md). Mobile native build validation has started;
no Android device or emulator is attached. Native installation acceptance remains open.

## 2026-10-09: Mobile native APK build and first accessibility fixes

A real Android release-variant APK now builds from Expo prebuild with bundled JavaScript
and the native SQLite, SecureStore, Nitro and QuickCrypto modules. Added
`npm run build:mobile:android` and a manual Android test-APK CI workflow; artifacts
are copied to `release/mobile`. Native projects remain generated/ignored. This is
a locally installable test build using generated debug signing, not a store release.

Radio choices in operational forms, staff and transfer now expose `checked` instead
of `selected` for correct assistive-technology semantics. Added SDK-matched
`expo-system-ui` 57.0.2 for the configured light appearance and removed the ignored
Android edge-to-edge customization. Expo 57.0.15 and React Native 0.86.2 remain unchanged.
Targeted `shell-quote` 1.10.0 → 1.12.0 removes the reported critical build-tool advisory.
Other reported Expo/Metro and builder transitive advisories remain a release gate;
blanket audit fixes proposing an older Expo/React Native line were not applied.

### Verification and remaining work

- First native build passed with JDK 21, Android SDK/build-tools 36, NDK 27.1.12297006
  and Gradle 9.3.1; all four Android ABIs were built. The updated build also passes
  through `npm run build:mobile:android`, producing
  `release/mobile/KOLO-0.0.0-android-test.apk` with bundled JavaScript.
- `adb devices -l` reports no attached devices; there is no installed emulator binary.
  Native build success does not establish offline SQLite/keystore runtime acceptance.
- Next mobile acceptance: install the test APK, execute offline setup/shop-day/restart,
  credential recovery, backup/restore, permissions, large text and TalkBack. Physical
  scanners/printers and desktop/mobile exchange remain deferred by user direction.

Final verification for this work: `npm run check`, `npm run bundle:mobile`, final
packaged Linux workflow and final native Android APK build pass. Android APK signature
verifies with the generated Android Debug certificate; package `cm.kolo.app`, minimum
API 24, target API 36, all four ABIs, non-debuggable release manifest. Windows artifact
PE certificate tables confirm unsigned builds, compiled files match final source, and
SHA-256 sums are saved beside the NSIS/portable executables. No release was published.

## 2026-10-09: Linux AppImage for user testing

Added `npm run dist:desktop:linux` and electron-builder's x64 AppImage target.
`release/desktop/KOLO-0.1.0-linux-x86_64.AppImage` builds successfully and is executable.
Actual AppImage launch in extract-and-run mode passes the disposable boot, local SQLite
and preload IPC smoke. Documentation checks pass and the artifact SHA-256 is recorded
in `release/desktop/SHA256SUMS.txt`. FUSE-mounted and target-user shop acceptance remain
separate from this launch check. No artifact was published.

## 2026-10-09: Desktop 0.1.1: start fresh after forgotten codes

User forgot all codes and confirmed that the previous data is not needed. Added
"Start a new shop" to locked, pending-setup and legacy screens, with typed name
confirmation and a fresh setup using new codes. The existing "Forgot your code?"
form now explains the saved recovery key and the fresh-start alternative.

One strict IPC command `startNewShop` stages/migrates an empty database and atomically
activates its slot using the restore/pairing infrastructure. It never grants access
to existing data and retains old database/credential files separately. Unlocked,
missing/malformed and unconfirmed requests are refused; activation failure leaves
the previous shop active. Native identity work stays single-flight.

Desktop version is 0.1.1 so the updated AppImage can sit alongside the running 0.1.0
build. Real-SQLite host tests pass for fresh activation, old-fact retention, empty
restart, new-code setup, old-session refusal and failed-activation recovery. The actual
Electron workflow adds locked-screen/confirmation accessibility audits and fresh setup
without the old code, followed by process restart and new-code unlock.

Verification: `npm run check` and the final packaged Electron workflow pass, including
new locked-screen/fresh-confirmation axe audits, confirmation refusal, fresh setup
without the old code and new-code unlock after restart. The 0.1.1 AppImage builds
and passes its actual extract-and-run SQLite/preload boot smoke.

### Desktop saved-shop picker (2026-10-09)
Added **Open a saved shop** / **Ouvrir une boutique conservée** to the welcome and locked screens. The main process enumerates retained local shop databases without exposing business data or credentials, excluding the current slot, staging files, empty databases, and unreadable files. Selection uses the durable slot generation check and serves the selected database locked; its original credentials are required. Both databases remain on disk.

Validation: full `npm run check` passed; real SQLite tests reopen the retained shop with its original code and product after restart and reject forged paths and unlocked selection. Packaged Electron workflow passed saved-shop selection, accessibility audit, original-code login and another process restart. Linux AppImage 0.1.2 built.

### Desktop entry redesign (2026-10-09)
Replaced the compact stacked entry card with a desktop task panel and contextual side panel. The welcome screen explains new-shop creation, backup restoration and joining another till, alongside retained shops. Setup has two steps, preserves names when going back, and offers optional till/cash account customization. Login names the selected shop and keeps switching separate from code recovery. Code recovery explains the owner key and returns to login with a success message. The owner appears first in the login roster so recovery returns to the intended account. Restore/join entry screens explain file requirements and display stage headings; Back waits for staged-file cleanup and is disabled during native work. The recovery-key dialog explains how to save the key.

Validation: full repository `npm run check` passed, followed by desktop typechecks and tests after final roster/validation refinements. The actual packaged Electron workflow passed welcome/create/restore/join accessibility checks, two-step setup with back navigation and mismatched-code rejection, login at 880×620, recovery through the DOM, fresh setup, saved-shop reopening and restart persistence. Screenshots were reviewed at desktop and compact window sizes. Linux AppImage 0.1.3 built and its disposable runtime boot/SQLite/preload smoke passed. User app data was not changed during implementation or verification.

### Desktop light and dark themes (2026-10-09)
The desktop stylesheet now uses semantic color tokens with light and dark sets selected by the system appearance. Green anchors the workspace, with yellow and red as small accents; the sidebar keeps a dark green palette in both themes and printed receipts stay light. Electron follows `nativeTheme` and updates the window background when the system appearance changes, so there is no light flash in dark mode.

Validation: full `npm run check` passed. The actual Electron workflow audits every captured screen with axe-core WCAG 2 A/AA and 2.1 AA in both light and dark appearance, and asserts the theme token follows native appearance changes. Light/dark screenshots were reviewed. The packaged Electron workflow passed, and Linux AppImage 0.1.4 built and passed its extract-and-run SQLite/preload boot smoke.

### Desktop settings page and softer dark theme (2026-10-09)
After user feedback that the dark theme was too dark, its palette was lifted to softer green-grey surfaces (canvas `#1f2b25`) with the same semantic tokens. A **Settings / Paramètres** page, available to every signed-in user, chooses the appearance (System, Light, Dark) and the language for this computer. The appearance is a renderer preference stored locally and applied before the first paint; "System" follows the OS theme, and explicit choices override it on screen while printed receipts stay light. The native window background before the first paint still follows the OS theme.

Validation: the actual Electron workflow audits Settings in light and dark, selects Dark over a light OS theme and Light over a dark one, checks the persisted choice and returns to System. Screenshots were reviewed. Full `npm run check` and the packaged Electron workflow passed; Linux AppImage 0.1.5 built and passed its extract-and-run boot smoke.

### Desktop stay signed in (2026-10-09)
At the user's request, the desktop keeps the last signed-in user open across restarts unless **Settings → Stay signed in on this computer** is turned off (on by default). Core adds `rememberMember`/`resumeWorkspace`: the remembered record names the business, user and current credential reference and is stored only in the OS-protected vault; resuming rechecks active business/device/member, lockout and an unchanged credential, so code resets, owner recovery, restore and pairing invalidate it. While on, minimize and OS lock/suspend do not lock; renderer loss/navigation still locks the running session. **Lock** and owner recovery forget the remembered user. The initial renderer load no longer counts as a locking navigation. Desktop version is 0.1.6.

Validation: core real-SQLite tests cover resume without secret proof, unchanged permissions, forged/changed/foreign credentials, suspended member/device, lockout and in-flight unlock. Desktop host tests use real SQLite, vault files and the session-memory module across restarts: default on, away vs integrity locks, Lock, turning off/on, owner recovery, forged and suspended remembered users, malformed commands and encrypted, damaged or missing records. The actual Electron workflow turns the option off before the locked-boot phases, then turns it on from Settings, minimizes without locking, restarts directly into the till, locks and restarts locked. Full `npm run check` and the packaged workflow passed; Linux AppImage 0.1.6 built and passed its extract-and-run boot smoke.

### Desktop receipt branding and layout pass (2026-10-09)
Receipts end with a thank-you line and "Generated by kolo · made by hblabs" (French: "Généré par kolo · conçu par hblabs"), shown on screen and printed; the "saved on this computer" note is screen-only. A layout pass unified control heights (inputs, selects and buttons at 46px), reserved a stable scrollbar gutter so pages no longer shift sideways, aligned cart quantities with their amounts, gave till settlement rows one spacing rhythm and full-width payment rows, widened create forms to the detail width, spaced staff permission groups, and laid backup/pairing panels out as an even two-column grid. Desktop version is 0.1.7.

Validation: the actual Electron workflow asserts the receipt footer and renders the print stylesheet to PDF; it now also captures the working screens (product form/detail, till cart and credit settlement, receipts, customer, supplier, purchase, account count, expenses, return, staff, backup/restore) when a screenshot directory is set. Screenshots and the receipt PDF were reviewed. Full `npm run check` and the packaged workflow passed; Linux AppImage 0.1.7 built and passed its extract-and-run boot smoke.

The credit is written "kolo" and "hblabs" in lowercase (user correction); Linux AppImage 0.1.9 carries it.

### Desktop show/hide for codes and passwords (2026-10-09)
Every code and password field (login, setup, recovery, staff codes, backup/restore/pairing passwords) has a **Show / Afficher** toggle beside the input that reveals the typed value and switches to **Hide / Masquer**. The toggle is a separate button outside the field's label, names the field it controls and is disabled with the field. Desktop version is 0.1.10.

Validation: the actual Electron workflow types a code on the login screen, reveals it, runs the axe audit in light and dark, hides it and then unlocks normally. Full `npm run check` and the packaged workflow passed; Linux AppImage 0.1.10 built and passed its extract-and-run boot smoke.

### Desktop terms, privacy notice and open-source notices (2026-10-09)
Added basic French/English **Terms of use**, a **Privacy notice** and **Open-source software** notices (effective 2026-10-09), shown in an in-app reader opened from the entry-screen footer, from setup step 2 ("By creating the shop, you accept…") and from a new **Settings → About** panel that also shows the app version (injected from the desktop package at build time). The texts describe actual behaviour: offline, no data sent to hblabs, local SQLite and OS-protected codes, encrypted user-placed files, the shop owner's responsibility for customer/staff data, not a certified fiscal device, "as is" with limited liability, and stay-signed-in on shared computers. The open-source list covers the shipped Electron, Chromium, Node.js, React/React DOM/Scheduler and Zod, whose full Electron/Chromium texts are installed with the app. They are templates written without legal review: governing law, a contact address and fiscal-certification claims still need confirmation by the user. Desktop version is 0.1.11.

Validation: the actual Electron workflow opens the terms from the French welcome footer, audits the reader in light and dark, switches to privacy and open-source tabs, closes it, checks the setup acceptance line and the Settings version. Full `npm run check` and the packaged workflow passed; Linux AppImage 0.1.11 built and passed its extract-and-run boot smoke.

### Server framework: Fastify (2026-10-09)
Replaced the NestJS/Express scaffold with Fastify 5 ([ADR-025](../adr/ADR-025-fastify-server.md)); `@nestjs/*`, `reflect-metadata`, `rxjs` and decorator compiler options are gone. Routes and responses are unchanged (`/healthz`, `/readyz`, `/api/v2/capabilities`). New: unknown routes, malformed bodies and unexpected failures return a uniform `{"error":{"code":…}}` (`not_found`, `bad_request`, `internal`) without internals, and SIGTERM/SIGINT close the listener and PostgreSQL pool. Earlier entries that say "Nest" refer to this server. No client code changed. Licensing (ADR-024): clients GPL-3.0, server closed for now.

Validation: server tests pass, including readiness against a real PostgreSQL 17 container.

### Desktop demo shop generator (2026-10-09)
`npm run demo:desktop -- [directory] [days]` builds "Alimentation Chez Mama Ngono" through the real `DesktopApplication` operations with a simulated clock (default 45 days ending 2026-10-09): 51 products in 7 categories with barcodes and reorder levels, cash/MTN/Orange/bank accounts, an owner, cashier and manager (credit allowed), 10 customers with credit limits, 5 suppliers, about 1,100 sales (cash, mobile money, split, credit, discounts), deliveries with partial payments, customer and supplier payments, expenses, returns, damage, counts, cash counts and bank deposits. It writes an encrypted backup (`kolo-demo-2026`) plus a README into `kolo-demo/` (git-ignored), then restores that backup on a fresh installation and checks the sales report. Staff codes do not travel in backups; the owner resets them after restore.

**Limit found and fixed the same day:** such a shop grows its database about 0.3 MiB per day, and backups refused snapshots above 16 MiB after roughly 50 days. See "Compressed transfer files" below.

### Compressed transfer files (2026-10-09)
Encrypted files are now `kolo.encrypted` format version 2 ([ADR-026](../adr/ADR-026-compressed-transfer-files.md)): content is deflated with fflate before AES-256-GCM, and the header authenticates `compression`, the encrypted length and the exact decompressed `content_bytes`. Inflation writes into a buffer one byte larger than that length and refuses any mismatch, so lying or bomb streams cannot allocate beyond the cap. Version 1 files still decrypt. Limits moved to `@kolo/contracts/transfer`: 128 MiB raw snapshot (previously 16), 32 MiB encrypted payload, 48 MiB file (previously 24); the signed manifest's `snapshot_bytes` cap follows. A 90-day demo shop (25.5 MiB raw) produces a backup of about 6 MiB. Older installations reject version 2 files with `unsupported_version`. Peak backup/restore memory at the new ceiling is unmeasured on Android/Windows hardware and remains part of the F3/F5 native gates.

Validation: new core tests cover the version 2 round trip and header authentication, legacy version 1 decryption, refusal of authenticated streams that expand beyond or fall short of their declared length or are not deflate data, refusal of incompressible content above the payload cap, and an end-to-end backup/restore of a shop whose snapshot exceeds the former 16 MiB cap. The demo generator now defaults to 90 days and verifies its restore.

Desktop version is 0.1.12 (compressed transfer files); Linux AppImage and Windows NSIS/portable 0.1.12 built and the packaged workflow smoke passed.

### Bundled Inter font (2026-10-09)
The desktop renderer now ships Inter (`@fontsource-variable/inter`, SIL OFL 1.1) instead of relying on installed fonts, which fell back to an unattractive default under Wine and on PCs without Inter or Segoe UI. The variable woff2 subsets (about 220 KB) are emitted as app files allowed by the existing `default-src 'self'` policy. Settings → About → Open-source software lists Inter and shows the full OFL text. The actual Electron workflow now asserts that the bundled face loads. Desktop version is 0.1.13.

### Windows restore activation, licence and field alignment (2026-10-09)
**Fixed: restore and pairing activation failed on Windows** ("La nouvelle boutique n'a pas pu être activée"). After renaming the staged database, `nodeWorkspaceFiles` fsynced it through a read-only handle. Windows `FlushFileBuffers` requires write access, so this failed with EPERM and every desktop restore/pairing activation on Windows was refused; Linux accepts it, so Linux tests passed. The file is now opened read-write for the fsync. Reproduced and verified with the Windows build under Wine 11.18: a new `restore-file` workflow-smoke phase restores a supplied backup (`KOLO_DESKTOP_SMOKE_OPEN_FILE`, `_PASSWORD`, `_SHOP`) from the entry screen of a fresh installation. It failed with `activation_failed` before the fix and passes after it. Workflow timeouts are also appended to `workflow-smoke.log` in the disposable profile, because Windows GUI builds under Wine expose no console. The Windows CI job (`npm run check`, packaged workflow smoke) exercises the same activation and would have caught this once it runs.

**Licence:** client packages (desktop, mobile, core, contracts) carry the canonical GPL-3.0 text as `LICENSE` and `"license": "GPL-3.0-only"`; the closed server is `UNLICENSED`. The in-app terms (section 2) now grant the GPL-3.0 instead of forbidding redistribution, and state that the kolo/hblabs names and logos are not licensed. The open-source notices show the full GPL text. The terms say source is provided under the GPL but give no URL yet; add one when the repository is public.

**Alignment:** in paired fields, when one label wraps (French), inputs now share a baseline (`.two-fields > .field` aligns to the end), except rows holding a customer/supplier search whose results list grows.

Desktop version is 0.1.14.

### Restore or join from the login page (2026-10-09)
The login page of an existing shop now offers **Restore a backup** and **Join a shop from another till** under "other options", as the first-run welcome screen already did. Both reuse the existing safe switch: the user types the current shop's name, that shop is kept as a saved shop (reopenable with its usual code), and the file is restored or joined into a separate empty slot. Previously restore was only reachable on a computer with no shop, so it was missing on any installation already in use. The `restore-file` workflow phase now also covers this path: run after `create` in the same directory, it restores from the login page and checks the previous shop is still listed. Desktop version is 0.1.15.

### Simplified desktop entry: one shop per computer (2026-10-09)
User decision: one shop per computer; the entry offers sign-in, forgotten-code recovery and import. Replaces the previous entry, which reached restore by two routes and offered saved shops, start-a-new-shop and join from several screens (including the login-page additions in 0.1.15).

- New computer: **Create a shop** or **Import a file**. Computer with a shop: login, **Forgot your code?**, **Import a backup**. Legacy tills: import a backup or start a new shop.
- `chooseImportFile` opens one native dialog and recognizes a backup or pairing invite by structure (anything else is `invalid_file`); `openBackup`/`openInvite` then use that file without a second dialog.
- Signed out on a computer with a shop, `restoreBackup` needs `replace: true` (otherwise `not_empty`). It validates the new code first, moves the current shop aside as a safety copy, restores into a fresh slot and, if the restore fails, selects the previous shop again. `nodeWorkspaceFiles` exposes `activeId()` for that rollback.
- Removed from the UI: saved-shops page and pickers, start-a-new-shop from login, separate join entry, the shop-name detour before restore. `savedShops`/`openSavedShop`/`startNewShop` remain in the bridge (support recovery of safety copies; legacy start-over).

Validation: new desktop host tests cover file recognition (backup, invite, malformed, cancelled, no second dialog), refusal without `replace`, malformed `replace` and an invalid code before any switch, replacement with a persisted safety copy, and rollback to the previous shop when the restore fails after the switch. The actual Electron workflow now checks the welcome screen offers exactly create/import, and replaces the fresh/saved-shop phases with `import-replace` (login → import → password → warning naming the current shop → restore → unlock → safety copy listed) and `import-reopen` (survives restart). Desktop version is 0.1.16.

### Units, list layouts and accent-insensitive search (2026-10-09)
- **Plural units:** `formatQuantityWithUnit`/`pluralUnit` (core `domain/money`) pick singular or plural with `Intl.PluralRules` (French keeps 0, 1 and 1,5 singular; English only 1) and pluralize shop-entered units ("24 sachets", "12 morceaux", "4 bocaux"; English "3 batteries", "0 boxes"). Symbols and abbreviations (kg, L, m², PCS, two letters or fewer, digits, full stops) and words ending in s/x/z are unchanged; only the first word of "sac de 50 kg" changes. Used for stock on product lists, minimum stock, count differences and till tiles.
- **Lists:** purchase and receipt history span the page; selecting a row adds the detail beside it (`.record-layout`). Receipt history is a table (date, short receipt number `V-` + last eight characters, customer, total; the receipt still shows the full number). `receipts()` now returns each sale's `totalMinor` and `customerName`, computed by the same rules as the receipt itself. Tables have no divider under their last row.
- **Search:** migration 21 adds `search_name` to products, categories, customers, suppliers and financial accounts: the name folded for accents, ligatures (œ, æ), curly apostrophes and ASCII case, backfilled on upgrade and kept current by insert/rename triggers. Catalogue, till and report searches compare it with the term folded the same way in JavaScript, so "cafe" finds "Café". Folding inside each query measured 139 ms per search on the 10,000-product benchmark; the stored key measures 13 ms (12 ms before the change). Tests run real SQLite: folding agreement between SQL and JavaScript for every mapped character, backfill, insert/rename triggers, wildcard escaping, and a digest pinning migration 21's SQL.

Desktop version is 0.1.17.

### Light analytics (2026-10-10)
A desktop **Analytics** section (nav entry for `reports.sales`) for one selectable period (today, 7 or 30 days, this month, this year, or custom days) with an optional grouping:

- KPI tiles: revenue, sales count and average basket with change against the previous equal-length period; gross profit, margin rate, expenses and net result with `reports.financial`.
- Sales over time as a line chart (revenue and gross profit on one currency axis), busy times as a weekday × hour heatmap with the busiest slot named, best sellers as ranked bars (by revenue, quantity or profit), sales by category and by payment account as donuts, top named customers as a table.
- Core `data/reports/analytics.ts` adds `profitTrend`/`salesTrend`, `salesActivity`, `productProfit`/`productSales`, `topCustomers`, `bucketKeys` and `defaultBucket`, wrapped in `application/reports.ts` under their own report permissions. Buckets use the shop's local offset in SQLite (`strftime` with a minutes modifier).
- Bridge: `analytics` (see the desktop analytics contract). New dependency: `recharts` 3.10.1 (with its `react-is` peer pinned to the React version). Chart colours are a fixed categorical order validated for colour-vision separation against the app's light and dark surfaces.

Validation: core tests (real SQLite) check that a trend sums exactly to `profitBetween` with bill discounts, uncosted lines and returns; local-day/hour placement across a UTC midnight; an oracle comparing SQL bucketing with the JavaScript calendar for random instants and offsets from −10:00 to +14:00; bucket enumeration and limits; product and customer rankings net of returns (including a product only returned); and permission denial for profit and customer figures. A desktop host test covers the assembled result, malformed requests and a sales-only actor receiving no profit or customer fields. The Electron workflow smoke opens Analytics and runs the axe audit in light and dark.

### Product photos and large files (2026-10-10)
- **Photos:** migration 22 adds `product_photos` (one per product, WebP/JPEG, ≤ 64 KiB, ≤ 512 px, SHA-256 digest, schema checks). Core `data/products/photos.ts` reads headers with `image-size` 2.0.4 and enforces a 16 MiB shop total; `application/photos.ts` adds `setProductPhoto` (products.edit), `removeProductPhoto`, `productPhoto`, `productPhotoDigest` and `photoUsage` (products.view). Photos are device-local: no exchange event, a local audit entry only. Desktop crops picked images to a 320 px square WebP in the renderer and shows them on the product page, product list and till tiles; products without a photo keep their initial.
- **Backups:** `createBackup` takes `includePhotos` (default true); the backup form has an "include product photos" box. Without it the snapshot drops `product_photos` before VACUUM.
- **Large files:** [ADR-027](../adr/ADR-027-large-files-and-product-photos.md). Transfer limits are a standard (unchanged) or large profile (1 GiB snapshot, 360 MiB payload, 496 MiB file; photo storage 256 MiB). Desktop Settings has an owner-only, per-computer "allow large files" switch stored in `preferences.json`. Readers check the active profile, including declared header lengths, before key derivation; the bounded file reader now allocates by file size rather than by cap. Mobile stays standard.

Validation: core tests cover header inspection (WebP, JPEG, PNG/SVG refused, bounds), store/replace/remove with audit and no exchange event, permission checks, scope, the shop limit (standard and large), schema checks, the 21→22 upgrade, backups with and without photos (restored and stripped), and a 33 MiB incompressible payload written and read under the large profile but refused under the standard one before key derivation. Desktop tests cover the photo commands, data URLs, malformed input, the owner-only switch and its persistence, and file reads past the standard cap. The Electron workflow smoke picks a 1200×800 PNG through the real file input, checks a 320×320 WebP is stored and shown on the product page and till tile.

### Logic and arithmetic audit fixes (2026-10-10)
An audit of the money and quantity rules before mobile work found the core arithmetic exact (BigInt intermediates, half-away-from-zero rounding, largest-remainder discount allocation, cumulative partial returns) and fixed the following.

- **Report breakdowns add up.** Sales by product, category, cashier and customer, product movement (fast/slow movers) and analytics product profit/sales were gross of whole-bill discounts and (except analytics) of returns, so they did not sum to `salesBetween`; analytics also left a discounted line's bill-discount share behind as revenue after a full return. Core `netSaleFacts` now values each sale line net of its allocated bill discount (`discountedLineTotals`, the allocation returns refund against) and each return line negative in its period; every breakdown is built from it. Sales by account is net of sale refunds; purchases by wholesaler is net of purchase returns. Busy-hours activity keeps counting sales where they were rung up.
- **Refunds are capped at what was settled.** A return's cash refund may not exceed `ReturnSource.refundableMinor`: the sale's payments (or a delivery's door payments, its total less what it left owing) less earlier refunds of the same original. The rest goes to the customer's or supplier's ledger. Enforced in the shared `applyReturn`, so replay agrees; desktop and mobile return forms show the limit. A shop that recorded an over-refund before this change would see that return refused on replay.
- **Mobile-safe plurals.** `formatQuantityWithUnit` no longer calls `Intl.PluralRules` (Hermes may lack it); the French/English rules are written out and checked against `Intl` at every thousandth from −3 to 3.
- **Cart and entry.** `view()` reports `INVALID_AMOUNT` for negative or fractional prices, discounts, quantities and payments instead of showing a total from them (a negative bill discount used to raise the total). `parseAmount` refuses grouping that mixes dots and commas ("1.000,500").
- **Stock counts per branch.** With more than one branch, `countStock` compares against the counted branch's movements; single-branch shops keep comparing the whole ledger.
- **Legacy v1 appliers** use the shared `saleTotals`/`purchaseTotals`, so an overpaid or over-discounted sale or delivery is refused instead of applied.

Not changed (policy, signalled in reports): profit counts no shrinkage from damage or count differences, and uncosted lines contribute revenue with no cost (counted in `linesWithoutCost`).

Validation: a seeded property test over real SQLite (random line and bill discounts, split and credit payments, partial and full returns crossing month boundaries) checks every breakdown against an independent BigInt oracle for four periods; regression tests for the fully returned discounted line, purchases by wholesaler, refund caps (credit sale, successive returns, purchases, replayed over-refund committing nothing) and branch-scoped counts; v1 applier refusals; cart and parsing cases; plural rules without `Intl.PluralRules`. The new report, refund and branch tests were run against the previous code and fail there.

### Mobile parity reorganization (2026-10-10)
Implemented the mobile parity plan's software stages A–G on the existing Expo app (see
[mobile](mobile.md) and the [parity checklist](mobile-parity.md)):

- Four permission-filtered destinations with stack navigation, predictable Back, discard
  confirmation, side rail and list/detail on wide screens; desktop-derived light/dark theme and
  shared native primitives; appearance stored beside language.
- Session generations own screens, drafts and async results. "Stay signed in" matches the desktop
  (on by default; keystore-held remembered user; Lock and turning it off forget it). With it off,
  leaving the app locks it, but pickers/share/print opened by KOLO keep the session.
- Two-step shop creation, file-type recognition for import, guided recovery/pending/joining, and a
  replacement restore that moves the active slot only on success.
- Three-step selling with stable checkout identity, change calculation and named credit; product,
  people, purchase, finance, expense and return screens with version checks and confirmations.
- All desktop report kinds and analytics via new core `application/report-views` (the desktop now
  delegates to it), native bar/trend/heatmap/share charts with figure tables; product photos via
  `expo-image-picker`/`expo-image-manipulator`; printing/PDF via `expo-print`; Backup & devices hub.
- Core: `application/records`, `stockLevels`, `productPhotoDigests`, product `categoryId` filter,
  photo commits invalidate `products`. Commit-triggered event sealing replaces the 3 s loop.
- Removed the superseded mobile screens and the unused legacy server-login screen.

### Verification

`npm run check`, `npm run bundle:mobile` and `npm run benchmark:mobile:host` (host baseline in the
parity guide). No installed Android build, native picker/print, TalkBack or device performance
check has run; those gates remain open.

### Additional product categories and Sell fixes (2026-10-10)
[ADR-028](../adr/ADR-028-additional-product-categories.md): one main category (reports) plus up to
20 others (browsing), migration 23, signed `PRODUCT_CATEGORIES_SET` under last-write-wins; mobile
and desktop product forms edit them and category filters match either. Mobile Sell lists the whole
catalogue when no search or category is chosen, tapping a product no longer opens the keyboard
(scans keep scanner focus), and inline quantity/discount rows share one label above the row.
Verified with core replica and desktop handler tests, `npm run check` and the Android bundle.

### Word search, running balances and till categories (2026-10-10)
Migration 24 adds an FTS5 index (`catalogue_search`, `unicode61 remove_diacritics 2`) over product
name/SKU/barcode/brand/description and customer/supplier name/phone/contact, kept current by
triggers. Searches match any word (all words required, the last as a prefix while still being typed)
beside the existing name-prefix and exact-barcode rules; typed operators are inert. Backups omit the
derived index and restore/pairing rebuild it. Statements carry `balance_minor`, the exact running
balance from a window sum over the whole ledger, shown on mobile and desktop. The desktop till has a
category filter (main or other category). JSON functions were reviewed and not adopted: only small
permission lists are stored as JSON. FTS5 is compiled into Node, Electron (SQLite 3.53.4) and the
expo-sqlite Android build; its installed-device behaviour still needs the native gate.

### Device reset, import crash and restored staff (2026-10-10)
- Reset (owner only, typed shop name and owner code): mobile Settings → "Réinitialiser ce téléphone"
  and desktop Settings → "Réinitialiser cet ordinateur" erase every shop file (active, safety copies,
  staging, slot pointer), the protected credentials they name (core `identity/device-reset`) and the
  remembered session, then reopen empty. Device preferences stay.
- Mobile crash after importing a backup: the replaced database was closed while the old screens could
  still query it, which aborts inside expo-sqlite. Replaced databases now close after those screens
  unmount, and the native adapter ignores a second close and refuses queries on a closed handle.
- Restoring another shop from Backup & devices used the same-shop path and was refused as another
  shop's file; it now uses the replacement path shared with the unlock screen.
- After a restore or pairing, staff codes belong to the other device: unlock lists (mobile and desktop)
  show only members with a code here, and mobile explains that the owner sets the others in Staff.

### Desktop renderer trust on short Windows paths (2026-10-10)
- The IPC trust check compared the sender frame URL with Node's `pathToFileURL` string. Node writes
  `~` as `%7E` while Chromium keeps it, so an install under an 8.3 short path (`C:\Users\RUNNER~1\…`)
  refused every command as `permission_denied`. `isRendererUrl` now compares decoded file paths
  (case-insensitive on Windows) and still refuses other files, schemes, queries and fragments. The
  installed-upgrade CI step is the Windows evidence.

### Local pre-push gate replaces the GitHub check workflow (2026-10-10)
- The "Active workspaces" GitHub workflow (`npm run check` + Metro export on every push) was slow and is
  removed. A husky `pre-push` hook, installed by `npm install` through the root `prepare` script, runs the
  same two commands locally and blocks the push on failure. Windows acceptance (`desktop.yml`) is now
  manual-only (run it before tagging); the tag release workflows still run on GitHub.

### App icons, README screenshots and Sell footer spacing (2026-10-11)
- App icon: a white K with the red brand dot on the sidebar green, drawn as SVG in `assets/brand`.
  `node scripts/render-icons.mjs` renders it with Electron to the desktop icon (`apps/desktop/build`,
  wired into electron-builder for the Windows `.ico` and Linux packages) and to the Android icon,
  adaptive foreground and Android 13 monochrome layer (`apps/mobile/assets`, wired into `app.json`).
- README screenshots: desktop images are reproducible with `node scripts/capture-desktop-screenshots.mjs`
  (demo shop, `readme-screenshots` workflow phase, private Xvfb display at 2x); Android images were taken
  on a Pixel 8 Pro. The `restore-file` smoke now selects Receipts at its new menu position.
- Launch: Android shows the K logo on brand green (`expo-splash-screen`) and holds it until the shop
  database has opened (or 8 s, after which the in-app spinner shows), replacing the default splash and the
  bare spinner. Desktop shows its window after the first paint. Both entry screens show
  "kolo <version> · made by hblabs".
- Mobile Sell no longer draws an empty, padded footer under "Scan or add a product to start" when the
  cart is empty. Verified on the installed Android build.

### Release-gate pass: advisories, Android checks, short sale numbers (2026-10-11)
- **Advisories.** `npm audit --omit=dev` reports 22 (14 high, 8 moderate), all in Expo/Metro build tooling
  (`@expo/cli`, Metro, config plugins, `xcode`); none is bundled into the APK. Their roots are `braces` 3.0.3
  and `node-forge` 1.4.0 (each already the newest published version, so no fix exists) and `uuid` 7.0.3 under
  `xcode` (the advisory covers `v3`/`v5`/`v6` with a caller buffer; `xcode` calls only `v4`). The audit's
  suggested fix is Expo 44 / React Native 0.72, a forced downgrade the plan rules out. No change; re-check at
  the next Expo SDK update.
- **Installed Android (Pixel 8 Pro, Android 17, release 0.1.2).** Checked over adb: the four destinations
  and Settings at 200 % system font scale (text wraps, nothing clipped, bottom bar labels fit); dark
  appearance in French on Sell, Products, Activity and Settings; a system theme change keeps the open screen.
  Changing the system font scale restarts the activity and returns to Sell. Measurements are in the
  [parity guide](mobile-parity.md#performance-baseline). Not yet run: TalkBack, photo pick/crop, print/PDF,
  "Stay signed in" off with Home/app switch, and the 10 000-product fixture on a phone.
- **Short sale numbers everywhere.** Desktop numbers are `V-<uuid>`, mobile numbers `V-YYYYMMDD-<12 hex>`;
  the desktop list shortened only its own form and mobile showed every number whole, so desktop and demo
  sales wrapped over three lines in mobile Activity. Core `domain/receipt-number` `shortReceiptNumber`
  recognises both and shows `V-` plus the sale ID's last eight hex digits, the same on every device. Desktop
  receipts list, mobile Activity and the mobile receipt title use it; stored numbers, the desktop receipt
  detail and printed receipts keep the whole number.
- **Unit plurals on mobile Products.** The product list and detail joined quantity and unit by hand
  ("Stock 77 canette"); they now use `formatQuantityWithUnit` like the desktop.

Verification: `npm run check` (new tests: both formats of one sale agree, 200 random UUIDs, malformed
shapes unchanged) and `npm run bundle:mobile`.

### Large fixture on a phone: two crashes and a broken report fixed (2026-10-11)
`npm run fixture:mobile` (`apps/desktop/scripts/mobile-fixture-backup.ts`) saves the 10 000-product
performance fixture as a genuine encrypted backup (password in its README) for restoring on a device.
Restoring it on the Pixel found:

- **Native abort when closing a shop database.** expo-sqlite's close finalizes every statement still
  linked to the connection, by default. Those include the FTS5 search index's own prepared statements
  (migration 24), which FTS5 frees again when it disconnects. The result is a double free (Scudo
  "invalid chunk state", SIGABRT in `closeDatabase`) whenever a connection closes after a search or an
  index rebuild: backup check, restore, replacement and device reset. A C program against system SQLite
  under AddressSanitizer reproduces it (one FTS5 query leaves 8 internal statements; finalizing them all
  and closing reports a double free). Every mobile connection now opens through one helper with
  `finalizeUnusedStatementsBeforeClosing: false`; the adapter finalizes its own statements. This is
  likely also the root of the earlier "crash after importing a backup".
- **Stock valuation, stock alerts, customer debt and supplier debt never loaded on mobile.** The phone
  asked for them from 1970, and `reportView` refuses periods longer than 3 700 days. Core now exports
  `UNDATED_REPORT_KINDS` and skips period validation for those kinds, which ignore it; mobile uses the
  shared set. A core test runs every kind from 1970: undated kinds equal their one-day result, dated
  kinds are still refused.
- **Stock alerts listed products that were fine.** In the alert query, `HAVING quantity<0` resolved
  `quantity` to the column `m.quantity` (one arbitrary movement) instead of the summed alias, so a
  product with stock left could alert because of a single sale (desktop and mobile). The sum is now
  aliased `on_hand`; a regression test fails on the old query.
- **Restore shows progress.** Reading the file, checking the backup and restoring each show a native
  spinner with what is happening (`Working` in the mobile UI kit). The step waits one frame first, so
  the spinner is drawn before the synchronous check starts. This applies to the entry screen and to
  Backup & devices.
- Measurements are in the [parity guide](mobile-parity.md#performance-baseline). Follow-up: the backup
  check takes about 84 s inside an open shop against about 10–16 s from the entry screen.

Verification: `npm run check`, `npm run bundle:mobile`, an installed release build that restores the
fixture without crashing, and the valuation report from a host restore of the same backup.
