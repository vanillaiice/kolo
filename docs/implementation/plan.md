# Detailed implementation plan

Accepted 2026-10-05. Sequence is driven by the standalone product: a server must never
be needed to create a shop or complete a sale. Estimates are intentionally omitted
until the device/desktop spikes measure the remaining native work.

**Priority update (2026-10-09):** Two installed clients, desktop and mobile, each
with local SQLite and shared business/event rules. File/Bluetooth/future transports
merge events; an optional paid hosted server stores and synchronizes those events.
Self-hosting remains a deployment option. Desktop software packages are complete;
release work now covers packaging, Windows credentials, recovery, performance,
accessibility and documentation. Physical hardware and cross-device acceptance are
deferred. Mobile is the next focus after this desktop work; browser delivery is deferred.
See [desktop implementation](desktop.md) and [desktop release](desktop-release.md).

## F0: Repository and stack foundations

**Dependencies:** existing implementation. **Delivered in this change:** npm workspaces,
one root lock, shared-core extraction, native wiring retained in mobile, Electron boot
and persistent SQLite adapter, server health/readiness/capabilities, versioned exchange
envelope validation, explicit Go archive, documentation/reference generation, CI.

**Acceptance:** existing core tests still pass; all workspaces typecheck; dependency
boundaries pass; server HTTP behavior and desktop persistence tests pass; server/desktop
compile; Metro resolves moved packages; docs links/reference are current. Native and
container smoke results are recorded separately, never inferred from compilation.

## F1: Standalone setup and local authority

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

## F2: Shared pure rules and transport-independent event journal

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

## F3: Backup and trusted file exchange

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

## F4: Standalone mobile operational MVP

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

## F5: Standalone desktop MVP

**Status:** Active phase; desktop software packages implemented, acceptance open. The first offline setup → product → cash sale → receipt →
restart workflow is implemented and verified in actual Linux Electron, followed by product
editing/archive, categories, manual stock movements, counts and history, split/credit checkout
and customers with payments and statements, discounts, suppliers and purchases, accounts/transfers/counts, expenses, reports, returns, staff, and backup/restore, pairing and file exchange through native dialogs. Named validated
IPC, opaque host authority, recovery, bounded reads and reusable React DOM screens
and OS-dialog receipt printing are in place. Windows release acceptance remains;
physical hardware and cross-device acceptance are deferred.
See [desktop implementation](desktop.md). Browser delivery is deferred; the reusable
DOM service boundary does not introduce a third client into the current release scope.

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

## F6: Optional Fastify synchronization server

**Split (2026-10-11).** **F6a, the relay, is delivered** ([ADR-029](../adr/ADR-029-sync-server-relay.md)):
owner-signed device trust, migration 25, enrollment, signed-challenge sessions, push/pull/receipts/
bootstrap/status over an append-only PostgreSQL journal, the shared client sync engine and desktop
connection/automatic sync. Tills apply every rule; the server stores and forwards verified facts.
The mobile connection screen and background sync were delivered the same day; installed Android/Windows acceptance
against a real server remains. F6b and F6c below were delivered the same day too.

**F6b: connection codes and end-to-end encrypted sync** ([ADR-030](../adr/ADR-030-end-to-end-encryption-and-connection-codes.md),
decided and delivered 2026-10-11; see the ADR's implementation notes for refinements). Replaces the earlier F6b (server-side business application, centralized reports
and server Go-fixture parity), which is dropped: the server never reads business records.

1. Connection codes: PostgreSQL migration for hashed single-use codes, `invite` CLI, enrollment by
   code (single use committed with the shop), till paste/scan screen that pins the fingerprint from
   the code, and owner-signed `SERVER_ENDPOINT_SET`/`CLEARED` so other tills connect automatically.
   Remove `KOLO_ENROLLMENT_CODE`. The pending mobile connection screen is built on this flow.
