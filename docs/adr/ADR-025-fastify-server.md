# ADR-025: Fastify for the optional server

**Status:** Accepted, 2026-10-09
**Supersedes:** the NestJS/Express server framework in ADR-017. TypeScript, PostgreSQL/pg,
shared `@kolo/core`/`@kolo/contracts` and every other ADR-017 decision remain.

## Context

The server must verify client-signed exchange bundles byte-for-byte as the clients
produce them, validate with the same schemas, store events in PostgreSQL and deliver
them per destination. That logic already exists in TypeScript, so the language stays.
The Nest scaffold was about 100 lines (health, readiness, capabilities). Its decorators,
`reflect-metadata` and RxJS add weight and indirection a small sync API does not need.
The user wants a strongly typed, testable, fast, light server that can serve many shops.

## Decision

Use Fastify 5 on Node 24 with pg and PostgreSQL. One `createApplication(config)` builds
the instance without listening. Routes are plain handlers; validation uses the shared
contract schemas; failures use one `{ "error": { "code": … } }` shape and never echo
internals. Tests use `inject()` or an ephemeral listener and real PostgreSQL. A typed
SQL query builder (Kysely) is proposed for F6 repositories but not yet added; explicit
SQL and transactions remain the rule.

## Consequences

No client changes: no client imports the server, and the scaffold has no sync routes.
Nest-specific module/guard/pipe structure is replaced by Fastify plugins and hooks;
authorization still belongs inside operations. Instances stay stateless behind a reverse
proxy so they can scale horizontally, with PostgreSQL as the expected bottleneck. The
server is closed source for now (ADR-024) and must move to a private repository before
the client repository is published.
