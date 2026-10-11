# ADR-029: Sync server relay, enrollment, sessions and propagated device trust

Date: 2026-10-11. Status: accepted and implemented (F6a). Extends ADR-018, ADR-019, ADR-021 and ADR-025;
replaces ADR-012's server-verified PIN login for the v2 server. Amended by
[ADR-030](ADR-030-end-to-end-encryption-and-connection-codes.md): connection codes replace the
enrollment code, sync becomes end-to-end encrypted and F6b server-side application is dropped.

## Context

F2/F3 gave every installation a signed journal, per-destination delivery and owner-approved pairing.
The optional server (spec §25, §30, §36) must let several tills of one shop converge over HTTP without
becoming a prerequisite for trading (ADR-001, ADR-018). Two gaps blocked this:

1. A device only trusted the keys it was paired with directly. Device trust was never a fact, so a till
   paired after another one could never verify that other till's sales, whether relayed by file or server.
2. The server needed its own identity in each shop, and `devices.platform` could not express it.

## Decision

**Owner-signed device trust.** `DEVICE_TRUSTED { device{id,label,platform,public_key}, authority_allowed, revision }`
and `DEVICE_REVOKED { device_id, revision }` are new signed v2 authority facts. They are applied only when
the actor is the shop owner on an authority-capable pinned device and the envelope requires `users.manage`.
The owner's device emits one whenever it registers or revokes a key, and `publishDeviceRoster` publishes keys
approved by earlier pairing once (new facts; nothing historical is re-signed). The highest roster revision
wins regardless of arrival order. An equal revision with different content is a conflict. A changed key for
a known device ID is refused. A device never trusts or revokes itself through these facts.

Importing a batch now verifies every event it can. An event whose origin is not yet trusted is not stored,
not acknowledged and is reported as `untrusted`; the importer retries it within the same batch after trust
facts apply, and otherwise it stays offered by its sender. Any other proof failure still refuses the batch.
An imported fact is recorded as already held by the device that sent it, so it is never offered back.

**Migration 25** (forward-only) rebuilds `devices` to allow platform `SERVER` (copy, drop, recreate and
re-insert under deferred foreign keys so child references stay valid), adds
`trusted_exchange_devices.roster_revision`, and adds `server_endpoints` for a connected server's address
and last outcome.

**The server is a relay destination.** It has one Ed25519 identity (`KOLO_SERVER_KEY_FILE`, created
`0600` on first start) and is registered on clients as a `kind:'server'`, `platform:'SERVER'` destination
without authority. It speaks the existing signed batch and receipt formats:

- `push`: authenticates the session, the batch sender and every origin, stores each verified fact in an
  append-only PostgreSQL journal and answers per event (`stored`, `duplicate`, or `rejected` with
  `untrusted_device` retryable, `invalid_signature`, `event_identity_conflict`). Changed content under a
  known identity is kept in `journal_conflicts` and never overwrites. A server-signed receipt covers exactly
  the stored and duplicate digests.
- `pull`: a bounded, server-signed page of facts the device has not acknowledged, original proofs intact,
  never including its own facts. The cursor only pages within one pass; the next pass starts over, so a
  fact a device skipped is never hidden behind a cursor.
- `receipts`: the device's signed acknowledgment of one offered page; applied never downgrades.
- `bootstrap`: owner-signed trust facts, so a device without authority learns the server's key from the
  owner rather than from the server.

The relay applies no business rules: every till still applies every fact with the shared core. Roster
facts are the one thing the server interprets, to know which keys may push and open sessions.

**Enrollment and sessions.** Attaching a shop requires the owner's authority-capable device to sign a
single-use challenge naming the shop, owner and its own key, plus the deployment's `KOLO_ENROLLMENT_CODE`
(enrollment is closed when unset). Shop and device IDs are kept. Another device claiming an enrolled shop
is `enrollment_conflict`; re-enrolling from the same device is idempotent. A trusted device signs a
single-use challenge for a 43-character bearer token stored only as a SHA-256 hash (default one hour).
No PIN, verifier, private key or credential reaches the server. Revoking a device ends its access on its
next request. Server addresses must be HTTPS except on loopback and private LAN addresses; payloads are
signed either way but are not encrypted at the application layer, so public deployments need TLS.

**Clients** (`core/application/server-sync`, `http-sync-transport`) connect after the person compares the
server's fingerprint with the one the server prints, then run bounded passes: push pending facts, pull
until empty, signing receipts for durable pages only. A lost response only causes a harmless resend.
Desktop runs passes in the Electron main process every minute while someone with shop-settings access is
signed in, sooner after a local change, backing off to fifteen minutes on failure.

## Consequences

- Devices paired at different times converge through the server or through file relay.
- The server holds signed business facts in plaintext. Hosted operation needs TLS, disk encryption and
  access control; end-to-end encryption is a later decision.
- Rate limits are per instance. Several instances behind a load balancer need a shared store.
- Server-side business application, centralized reports and Go fixture parity remain F6b. Permission
  checks on each event's actor happen on every receiving till, not on the server.
- Mobile uses the same core operations; its connection screen and background scheduling are pending.
