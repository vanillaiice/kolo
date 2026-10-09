# Detailed implementation plan

Accepted 2026-10-05. Sequence is driven by the standalone product: a server must never
be needed to create a shop or complete a sale. Estimates are intentionally omitted
until the device/desktop spikes measure the remaining native work.

**Priority update (2026-10-06):** The user requested desktop/web first before further
mobile work. F5 is the next active implementation phase; F4 native acceptance remains
open. Existing F1–F4 shared business logic is reused. See [desktop implementation](desktop.md)
for the first usable offline desktop milestone and the separate browser scope.

## F0 — Repository and stack foundations

**Dependencies:** existing implementation. **Delivered in this change:** npm workspaces,
one root lock, shared-core extraction, native wiring retained in mobile, Electron boot
and persistent SQLite adapter, Nest health/readiness/capabilities, versioned exchange
envelope validation, explicit Go archive, documentation/reference generation, CI.

**Acceptance:** existing core tests still pass; all workspaces typecheck; dependency
boundaries pass; server HTTP behavior and desktop persistence tests pass; server/desktop
compile; Metro resolves moved packages; docs links/reference are current. Native and
container smoke results are recorded separately, never inferred from compilation.

## F1 — Standalone setup and local authority

**Dependencies:** F0. **Modules:** `core/identity`, `core/application`, native credential
adapters; append SQLite migration 15+ rather than changing migrations 1–14.

**Status (2026-10-06):** Shared setup, current local authority, operation/report checks,
native mobile/desktop credential adapters, mobile setup/unlock/access recovery and POS,
staff controls, owner-proof legacy conversion and provisioning crash recovery are
implemented. Migrations 15–16 preserve migrations 1–14. Tests and Metro checks pass.
The implemented KDF policy still requires Android/Windows benchmark/security acceptance;
the only detected Android emulator is offline. F1 native acceptance remains open.
Encrypted backup/restore and replacement-device enrollment require F2/F3; desktop
setup/POS UI is F5. See [progress](progress.md) and
[native validation](f1-native-validation.md).

**Tasks:**

1. Define installation lifecycle: empty → configured/locked → unlocked → connected
   optionally. Local installation identity and unlock sessions are separate from cloud
   sessions. No subscription or remote session expiry stops local operations.
2. Add installation metadata, owner authority, local credential verifier references,
   device public keys, membership/grants, audit journal, and setup completion marker.
3. Implement planned `createWorkspace(input, ports)`, `unlockWorkspace(input, ports)`,
   `lockWorkspace()`, `currentInstallation()`, `grantPermission()`, `revokePermission()`.
   Setup creates business, owner, device, initial financial accounts and bootstrap
   identity events atomically; secret provisioning uses a recoverable pending state
   because a native keystore and SQLite cannot share a transaction.
4. Adopt a reviewed PIN/password KDF and native key storage adapter after Android and
   Windows benchmark/security spike. Store no raw PIN, fast unsalted digest, or reusable
   cloud token in SQLite. Specify retry delays, recovery, and lost-device replacement.
5. Add local actor/context and permission enforcement at application operations.
   Retrofit existing sales, credit, stock, cash, expense, supplier methods. Existing
   raw repository functions are lower-level primitives, not authorized public commands.
6. Add mobile create/unlock/restore screens; remove automatic demo enrollment from
   normal boot. Keep an explicit developer seed behind a developer-only command.
7. Migrate old demo/server-enrolled devices explicitly. Never relabel one shop's data
   as another or discard pending events. Online account attachment keeps all local IDs.

**Acceptance:** airplane-mode fresh install can create a shop, restart, unlock, and
complete a sale. Invalid/suspended actors cannot write via UI or direct application
commands. A crash during secret/setup provisioning recovers without a half-enrolled till.

## F2 — Shared pure rules and transport-independent event journal

**Dependencies:** F1 identity model; pure rule extraction can begin alongside F1.
**Modules:** `core/rules`, `core/application`, `core/data/exchange`, `contracts/events`.

