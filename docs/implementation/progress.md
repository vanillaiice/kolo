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

### Per-architecture APKs and fingerprint unlock (2026-10-11)
- **Smaller Android downloads.** A local Expo config plugin (`apps/mobile/plugins/with-abi-splits.js`)
  builds arm64-v8a (44 MB) and armeabi-v7a (35 MB) APKs plus a universal fallback (87 MB, was 130 MB),
  with version codes `versionCode × 10 + 0/1/2`. The build and release scripts handle the three files;
  [releasing](../releasing.md#android-files-per-phone-type) says which file fits which phone. Settings →
  About shows the phone's architecture (`expo-device`).
- **Fingerprint or face unlock.** Each member can opt in on a phone (Settings → Fingerprint or face). Their
  remembered-session reference, never the code, is kept with `expo-secure-store` `requireAuthentication`,
  so Android releases it only after the system biometric check. The unlock screen offers the prompt once
  and as a button; success goes through `resumeWorkspace`, which still requires the same active member,
  device, business and credential. A changed code, owner recovery, restore or newly enrolled fingerprint
  makes it stale or unreadable: it is forgotten and the code is asked for. Android accepts any fingerprint
  registered on the phone, so the switch warns against shared phones, and the owner has a per-phone
  switch that removes every enrollment. Lock keeps the enrollment; device reset removes it.
  The prompt is offered only while KOLO is in front: with "Stay signed in" off the till locks in the
  background, and a prompt requested then is never shown or answered, which left the button disabled.
  A fingerprint attempt has its own busy state (the code path never waits on it), and an attempt still
  pending when KOLO returns to the front is abandoned. Verified on the Pixel: the prompt keeps KOLO's
  activity resumed, appears after Home and return, and cancelling leaves both unlock paths usable.
  Logic in `src/data/auth/biometric-unlock.ts` (tested with real SQLite preferences); the native port is
  `biometric-on-device.ts`.


### Stock valuation counts opening stock (2026-10-11)
Owner decision: stock is valued at its latest known cost. The costing method `LATEST_PURCHASE` is now
`LATEST_COST`: the unit cost of the most recent delivery or opening-stock movement that carries one, and
otherwise the product's purchase price. Opening stock entered on a product form records no cost of its
own, so a new shop's stock used to be worth 0 until its first delivery. Only a product with neither a
costed inflow nor a purchase price is reported as uncosted. Dead stock uses the same rule. Tests cover
opening cost against a later delivery and the purchase-price fallback giving way to a delivery.

### F6a sync server relay and propagated device trust (2026-10-11)

[ADR-029](../adr/ADR-029-sync-server-relay.md). The server is now AGPL-3.0-only (ADR-024 amended).

- **Contracts:** `DEVICE_TRUSTED`/`DEVICE_REVOKED` payloads; `contracts/sync` request/response schemas
  and enrollment/session signing messages; shared event/batch/receipt signing messages in `delivery`.
- **Core:** owner devices emit signed trust facts on register/revoke and `publishDeviceRoster` publishes
  earlier pairings once, so tills verify devices they never paired with. Batch import reports `untrusted`
  facts (not stored, not acknowledged), retries them after trust in the same batch, and never offers
  imported facts back to their sender. Migration 25 allows the `SERVER` platform (devices rebuilt under
  deferred foreign keys), adds roster revisions and `server_endpoints`. `server-sync` connects after
  fingerprint confirmation and runs bounded push/pull/receipt passes; `http-sync-transport` uses `fetch`.
- **Server:** Kysely/PostgreSQL forward-only migrations with an explicit `migrate` command;
  append-only journal, conflicts and receipts (triggers); enrollment code + owner-signed challenge;
  device-signed sessions stored as hashes; push/pull/receipts/bootstrap/status; tenant from the session
  only; `@fastify/rate-limit`; persistent `0600` identity file printed as a fingerprint at start.
  Dockerfile and self-host Compose keep the identity on a volume and migrate before serving.
- **Desktop:** Devices screen sync panel (check fingerprint, enroll or join, sync now, disconnect,
  status) in French/English; automatic passes in the main process each minute while signed in with
  shop-settings access, sooner after local changes, backing off to fifteen minutes.

### Verification

- `npm run check` with `KOLO_TEST_DATABASE_URL`: boundaries, typecheck, docs/links, builds and 812
  tests (8 contracts, 716 core, 54 desktop, 22 mobile, 12 server against real PostgreSQL 18).
  Server tests: three real SQLite tills converge through a real listener, including one paired after the
  others; replayed pushes, identity conflicts, forged proofs, cross-shop isolation, enrollment code and
  conflicts, revocation, size and rate limits, persistent identity. Core tests add trust propagation,
  revision ordering, unauthorized roster facts, and a populated schema-24 upgrade with `foreign_key_check`.
- `npm run bundle:mobile` passed. `npm run smoke:server` passed (image tests against fresh PostgreSQL).
  Live image run: migrate, serve, fingerprint unchanged across restart with the identity volume.
- `npm run smoke:desktop` passed. `npm run smoke:desktop:workflow` hangs in its first phase both with
  and without this change in this environment (checked on the stashed baseline); not investigated here.
- Desktop end-to-end against the running built server and PostgreSQL (temporary script, not kept):
  fingerprint check, wrong fingerprint and enrollment code refused with their codes, grouped
  upper-case fingerprint accepted, enrollment, sale pushed, idle second pass, status, disconnect.
  This found that the protected key store refused the new claim domains; `kolo.server-enrollment.v1`
  and `kolo.server-session.v1` are now on its signing allowlist (desktop regression test added).
  Fixture signers in server tests had not exercised that allowlist.
- The listen address is `KOLO_HOST` (default `127.0.0.1`). It was `HOST`, but some shells export
  `HOST` as the machine name, which made `npm run dev:server` fail with `ENOTFOUND`.
- Not verified: installed Windows/Android tills against a real server, TLS deployment, mobile UI
  (pending), several server instances (rate limits are per instance).

## 2026-10-11: End-to-end encrypted sync, connection codes and operator dashboard (F6b, F6c)

The user chose end-to-end encryption and single-use connection codes ([ADR-030](../adr/ADR-030-end-to-end-encryption-and-connection-codes.md))
and asked for both, plus the operator dashboard, to be built.

Implemented in this change:

- **Contracts:** `kolo.sync-batch` v1 with clear or sealed facts, `CLEAR_EVENT_TYPES`, sealed-event and sealed-key
  additional data, connection-code format/parse, and the `DEVICE_ENCRYPTION_KEY`, `SHOP_KEY_GRANTED`,
  `SERVER_ENDPOINT_SET`/`CLEARED` payloads.
- **Core:** migration 26; vault `encryptionKey`/`agree` (X25519 key beside the signing record);
  `application/sealed-sync` (announce key, owner key grants and rotation, seal/open, sync batches); the sync engine now
  seals on push, opens on pull, runs a second round when keys change, connects by code or by the owner's shared address,
  and records per-till opt-out. Delivery gained shared `recordOffer`/`importAuthenticated` helpers and a `locked` outcome.
- **Server:** migrations `0002_sealed_sync_and_codes` (sealed journal rows, clear-type constraint, connection codes, shop
  status; refuses F6a plaintext business facts unless `migrate --discard-plaintext`) and `0003_admin` (operators,
  sessions, append-only audit, purge-only deletion); enrollment by code; suspension/removal enforced on every request;
  CLI `invite`, `admin create`, `admin reset-totp`, `purge`; `KOLO_PUBLIC_URL`; hourly purge after 30 days.
- **Operator dashboard:** `apps/admin` (React/Vite, AGPL) served on a separate loopback listener with scrypt + TOTP
  sign-in (single use, lockout), viewer/admin roles, origin checks, strict CSP; codes with QR, shops, suspend/resume/
  remove/restore, health and audit with CSV export. Dependencies added: `otpauth` 9.5.2 and `qrcode` 1.5.4 (server).
- **Desktop:** paste-a-code connection (fingerprint taken from the code), automatic connection from the owner's shared
  address with a notice, owner share code, waiting-for-key counts, new refusal texts; native X25519/HKDF adapter.
- **Mobile:** native X25519/HKDF adapters only; the connection screen followed later the same day (next entry).

Also in this change: the server logs one JSON line per request at `KOLO_LOG_LEVEL` (default `info`, never bodies or
headers), and the desktop sync panel shows progress labels and form spacing.

### Verification

- Server, against real PostgreSQL 18 (`KOLO_TEST_DATABASE_URL`): 19 tests pass, including convergence of three tills
  that never met with a search of every stored journal, conflict and receipt row for product names, sale numbers, the
  shop name and event types (none found); held-back facts until a key is granted; replay and re-sealing as duplicates;
  `plaintext_refused`, forged clear facts and forged sealed facts (refused by every till without blocking the page);
  cross-shop isolation including opening another shop's sealed facts; codes used once, expired, cancelled, claimed by
  another device; shared address and opt-out; revocation with epoch rotation the revoked till cannot open; suspension,
  removal and purge; the plaintext migration refusal and `--discard-plaintext`; operator sign-in, TOTP replay, lockout,
  idle expiry, reset, viewer refusal, foreign origin, code issue/cancel, shop actions, audit, static path traversal.
- Core: sealed-sync unit tests (grants, header binding, rotation, forged key/grant/address facts, address revisions);
  contracts: connection-code fuzzing and sealed shapes; desktop: vault X25519 persistence and agreement, RFC 5869 HKDF
  vector, code validation and refusal mapping.
- Live smoke on a throwaway database: `migrate`, `admin create`, `invite`, serve, dashboard page with CSP, TOTP sign-in,
  code issue with QR, health; the public sync port does not serve the dashboard. Dashboard screenshots checked in Electron.
- Not proven: installed Android X25519/HKDF through react-native-quick-crypto, Windows vault, packaged desktop against a
  hosted HTTPS server, and the Docker image build with the dashboard.

## 2026-10-11: Phone server sync and hosted subscriptions (F6 mobile, F7)

The user asked for server sync on the phone, then the server's remaining features; they chose manual billing with one
plan per shop ([ADR-031](../adr/ADR-031-hosted-subscriptions-manual-billing.md)).

Implemented in this change:

- **Mobile:** Backup & devices → Sync server: paste a connection code, check it (fingerprint from the code), connect;
  last sync, waiting count, subscription status, sync now, stop (remembered), support details, and on the owner's main
  till a share code sent through the Android share sheet. A background loop while signed in and in the foreground syncs
  every minute, soon after local changes and on return to the app, and follows the owner's shared server address.
  Sync refusals have their own French/English texts. No QR scanning (it would need `expo-camera`).
- **Core:** `ServerSyncScheduler` (shared by desktop and mobile; the desktop's `AutoSync` re-exports it); client
  migration 27 and `entitlements` on the transport, read before each transfer so a paused till learns why.
- **Server:** `KOLO_EDITION`, `KOLO_GRACE_DAYS`, `KOLO_BILLING_WEBHOOK_SECRET`; migration `0004_hosted`; `GET
  /api/v2/entitlements`; transfer refused with `hosted_service_inactive` after grace; payments recorded in the dashboard
  (append-only, audited) or by the signed, idempotent generic webhook; codes with paid months; `invite --months`.
- **Dashboard:** subscription column, shop subscription with payment form and history, paid months on codes, edition.
- **Desktop:** subscription status and expiry texts, support details.
- **Self-hosting:** compose settings for edition, ports and proxy; `infrastructure/Caddyfile.example`;
  `infrastructure/backup.sh`/`restore.sh`; [self-hosting guide](selfhost.md) with upgrade/rollback and support answers.

### Verification

- Server on real PostgreSQL: 24 tests pass, including expiry pausing transfer while tills keep trading, grace, renewal
  delivering both tills' held facts, early renewal extending from the paid end, codes with months, payment validation
  and append-only rows, purge of payments, the webhook (signature, staleness, idempotent retry, conflict, absent on
  self-hosted servers) and the dashboard payment API (viewer refused, history, grace date).
- Mobile: 23 tests (sync refusal texts in both languages), typecheck and Metro bundle. Desktop: 56 tests.
- Docker Compose drill on separate ports: clean install, migrate, operator, code, a till syncing 11 facts, backup,
  `down -v`, fresh empty server with a new identity, restore, original fingerprint back, the same till resyncs with
  nothing missing and no error.
- Not proven: the phone screens on an installed Android device against a real server (needs the user's phone and the
  firewall port), a real payment provider, and HTTPS through the Caddy template.

## 2026-10-11: Adding a till by code, QR scanning and desktop menu order (ADR-032)

Prompted by pairing a real phone: the file flow was judged too long for shops. Implemented:

- **Join by code:** server migration `0005_join` and `/api/v2/join` mailboxes; core `application/join` (`startJoin`,
  `pollJoin`, `approveJoin`, `endJoin`, `lookupJoin`, `requestJoin`, `finishJoin`); desktop Devices → Add a till shows a
  code and QR, then the new till's name to Allow or Refuse, with file pairing under "No internet? Use files"; phone
  welcome screen gets "Join a shop" (scan the QR or type code and address, name the phone, choose its code, wait) and the
  phone's Add a till gets the same owner flow. After joining, the phone connects to the server it joined through.
- **QR scanning on the phone** with `expo-camera` (~57.0.6, Expo-matched), for join codes and server connection codes.
- **Fixes found on the real phone:** Android release builds blocked plain `http://` (config plugin `with-lan-http`; the
  app still refuses plain HTTP outside loopback and private networks); "Reset this phone" failed the next start after
  SQLite removed WAL files it then tried to delete; a second authority till of an attached shop was refused
  (`enrollment_conflict`) instead of joining; an authority till could create a second shop key before receiving the
  first (keys are now managed after pulling and created only when the shop has none); snapshots carried the source
  till's own server connection rows; the desktop warned about a missing token when reconnecting an attached shop.
- **Desktop menu order:** Settings → Menu order (up/down, default) and drag-and-drop in the sidebar, per computer.

### Verification

- Server on real PostgreSQL: join by code end to end (empty till with the real vault and snapshot files receives the
  shop, connects on its own, gets the shop key and later sales), forged invite tag, forged request tag, refusal,
  non-authority refused; second authority till joins without a code; all server tests pass.
- Installed on the user's Pixel 8 Pro (release APK): file pairing into the desktop shop, server check over LAN HTTP after
  the cleartext fix, then a reset and a real join by code: the phone scanned the desktop's QR with the camera, the owner
  allowed it on the desktop, the shop opened on the phone and it synced with the LAN server.

## 2026-10-11: Bilingual public landing page

Implemented the user-approved static landing page in `apps/landing`, with iOS,
Google Play and F-Droid explicitly marked as coming later:

- Plain HTML/CSS and progressive browser JavaScript, generated by Node without new
  dependencies. Shared layout and matching English/French content files generate
  complete language-specific pages; the root has a no-JavaScript language chooser.
- Existing KOLO branding, locally served Inter, optimized real demo screenshots,
  accessible enlargement dialog, practical feature copy, offline/sync explanation,
  downloads, developer/self-hosting links, promoter assets and FAQ.
- Download links use a saved public GitHub release snapshot, including published
  prereleases and each app's actual version. Explicit refresh command, missing-asset
  fallback, and tests for drafts, historical tags and invalid/mismatched assets.
- Optional real video hook with poster, bilingual captions and no autoplay; no demo
  video has been supplied. Build-time public URL enables canonical/share metadata
  and sitemap. Static output can be served at a domain root or under a subpath.
- Root build/check integration and maintainer guide. README status now reflects
  Linux builds and implemented optional encrypted sync.

### Verification

- `npm run check:landing`: translation parity, generated local links/anchors/media,
  font assets, future-platform labels and release-selection tests passed.
- Real Electron browser checks: English/French at 1440, 768, 390 and 320 px, without
  horizontal overflow, broken loaded images or axe WCAG A/AA violations. Screenshot
  enlargement, close, FAQ, saved-language redirect and loading without JavaScript
  passed. Desktop/mobile screenshots visually reviewed.
- Published Windows installer, Linux AppImage and universal Android APK links
  followed to HTTP 200; deployment URL/share metadata and sitemap generation checked.
- Repository boundaries/typechecks, client tests, release checks, documentation
  checks, app builds and mobile Metro bundle passed. The initial `npm run check`
  stopped at the server liveness test because the sandbox blocked its loopback
  listener; rerunning the server suite with local networking passed (5 passed,
  23 PostgreSQL-dependent tests skipped without a test database).
- No hosting deployment or commit performed. See `apps/landing/README.md` for preview,
  release refresh, content/media updates and static deployment instructions.

## 2026-10-12: Sitemap, robots and bilingual website policies

Added English/French privacy and cookie pages with footer links, canonical URLs
and matching language alternates. They cover the website's actual browser storage,
self-hosting requests/logging, locally served assets and external GitHub links.
The user supplied `kolo.hblabs.xyz`, `contact@hblabs.xyz` and self-hosting on their
server; these live in `apps/landing/content/site.json`. Server-log retention remains
unconfirmed and configurable rather than specifying an invented period.

Every build now generates `sitemap.xml` and `robots.txt`, listing the root,
two landing pages and four policies. Sitemap entries include language alternates.
A public-URL environment override still supports other domains or subpaths.
Language preferences are saved only after an explicit EN/FR choice; the cookie
page can clear them without subsequent page visits recreating the value.

Verification: `npm run check:landing`, JavaScript syntax and whitespace checks
passed. XML parsing confirmed seven public sitemap routes and valid bilingual
links. All four policy pages passed real-browser layout and axe WCAG A/AA scans
at 1440, 390 and 320 px. Preference removal, subsequent navigation, language
switching on a policy page and loading without JavaScript passed. The running
Python preview serves the rebuilt site; nothing has been deployed.

## 2026-10-12: PostgreSQL server tests in the push gate

`npm run test:server:pg` (`scripts/test-server-postgres.mjs`) starts a throwaway `postgres:18` container on a random
loopback port, runs the server suite with `KOLO_TEST_DATABASE_URL` and removes the container. The pre-push hook runs it
when Docker is reachable. First run: 28 passed, 0 skipped (previously 23 skipped without a database).

## 2026-10-12: Tax included in prices, payment terms and alerts (ADR-033)

The user chose tax-inclusive prices, payment terms in days, in-app alerts plus desktop system notifications, and four
alert kinds (stock, overdue customers, supplier payments, cash differences and sync).

- **Core:** contracts `TAX_SETTINGS_SET`, `PRODUCT_TAX_SET`, `PAYMENT_TERMS_SET` (new event types, so older tills keep
  them unsupported); migration 28 (`shop_tax_settings`, `product_tax_rules`, `payment_terms`, `notification_state`,
  the last cleared from snapshots); `rules/tax` and `rules/terms`; `operations.setTaxSettings`, `setProductTaxRule`,
  `setPaymentTerms`; sales stamp the effective rate per line; receipt `tax` groups; `tax` report kind;
  `application/settings` reads; `application/notifications` with per-user read/announced marks; `rateEntry`,
  `rateInput`, `formatRate`.
- **Desktop:** ten bridge commands (`electron/settings.ts`), Settings tax/terms panels and a per-computer
  system-notification switch, product tax rule, customer/supplier due dates, receipt tax lines, "Tax collected"
  report, topbar Alerts with system notifications through the renderer's Notification API.
- **Mobile:** More → Alerts with unread count, Settings → Shop → Tax and Payment terms, product Tax, person due dates
  and own terms, receipt (screen, share text, print) tax lines, tax report.

### Verification

- Core: 19 new tests: exact BigInt oracle for included tax over boundaries and 5,000 random cases; property test that
  groups add up to sale totals under random discounts; oldest-first oracle over 3,000 random ledgers; operations,
  permissions, LWW, invalid input with no writes; tax report equals net sales after returns; migration 27→28 on a
  populated schema; snapshot sanitize; two-replica relay with LWW, duplicates and forged/invalid facts quarantined;
  notifications by kind, permission, fingerprint and marks. Rate entry/format round-trip for all 10,001 rates.
- Desktop: 2 new host tests over real SQLite (versioned edits, retries, permissions, dispatcher). Mobile: receipt output
  tax lines. Typechecks, Metro Android export.
- `npm run check` (742 core, 60 desktop, 24 mobile tests), `npm run test:server:pg` (28/28) and the Electron workflow
  smoke pass. The smoke now enables tax and terms in Settings, opens Alerts, the tax report, the product tax rule and a
  customer's due dates, with axe WCAG A/AA audits in light and dark. Auditing product detail for the first time found
  the photo editor's hidden file input had no accessible name; it now has one and is out of the tab order.
- Not verified: rendering of the new screens on an installed Android phone or Windows; native notification display
  (Electron's Notification on Windows/Linux); Android system notifications are not built.

## 2026-10-12: Android notifications for alerts

The user asked for Android system notifications if not difficult. Added `expo-notifications` (SDK 57 match, local
notifications only, no Firebase/push) with its config plugin (monochrome status-bar icon). `data/output/
notifications-on-device.ts` is the only module importing it; a per-phone `systemNotifications` device preference (on by
default) is switched in Settings and on the Alerts screen, which asks Android 13+ for permission through
`session.systemUi`. While the shop is open, the shell rereads alerts on changes, every five minutes and on return to the
foreground, raises new unread ones once (three, then a summary) and marks them announced; a tap opens More → Alerts.
No background task: a closed or killed app raises nothing.

Verification: Android release build (`npm run build:mobile:android`, with ANDROID_HOME set) produced the three APKs and the
merged manifest declares POST_NOTIFICATIONS; mobile typecheck, 24 mobile tests, Metro export, boundaries; `expo config` introspection shows the
notification icon/colour resources. Not verified on a device: permission prompt, channel, banner and tap navigation.

## 2026-10-12: `kolo` CLI (offline tooling and headless till)

Implemented by the user; reviewed here. `apps/cli` (`npm run kolo -- --help`):

- **Offline (step 1):** `report`, `export` (JSON/CSV, formula-neutralized), `check` (SQLite integrity, foreign keys,
  stock-ledger and cross-shop scope, journal/outbox/delivery state) on a private read-only copy of a standalone SQLite
  file (WAL/SHM companions refused) or a verified encrypted backup; `backup verify|inspect|decrypt`; `demo` and
  `fixture` build signed, restorable shops through core's authorized operations. Outputs are created exclusively with
  mode 0600; passwords only from `KOLO_BACKUP_PASSWORD` or a password file.
- **Headless till (step 2):** `kolo till` is its own paired device (file pairing or join code with the owner's
  Allow) with a 0700 state directory, AES-GCM file vault and process lock; sync, file exchange, permission-checked
  product/price/stock imports (atomic, idempotent by job ID with deterministic event IDs), live product export,
  reports and backups.

Review: 6 CLI tests pass (pairing across restarts, duplicate/altered imports, rollback of a partly invalid batch,
interrupted signing resumed, revoked permission via exchange, vault without plaintext keys, unsafe state refused,
join fingerprint pinning, sealed sync). Manual run: demo → inspect → reports with periods → check → CSV export →
decrypt (0600) → report/check on the copy; overwrite, missing input, unknown report, invalid date and wrong password
fail with exit 2. Boundaries and documentation checks pass. Not verified: a headless till against a real deployed
server, Windows ACL behaviour of the state directory.

## 2026-10-12: CLI in the test infrastructure

- **Shared integrity checker:** `kolo check`'s checks moved to `core/data/database/integrity` and gained credit-sale
  debt, return-beyond-original and tax-rule scope invariants, with corruption/attention severities. Core suites,
  desktop host tests and the server's PostgreSQL tills now assert consistency in teardown (`closeConsistent`).
  Enabling it flagged another device's origin counter copied into a paired/restored till; that row never allocates
  (restores and re-pairs get new device IDs), so the counter check is now limited to the database's own till.
- **Electron smoke cross-check:** the workflow smoke verifies the app's real backup with the CLI (signature,
  integrity, sales report of 2 sales / 250 FCFA).
- **End-to-end sync (`npm run test:e2e`):** disposable PostgreSQL, built server process, owner till and a CLI
  headless till joining by code; import → owner → sale → CLI convergence over HTTP, no plaintext in `pg_dump`, both
  tills consistent. Added to the pre-push hook when Docker is reachable.

Verification: core 745 (3 new), desktop 60, CLI 9 tests; `test:server:pg` 28/28; Electron workflow smoke with the backup
cross-check; `test:e2e` passed, and a deliberately wrong expectation made it fail and clean up its container.

## 2026-10-12: Server tests on PGlite by default

The 23 server tests that needed `KOLO_TEST_DATABASE_URL` skipped in every `npm test`/`npm run check`. Without that
variable, `freshDatabase()` now starts an in-process PGlite (`@electric-sql/pglite` 0.5.8) behind
`@electric-sql/pglite-socket` 0.2.11 (wire protocol, 16 multiplexed connections), one instance per fresh database in
place of `CREATE DATABASE`; the server's `pg.Pool` and the tests' `pg.Client` helpers are unchanged. Both are exact,
dev-only server dependencies (two packages, about 26 MB) and are imported lazily, so the production image and
real-server runs never load them. `kysely-pglite` was rejected: unmaintained since 2024 and it ships a CLI toolchain.

Verification: `npm test -w @kolo/server` 28 passed, 0 skipped (about 26 s); `npm run test:server:pg` 28/28 on
PostgreSQL 18; `npm run smoke:server` passed in the built image. No test needed a PGlite-specific skip.

## 2026-10-12: Microsoft Store package for Windows

The user chose the Store (free, Microsoft signs) over SignPath or a certificate to avoid the SmartScreen warning.
`appx` settings in `apps/desktop/electron-builder.json` (identity placeholder `hblabs.KOLO`, French/English, brand
background), Store tile/logo images in `apps/desktop/build/appx` generated from the icon, `npm run dist:desktop:store`,
an unsigned `KOLO-x.y.z-win-x64-store.appx` built from the tagged release's unpacked app and uploaded as the
`kolo-desktop-msstore` Actions artifact (not to the GitHub release, so the publish gate is unchanged), and a validation
build in the manual Windows acceptance workflow. The Partner Center identity comes from the `KOLO_STORE_IDENTITY_NAME`
and `KOLO_STORE_PUBLISHER` repository variables. See [releasing](../releasing.md#microsoft-store-windows).

Verification: the builder configuration passes electron-builder's schema in a Linux unpacked build; workflow YAML parses.
Not verified: AppX needs Windows' `makeappx`, so the package has not been built yet (first run is the Windows workflow);
Partner Center certification, Store install, and the shop's data in the virtualized `%APPDATA%` (separate from an NSIS
install and deleted on uninstall) are unchecked.

## 2026-10-12: Desktop QR pairing refresh and customer debt clarity

The reported Windows 0.4.0 pairing screenshot shows the no-server file fallback. Connecting or disconnecting a
server now explicitly notifies the shell after the endpoint is persisted, including reconnects to an already
trusted server. This prevents the pairing panel from staying on the file workflow. The panel offers a direct
connection-form button when no server is configured, exposes server-state errors with retry, and handles QR
generation failures while retaining the short code and address.

Checkout offers **Set as debt** with an explicit money-received field and zero-payment default. **Pay now** uses
the selected customer's existing prepaid balance to reduce the automatic payment. Shared settlement arithmetic
distinguishes credit consumed from new debt and shows the resulting balance. An optional expected-balance hint
refuses stale new checkouts without writing anything; saved retries remain idempotent. The selected customer is
reread after changes/conflicts. Cash movements still represent actual money received; consuming prepaid credit
does not create another cash payment.

Receipt history shows full total, money received at checkout and the amount posted to the account. Customer
statements show the originating receipt and those totals alongside the signed movement, credit used, new debt
and labelled balance. Receipt account impact is reconstructed in the statement's historical order and requires
`customers.view`; later payments/purchases do not replace an earlier receipt's balance with the current balance.
Existing immutable records, signed sale events and schemas are preserved.

Verification: `npm run check` passed (including core 748, desktop 62 and server 28 tests), Android Metro export
passed, and the actual Linux Electron workflow passed with light/dark accessibility audits. The added UI drill
records a 600 FCFA advance, a 500 FCFA purchase fully covered by it, then another 500 FCFA purchase with no new
payment: the remaining 100 FCFA credit is used and only 400 FCFA becomes debt. Historical receipt/statement
checks and the CLI backup integrity/report cross-check passed. Full server tests and Electron required execution
outside the filesystem/network sandbox for local ports and Chromium. Installed Windows verification remains open.

## 2026-10-12: Direct local QR pairing and synchronization without a server

The user clarified that the Windows 0.4.0 till was standalone, with no server configured, and requested QR
pairing/sync in that mode. [ADR-034](../adr/ADR-034-local-network-pairing-and-sync.md) accepts a desktop-hosted
local-network transport over the same Wi-Fi/hotspot, without internet, a separately installed service or
PostgreSQL. Desktop now shows a local QR by default; a phone scans it and a new PC can paste its link on the
entry screen. Existing connected-server joining and encrypted file exchange remain available.

The app-local listener opens only after local pairing is enabled, persists its chosen port, closes on lock,
shutdown and shop switch, and resumes on that port while the enabled shop is unlocked. Owner approval,
signed requests, sealed random snapshot passwords and verified atomic activation reuse the existing pairing
protocol. A verified staging database receives its host address before activation. QR mailboxes expire in ten
minutes, reject replacement requests and can be cancelled; the owner sees the requesting device's name.

Direct exchange encrypts existing signed journal batches/receipts with native X25519, HKDF and AES-GCM, signs
the complete packet with the installation's Ed25519 identity, and binds replies to their request IDs. The
existing tenant/origin/actor/trust/digest/dependency checks remain authoritative. Lost replies, duplicate
requests and offline sales preserve exact stock, debt and cash. The new bounded signing domain is explicitly
allowed in the protected vault. Literal private IPv4 addresses, refused redirects/browser origins, bounded
requests and concurrency limit exposure. Migration 29 adds only installation-local network settings/status;
they are removed from backups/enrollment snapshots and incoming snapshots must not carry them.

Foreground clients synchronize each minute and soon after local changes, with manual sync/status and host
address editing on mobile. The host and clients require a signed-in member with shop-settings access. The
main desktop must remain open and unlocked. Mobile hosting, Bluetooth and discovery are not implemented.

Verification: full `npm run check` passed (contracts 12, core 748, desktop 65, mobile 24, server 28, CLI 9;
release and landing checks also passed), final Android Metro export passed, and the desktop/CLI builds passed.
Real SQLite/OpenSSL/HTTP tests paired two installations, exchanged independent sales both ways, dropped a
reply after commit, retried without duplication, checked listener lock/unlock and stable port, and rejected
wrong fingerprints/codes, cancelled/unapproved joins, browser origins, tampered packets and mismatched replies.
Snapshots sanitize local addresses/listener state. The actual Linux Electron workflow displayed a local QR
with zero connected servers, passed light/dark accessibility audits, existing shop workflows and the CLI backup
integrity/report cross-check. The compositor sometimes withheld animation frames: smoke-only foreground/
background-throttling settings and a bounded frame wait prevent hanging while retaining CSS/accessibility
assertions. Physical Windows firewall/installed-package and Android camera/Wi-Fi acceptance remain open;
both installed apps need updated builds to use the new local QR protocol.

## 2026-10-17: Binary chunked container, one size limit, no JSON files

The user asked for a more consistent and predictable backup format, then decided (still in beta) to drop
the two size profiles and the old JSON files. [ADR-035](../adr/ADR-035-binary-encrypted-container.md)
replaces the JSON/base64 envelope with a binary container (format version 3) for backups, enrollment
snapshots, exchange bundles and receipts: an 8-byte magic, a canonical printable-ASCII header, then the
deflated content in 1 MiB AES-256-GCM chunks (STREAM: nonce = 7-byte random prefix, chunk counter, final
flag; the header is every chunk's additional data). PBKDF2/AES-GCM/password rules, snapshot framing and
validation are unchanged. SQLCipher (no compression, a different SQLite build per runtime) and age
(JavaScript crypto, against ADR-022) were considered and rejected.

- **No legacy files.** Version 1/2 JSON files are `invalid_file`, refused before key derivation and not
  recognized by the file-kind check. Beta users need a new backup from this release; older releases cannot
  read the new files.
- **One size limit** on desktop and phone (`TRANSFER_LIMITS`): 1 GiB snapshot, file bound 1 MiB above the
  content. Exchange bundles/receipts are bounded to one 8 MiB batch; a join-mailbox enrollment to 48 MiB of
  base64 (`MAX_JOIN_ENROLLMENT_CHARS`). Product photos: 256 MiB per shop. The desktop "large files" switch,
  its IPC command, `preferences.ts`, `SnapshotPort.limits()`, `limitsOf` and the CLI's large-profile
  options are gone; a leftover `preferences.json` is ignored.
- Core APIs take and return file bytes: `TransferDocument.bytes`; `previewBackup`, `completePairing`,
  `previewBundle`, `importReceipt` and the invite/request functions take `Uint8Array`. `TransferCrypto`
  gains `sealBytes`/`openBytes`, implemented once in `nativeTransferCrypto`.
- Names drop `.json` (`.kolo-backup`, `.kolo-enrollment`, `.kolo-exchange`, `.kolo-receipt`); invitations
  and requests keep theirs. `@kolo/core/backup/file-kind` recognizes files for desktop and mobile (the
  mobile-only module is gone). Join mailboxes carry an enrollment container as strict base64.

Measured on the 10 000-product fixture (77.4 MiB image): the file shrinks from 16.9 MiB to 12.7 MiB
(13 chunks); host decryption takes 0.32 s and about 143 MiB over baseline, against about 170 MiB before.

Validation: `encryption.test.ts` checks the format against an independent implementation of the ADR written
with Node `crypto`/`zlib`, in both directions, across chunk sizes and exact chunk boundaries; a fixed version 3
file; every single-byte change and every truncation of a multi-chunk file; reordered, duplicated and spliced
chunks; misplaced final flags; non-canonical, non-ASCII, unknown-field and out-of-range headers (no key
derivation); file/content limits before key derivation and the single limit's room for incompressible
content; deflate bombs; seeded random and mutated inputs; a real version 2 file from the previous release
refused before key derivation; file-kind recognition and the base64 carrier. Integration tests refuse a
re-wrapped JSON backup (core, desktop import) and a JSON join enrollment through the real server (nothing
installed, the join can still finish), bound exchange files to one batch, and check the mailbox holds base64
of a container. Photo tests fill the 256 MiB budget directly and check the next photo is refused.
Full `npm run check` passed (contracts 12, core 763, desktop 64, mobile 22, server 29, CLI 9, release and
landing) and `npm run bundle:mobile` passed. Not run: the Electron workflow smoke and the Docker end-to-end
sync (both updated for the new names). Saving and opening `.kolo-*` files through installed Android/Windows
pickers, and backups near 1 GiB on real devices, are not yet verified.

### Container revision proposed; backup recovery key (2026-10-17)

Two external reviews approved the container and end-to-end streaming, and asked for envelope encryption
before unattended backups. [ADR-035](../adr/ADR-035-binary-encrypted-container.md) is now **proposed**
with key slots: a random per-file key, an Argon2id password slot (NFC-normalized passwords) and an RFC 9180
HPKE recipient slot, with an immutable prefix as every chunk's additional data and a separately
length-delimited slot section. [ADR-036](../adr/ADR-036-shop-backup-recovery-key.md) proposes a shop-wide
backup recovery key, separate from the per-till PIN recovery code (owner's choice): shown once, never
stored, its public key pinned through an owner-signed `SHOP_BACKUP_KEY` fact. The single-key container
described above is what the working tree implements; milestone 1 replaces it after the ADRs are reviewed.
Found while checking: Android auto-backup is not disabled (Expo default), so plaintext staging snapshots
and possibly the business database can reach the user's cloud device backup; milestone 1 covers it.

### Milestone 1, steps 1–2: primitives and the key-slot container (2026-10-17)

The second review approved ADR-035/036 in principle; its points are folded in (Argon2id parameters per slot within
bounds, the immutable `recipients` list for detecting removed slots, mandatory manifest checks because HPKE gives no
authorship, sync-key continuity after losing every till, Android `allowBackup` and device-transfer rules).

- **Primitives.** `TransferCrypto` gains native `hmacSha256`, `x25519` and `argon2id` (Node/OpenSSL on desktop, CLI and
  server; react-native-quick-crypto on mobile). `@kolo/core/backup/hpke` implements RFC 9180 single-shot base mode
  (DHKEM-X25519, HKDF-SHA256, AES-256-GCM); X25519 public keys come from the native agreement with the base point, so no
  key export is needed. Passwords are NFC-normalized; Argon2id 64 MiB/3/1 is provisional pending an Android measurement.
- **Container.** Content header (prefix, every chunk's additional data) plus a length-delimited key-slot section;
  a random per-file key; password slots (Argon2id) and recipient slots (HPKE). `encryptTransfer`/`decryptTransfer`
  still accept a password string; `{ password, recipients }` and `{ recoveryKey }` add the recovery path;
  `inspectContainer` reads purpose and slots without secrets. New error code `invalid_recovery_key` (desktop/mobile text).
- **Recovery key encoding.** `@kolo/core/backup/recovery-key`: 32 random bytes as 56 Crockford symbols with a 20-bit
  checksum, forgiving input (case, spaces, O/I/L), RFC 9180 `DeriveKeyPair`, a pinned key-ID derivation.

Tests: RFC 9180 vectors for both AES-GCM sizes (key pair, encap/decap, key schedule, ciphertext) and the RFC 9106
Argon2id vector; composed/decomposed accents, Hangul, other scripts and emoji; an independent implementation of the
new layout in both directions; a regenerated golden file opening with its password and its recovery key; every
single-byte change (prefix, records and the slot in use refused; another slot never alters content); truncation,
reordering, splicing, slot transplanting and swapping; canonical/ordered/bounded sections with no key work; adding and
removing slots without re-encryption; every single-symbol typo and adjacent swap of a recovery key caught. Full
`npm run check` passed (contracts 12, core 779, desktop 64, mobile 22, server 29, CLI 9) and the mobile bundle built.
Not yet done in milestone 1: `SHOP_BACKUP_KEY` facts and their migration, key creation/restore screens, backups
sealed to the pinned key and carrying sync keys, streaming and the desktop worker, Android/iOS backup exclusion,
the lose-every-till drill and installed-device runs.

### Milestone 1, steps 3–5 (2026-10-17)

Done: `SHOP_BACKUP_KEY` owner fact and migration 30 (`backup_recovery_keys`); `prepareBackupRecoveryKey`/
`confirmBackupRecoveryKey` (fresh PIN, shown once, three groups typed back, nothing secret stored); backups seal to the
pinned key and carry the shop data keys in the signed manifest (`createBackup(context, null, …)` makes a
recovery-key-only backup); `previewBackup` opens with `{ recoveryKey }`; restore re-grants carried keys to the new
device and opens a new epoch; recovery mode refuses a backup signed by an untrusted till (`untrusted_backup`).
Server migration `0006_recovery`: operator-issued owner-recovery codes bound to one shop (dashboard shop page and
`invite --recovery-shop`) attach a restored owner device; the till reports `enrollment_conflict` with that remedy.
Desktop: recovery key panel (create, print, confirm), restore by recovery key, backups via sealing crypto. Mobile:
backups via sealing crypto and new error strings. Tests: core `backup-key.test.ts` (7), server `recovery.test.ts`
(2, including the lose-every-till drill: restore from backup + printed key, recovery code, read a sale synced after
the backup, trade under epoch 2), desktop recovery-key command flow. Full `npm run check` not yet rerun after these.
Still open: mobile recovery-key screens and restore-by-key, streaming codec/file ports and the desktop worker,
Android `allowBackup`/data-extraction rules and iOS exclusion, CLI backups with sealing crypto, ADR status and
docs (server-api, selfhost, CLAUDE.md migration 30), installed-device runs and freezing Argon2id parameters.

### Milestone 1 complete in code; device acceptance open (2026-10-17)

ADR-035 and ADR-036 are **accepted**. Since the entry above:

- **Streaming end to end.** `writeBackup` streams a backup to a sink and `previewBackupFile` decrypts from a reader into
  private staging, 1 MiB at a time, yielding to the event loop between chunks. The desktop copies the database with
  `VACUUM INTO` in a worker thread. Facts written while a backup runs are signed inside the copy. Desktop saves go to a
  private temporary file (synced, then copied into a newly created destination, never over an existing file, and
  always removed). The desktop opens backups through one descriptor read in pieces.
- **Mobile.** Backups stream into the app cache and are copied out through the folder picker; a closed picker keeps
  the file for another try, and leftovers are cleared at start. Restore reads the picked file in pieces. There are a
  recovery-key screen (create, write down, confirm) and restore by recovery key on the entry and devices screens.
  Android `allowBackup="false"` plus data-extraction rules are verified in the generated manifest.
- **CLI.** Backups use sealing crypto. `--recovery-key-file`/`KOLO_BACKUP_RECOVERY_KEY` open a backup by recovery key.
  `withBackup` streams the file instead of reading it whole.
- **Server.** `connectServer` reports `enrollment_conflict` (remedy: owner-recovery code) only for a device that began
  as a restored backup. A till approved by the owner keeps `invalid_session` until the approving till syncs.
- **Tests.** The fuzz test now accepts a mutated file that still opens only when it yields the original content (a
  byte rewritten with its own value, or only the unused slot touched). The exact-boundary search draws several
  payloads per size over a wider range, so it no longer depends on luck.
- **Docs.** server-api (recovery codes, `invite --recovery-shop`, migration `0006_recovery`), selfhost (recovering
  after losing every till), and CLAUDE.md (SQLite 29 immutable and 30 new; server `0001`–`0006`).

Verified: full `npm run check` passed (contracts 12, core 787, CLI 10, desktop 67, mobile 22, server 31, release 2, landing 3),
`npm run bundle:mobile` built, and `npm run docs:api` regenerated.
Still open (needs installed builds or hardware):
- Electron ↔ Android file interop (ADR-035 item 2).
- Mobile memory and UI stalls on a large backup (item 4).
- A free-space check before writing (item 5; a full disk already fails safely).
- Argon2id parameters, provisional until measured on a low-end Android device.
- quick-crypto DER import and `String.normalize` on Hermes.
- The packaged Electron workflow smoke and the Docker end-to-end run.
- iOS backup exclusion, which waits for an iOS build.

### Desktop Argon2id under Electron (2026-10-17)

Found by installed-AppImage testing: Electron 44 ships BoringSSL, which has no Argon2
(`ERR_CRYPTO_ARGON2_NOT_SUPPORTED`). As a result, the packaged desktop app could neither open nor write a
password-protected backup, and reported the failure as "wrong password or altered file".

- **Fix.** The desktop adapter now derives Argon2id with hash-wasm 4.12.0, a WebAssembly build, in Node tests and
  in Electron alike. It matches OpenSSL: about 200 ms against 130 ms native at 64 MiB/3/1.
- **Errors.** `passwordKey` no longer turns a failed derivation into `authentication_failed`; the failure surfaces
  as itself.
- **Test.** `apps/desktop/src/electron/electron-runtime.test.ts` runs the desktop transfer crypto in Electron's own
  runtime, headless. It checks the Argon2id vector, opens the OpenSSL-written golden file with its password and its
  recovery key, and round-trips a new file, so a primitive missing from Electron now fails `npm test`.
- **Packaged build.** The rebuilt AppImage's own code derives the expected key under the same Electron.

Mobile's quick-crypto bundles OpenSSL 3.6.2, which has Argon2; an installed Android run must still confirm it.
`npm run check` passed: core 787, desktop 68, CLI 10, server 31.

### Test where it ships (2026-10-17)

Review after the Electron Argon2id miss: every test passed on Node while the packaged app failed. The cause was
structural, not one missing test. Desktop tests ran on Node, the real-Electron workflow smoke was outside every
routine gate (and broken by the old `last-backup.json` name), release CI smoke-tested packaged Windows but never
packaged Linux, and local builds and releases (`dist:desktop:*`, `scripts/release.mjs`) uploaded with no packaged
check at all.

- **Desktop tests run inside Electron.** `npm test -w @kolo/desktop` uses `scripts/test-in-electron.mjs`. Proven by
  mutation: with the old Argon2 call the backup tests pass on Node (13/13) and fail in Electron (7 of 13).
- **One platform check, shared by every runtime.** `@kolo/core/application/platform-check` runs known answers for
  every primitive, the golden backup opened by password and by recovery key, and a round trip. It never throws.
  - Core tests prove it names each broken primitive and the checks that depend on it (missing Argon2, wrong X25519,
    HMAC, Ed25519, PBKDF2, HKDF, UTF-8, an identity `String.normalize`).
  - It runs in the CLI's Node adapters, in Electron (desktop tests), in the packaged app (`--self-check`, plus
    node:sqlite, every migration and the snapshot worker) and on Android (`kolo://self-check`; More → About → Device
    check).
- **Build gates.**
  - `verify:desktop:linux|win`: packaged self-check, then the packaged real-UI workflow, ending with the CLI
    verifying the app's backup. Xvfb is used when there is no display; Windows runs through wine from Linux, with
    the unverified UI workflow stated.
  - `verify:android`: installs on a connected device without ever uninstalling, then reads logcat.
  - `scripts/release.mjs` uploads nothing that fails; release CI verifies both desktop platforms.
  - Verified here: Linux packaged, all 18 checks plus the full workflow and CLI cross-check; Windows packaged
    through wine, 18 checks.
- **Smoke realism.** The workflow smoke now saves and opens through the app's real file adapters, with only the OS
  dialog faked.
- **Found by the new gates.** `--self-check` hung on Windows: Chromium locks its temporary user data, so the cleanup
  failed and the app never exited. Cleanup is now best effort. Electron under wine also hangs writing to a pipe, so
  the verifier logs to a file.

Still open: `verify:android` needs a phone or emulator (none attached here). Release CI's Linux job (AppArmor userns
and Xvfb setup) has not run yet.

**Android device run (2026-10-17).** `npm run verify:android` on a Samsung Galaxy A04e (SM-A042F, Android 13,
arm64-v8a, a low-end phone) passed all 17 platform checks on the installed test build. This settles three open items:
- quick-crypto's DER key imports work (X25519, Ed25519, PEM ephemeral agreement);
- `String.normalize` works on Hermes (NFC);
- Argon2id at 64 MiB/3/1 is measured on a low-end device: 830 ms per derivation, 1.0 s to open a password backup,
  2.4 s for a seal-and-open round trip with both slots.

### Android app ID `xyz.hblabs.kolo` (2026-10-17)

The owner chose to change the Android package from `cm.kolo.app` to `xyz.hblabs.kolo` (the reverse of the product domain
kolo.hblabs.xyz) before any Play Store release. Phones with KOLO 0.4.1 or earlier keep that app; the next release
installs beside it, and a shop moves by backup and restore (docs/releasing.md). The desktop ID stays `com.hblabs.kolo`
because Windows installer upgrades depend on it. `verify-android.mjs` and the screenshot script use the new ID.

## 2026-10-18: Review fixes (costing, replay, sync keys, backup and restore)

Fixes for the seven findings of the internal code reviews of 2026-10-17:

- **Sale cost.** `completeSale` freezes each line's cost with the valuation's costing policy (`currentUnitCost`,
  LATEST_COST: latest costed delivery or opening stock, else the purchase price) instead of the editable
  `purchasePriceMinor` or a caller's cost. Desktop and mobile both go through it; history and returns keep the frozen cost.
- **Replay after repricing.** A received sale whose price differs from the receiver's current price no longer needs
  `sales.price_override` when a signed `PRODUCT_SAVED` this till wrote or applied set that price for the product. A
  price no catalogue fact ever set still needs the override its signer claimed. No time bound is applied, because till
  clocks disagree.
- **Key grants ahead of the sealed backlog.** Server pull offers a shop's clear trust/key/address facts before its sealed
  facts on every pass (cursor `c` phase, partial index in server migration `0007_clear_first`). A new till reaches its
  grant within a few pages however long the backlog is; the backlog then drains.
- **Backups carry every key.** `writeBackup` uses `shopKeyCoverage` and fails with `sync_keys_unavailable` when any key
  granted to the till cannot be opened (vault failure, or a platform without sealing). A shop that never used
  encrypted sync has no grants and backs up as before.
- **Restore checks the books.** `validateSnapshot` runs `checkIntegrity` after migrating the staged copy. Corruption
  findings fail with `inconsistent_records` before activation; attention states (quarantined or stuck sync) are allowed.
  Backup creation is not blocked.
- **Desktop exports publish atomically.** Saves write a synced hidden sibling and publish it with a hard link, which
  never overwrites. Filesystems without hard links (FAT/exFAT) get a `wx` claim, then a rename. A failed copy leaves
  nothing under the chosen name.
- **Server restore.** `infrastructure/restore.sh` validates the key (same checks as `loadServerKey`) and the dump before
  changing anything. It restores into a staging database while the server serves, then switches over. The previous
  database and key are kept for rollback.

New error texts (French/English) on desktop and mobile: `sync_keys_unavailable`, `inconsistent_records`.

### Verification

- `npm run check` passed: contracts 12, core 794, CLI 11, desktop 68 (inside Electron), mobile 22, server 35, plus the
  release and landing checks. `npm run bundle:mobile` passed, and `npm run docs:api` was regenerated.
- New tests use real SQLite or PGlite:
  - a replay across two tills after a repricing, plus a forged sale that claims no override;
  - frozen sale costs against the valuation;
  - a backup made during a vault failure, and on a platform that cannot open grants;
  - a restore preview of a backup whose books disagree;
  - an interrupted desktop export;
  - a key grant ahead of a sealed backlog, with a 2-fact, 1-page budget;
  - `restore.sh` against a logging stand-in for `docker`, with the key check run in real Node.
- Two analytics/consistency tests had passed sale-line costs that differed from the product's cost. They now set the
  cost on the product instead.
- Docker drill (2026-10-18, isolated compose project `kolo-restore-drill`, PostgreSQL 18, then removed). Steps:
  back up, add a connection code, then try four bad inputs. A missing dump, an invalid key, a text file and a
  truncated dump each exited 2 before any change, with the server serving its unchanged database. A valid archive
  that fails partway through `pg_restore` exited 1: the staging database was dropped and the server never stopped.
  A real restore over the running deployment brought back the backed-up data with the original key, and kept
  `kolo_previous_*` (with the newer code) and the previous key. Finally, after `down -v`, a restore onto fresh
  volumes brought back the data and the original key.
- `verify:android` on the Samsung Galaxy A04e (arm64-v8a) with an APK built from this tree: all 17 checks passed.
  The build was not copied into `release/mobile`.
- `verify:desktop:linux` on an unpacked app packaged from this tree (`pack:desktop`): all 18 self-checks and the
  full real-UI workflow passed. That covers backup to a file through the new atomic export, restore, import-replace
  and crash recovery, and the CLI verified the backup the app wrote.
- `verify:desktop:win` on a Windows unpacked app packaged from this tree: all 18 self-checks passed under wine 11.18.
  The Windows UI workflow still needs Windows or CI.
- Exports to FAT32 and exFAT: real loop-mounted filesystems, attached through udisks the way a USB stick is, with the
  built desktop adapter run in Electron 44's Node. On both, `link` fails with `EPERM`, the claim-and-rename fallback
  is used, and saving, refusing to overwrite, an interrupted copy and a small save are all correct, with nothing
  left behind. The local disk takes the hard-link path. A FAT drive on Windows was not tested.

## 2026-10-18: Keep the change as customer credit

A named customer who hands over more cash than the total can leave the change on their account as an advance, in the
same step as the sale. Example: a 700 sale, 1,000 handed over, 300 kept.

- **Core.** `completeSale(context, cart, keptChange?)` records the change as an ordinary customer payment, under
  `customers.pay`, in the sale's transaction. The payment goes into one of the sale's cash accounts, noted with the
  sale number at the sale's time. The sale must name a customer and leave nothing owing; any refusal writes nothing.
  No contract changes: other tills, old or new, apply the two existing facts (`SALE_COMPLETED`, `CUSTOMER_PAYMENT`).
- **Shared rule.** `keepableChange` (cash tendered beyond the cash due) is used by both tills.
- **Receipt.** `Receipt.changeKeptMinor` is found through `changeKeptOnAccount`. Returns refund only what the sale
  collected; the advance stays the customer's.
- **Desktop.** "Keep the change as customer credit" appears beside the change due when a customer is chosen and
  "Cash received" exceeds the cash paid. `checkout` takes `keptChangeMinor`, which is part of retry identity. The
  receipt prints "Change kept as credit".
- **Mobile.** A toggle appears in cash settlement with a customer. The draft carries stable IDs for the payment, so
  a retried tap records it once. The receipt screen, shared text and printed receipt show the kept change.

### Verification

- `npm run check` passed: core 803 (including the new `kept-change.test.ts`, the sync test and `keepableChange`),
  desktop 69 inside Electron, mobile 23, server 35, contracts 12, CLI 11.
- `npm run bundle:mobile` passed, and `npm run docs:api` was regenerated.
- `verify:desktop:linux` on a freshly packaged app passed, including the new real-UI step: the till offers and keeps
  the change, the receipt shows it, and the customer holds −300.
- `verify:android` on the Samsung Galaxy A04e (arm64-v8a) with the release APK built from this tree
  (`apps/mobile/android/app/build/outputs/apk/release/app-arm64-v8a-release.apk`, versionCode 72): all 17 checks
  passed. A first run without a path had picked the Oct 12 `release/mobile/KOLO-0.4.1-*` file (the APK came from a
  direct Gradle run, so the copy was never refreshed). That file's package is the old `cm.kolo.app`: it installed as a
  second app and the self-check ran the `xyz.hblabs.kolo` build already on the phone, yet the script reported success.
- **Fixes.** Android is now 0.5.0 (versionCode 8), because the app ID changed. `verify-android.mjs` now fails when
  the `release/mobile` copy is older than Gradle's APK, when the install leaves `xyz.hblabs.kolo` untouched (another
  app ID), or when the installed version is not `app.json`'s.

## 2026-10-18: Operation journal (desktop and mobile)

A read-only view of who did what, when and on which device (spec §39), for owners, accountants and anyone the owner
grants `audit.view` (for example a manager who is a shareholder). No schema change and no new events.

- **Core.** `application/audit.auditTrail(context, query)` pages the signed event journal newest first, so it covers
  every till once synced, plus three checks only the recording till keeps because they changed nothing: cash counts,
  cash corrections that matched, and stock counts that matched. Entries carry type, family, member, device, source,
  application status for held-back facts, the record concerned (and a related party or account), and figures: sale
  and delivery totals through the shared pricing rule, return totals, payments, expenses, stock and cash movements,
  role and permission changes. A product save shows the previous price and cost when they changed. Filters: period,
  member, device, family, record (any fact naming its ID), keyset cursor. Key material never leaves a payload.
- **Desktop.** `journal` bridge command (strict validation in `electron/reports.ts`) and a Journal section after
  Reports, shown with `audit.view`. A record name narrows the list to its history.
- **Menu order.** A section added by a newer version now lands after the one it follows by default, inside an order
  someone chose, instead of at the end.
- **Mobile.** More → Operation journal, with the shared period picker, member/device/type choosers and tap-to-narrow.
- **Not done.** Export (CSV or print) of the journal. Facts from other tills appear only once synced; a cash count
  that moved no money stays on the till where it was made.

### Verification

- Core (real SQLite): `audit.test.ts` covers authorization (cashier and default manager refused, accountant allowed,
  grant and revocation take effect at once), summaries, price-change detail, local-only checks without duplicates,
  every filter, paging joined page by page against the whole journal, and malformed queries;
  `exchange.test.ts` shows another till's sale on the receiving till with that till's device and member.
- Desktop inside Electron: a host test of the bridge (filters, cursor, refused input, permission), the menu-order
  test, and journal text coverage. The Electron workflow smoke opens the Journal, finds the day's expense, runs the
  axe audit in light and dark, and narrows to a record.
- Mobile: localization test that every operation, family and status has French and English text.

## 2026-10-18: Journal CSV export (desktop and mobile)

- **Core.** `application/audit.auditExport` reads every entry matching the journal filters, page by page under
  `audit.view`, up to 20,000 (`truncated` beyond). The pure `domain/audit-csv.auditCsv` writes them with papaparse
  5.5.5 (new core dependency, MIT): UTF-8 byte-order mark, CRLF, `;` (French) or `,` (English), local date and time
  plus the UTC instant, whole-XAF amounts as numbers, client-supplied headings and wording. Formula escaping uses our
  own pattern: papaparse's default misses a cell that starts with `=`, `+`, `-` or `@` and continues on another line
  (found by the fuzz test).
- **Desktop.** Export CSV on the Journal; `saveCsv` bridge command and `saveDesktopExportFile`, which never overwrites.
- **Mobile.** Export CSV on the journal screen, saved into a folder the member picks.
- **Not done.** Installed Android acceptance of the folder picker and file.

### Verification

- Core: export joined across pages, truncation at the limit, permission; CSV read back cell for cell with papaparse's
  parser in both separators, formulas defused, accented and quoted text; 300-case fuzz round trip.
- Desktop inside Electron: the adapter saves exact bytes, refuses unsafe names and empty files, never overwrites;
  the bridge saves the renderer's text exactly and refuses malformed input and a locked session. The workflow smoke
  exports the day's journal and reads the saved file back.
- Mobile: text coverage for every export column.

## 2026-10-18: `data.export` permission

Exporting shop data now needs its own permission, so staff who can see figures cannot take them away in bulk.

- **Contract.** `data.export` is appended to `PERMISSIONS`. Owners hold it; no other role does by default (managers
  explicitly exclude it); the owner grants it per member in Staff (Administration group).
- **Core.** `auditExport` requires `audit.view` and `data.export` on every page, so a revocation stops an export under
  way. Reading the journal on screen still needs only `audit.view`.
- **Desktop.** New `journalExport` bridge command runs the export in the main process under both permissions; `saveCsv`
  requires `data.export`. The Export button is hidden without it.
- **Mobile.** The Export button is hidden without it; the core check refuses it regardless.
- **Compatibility.** Synced facts carry only the permissions their own operation required, and exporting creates no
  fact, so older tills are unaffected. A grant or revocation of `data.export` itself is a new value to a till that
  has not been updated: that till holds the fact back until it is. Update every till before granting it.
- Backups, invitations and exchange files already require `business.settings` (owner by default).

### Verification

- Core: an accountant reads the journal but cannot export; a grant allows it and a revocation stops it; managers can
  do neither by default. Contracts tests pass with the new permission.
- Desktop inside Electron: `journalExport` and `saveCsv` refuse members without `data.export`, including the owner
  once it is revoked; malformed export filters are refused.


## 2026-10-19: Landing download suggestion

The landing page now suggests the download for the visitor's device. Without JavaScript the page is unchanged.

- **Detection.** `apps/landing/platform.mjs` reads `navigator.userAgentData.platform` first, then the user agent.
  Android is checked before Linux; ChromeOS gets Linux; iPadOS asking for the desktop site is told apart from a Mac by
  its touch screen. The build inlines the function into `assets/site.js`, because the CSP allows only same-origin
  scripts.
- **Page.** The matching card gets a "Recommended for this device" badge and moves first on narrow screens only; the
  desktop order stays put. The hero button reads "Download for Android/Windows/Linux" and still scrolls to
  `#downloads`, keeping the unsigned-build note in view. iPhone/iPad and Mac visitors see a short note instead. The
  universal APK stays the Android pick, since browsers cannot reliably report ARM64 or ARMv7.
- **Privacy.** The privacy page (both languages, dated 19 October 2026) states that the reported device type is read
  only to suggest a download, and is neither stored nor sent. The cookie page is unchanged: nothing is saved.

### Verification

- `npm run check:landing`: translation parity, markup checks for card platforms and note hooks, 10 detection tests
  over real user agents (Android Chrome, Samsung Internet, Firefox, Opera on Tecno; Windows Edge/Firefox/IE11;
  Ubuntu Firefox, Linux Chrome, ChromeOS; iPhone Safari/Chrome, iPad; macOS Safari/Firefox), client hints, iPadOS
  touch, unknown inputs, and the built `site.js` running in a VM.
- Headless Chromium against the preview server with Android, Windows, iPhone and Mac agents plus the host's own
  browser: the right card, badge, hero label and note in English and French, at 390 and 1280 px. The served HTML
  with JavaScript off has no suggestion and both notes hidden.


## 2026-10-19: Report PDFs

Every report can now be printed or saved as an A4 PDF, on desktop and on mobile.

- **Core.** `domain/report-document` turns any `ReportResult` into a sheet (headline tiles, notes, one table) and a
  self-contained A4 page: shop, title, period, print time and the "Generated by kolo · made by hblabs" credit. Every
  value is escaped; a CSP in the page allows no script or external resource; table headings repeat on each page and
  rows do not split. Clients supply the wording (`REPORT_DOCUMENT_LABELS`).
- **Desktop.** "Save as PDF" above each report. The new `saveReportPdf` command reads the figures in the main process
  under the report's permission and renders them in a hidden, script-less window on its own session (`electron/pdf.ts`),
  then offers a new `.pdf` in the save dialog. The renderer supplies only the wording and the file name.
- **Mobile.** "Print or save as PDF" on each report opens the Android print dialog with the same page. The report is
  read again with the full 500-row limit rather than the phone's 100.
- **Permission.** The report's own permission and `data.export`, like the journal CSV: a PDF takes the figures off the
  device. The desktop command refuses without it; both apps hide the button.

### Verification

- Core: every report kind; escaping of hostile names in the shop, title and rows; no script or resource reference;
  exact money and negative marks; blank groups, unknown costs, negative stock; empty and truncated lists.
- Desktop inside Electron: the saved page carries the installation's escaped shop name and the exact line total;
  cancel saves nothing; bad names, kinds, periods, languages, missing or extra labels, over-long wording, a
  renderer-supplied shop name and extra fields are refused; locked sessions, a revoked `reports.sales` and a revoked `data.export` are refused.
  The packaged workflow smoke saves the dashboard as PDF through the real print window and checks the file.
- Mobile: French and English wording exists for every label and report title; period lines for a range, a single day
  and snapshot reports. Not verified on a device: the Android print dialog with a report.

## 2026-10-19: Role permission matrix (ADR-037)

The owner can now edit what each staff role allows, as a roles × permissions matrix, while shops that never edit a
role keep exactly the built-in defaults.

- **Core.** `identity/roles`: `listRoles`, `setRolePermissions` (null or the defaults returns a role to them) and
  `changeMemberRole`; `clearPermissionOverride` in `identity/workspace`. `@kolo/contracts/permissions` exports
  `STAFF_ROLES`, `isStaffRole`, `defaultPermissions`, and `resolvePermissions` takes the shop's role set. SQLite
  migration 31 adds `role_permissions`; authority checks, reports, backups and file previews resolve through it.
- **Facts.** Owner-signed `ROLE_PERMISSIONS_SET` (per role, higher revision wins, equal revision must match),
  `MEMBER_ROLE_CHANGED` and `PERMISSION_OVERRIDE_CLEARED` (member revision chain). They replicate over files, the
  local network and the server like other sealed facts; owner review cannot accept a quarantined role fact.
- **Desktop.** Staff gains Members | Roles tabs: the matrix with a "Customized" mark and "Reset" per role; members
  get a role picker and an "Exception" mark where they differ from their role. Switching a permission back to the
  role's choice clears the exception. Commands `listRoles`, `setRolePermission`, `resetRole`, `setStaffRole`.
- **Mobile.** More → Staff → Roles edits one role at a time with reset; the member screen has the role picker,
  exception hints and the same clearing rule. The journal names roles for the new facts in both apps.

### Verification

- Core: defaults unchanged with no rows; an edited role reaches its holders' next command; grants and revocations
  beat the role and clearing them returns to it; defaults or null store NULL; repeated sets record nothing; only the
  owner edits roles or moves members; OWNER, unknown permissions and malformed lists refused; a role move keeps
  exceptions and advances the revision; a corrupt role row fails closed for its holders only. Two replicas converge on
  the matrix, a role move and a cleared exception; a stale revision loses; an equal-revision rewrite is quarantined
  as a conflict; a staff-signed role fact is refused and cannot be accepted through review.
- Desktop inside Electron: matrix cell, reset, role move, exception clearing that leaves no stored override, invalid
  roles/permissions/flags, owner role move and staff access refused. The workflow smoke ticks a matrix cell.
- Not verified on a device: the mobile Roles screen and member role picker on Android.

## 2026-10-20: Add a category while adding a product

A product can be filed under a new category from its own form, without leaving it.

- **Desktop.** New product now has a category picker (it had none; the category could only be set by editing
  afterwards). In both the new and edit forms, "+ New category…" opens an inline name field that creates the category
  and selects it; the product draft is kept. `createProduct` takes an optional `categoryId`, which must be an active
  category of the shop, and is part of the same-request retry identity.
- **Mobile.** The main and additional category pickers on the product form offer "New category" inside the sheet,
  under `products.create`, and select what they create.

### Verification

- Desktop inside Electron: creating a product with a category and its identical retry; a retry without the category
  conflicts; archived, unknown and malformed categories are refused with nothing written.
- Not verified on a device: the mobile picker's create row on Android.

## 2026-10-20: Shop-defined roles (ADR-038)

The owner can add their own roles next to the four built-in ones, assign them to members and delete them once nobody
holds them.

- **Core.** `identity/roles`: `listCustomRoles`, `createCustomRole` (a named copy of a built-in role's current
  permissions), `updateCustomRole` (rename or permissions), `deleteCustomRole` (`role_in_use` while held), and
  `changeMemberRole` accepts `{ customRoleId }`. `LocalMember.customRoleId`. New `WorkspaceError` codes `role_in_use` and
  `duplicate_name`. SQLite migration 32 adds `custom_roles` and `local_memberships.custom_role_id`; authority resolves
  through the held custom role and fails closed if it is unknown or corrupt.
- **Facts.** Owner-signed `CUSTOM_ROLE_SET` (higher revision wins, equal revision must match, base never changes);
  `MEMBER_ROLE_CHANGED` carries an optional `custom_role_id` and waits for its role. The journal names custom roles.
- **Desktop.** Roles tab: "New role" (name + based on), custom columns with Rename/Delete (Delete disabled while held);
  member and new-member pickers list custom roles. Commands `listCustomRoles`, `createCustomRole`, `renameCustomRole`,
  `setCustomRolePermission`, `deleteCustomRole`; `setStaffRole` takes `customRoleId`, `createStaff` an optional one.
- **Mobile.** More → Staff → Roles lists custom roles with the built-in ones; new, rename, delete. Member and new-member
  screens list them.

### Verification

- Core: a new role copies the shop's current base set; holders follow its edits but not the base role's; exceptions
  apply on top; moving back to a built-in role clears it; unique names ignoring case; no fact for unchanged edits;
  delete refused while held (suspended holders included), tombstoned, then unassignable and uneditable; owner-only;
  malformed IDs, names, bases and permissions refused; unknown or corrupt custom role fails closed for its holder only.
  Two replicas converge on roles, tombstones and a move; a stale revision loses; a same-revision rewrite, a changed
  base and an `OWNER` base are quarantined; a move waits for its role then applies; a staff-signed role fact is refused.
- Desktop inside Electron: create with identical retry, duplicate name, tick a permission, create a member straight
  into the role, exceptions against it, rename, `role_in_use`, move off and delete, deleted role unassignable, invalid
  inputs and staff access refused.
- Not verified on a device: the mobile role screens on Android.

## 2026-10-20: Desktop in-app updates

Desktop KOLO looks for a newer version on GitHub Releases and offers to install it; automatic updates are an opt-in,
per-computer setting, off by default ([desktop release](desktop-release.md#in-app-updates)).

- **Desktop.** `electron/updates.ts` (`DesktopUpdates`, `installKind`, `updateHandlers`) drives electron-updater 6.8.9:
  pre-releases allowed, no download without a click unless the setting is on. Checks 20 s after start and every six
  hours. "Restart and install" closes the shop and database before the installer starts, and restarts the current
  version if it cannot start. NSIS and AppImage install when KOLO closes in automatic mode; a `.deb` waits for an
  explicit restart (password prompt); portable copies only link to the download page; Store, development and smoke
  runs never check. Bridge: `updateState`, `checkForUpdate`, `downloadUpdate`, `installUpdate`, `setAutomaticUpdates`,
  `openDownloads`, `onUpdate` (`UpdateService`, `UpdateView`). Renderer: an update banner with "Later", and
  Settings → Updates (state, check now, automatic setting). French/English text.
- **Self-check.** A packaged build's `--self-check` loads electron-updater from the asar and requires `app-update.yml`.

### Verification

- Inside Electron: install-kind matrix; found/current/failed checks with no error detail; concurrent checks reach the
  updater once; progress clamped and ignored outside a download; failed download retried; automatic mode persists,
  downloads, and installs on close only for NSIS/AppImage; defensive preference reads (default off); install closes
  the shop first and reports an installer that did not start; portable never downloads; Store/development never load
  the updater; scheduled checks stop on dispose; the bridge refuses untrusted senders and malformed input.
- `npm run check`, `npm run bundle:mobile`, `npm run dist:desktop:linux` and `npm run verify:desktop:linux` passed,
  including the new `updater` self-check entry. A live electron-updater check against `vanillaiice/kolo` from
  version 0.7.0 found the 0.8.0 pre-release.
- Not verified: an actual install transition (NSIS silent install and relaunch on Windows, AppImage replacement, `.deb`
  through pkexec), unsigned-installer behaviour under SmartScreen during a silent update, and the banner on Windows.
  Copies up to 0.8.0 have no updater and must be updated by hand once.

### Follow-up: safety copy, beta channel, update policy and release notes

- **Safety copy.** Every install (button, or on close in automatic mode) first writes `pre-update/<version>-<time>.db`
  with `VACUUM INTO` (`writeSafetyCopy`, newest three kept, removed by a computer reset). A failed copy installs
  nothing (`failed` step `backup`; on close, the install is cancelled). An automatic encrypted backup was not used:
  those need an owner session and a pinned recovery key (ADR-036) and are not implemented yet.
- **Policy.** `nonBreaking` (semver `^current`) gates automatic download and install on close; `offered` hides
  pre-release versions from non-pre-release copies. Pre-releases are read only below 1.0.0 or on a beta copy.
  `UpdateStatus` carries `breaking` and `notes` (`FoundUpdate`, `ReleaseNote`).
- **Notes.** electron-updater's full changelog (every release since the installed one, newest first, bounded) is
  shown as plain text by `release-notes.ts` (`noteBlocks`, `parseNotes`): the part before the first rule, in the
  reader's language when split by "Français"/"English" headings. Breaking updates show a warning and open the notes.
- **Releases.** `CHANGELOG.md` (new, bilingual sections) is required: `releaseNotes()` puts the version's section
  before the download instructions and fails without it. `isPrerelease` marks GitHub pre-releases only below
  1.0.0 or with a suffix; `release-github.mjs` passes `--prerelease=<flag>`.

Verification: Electron tests for the caret and beta matrices, bounded notes, allowPrerelease by version, beta not
offered, automatic off by default, breaking versions never auto-downloaded or installed on close, copy → close →
install order, failed copy installs nothing, close-time copy and cancellation, a real SQLite safety copy and pruning
across versions that sort wrongly as text, and the notes reader (language choice, rule, dropped scripts, bounds).
`node --test scripts/release-info.test.mjs` covers the changelog section and the pre-release flag. Not verified:
the notes rendering of a real GitHub release body in the packaged app, and every item listed above.

## 2026-10-21: A new computer joins by the owner's code

A fresh computer could only join through a same-Wi-Fi `kolo://local` link, so a shop whose main till is a phone (which
shows a server code and address) could not add a computer, and pasting the phone's server share code
(`kolo://connect`) produced the connection-code error "it starts with kolo://connect".

- **Desktop entry.** "Rejoindre une boutique" accepts the owner's 10-character code plus the address shown under it
  (`https://` assumed when typed bare), a server `kolo://join` link, or a local `kolo://local` link. The existing
  `lookupLocalJoin`/`requestLocalJoin`/`finishLocalJoin` commands route a code or server link to the core
  `lookupJoin`/`requestJoin`/`finishJoin` over the sync transport, and take an optional `url`. The joined computer
  connects to the owner's shared server address on its own afterwards (`pendingShopServer`).
- **Errors.** `not_join_code` (a share code was pasted: says to use Add a till → Show a code), `invalid_join_code`,
  `join_address_needed`; `invalid_address` for a non-HTTPS public address.
- **Mobile.** Add a till offers "Send the link (for a computer)" to share the `kolo://join` link; share-code help on
  both apps says it is for already-paired tills, not new ones.

Verification: Electron test `join-entry.test.ts` (share code named, malformed text and missing address refused before
any network call, typed address defaults to HTTPS, a link brings its own address, request and finish take the same
route). Not verified: a real phone-to-desktop join against `sync.kolo.hblabs.xyz`, or the Android share sheet.
Desktop QR scanning by webcam is still not implemented.
