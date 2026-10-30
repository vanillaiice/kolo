# Architecture Decision Records

Each ADR records one decision, its context, and its consequences.

Accepted ADRs preserve decision history. Changes belong in a superseding ADR.

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
| [021](ADR-021-signed-journal-and-late-event-policy.md) | Signed journal, destination receipts and late-event policy | Implemented core; native verification pending; amended by ADR-040, ADR-042 |
| [022](ADR-022-encrypted-files-and-approved-snapshots.md) | Encrypted files and approved snapshots | File format and size limits superseded by ADR-035 |
| [023](ADR-023-partial-returns-and-source-ordering.md) | Partial returns and source ordering | Accepted; amended by ADR-041 |
| [024](ADR-024-licensing-and-paid-unlocks.md) | Licensing and paid cosmetic unlocks | Server license amended to AGPL-3.0-only |
| [025](ADR-025-fastify-server.md) | Fastify for the optional server | Accepted |
| [026](ADR-026-compressed-transfer-files.md) | Compressed transfer files and larger snapshots | File format superseded by ADR-035 |
| [027](ADR-027-large-files-and-product-photos.md) | Large transfer files and optional product photos | Size profiles superseded by ADR-035 |
| [028](ADR-028-additional-product-categories.md) | Main and additional product categories | Accepted |
| [029](ADR-029-sync-server-relay.md) | Sync relay, enrollment, sessions and device trust | Accepted; amended by ADR-030, ADR-040 |
| [030](ADR-030-end-to-end-encryption-and-connection-codes.md) | Encrypted sync and single-use connection codes | Accepted; amended by ADR-040, ADR-043 |
| [031](ADR-031-hosted-subscriptions-manual-billing.md) | Hosted subscriptions with manual billing | Accepted |
| [032](ADR-032-join-by-code.md) | Adding a till with a short code | Accepted; amended by ADR-044 |
| [033](ADR-033-tax-payment-terms-notifications.md) | Tax, payment terms and local notifications | Accepted |
| [034](ADR-034-local-network-pairing-and-sync.md) | Direct local-network pairing and synchronization | Accepted |
| [035](ADR-035-binary-encrypted-container.md) | Encrypted container with key slots | Accepted (device acceptance open) |
| [036](ADR-036-shop-backup-recovery-key.md) | Shop backup recovery key | Accepted |
| [037](ADR-037-role-permission-matrix.md) | Shop role permission matrix | Accepted |
| [038](ADR-038-custom-roles.md) | Shop-defined roles | Accepted |
| [039](ADR-039-till-limits-and-trial-days.md) | Till limits per shop and trial days on codes | Accepted |
| [040](ADR-040-revoked-device-history.md) | A revoked till's history stays accepted up to a cutoff | Accepted |
| [041](ADR-041-concurrent-returns.md) | Two tills returning the same sale offline | Accepted |
| [042](ADR-042-authority-revision-history.md) | Facts are judged by the revision they were signed under | Accepted |
| [043](ADR-043-vouched-positions.md) | Only a vouched fact holds its origin position on the server | Accepted |
| [044](ADR-044-join-code-key-stretching.md) | The join code is stretched with Argon2id | Accepted |
| [045](ADR-045-operator-dashboard-v2.md) | Operator dashboard v2: Preact, strict requests, step-up and a chained audit log | Accepted |
