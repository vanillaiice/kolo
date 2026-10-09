# KOLO optional server

Fastify + PostgreSQL ([ADR-025](../../docs/adr/ADR-025-fastify-server.md)). Hosted/self-hosted editions use the same application; hosted
configuration later adds billing. Clients work without a server.

From root: `npm run dev:server`. It builds and watches emitted JS; rerun the build
when changing TypeScript. Copy `.env.example` to `.env` here for PostgreSQL config.
Default bind: localhost:8080.

Implemented: `/healthz`, `/readyz`, `/api/v2/capabilities`. Readiness is 503 without
a reachable database. Unknown routes and failures return `{"error":{"code":…}}`. Capabilities report sync/enrollment false. Auth, ingestion,
and server schema migrations are planned; archived Go migrations are not run.

`Dockerfile` builds from repository root. `infrastructure/compose.selfhost.yml` is a
deployment rehearsal scaffold, not a shipping server edition.

See [API](../../docs/implementation/server-api.md),
[deployment](../../docs/implementation/development.md), and [phases](../../docs/implementation/plan.md).
