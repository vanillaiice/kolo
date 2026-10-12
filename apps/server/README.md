# KOLO sync server

Optional Fastify/PostgreSQL server for hosted and self-hosted shops. It relays
end-to-end encrypted shop events between devices; local trading works without it.
Supports device enrollment, signed sessions, sync, join codes and hosted billing.
The operator dashboard runs on a separate loopback listener.

## Local setup

Requires Node 24.16+ (24.x), npm 11 and PostgreSQL. From the repository root:

```sh
npm ci
cp apps/server/.env.example apps/server/.env
# Configure DATABASE_URL; set KOLO_PUBLIC_URL to the address devices will use.
npm run build:packages
npm run build -w @kolo/admin
npm run build -w @kolo/server
npm run migrate -w @kolo/server
npm run dev:server
```

Sync listens at `127.0.0.1:8080` by default. `/healthz` checks liveness;
`/readyz` requires a reachable, migrated database. `/api/v2/capabilities` reports
whether sync and enrollment are available. Serving does not apply migrations.
The dev command watches compiled JavaScript; rebuild after TypeScript edits.

From `apps/server`, create an operator and issue a shop connection code:

```sh
node --env-file=.env dist/main.js admin create operator
node --env-file=.env dist/main.js invite --label "Shop name"
```

The dashboard defaults to `http://127.0.0.1:8081/admin/`. Back up the server identity
file with PostgreSQL; devices pin that identity.

See the [API guide](../../docs/implementation/server-api.md),
[self-hosting guide](../../docs/implementation/selfhost.md) and
[development guide](../../docs/implementation/development.md) for deployment and tests.

Licensed under [AGPL-3.0-only](LICENSE).
