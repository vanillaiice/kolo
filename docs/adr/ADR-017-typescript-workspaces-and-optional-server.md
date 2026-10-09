# ADR-017: TypeScript workspaces, Electron desktop and optional NestJS server

**Status:** Accepted, 2026-10-05
**Supersedes:** ADR-005 backend language; ADR-013 Go-specific driver/migration tooling.
**Retains:** PostgreSQL, SQLite, tenant isolation, immutable finances, React Native/Expo.

## Context

The user explicitly chose standalone mobile/desktop and optional hosted/self-hosted
sync. Go maintenance is slowing product work. A Rails server was considered, but the
business rules must run in both offline clients; sharing TypeScript reduces duplicated
rules and preserves existing tested data logic.

## Decision

Use strict TypeScript npm workspaces: `packages/core`, `packages/contracts`, Expo mobile,
Electron/React desktop and an optional NestJS/Express server with PostgreSQL/pg. One root
lockfile and Node 24 LTS own tooling. Preserve Go under `archive/legacy-go` until parity.
Electron's Node process owns SQLite; renderer receives named IPC operations, not SQL.
Native SDK imports remain app-local. Pure domain rules are shared; local SQLite and
server PostgreSQL repositories/transaction orchestration remain separate.

## Consequences

The backend can share numerical/validation contracts with installed clients. Electron
distribution/runtime cost needs target-PC measurement. Framework validation does not
replace domain operations, authorization or DB invariants. Nest foundation is not server
parity: financial appliers, identity, migrations and sync require F6 checks. Package source
exports for Metro and compiled exports for Node are explicit and tested. Rails is not
the chosen desktop/server baseline; revisiting it requires a new decision.
