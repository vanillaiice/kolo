# Architecture Decision Records

Each ADR records one decision, its context, and its consequences.

An ADR is immutable once accepted. To change a decision, write a new ADR that
supersedes it — do not edit history. This mirrors the system's own rule that
corrections are new records rather than destructive edits.

| ADR | Decision | Status |
|---|---|---|
| [001](ADR-001-offline-first.md) | Offline-first architecture | Accepted |
| [002](ADR-002-sqlite-local-database.md) | SQLite as the local operational database | Accepted |
| [003](ADR-003-postgresql-server-database.md) | PostgreSQL as the server database | Accepted |
| [004](ADR-004-react-native-client.md) | React Native + TypeScript client | Accepted |
| [005](ADR-005-go-backend.md) | Go backend | Superseded by ADR-017 |
| [006](ADR-006-event-based-synchronization.md) | Event-based synchronization | Accepted |
| [007](ADR-007-immutable-financial-transactions.md) | Immutable financial transactions | Accepted |
| [008](ADR-008-multi-tenant-architecture.md) | Multi-tenant architecture | Accepted |
| [009](ADR-009-inventory-movement-ledger.md) | Inventory movement ledger | Accepted |
| [010](ADR-010-integer-minor-units-for-money.md) | Integer minor units for money | Accepted |
| [011](ADR-011-uuidv7-identifiers.md) | UUIDv7 identifiers from a standard library | Accepted |
| [012](ADR-012-authentication.md) | Phone-and-PIN authentication with cached sessions | Partially superseded by ADR-018 |
| [013](ADR-013-server-persistence.md) | Server persistence: driver, migrations, tenant enforcement | Go tooling superseded by ADR-017; isolation retained |
| [014](ADR-014-client-writes-and-the-sync-outbox.md) | Client writes and the sync outbox | Accepted |
| [015](ADR-015-last-write-wins-for-products.md) | Last-write-wins for products, customers, accounts and suppliers | Accepted |
| [016](ADR-016-expo-and-the-device-sqlite-driver.md) | Expo, and the device's SQLite driver | Accepted |

| [017](ADR-017-typescript-workspaces-and-optional-server.md) | TypeScript workspaces, Electron desktop, optional NestJS server | Server framework superseded by ADR-025 |
| [018](ADR-018-standalone-editions-and-local-authority.md) | Standalone editions and local authority | Accepted |
| [019](ADR-019-event-exchange-and-destination-delivery.md) | Event exchange and per-destination delivery | Accepted |

| [020](ADR-020-local-credential-policy.md) | Native local credentials and recovery | Implemented candidate; platform gate pending |

| [021](ADR-021-signed-journal-and-late-event-policy.md) | Signed journal, destination receipts and late-event policy | Implemented core; native verification pending |

ADR-001 through ADR-009 record the baseline established by `SPECIFICATION.md`
(§63). They are written down so that later work has something concrete to
consult and supersede, per §55.

- [ADR-022: Encrypted files and approved snapshots](ADR-022-encrypted-files-and-approved-snapshots.md)

- [ADR-023: Partial returns and source ordering](ADR-023-partial-returns-and-source-ordering.md) — exact compensating returns and competing offline source chains.

- [ADR-024: Licensing and paid cosmetic unlocks](ADR-024-licensing-and-paid-unlocks.md) — clients GPL-3.0, server closed for now; draft trademark, offline-signed one-time branding unlock.

- [ADR-025: Fastify for the optional server](ADR-025-fastify-server.md) — replaces NestJS/Express; TypeScript, pg and shared contracts stay.

- [ADR-026: Compressed transfer files and larger snapshots](ADR-026-compressed-transfer-files.md) — deflate before encryption (format v2), bounded inflation, 128 MiB snapshots; supersedes ADR-022 limits.
