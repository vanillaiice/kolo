# KOLO optional server

Fastify + PostgreSQL ([ADR-025](../../docs/adr/ADR-025-fastify-server.md)). Clients
work without it; hosted and self-hosted editions will run the same application.

Implemented: `/healthz`, `/readyz` (503 without a database) and `/api/v2/capabilities`.
Authentication, event ingestion and server migrations are planned.

From the root, `npm run dev:server` builds and watches on `localhost:8080`. Copy
`.env.example` to `.env` here for PostgreSQL settings. The `Dockerfile` builds from the
repository root; `infrastructure/compose.selfhost.yml` is a deployment scaffold.

See the [server API](../../docs/implementation/server-api.md) and
[deployment guide](../../docs/implementation/development.md).
