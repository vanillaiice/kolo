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
| [005](ADR-005-go-backend.md) | Go backend | Accepted |
| [006](ADR-006-event-based-synchronization.md) | Event-based synchronization | Accepted |
| [007](ADR-007-immutable-financial-transactions.md) | Immutable financial transactions | Accepted |
| [008](ADR-008-multi-tenant-architecture.md) | Multi-tenant architecture | Accepted |
| [009](ADR-009-inventory-movement-ledger.md) | Inventory movement ledger | Accepted |
| [010](ADR-010-integer-minor-units-for-money.md) | Integer minor units for money | Accepted |
| [011](ADR-011-uuidv7-identifiers.md) | UUIDv7 identifiers from a standard library | Accepted |
| [012](ADR-012-authentication.md) | Phone-and-PIN authentication with cached sessions | Accepted |
| [013](ADR-013-server-persistence.md) | Server persistence: driver, migrations, tenant enforcement | Accepted |

ADR-001 through ADR-009 record the baseline established by `SPECIFICATION.md`
(§63). They are written down so that later work has something concrete to
consult and supersede, per §55.
