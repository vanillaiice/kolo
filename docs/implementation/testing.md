# Testing and release gates

## Active commands

| Command | Coverage |
|---|---|
| `npm run boundaries` | Shared/platform/server/renderer import constraints |
| `npm run typecheck` | Builds package declarations then checks all active workspaces |
| `npm test` | Real SQLite business/core tests, contract failures, Nest HTTP, desktop persistence |
| `npm run build` | Shared JS/declarations, Nest emitted JS, Electron main/preload/renderer |
| `npm run smoke:server` | Build image and test real PostgreSQL readiness in disposable containers |
| `npm run smoke:desktop:workflow` | Actual Electron DOM setup, OS-vault unlock, barcode/cash sale, persisted receipt and process restart with disposable data |
| `npm run smoke:desktop` | Actual Electron SQLite/preload/renderer boot using disposable user data |
| `npm run smoke:credentials` | Actual Electron crypto/OS vault contract in disposable user data; unavailable encryption exits 2 |
| `npm run benchmark:credentials` | Five native KDF measurements on the host; does not verify OS storage |
| `npm run bundle:mobile` | Metro resolution of Expo workspace source/native entry imports |
| `npm run docs:api` / `docs:check` | Current public declarations/JSDoc and local links |
| `npm run check` | Boundaries + types + tests + docs + builds |
| `make legacy-test` / `legacy-integration` | Explicit archived Go checks, not an active runtime gate |

Current tests use Node's built-in runner; core tests retain `node:sqlite`, not mocks.
Reusable business tests live in core. Mobile also runs pure localization/error checks
and real file-backed SQLite device-preference tests (restart, independent business
replacement, corrupt/unsupported values and failed-write retry). These host tests do
not render React Native or exercise installed expo-sqlite. Native/platform verification
is a separate gate.
Nest controller tests make real HTTP requests. The real-PostgreSQL readiness test
skips without `KOLO_TEST_DATABASE_URL`; `npm run smoke:server` runs it in a fresh
private Docker network/database and cleans up only its own resources. Electron persistence tests call the
actual Node SQLite adapter on a temporary file and reopen it.

## Test layers

| Layer | Method | Required failure cases |
|---|---|---|
| Pure financial/domain rules | Unit, generative/property tests, independent BigInt oracle | Boundaries/overflow, fractional quantities, discounts, sign/rounding |
| SQLite operations | Real schema/triggers and transactions | FK/scope rejection, rollback all effects+event, immutable-history writes |
| Contracts | Untrusted runtime parsing and golden fixtures | Wrong versions/IDs/tenant, unknown fields, oversized UTF-8, duplicate identities |
| Exchange/import | Two/three real databases, failpoint/restart tests | Duplicate/reorder, missing dependency, changed same-ID payload, receipt loss |
| Identity/authorization | Direct operation/API calls, matrix fixtures | Hidden-control bypass, wrong shop, revoked actor/grant, forged pairing |
| Server repositories | Real PostgreSQL isolated test DB | Concurrency/idempotency, transaction/commit failures, tenant FK/query escape |
| Transport | Fake failure/timeouts plus actual endpoint tests | Partial transfer, retry/backoff, batch limits, credential expiry |
| UI | Component checks for interaction rules; real device/system workflows | Focus/scanner flow, stale reads, local failure states, accessible translation |
| Release/runtime | Installed app + container on target platform | Fresh offline launch, restore, upgrade, crash/power failure, low memory |

Assertions prove behavior, not merely duplicate implementation structure. Business
rule coverage is held high; do not add trivial tests solely to inflate percentages.
Preserve archived kernel/domain scenarios as parity requirements when ported. Core
coverage is measured with `npm run test:coverage -w @kolo/core`; exclusions require a
documented unreachable path and a proof, not a hand-waved coverage target.

## Canonical two-installation convergence test (F3 gate)

1. Offline-create one shop, owner and catalog/account baseline; pair A/B with distinct
   installation keys and origin sequences, preserving the same business/entity IDs.
2. Give opening stock 2 units and known cash. Disconnect both; each sells one unit.
   A takes a customer credit payment; B records a partially paid supplier delivery.
3. Exchange all events in both directions; send the same bundles again and lose one
   receipt. Restart an importer between durable reception and application.
