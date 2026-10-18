# Testing and release gates

## Test where it ships (rule since 2026-10-17)

A green Node run proves nothing about a runtime it did not use. On 2026-10-17 every test passed while the packaged
desktop app could not open any password backup: Node's OpenSSL has Argon2id, Electron's BoringSSL does not. So each
platform adapter runs in the runtime that ships it, and no build is handed out or uploaded before it passes there.

| Runtime | What ships it | Where its adapters are tested |
|---|---|---|
| Node (OpenSSL) | CLI, server | `npm test` (CLI `crypto.test.ts`, server tests) |
| Electron (BoringSSL, Electron's node:sqlite) | Desktop | `npm test -w @kolo/desktop` runs every desktop test inside Electron (`scripts/test-in-electron.mjs`); `electron-runtime.test.ts` fails if run elsewhere |
| Packaged desktop (asar, fuses, installer layout) | AppImage, deb, NSIS, portable | `npm run verify:desktop:linux` / `verify:desktop:win` after every build |
| Hermes + quick-crypto (OpenSSL 3.6) | Android APK | `npm run verify:android` on a phone or emulator after every build |

One shared check, `runPlatformCheck` (`@kolo/core/application/platform-check`), holds the known answers: UTF-8,
base64, NFC passwords, SHA-256, HMAC, PBKDF2, AES-256-GCM, X25519 (RFC 7748), Ed25519 (RFC 8032), Argon2id, HKDF
(RFC 5869), ephemeral agreement through PEM keys, the golden ADR-035 backup opened by password and by recovery key, and
a new backup round trip. Every runtime runs the same list: Node in the CLI tests, Electron in the desktop tests, the
packaged app through `--self-check` (plus node:sqlite, every migration and the snapshot worker), and Android through
`kolo://self-check` or More → About → Device check.

- **Desktop builds:** `verify:desktop:linux` runs the packaged app's self-check, then the packaged real-UI workflow
  smoke, which ends with the CLI verifying the backup the app wrote. It starts Xvfb when there is no display.
  `verify:desktop:win` does the same on Windows; from Linux it runs the self-check through wine and states that the
  Windows UI workflow is not verified there.
- **Android builds:** `verify:android` installs the APK matching the connected device over the existing app (never
  uninstalling: that would erase the shop), opens `kolo://self-check` and reads the result from logcat.
- **Releases:** `scripts/release.mjs` runs the platform's verification after building and uploads nothing if it
  fails. Release CI runs `verify:desktop:linux|win` for both desktop platforms.
- **Handing out test builds** follows the same rule: build, verify, then share.
- **Workflow smoke file paths:** the smoke replaces only the OS dialogs. Saves and opens go through the app's real file
  adapters (streamed temporary file, sync, new destination; reads in pieces).

## Active commands

| Command | Coverage |
|---|---|
| `npm run boundaries` | Shared/platform/server/renderer import constraints |
| `npm run typecheck` | Builds package declarations then checks all active workspaces |
| `npm test` | Real SQLite business/core tests, contract failures, server HTTP, desktop persistence (desktop inside Electron's runtime) |
| `npm run build` | Shared JS/declarations, server emitted JS, Electron main/preload/renderer |
| `npm run smoke:server` | Build image and test real PostgreSQL readiness in disposable containers |
| `npm run smoke:desktop:workflow` | Actual Electron DOM setup, OS-vault unlock, barcode/cash sale, persisted receipt and process restart with disposable data |
| `npm run pack:desktop` / `dist:desktop:win` | Stage production dependencies and build unpacked / NSIS + portable artifacts without publishing |
| `npm run smoke:desktop:packaged` | Packaged workflow, axe audits, minimize lock, renderer/main termination and persisted checkout |
| `npm run verify:desktop:linux` / `verify:desktop:win` | Packaged `--self-check`, then the packaged workflow smoke; required after every desktop build |
| `npm run verify:android` | Installs the APK on a connected device or emulator and reads its `kolo://self-check`; required after every Android build |
| `npm run benchmark:desktop` | Actual renderer/preload/SQLite timings with 10k products and 100k stock movements |
| `npm run smoke:desktop` | Actual Electron SQLite/preload/renderer boot using disposable user data |
| `npm run smoke:credentials` | Actual Electron crypto/OS vault contract in disposable user data; unavailable encryption exits 2 |
| `npm run benchmark:credentials` | Five native KDF measurements on the host; does not verify OS storage |
| `npm run build:mobile:android` | Expo prebuild and real native Android release-variant test APK with bundled JS; not device acceptance |
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
Server tests make real HTTP requests or Fastify `inject()` calls. Without `KOLO_TEST_DATABASE_URL` every
database test runs on PGlite (PostgreSQL compiled to WASM, dev-only) behind `@electric-sql/pglite-socket`, one
in-process instance per fresh database, so `npm test` skips none of them. PGlite multiplexes one engine connection
and is PostgreSQL 17, so `npm run test:server:pg` (PostgreSQL 18 in Docker, also in the pre-push hook) remains the
authoritative run for concurrency and version behaviour. `npm run smoke:server` runs the readiness test inside the
built image against a private Docker database and never loads PGlite. Electron persistence tests call the
actual Node SQLite adapter on a temporary file and reopen it.

**Integrity after every test.** `core/data/database/integrity` (`checkIntegrity`, also `kolo check`) separates
corruption (SQLite damage, foreign keys, stock movements vs sale/purchase lines, credit-sale debt vs the sale's own
arithmetic, returns beyond the original, cross-shop references, this till's journal counter) from attention states
(quarantined, unsupported or stuck sync work). Core suites that build real databases, the desktop host tests and the
server's real-PostgreSQL tills close their databases through `closeConsistent`, so every scenario also proves the
shop is still consistent afterwards.

**CLI as an independent checker.** `npm run smoke:desktop:workflow` ends by running `kolo backup verify`, `kolo
check --backup` and `kolo report sales --backup` on the backup the real Electron app saved. `npm run test:e2e`
(`scripts/test-e2e-sync.mjs`) starts a disposable PostgreSQL 18, the built server as its own process with a code from
`invite`, an owner till and a `kolo till` process that joins by code; they sync over HTTP, the headless till imports
products the owner then sells, and the run checks convergence, a plaintext-free `pg_dump` and both tills' integrity.
The pre-push hook runs it (after `test:server:pg`) when Docker is reachable.

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

The workspace gate runs locally, not on GitHub: `npm install` sets up a husky `pre-push`
hook (`.husky/pre-push`) that runs `npm run check`, then the Metro export
(`npm run bundle:mobile`), and refuses the push if either fails. `git push --no-verify`
skips it; do so only knowingly. On GitHub, Windows acceptance (`desktop.yml`) runs only when started by
hand (Actions → Run workflow), e.g. before tagging; tag release workflows run as before. Desktop tests run inside Electron's runtime (`ELECTRON_RUN_AS_NODE`), so CI needs the Electron binary that `npm ci` downloads. Add PostgreSQL integration service and packaged/native jobs in their
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

## Desktop release work (2026-10-09)

See [desktop release](desktop-release.md) for the Windows CI, installed-version transition,
credential checks, signing/manual update approach and pending target-platform evidence.
Packaged Linux workflow and WCAG axe audits of setup, till, reports and transfer pass;
this does not establish a Windows result or a full screen-reader audit.

### Restoring a real backup (Linux or Windows/Wine)

The `restore-file` workflow phase restores a supplied backup from a fresh installation's entry screen:

```sh
KOLO_DESKTOP_SMOKE_DIR=<empty dir> KOLO_DESKTOP_SMOKE_PHASE=restore-file \
KOLO_DESKTOP_SMOKE_OPEN_FILE=<file.kolo-backup> KOLO_DESKTOP_SMOKE_OPEN_PASSWORD=<password> \
KOLO_DESKTOP_SMOKE_OPEN_SHOP="<shop name>" KOLO_DESKTOP_AXE_PATH=node_modules/axe-core/axe.min.js \
  node_modules/.bin/electron apps/desktop --workflow-smoke
```

Under Wine, run `wine release/desktop/win-unpacked/KOLO.exe --workflow-smoke` and give paths as `Z:/…`.
A timeout writes its diagnostic to `workflow-smoke.log` in the smoke directory. `npm run demo:desktop`
produces a suitable backup.
