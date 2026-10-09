# ADR-021: Signed journal, destination receipts and late-event policy

Date: 2026-10-06. Status: implemented F2 core; native platform acceptance remains open.
Extends [ADR-019](ADR-019-event-exchange-and-destination-delivery.md).

## Decision

Migration 17 adds immutable canonical facts and detached signatures, origin-local
sequence allocation, permanent applied identities and financial entity claims.
Business effects, the new fact and its applied marker commit together. Signing runs
outside the synchronous transaction using the protected installation key; a failed
or interrupted signature leaves a durable unsigned local fact for retry. Historic
unsigned v1 events are never retroactively signed.

The signed envelope includes business, event ID, origin device/sequence, actor,
type/version, occurrence time, branch, authority revision, required permissions and
payload. Canonical JSON follows RFC 8785 string serialization and UTF-16 key ordering,
restricted to safe integer numbers. It rejects invalid Unicode, non-JSON values,
accessors, cycles, excessive depth and bytes. Events are limited to 1 MiB and signed
containers to 8 MiB/1000 events. Native readers must enforce the byte limit before
loading a file. SHA-256 digests and detached Ed25519 signatures use lowercase hex.
The signed UTF-8 message is a domain prefix plus canonical JSON:
`kolo.event.v2\0`, `kolo.batch.v2\0` or `kolo.receipt.v1\0`.

Origin and forwarding sender signatures are verified independently under current
owner-approved pinned public keys. A receiver is bound into the batch. Relay preserves
an event's exact origin, actor, sequence, occurrence time, digest and signature.
Verification capabilities are private, bound to exact content and the unlocked
context; crypto awaits are followed by current authority/trust checks.

A verified event is durably stored before application. A separate application commit
includes every business row, financial entity claim and permanent applied identity.
A savepoint prevents partial effects even with a driver that joins outer transactions.
Missing dependencies defer; unsupported verified versions are retained; malformed,
unauthorized or conflicting facts are quarantined. Same event ID/origin position with
different content is recorded separately without overwriting the first fact.

Owner-signed authority changes require a separately approved authority-capable device.
Membership/grant changes advance explicit revisions, and future revisions wait for
prerequisites. Concurrent authority edits at the same revision conflict. Imported
credential reset/recovery events advance authority; they never copy native PINs,
verifiers or credential references. Remote staff need device-local provisioning.

Financial imports require current active actor permissions and the exact current
membership revision. A future revision waits; older/revoked authority is quarantined.
Price discrepancies against the receiving catalog require the price-override claim;
a catalog change can therefore require review for a legitimate earlier sale. The
owner may explicitly approve an exact signed business digest after a permission or
revision conflict. That immutable review is audited; strict payload/scope/dependency/
financial checks still apply. It cannot approve authority changes, ID collisions,
malformed facts or revoked device keys. No untrusted wall-clock revocation cutoff is
claimed. Imported credit sales are not rejected against the combined current credit
limit: independent authorized offline sales both remain facts.

Offering a batch creates per-destination metadata, never acceptance. A signed receipt
acknowledges only exact durable digests from an actual offered batch and the expected
receiver. Stored/deferred/unsupported acknowledgments differ from applied; an applied
acknowledgment cannot be downgraded. Receipt loss permits resending without repeating
effects. Peer acknowledgments never change another destination or HTTP v1 cloud state.

Migration retains original v1 outbox/inbox IDs, source positions and delivery state
in an immutable archive plus an explicit `unsigned_v1_snapshot` baseline/watermark.
Pruned historic facts are not fabricated. The old HTTP sync engine is restricted to
unconverted legacy workspaces; configured installations require signed v2 exchange.
No journal, signature, dedup identity or legacy archive pruning is enabled.

## Evidence and limits

Real SQLite replicas and Node/OpenSSL exercise duplicate/reordered facts, both offline
sales, negative stock, relay, lost receipts, origin proof mutations, malformed fan-out,
SQL rollback/retry, stale-authority review, scoped delivery, branch preservation,
membership revisions and legacy migration. Desktop tests exercise signing through
the protected credential adapter; Android Metro resolves native imports.

F3 still supplies pairing/key confirmation, approved baselines, encrypted exchange
files, backup/restore and native transfer screens. Nest v2 ingestion is F6. Fixture
baselines do not prove pairing. Android and Windows native crypto/storage acceptance
remains a platform gate; TypeScript and OpenSSL tests do not replace it.

References: [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785),
[Node signing](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback).