**Status (2026-10-06):** Shared exact rules, strict payloads, migration 17 journal,
native signature ports, verified replay/relay, independent destination receipts and
legacy provenance are implemented. Real SQLite/OpenSSL replica checks cover core
acceptance. Mobile retries signing while unlocked. F1 native gates remain deferred;
F3 pairing/encrypted files/baselines and F6 server ingestion are still separate.
See [exchange](exchange.md) and [ADR-021](../adr/ADR-021-signed-journal-and-late-event-policy.md).

**Tasks:**

1. Extract money, quantity, pricing, settlement, credit, and permission rules from
   SQLite modules into framework/database-independent functions. Keep compatibility
   exports while callers migrate. Use exact intermediate arithmetic and safe integer
   boundary checks; test against independent BigInt oracles.
2. Define payload schemas and immutable envelope for every existing event type;
   schemas validate names, IDs, signs, relationships, money, timestamps, and limits.
   Add bootstrap/membership/permission event types with distinct authority policies.
3. Introduce `event_journal`, `(origin_device_id, origin_sequence)` uniqueness,
   `exchange_destinations`, `event_deliveries`, `import_batches`, and per-peer receipts.
   Financial writes plus immutable events commit together. Receipt metadata can change;
   the event cannot. Keep applied-event identity even after journal compaction.
4. Implement planned `appendEvent(tx, event)`, `eventsForDestination(query)`,
   `acknowledgeDelivery(tx, destination, receipt)`, `applyEvent(tx, verifiedEvent)`,
   `retryDeferred(database)`, and `exchangeStatus(destination)`.
5. Retain received events for onward relay. Preserve origin/actor/occurrence time.
   Decide canonical payload encoding, content digest and detached signature format;
   bind signature to business, origin sequence, event ID, type/version, time and payload.
6. Migrate v1 outbox/inbox without changing IDs or inventing origins. Pruned or imported
   historic records cannot always be reconstructed into signed events: use a declared
   baseline snapshot and replay watermark, not fabricated original events. New events
   use v2 semantics; old records/unsigned events carry explicit migration provenance.
7. Keep HTTP v1 adapter isolated until server parity. A file/peer receipt cannot flip
   the old cloud delivery flag. Journal retention requires backup/baseline and peer
   acknowledgement rules before any pruning feature is enabled.

**Acceptance:** repeated and reordered authorized events converge; both offline sales
stand; lost acknowledgements do not duplicate effects; an ID reused with different
content is quarantined; peer delivery leaves cloud work pending; denied imports leave
no business effects. Arithmetic is identical on mobile, desktop, and server.

## F3 — Backup and trusted file exchange

**Dependencies:** F1/F2. **Modules:** `core/exchange`, `core/backup`, native file adapters.

**Status (2026-10-06):** Implemented consistent sanitized snapshots, authenticated encrypted
files, isolated validation/fresh-key restore/atomic active slots, owner-confirmed pairing
and approved baselines, bounded bundle previews/imports/receipts and localized diagnostics.
Mobile screens and native file adapters are wired. Real SQLite/OpenSSL full workflows and
actual Linux Electron/OS-vault restore/new-sale smoke pass. Android/Windows device,
power-loss, KDF/security and memory measurements remain deferred native acceptance gates.
Desktop renderer transfer UI belongs to F5. See [ADR-022](../adr/ADR-022-encrypted-files-and-approved-snapshots.md).

**Tasks:**

1. Implement consistent database snapshot creation using supported SQLite backup or
   checkpoint/snapshot primitives. Never copy only a live WAL database file. Manifest
   contains format/schema versions, shop ID, snapshot boundary and checksums.
2. Create encrypted backups with a reviewed authenticated-encryption library and
   measured password KDF. Keep credentials/tokens/device private keys out of exchange
   bundles; define protected backup secret policy and recovery procedure explicitly.
3. Implement `previewBackup()`, `createBackup()`, `restoreWorkspace()` using temporary
   locations, integrity/foreign-key checks, migration, owner confirmation and atomic
   replacement. Restoration chooses a fresh installation ID/key; original event origin
   identities remain. Existing-device rollback requires explicit recovery mode.
4. Implement `createPairingInvite()`, `acceptPairingInvite()`, `confirmPairing()` and
   owner-approved snapshot initialization. Pairing proves shared shop and authority
   out of band; an imported `business_id` alone is not trust.
