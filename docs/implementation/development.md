# Development, migration, deployment and upgrades

## Workspaces and commands

Use Node 24 LTS ≥24.16, npm 11, root `npm ci`. Do not install from individual app
directories or add competing lockfiles. Shared packages compile first; their exports
point Node/Electron/types to `dist` and Expo to source. Root scripts enforce build order.

`npm run dev:mobile` starts Expo with its native dev-build workflow. F1 adds
QuickCrypto/Nitro; rebuild the native development app before using local credentials.
Normal boot is offline create/unlock, with optional explicit legacy migration.
`npm run dev:mobile:demo` explicitly opts into the developer-only demo seed on an
empty database. Normal start does not seed data; an existing demo database is preserved.
`npm run dev:desktop` builds and launches the first offline desktop workflow; it does not currently
provide Vite hot reload. Pinned Electron downloads its runtime on first developer launch;
standalone installers bundle that runtime. `npm run dist:desktop:win` builds
NSIS and portable artifacts without publishing; see [desktop release](desktop-release.md). `npm run smoke:desktop` verifies actual
Electron SQLite/preload boot with a disposable database and requires a graphical session.
`npm run smoke:desktop:workflow` adds actual setup/product/cash-sale/receipt DOM interaction
and a second process to verify locked restart and persistence. `npm run dev:server` builds and watches emitted JS; rerun the
build for TS edits. Document these limits instead of assuming live reload exists.

Core source edits → JSDoc → `npm run docs:api` → relevant tests → `npm run check`.
App/import edits additionally require `npm run bundle:mobile`. Public API generation
uses TypeScript syntax/type inspection; generated declarations list existing methods
only. Source JSDoc and guides own invariants and planned behaviors.

## Repository migration map

| Previous path | Current path |
|---|---|
| `apps/mobile/src/data/*` | `packages/core/src/data/*`, except native wiring |
| `apps/mobile/src/domain/*` | `packages/core/src/domain/*` |
| `data/database/open-on-device.ts` | Remains app-local; imports core driver/adapter/migrations |
| `data/auth/store-on-device.ts` | Remains app-local; imports core keystore interface |
| `backend/*` | Removed from the tree; available in repository history |
| Mobile package lock | Archived resolution; root lock used by all active workspaces |
| Root historical guidance | Preserved under `docs/history/legacy-project-guidance.md` |

Existing core SQL/JSDoc/tests move together. Native wrappers and app imports now use
package subpaths. Mobile native SDK versions stay Expo-controlled. Go fixtures are
reference evidence; no financial behavior is removed merely because its server is
archived. The Fastify scaffold cannot replace a running Go deployment until F6 parity.

## SQLite and PostgreSQL migrations

Client migrations 1–14 are unchanged. Migrations 15–16 add local authority/setup
and credential/staff recovery intents without auto-adopting legacy sessions or
altering pending outbox. Future journal and
delivery changes append new migrations. Take a verified recoverable backup before shipping an
upgrade, preserve v1 outbox content and report totals, and reject databases newer than
the app. Migration completion is a transaction; do not start the UI against a partial
schema. A released migration is immutable; fixes are a new migration.

The server has its own forward-only PostgreSQL migrations, embedded in `apps/server/src/database.ts`
and applied by Kysely's migrator under its lock with `npm run migrate -w @kolo/server` (or
`node apps/server/dist/main.js migrate`). Serving never migrates; `/readyz` and sync answer
`schema_outdated` until migrations ran. Do not run Go migrations from the server. SQL rollback that
destroys received facts is forbidden; application downgrade requires a compatible schema or a verified restore.

## Sync server deployment

Development DB: `make db-up` runs PostgreSQL 18 on 5433 with the existing named volume.
`make db-down` preserves data; no default target resets the database.