4. Query stocks, customer/supplier/account balances, cash flow and period sales/profit
   on both. Compare facts by IDs and assert each effect appears exactly once.
5. Introduce device C and relay A through B; A's origin and signature stay intact.
6. Configure a cloud destination and prove peer receipts leave cloud deliveries pending.

F2 core covers approved fixture baselines, real Ed25519 proofs and real SQLite replay,
including negative stock, reversed dependencies, financial compensation, branches and
independent receipts. Actual pairing, file encryption and installed transfers remain
F3 gates. Continue with variants involving
the last item sold twice (negative stock remains visible), shuffled dependencies,
offline mutable edits with equal timestamps, and late events landing in old periods.

## Database upgrade/backup tests

Keep frozen pre-upgrade fixtures for every released schema. Exercise migration from
each baseline with sales, debt, expenses, suppliers and pending v1 outbox events. Verify
identity/provenance and totals before/after. Newer DB version fails safe without writes.
Backup a live WAL database with concurrent activity using the supported snapshot API;
restore and check integrity/FKs/account reconciliation. Wrong password/corrupt backup
changes nothing. Restore creates a fresh writable installation identity, while all old
event origins survive. Old and upgraded clients exchange under the version matrix.

See the concrete [F1 native acceptance procedure](f1-native-validation.md) for current
credential/setup evidence, blocked platform checks and required target-device steps.

## Native and installed-runtime matrix

Android: low-cost physical device plus emulator; first start/no network, expo-sqlite
migrations/rollback/reopen, keystore with/without screen lock, clear-data/recovery, scanner,
receipt and background/restart. iOS remains unverified until actual native testing.

Desktop: clean Windows install first; verify Node/Electron SQLite runtime (Node tests
alone use a different runtime), preload sandbox/IPC, single-instance lock, offline assets,
user-data persistence, migration, power-loss behavior, native dialogs, printer/scanner,
installer signing/update rollback. Linux/macOS are additional declared matrices.
Headless Electron smoke is useful but does not replace a shop workflow/installer test.

Bluetooth: publish exact phones/PC adapters/OS versions for discovery, permissions,
pairing, chunk/resume/retry and receipt transfer. Expo Go does not prove custom native
transport; test dev/production builds.

Server: build the image, boot with a clean PostgreSQL, verify migrations/readyz,
enroll/sync actual clients, perform full database restore and upgrade rollback. Hosted
expiry/billing-webhook retry must leave offline clients usable; self-host boot must not
depend on external billing/accounts.

## Performance and maintenance

Use fixtures with at least 10k products, 100k movements, multi-day event backlogs and
long customer/supplier histories. Measure cold startup, barcode/search, sale commit,
report latency, memory and background transfer impact on target devices. Establish
recorded budgets from measured shop hardware in F4/F5; do not invent unsupported targets.
Test chunking/deferred queues without blocking the UI. Re-run affected platform gates
after dependency/native upgrades; avoid repeating unrelated expensive checks without cause.

## CI

The foundation workflow installs the root lock on Node 24, runs `npm run check`, then
Metro export. CI build/adapter tests do not launch Electron, so its runtime binary is not needed. Add PostgreSQL integration service and packaged/native jobs in their
phases; label unavailable platform evidence in progress rather than claiming CI proves it.


## F3 recovery and transfer evidence

Real file-backed SQLite tests use production native encryption framing with OpenSSL
AES-GCM/PBKDF2/Ed25519. They pair through the actual invitation/request/approval APIs,
make offline credit sales on both devices, exchange twice, compare stock/debts/cash/reports,
apply duplicate receipts, restore with a fresh origin and re-pair while retaining a new
sale. Failures cover password/tag/header/purpose changes, forged previews, wrong codes,
unexpected executable schema, mixed shops, native provisioning interruption and rejected
active-pointer commits. Compacted snapshots exclude original credential/key references.
Desktop file tests cover bounded descriptor reads, cancellation, native AES and refused
overwrite. `npm run smoke:credentials` now also tests real Linux Electron/OS-vault backup,
fresh restore and a new sale. Hardware gates still require Android/Windows installed
native file dialogs, KDF/memory measurements and interrupted/power-loss activation drills.