5. Implement `exportBundle()`, `previewBundle()`, `importBundle()`, `exportReceipt()`,
   `importReceipt()`. Validate bounded bytes → format → shop/trust/signature → payload
   → actor permissions → dependency availability → transactional application.
6. Mark exported events as offered, not delivered. Importers acknowledge durable
   storage/application outcomes by receipt. Persist failed/deferred diagnostics by ID,
   with localized descriptions and a recovery action. Use `.kolo-exchange.json` and
   `.kolo-receipt.json` initially; encrypted archive packaging is a later compatible
   container layer, not a different event format.
7. Prevent unbounded archive expansion, oversized batches and unsupported versions.
   Export history may be chunked; one failed chunk never invalidates earlier receipts.

**Acceptance:** two real SQLite installations each record sales while disconnected;
exchange bundles in both directions twice; stock, debts, balances, and reports match
with no duplicate effects. Back up, restore on a fresh installation, and make a new
sale without sequence/device collision. Corrupt/untrusted exports change nothing.

## F4 — Standalone mobile operational MVP

**Status (2026-10-06):** Operational navigation/screens, bounded authorized local
queries/domain invalidation, split/credit till, shared categories and partial/full
compensating returns are implemented. Software verification is recorded in progress.
Active setup/staff/transfer localization and durable device language selection are
implemented. Installed shop-day/hardware/accessibility/performance acceptance remains
open; see [mobile operations](mobile.md) and [F4 native validation](f4-native-validation.md).

**Dependencies:** F1, F2; transfer screens use F3.

Build navigation and application adapters for products/categories, stock movements,
POS cash/split/credit payments, customers/payments/statements, suppliers/purchases,
supplier payments, financial accounts/transfers/count/reconciliation, expenses and
reports. Add explicit compensating sale/purchase returns and reversals; a movement
type alone is not a finished return workflow. Add receipts and hardware-scanner entry.
Translations are keyed French/English strings, not prose in business operations.

Read locally after commits and incoming changes. Use pagination/indexed searches and
measured list rendering. Define observable invalidation by changed domains instead
of duplicating SQLite in a global store. Cover owner/cashier permissions and stock
below zero. Add backup/exchange diagnostics and accessible empty/error states.

**Acceptance:** Android low-cost hardware completes a full shop day offline, including
restart, credit collection, supplier payment, cash count, receipt, and backup. Native
SQLite/keystore, scanner, and chosen receipt hardware are tested on devices.

## F5 — Standalone desktop MVP

**Status:** Active phase. The first offline setup → product → cash sale → receipt →
restart workflow is implemented and verified in actual Linux Electron, followed by product
editing/archive, categories, manual stock movements, counts and history, split/credit checkout
and customers with payments and statements, discounts, suppliers and purchases, accounts/transfers/counts and expenses. Named validated
IPC, opaque host authority, recovery, bounded reads and reusable React DOM screens
are in place. Broader management/transfer UI and Windows/hardware acceptance remain.
See [desktop implementation](desktop.md). Browser delivery still needs an explicit
runtime/storage or server-API choice; the user confirmed desktop first with reusable
React UI for that later browser version.

**Dependencies:** F1/F2; F3 for exchange; F4 business behavior may guide UI.

Add typed allowlisted IPC commands invoking the same application operations. Never
expose `executeSql`, arbitrary paths, or generic IPC. Add desktop setup/unlock, till
keyboard flow, product/inventory/finance screens and reports, backup/import native
dialogs, printer/scanner adapters, safe single-instance behavior, close/crash recovery.
Keep expensive reports/transfer work off the renderer; benchmark main/utility process
placement. Select installer tooling and code-signing/update approach after a Windows
packaging spike. Windows first; declare other platforms only after testing.

**Acceptance:** installed application on a clean offline PC opens without developer
tools, sells, prints, restarts, restores, and exchanges with mobile. Renderer escape,
untrusted navigation and malformed IPC cannot access unrestricted files/SQL. Measure
startup/search latency/memory on target hardware and record budgets/results.

## F6 — Optional NestJS synchronization server

**Dependencies:** F2/F3 format/identity. **Modules:** identity, enrollment, memberships,
sync, domain appliers, reports, audit, postgres; contracts shared with clients.