```sh
# Local server: configure, migrate once, create an operator, issue a code per shop, then serve
cp apps/server/.env.example apps/server/.env   # set DATABASE_URL (and KOLO_PUBLIC_URL beyond loopback)
npm run build:packages && npm run build -w @kolo/admin && npm run build -w @kolo/server && npm run migrate -w @kolo/server
(cd apps/server && node --env-file=.env dist/main.js admin create <username>)   # prints password + authenticator QR
(cd apps/server && node --env-file=.env dist/main.js invite --label "Shop name") # paste the code on the owner's till
npm run dev:server   # sync on :8080, operator dashboard on http://127.0.0.1:8081/admin/
npm run dev -w @kolo/admin   # dashboard with hot reload on http://localhost:5173/admin/, API proxied to :8081

# Server tests against a disposable PostgreSQL (each test creates and drops its own database)
KOLO_TEST_DATABASE_URL=postgres://kolo:…@127.0.0.1:5434/kolo_test npm test -w @kolo/server

# Container build from repository root
docker build -f apps/server/Dockerfile -t kolo-server:foundation .

# Build and verify real PostgreSQL readiness with disposable containers
npm run smoke:server

# Deployment rehearsal; set password without putting it into a committed file
docker compose -f infrastructure/compose.selfhost.yml up --build -d
```

Compose requires `KOLO_DATABASE_PASSWORD` and `KOLO_PUBLIC_URL` (printed into connection codes). It migrates
before serving and keeps the server identity on the `identity` volume: back it up with the database,
because a new identity breaks every connection code and makes every till reconnect with a new one. The operator
dashboard is published on the host's loopback (`127.0.0.1:8081`); reach it remotely through an SSH tunnel. Use a URL-safe generated secret or properly
percent-encode it in a configured database URL; the simple interpolation template does
not encode reserved characters. Self-host ports bind localhost; public deployment needs
a TLS reverse proxy and explicit network configuration. Docker's foundation image
installs only the server production dependency graph and compiled shared/server packages;
mobile/desktop tooling and root development dependencies stay out of the runtime. Image
scanning and version/digest pinning are F7 release work. The image runs as Node's non-root user. Keep existing volumes/backups;
do not reuse a real customer database for a test.

## Upgrade methods

One root lock records exact resolved versions. Update one stack at a time: TypeScript
and Node, shared schemas, Fastify, Electron, Expo/native modules. Regenerate lock via root
install; run affected unit/integration/bundle/runtime checks. Electron bundles its own
Node, so test its SQLite/preload runtime rather than assuming host Node behavior.
Expo owns its React/React Native/native SDK version matrix.

Publish minimum/maximum supported event/container/schema versions and migration paths
before releases. Distribution checks must preserve user data when an app upgrade fails.
Standalone customers can receive installers/app updates manually; cloud availability
cannot be a prerequisite for upgrading a standalone database. Code signing, staged
rollout and rollback belong to F9.

## Status and handoff

Every phase records date, changed modules, compatibility impact, checks/results,
remaining native/external limitations and next concrete work in [progress](progress.md).
Do not claim a feature from a schema declaration alone. The open F1 native gate is documented in [native validation](f1-native-validation.md).
F2/F3 real SQLite convergence and Linux native backup/restore checks are recorded.
Android/Windows installed-device transfer acceptance remains open; see
[F3 native validation](f3-native-validation.md).

## Android native test APK

Install JDK 21 and the Expo SDK-compatible Android SDK/NDK; set `ANDROID_HOME` to
the SDK directory. `npm run build:mobile:android` runs Android prebuild, assembles a
release-variant APK with bundled JavaScript, and copies it to `release/mobile`. It
limits Gradle workers to two and retains the generated project for incremental builds.
Native directories remain generated/ignored. The manual Android CI workflow provides
the same artifact. There is no Metro dependency at test runtime.

This is a test APK using the generated debug signing identity, not a production store
release. Versioning, release keystore management and store signing remain release work.
An APK build does not verify SQLite/keystore runtime, offline shop-day behavior, TalkBack
or recovery on a device; follow [F4 acceptance](f4-native-validation.md).
