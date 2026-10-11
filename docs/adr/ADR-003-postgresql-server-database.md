# ADR-003: PostgreSQL as the server database

**Status:** Accepted
**Source:** SPECIFICATION.md §23, §31, §63

## Context

The platform needs a central store for multi-device coordination, backup, remote
access, centralized reporting, authentication state, and audit data.

## Decision

PostgreSQL is the server database. It is responsible for centralized business
data, synchronization state, multi-device coordination, server-side reporting,
authentication-related state, audit data, and backup.

SQLite (ADR-002) remains the local operational database. PostgreSQL is not in the
path of any core business operation.

## Consequences

* Server schema and client schema are related but independent artefacts, with
  separate migration histories.
* The server is the durable system of record across devices, but it is not the
  arbiter of whether a business operation may proceed; that is decided locally.
* Idempotency of event application (ADR-006) is enforced with database
  constraints, not only in application code.
