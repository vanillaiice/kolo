# KOLO

Standalone business management for Cameroon: inventory, POS, credit, suppliers,
cash, expenses, and reports. Mobile and desktop operate from local SQLite.
Encrypted file exchange and backup/restore are implemented; Bluetooth is planned. Optional hosted or
self-hosted synchronization connects the same installations.

The architecture was accepted on 2026-10-05. Start with the [implementation guide](docs/implementation/README.md)
and [phased plan](docs/implementation/plan.md). [SPECIFICATION.md](SPECIFICATION.md) owns
product rules; ADR-017 through ADR-019 record the updated architecture.

## Repository

| Directory | Responsibility | Current state |
|---|---|---|
| `packages/core` | Shared exact rules, SQLite operations, signed replay and receipts | F1–F3 core and real SQLite replica tests |
| `packages/contracts` | Strict payloads, canonical signed batches/receipts | Signed events, pairing and encrypted file formats |
| `apps/mobile` | Expo/React Native screens and native SQLite/keystore wiring | Local setup/POS, backup, pairing and file exchange; native acceptance pending |
| `apps/desktop` | Electron/React app; main process owns SQLite | Local setup/recovery, product/stock, cash till and receipts; broader workflows/Windows acceptance pending |
| `apps/server` | NestJS/PostgreSQL optional synchronization server | Health/readiness/capabilities; sync planned |
| `infrastructure` | Development database and self-host deployment scaffold | Compose and server Dockerfile |
| `docs` | Decisions, plan, contracts, testing, function reference | Current architecture and implementation status |
| `archive/legacy-go` | Previous Go server, migrations, and tests | Preserved reference; excluded from active checks |

## Development

Use Node **24 LTS, at least 24.16**, and npm 11. Install from the repository root;
there is one active npm lockfile. `.nvmrc` selects the Node line. Mobile SDK versions
remain controlled by Expo; do not independently upgrade React Native.

```sh
npm ci
npm run check
npm run bundle:mobile
npm run dev:mobile
npm run dev:desktop
npm run dev:server
```

`npm run check` builds shared packages, checks imports and types, runs tests,
checks the API reference and documentation links, and builds server/desktop.
Native/device and container checks are separate; see [testing](docs/implementation/testing.md).
`make help` lists equivalents and explicit archived Go test targets.

Desktop has its first offline setup/product/cash-sale/receipt workflow. Mobile has standalone setup and operational
screens, with Android device acceptance pending. Desktop/web is now the implementation
priority; see the [desktop milestone](docs/implementation/desktop.md). A browser app
has not been implemented.
The new server does not implement authentication or event ingestion yet.
The [status log](docs/implementation/progress.md) records verified foundations and
remaining work separately.

## Documentation

- [Architecture and editions](docs/implementation/architecture.md)
- [Phases and acceptance criteria](docs/implementation/plan.md)
- [Business operations and database rules](docs/implementation/business-core.md)
- [Exchange, import, backup, and Bluetooth](docs/implementation/exchange.md)
- [Implemented and planned server API](docs/implementation/server-api.md)
- [Offline identity and authorization](docs/implementation/identity.md)
- [Testing and release gates](docs/implementation/testing.md)
- [Development, migration, deployment, and upgrades](docs/implementation/development.md)
- [Generated public functions, types, and methods](docs/reference/typescript-api.md)

Public APIs are documented from source JSDoc: run `npm run docs:api` after changing
an exported declaration. Business methods must state validation, authorization,
transaction boundaries, event effects, error behavior, and retry semantics.
