# KOLO sync server

The optional server that will keep several KOLO devices of one shop in step. The
Android and desktop apps never need it: every sale and stock movement is saved on the
device first, and shops already move data between devices with encrypted backups and
file exchange. Hosted and self-hosted editions will run this same application.

Built with Fastify and PostgreSQL ([ADR-025](../../docs/adr/ADR-025-fastify-server.md)).
Licensed under [AGPL-3.0-only](LICENSE): anyone who runs a modified copy as a service
must share their changes with its users.

## Status

Synchronization is **not available yet**. Implemented today:

- `GET /healthz`: the process is up.
- `GET /readyz`: PostgreSQL is reachable (503 without a database).
- `GET /api/v2/capabilities`: API and exchange format versions, with `sync` and
  `enrollment` reported as `false` until they ship.

Device enrollment, authentication, event ingestion and server migrations are planned.

## Running it

From the repository root, `npm run dev:server` builds and watches on `localhost:8080`.
Copy `.env.example` to `.env` in this directory for the host, port and PostgreSQL
settings. The `Dockerfile` builds from the repository root (`npm run smoke:server`
builds and checks the image); `infrastructure/compose.selfhost.yml` is a deployment
scaffold.

See the [server API](../../docs/implementation/server-api.md) and
[deployment guide](../../docs/implementation/development.md).