Port Go auth/tenant/domain behavior selectively using fixtures and shared rules, not
its layering boilerplate. Add versioned SQL migrations and a real PostgreSQL test
harness. PostgreSQL constraints/triggers enforce append-only finances, per-tenant
relationships, uniqueness and safe values. Implement endpoints in the API guide;
each accepted event commits journal+effects+receipt transactionally. Per-event bad
input does not reject unrelated valid events. Dependency failures remain retriable.
Use destination-scoped opaque cursors, bounded batches, timeouts and backpressure.
No client may override authenticated tenant; forwarded origin authorization is checked
separately from the forwarding installation's authentication. Add rate limiting and
structured errors without logging credentials or full financial payloads.

**Acceptance:** real clients synchronize with real PostgreSQL, survive delayed/reordered
events and lost responses, and converge. Cross-tenant reads/writes are impossible via
HTTP/repositories. Invalid events are visible and retained. Nest behavior matches the
archived fixtures for money, sales, credit, cash and purchases.

## F7 — Hosted subscription and self-hosted edition

**Dependencies:** F6 and client endpoint enrollment UI.

One server image has hosted/self-host config. Add hosted entitlements/billing behind
adapters, idempotent signed payment-webhook handling and audit; provider/product pricing
is a later decision. Attach existing shops after authority proof; do not recreate IDs.
Expiry pauses hosted transfer, and exported/local data remains accessible. Clarify
self-host licensing before implementation; no hosted billing dependency in local mode.
Ship configuration templates, TLS reverse-proxy method, backups, migration command,
health checks, upgrade/rollback procedure, and owner support diagnostics. Self-host
bootstrap works on a LAN without external accounts or required telemetry.

**Acceptance:** hosted expiry does not stop either till; subscription recovery syncs
the retained backlog; a clean self-host install and full backup/restore drill pass;
changing endpoint requires explicit enrollment and destination progress stays isolated.

## F8 — Bluetooth transport

**Dependencies:** F3 stable trusted exchange and supported hardware spike.

Measure Android↔Android and Android↔Windows discovery/pairing/throughput. Choose
BLE or classic Bluetooth and reviewed native adapters based on payload sizes/platform
support; do not assume Expo Go or all desktop OSes supply the API. Transfer framed
bundle bytes with transfer ID, lengths, chunk ordering, integrity checks, bounded
buffers, resumption and explicit receipt exchange. OS pairing alone is not shop trust.
Reuse importer and application appliers; no Bluetooth-only financial logic. Permission
refusal or connection loss always leaves file exchange available.

**Acceptance:** interruption at every chunk/ack boundary is retryable without duplicate
effects; malicious length/chunk framing is refused; supported devices converge offline.

## F9 — Release and maintenance

**Dependencies:** edition-specific completed phases; do not wait for Bluetooth to ship
a verified standalone/file-exchange edition.

Resolve the recorded Expo/Metro advisories through SDK-compatible updates before
mobile release; never force a conflicting major downgrade just to clear an audit.
Publish compatibility matrix for app/schema/event/bundle/server versions. Enforce
forward migrations, minimum readable formats, staged client rollout and recoverable
server upgrades. Older apps retain unknown verified events durably without applying
them; senders see unsupported payload versions. Add verified installers, native crash
recovery, restore drills, accounting reconciliation fixtures, realistic multi-day
backlogs, permissions/revocation guidance and low-cost hardware benchmarks.

Retire Go only after parity and preserved migration references. The MVP gate is a
complete offline shop workflow with recoverable backup and trusted file exchange,
not merely successful bundling or an HTTP 200.

## Implementation method for every work package

1. Read relevant product rule and ADR; state inputs, effects, failures and authority.
2. Add/modify pure rule and contract first; choose the smallest module.
3. Implement operation with transaction/event boundaries and platform ports.
4. Add meaningful failure/rollback/replay/isolation tests; use real databases.
5. Add UI/API adapter calling that operation; keep rules out of controllers/screens.
6. Run relevant tests, root checks, platform checks when affected; record evidence.
7. Update source JSDoc, generated API, guide/compatibility table and progress.