2. HPKE/X25519 spike on Hermes and Electron; record the chosen implementation.
3. Device X25519 keys in the native keystores, `DEVICE_TRUSTED` v2, `SHOP_KEY_GRANTED`, epoch
   rotation on revocation, sealed-event format and server journal version; tills seal on push and
   open on pull. File exchange is unchanged.

**Acceptance:** a code works once, expires and can be cancelled; a wrong fingerprint is refused;
a second till connects with no typing. The server database and logs contain no business payload
(checked by searching a real PostgreSQL dump for known product names and amounts). A revoked till
cannot read facts sealed after its revocation; a new till reads all history. Lost responses,
reordering and replay still converge. Cross-shop access stays impossible.

**F6c: operator admin dashboard** (delivered 2026-10-11). For whoever runs the server (hblabs for hosted, the self-hoster
otherwise), not for shop owners. Depends on F6b step 1.

- **Delivery.** A static React/TypeScript app built in `apps/admin` and served by the server with a
  JSON admin API, on a separate listener (`KOLO_ADMIN_HOST`/`KOLO_ADMIN_PORT`, default
  `127.0.0.1:8081`) so the public sync port never exposes it. Remote use goes through a VPN/SSH
  tunnel or a reverse proxy with its own restrictions.
- **Access.** Admin accounts created by CLI (`admin create`), password hashed with scrypt plus
  mandatory TOTP using an established library; passkeys later. HttpOnly, Secure, SameSite=Strict
  session cookies with idle expiry, origin checks, rate limits and lockout. Roles: `admin`
  (changes) and `viewer` (read-only).
- **Connection codes.** Issue with label and expiry, show the code and QR once, list
  unused/used/expired/cancelled with the shop each attached, cancel.
- **Shops.** Search and list by display name, status, device count, last sync and storage. Detail:
  devices (label, platform, trusted/revoked, last seen), delivery backlog per device, rejected and
  conflicting event counts, key epoch. Suspend/resume: a suspended shop gets 403 `shop_suspended`
  on sessions, push and pull while its tills keep trading. Remove: two-step confirmation, 30-day
  soft delete, then purge.
- **Server health.** Version, schema migrations, database size, journal growth, request/error and
  rate-limit rates, active sessions.
- **Audit.** Every admin sign-in and change is written to an append-only `admin_audit` table in the
  same transaction as the change, with admin, action, target, time and address; viewable and
  exportable.
- **Never shown:** business records (they are sealed) or anything that could act as a shop.
- **Later (F7):** plans, entitlements, payments, expiry and renewal codes.

**Acceptance:** every admin endpoint refuses without a session; viewers cannot change anything;
every change is audited atomically; suspension blocks sync but not local trading; the admin
listener is absent from the public port; real-PostgreSQL tests and a browser smoke test pass.

**Dependencies:** F2/F3 format/identity. **Modules:** identity, enrollment, connection codes,
sync, admin, audit, postgres; contracts shared with clients. The paragraphs below predate ADR-030;
where they mention server-side appliers or archived fixture parity, those are dropped.

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
HTTP/repositories. Invalid events are visible and retained. Server behavior matches the
archived fixtures for money, sales, credit, cash and purchases.

## F7: Hosted subscription and self-hosted edition

**Delivered (2026-10-11), [ADR-031](../adr/ADR-031-hosted-subscriptions-manual-billing.md):** `selfhost`/`hosted`
editions in one image, one plan per shop with manual payments in the dashboard, codes with paid months, grace then a
transfer-only pause (`hosted_service_inactive`) that never stops a till, renewal delivering the retained backlog, a
provider-neutral signed webhook, till-side status and support details, the [self-hosting guide](selfhost.md) with HTTPS
template, backup/restore scripts and upgrade/rollback procedure. Acceptance evidence: real-PostgreSQL billing tests and a
Docker Compose install → sync → backup → destroy → restore → resync drill. Remaining: choosing and adding a payment
provider adapter, owner reminders and subscription invoices.

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

## F8: Bluetooth transport

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

## F9: Release and maintenance

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
