# KOLO technical overview

KOLO is an npm workspace of standalone clients over a shared TypeScript core. Each
client owns a local SQLite database and completes every business operation offline.
An optional server synchronizes encrypted, signed events between installations.

## Repository

| Path | Contents |
|---|---|
| `packages/core` | Business rules, SQLite operations, migrations, signed replay |
| `packages/contracts` | Runtime-validated exchange payloads and signed formats |
| `apps/desktop` | Electron + React; the main process owns SQLite and credentials |
| `apps/mobile` | Expo / React Native, Android first |
| `apps/server` | Fastify + PostgreSQL encrypted relay and hosted billing |
| `apps/admin` | Operator dashboard served by the server on its own loopback listener |
| `apps/cli` | [CLI](../apps/cli/README.md): offline tools and paired headless till |
| `apps/landing` | Bilingual static website |
| `infrastructure` | Development database and self-host deployment |
| `docs` | Decisions, implementation guides, generated API reference |

## Development

Requires Node 24 LTS (at least 24.16, see `.nvmrc`) and npm 11. Install from the root;
there is one lockfile.

```sh
npm ci
npm run check            # boundaries, types, tests, API docs, builds
npm run bundle:mobile    # Metro bundle for Android
npm run dev:desktop
npm run dev:mobile
npm run dev:server
```

`make help` lists the same commands. Device, packaged-app and container checks are
separate; see [testing](implementation/testing.md). Expo controls mobile SDK versions;
do not upgrade React Native on its own.

After changing an exported declaration, run `npm run docs:api`. Public methods document
validation, authorization, transactions, events, errors and retries in JSDoc.

## Documentation

- [Implementation guide](implementation/README.md): architecture, plan and every subsystem guide
- [Progress log](implementation/progress.md): what is implemented and verified
- [Releasing](releasing.md): tags, CI release builds and signing
- [Architecture decisions](adr/README.md)
- [Generated API reference](reference/typescript-api.md)
- [Product specification](../SPECIFICATION.md)
