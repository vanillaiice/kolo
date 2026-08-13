# KOLO

Offline-first business management platform (inventory, POS, customer credit, cash, reports)
for small and medium businesses in Cameroon.

`SPECIFICATION.md` is the source of truth. See `docs/adr/` for architectural decisions.

## Repository layout

```
apps/mobile/          React Native + TypeScript client (Android-first)
backend/              Go backend (cmd, internal, migrations)
packages/             Shared contracts (types, validation)
docs/                 Product, architecture, domain, database, api, ADRs
scripts/              Development and operational scripts
infrastructure/       Deployment configuration
```

## Backend

Requires Go 1.26+.

```sh
cd backend
go test ./...      # run tests
go vet ./...       # vet
```

## Source of truth hierarchy

```
Product specification → Architecture specification → ADRs
    → Domain specifications → Implementation → Tests
```

If implementation conflicts with the specification, raise the conflict rather than
silently normalising it.
