# Exchange, replay, backup and Bluetooth

## Implemented F2 core

`contracts/events` defines strict current payloads and the immutable v2 envelope;
`contracts/canonical` defines signed bytes; `contracts/delivery` defines authenticated
batches and per-peer receipts. The older unsigned `kolo.exchange` format remains a
legacy structural codec. It conveys no verified authority.

`application/exchange` implements owner-approved destination/key registration,
device trust suspension, `sealPendingEvents` and `verifyEvent`. Registration requires
owner approval in the unlocked local context; F3 pairing confirms keys before
calling it. `application/event-application` implements `applyEvent`, `retryDeferred`
and exact-digest owner review. `application/event-delivery` implements
`eventsForDestination`, `exchangeStatus`, `createJournalBatch`, `importJournalBatch`,
`createPeerReceipt` and `acknowledgeDelivery`.

F3 adds encrypted native files, snapshots, pairing and mobile screens around these
shared operations. Bluetooth and Nest v2 ingestion remain later phases. Read [ADR-021](../adr/ADR-021-signed-journal-and-late-event-policy.md)
for byte encoding, trust, revisions and late-event decisions.

## Signed containers

Events have `event_id`, `business_id`, `origin_device_id`, `actor_id`,
`origin_sequence`, `event_type`, `event_version`, `occurred_at`, `branch_id`,
`authority_revision`, `required_permissions` and a strict payload. The detached proof
contains `{ envelope, digest, signature }`. Every envelope field is signed.

A signed batch contains `{ batch, digest, signature }`; `batch` has format
`kolo.events`, format version 2, batch/shop/sender/receiver IDs, creation time and
1–1000 signed events. Its sender may forward another device's facts. Original proofs
are preserved. A signed receipt contains `{ receipt, digest, signature }`; `receipt`
has format `kolo.receipt`, version 1, receipt/shop/sender/receiver/batch IDs, creation
time and exact event digests with stored/applied/deferred/unsupported states.

Canonical JSON uses UTF-16 sorted keys, ECMAScript string escaping and safe integer
numbers only; array order remains significant. Invalid Unicode, cycles/accessors,
non-JSON values and excessive depth are refused. SHA-256 and Ed25519 sign domain-prefixed
UTF-8 bytes; digests/signatures are lowercase hex. Envelopes are bounded to 1 MiB,
containers to 8 MiB. `decodeSignedJournalBatch` checks raw UTF-8 bounds before parsing;
native readers must bound file reads as well. Signatures authenticate data but do not
encrypt customer or financial information.

## Journal and delivery storage

| Table | Meaning |
|---|---|
| `event_journal`, `event_signatures` | Immutable envelope and original detached proof |
| `journal_origins` | Sequence allocated transactionally per shop/origin |
| `applied_events`, `journal_entity_claims` | Permanent application/financial identity |
| `trusted_exchange_devices` | Scoped public-key pins and distinct authority capability |
| `exchange_destinations`, `event_deliveries` | Independent receiver progress |
| `offered_batches`, `offered_batch_events` | Exact batch/digest coverage offered to a receiver |
| `import_batches`, `import_batch_events` | Durable received batch and per-event progress |
| `peer_receipts` | Authenticated receiver acknowledgments |
| `exchange_conflicts`, `event_reviews` | Preserved collisions and audited exact-digest decisions |
| `legacy_event_archive`, `legacy_baselines` | Unsigned v1 provenance, original positions and watermark |

New local business effects, v2 fact and applied identity share the same transaction.
Native signing runs afterward; failure or lock leaves the fact queued for signing,
not a failed sale. Mobile seals on unlock and retries pending signatures while unlocked.
There is no network dependency. Desktop/native ports support signing; desktop setup
and transfer renderer UI remain F5.

## Import and retry

1. Bound and parse the signed batch; verify shop/receiver, forwarding sender and each
   independently pinned origin. Changed proof or unknown/revoked key grants no acceptance.
2. Persist verified content and import progress. Same identity/content is a duplicate;
   changed event ID/origin-position content is quarantined in separate immutable diagnostics.
3. Validate strict payloads, safe arithmetic, fan-out, signs, branch/reference scope,
   current actor authority and financial entity ownership.
4. Apply every business row plus its permanent applied marker in one transaction.
   Missing dependencies defer without partial effects. Retry has bounded passes.
   Future verified payload versions remain signed and unapplied for an upgrade.
5. Sign a receipt for exact durable non-quarantined digests only. Stored/deferred does
   not claim business application. Re-import after interruption resumes safely.

Grant/suspension/reset facts advance membership revisions; future revisions wait.
Older/revoked authority and price discrepancies may require owner review of the exact
signed digest. An untrusted occurrence clock cannot establish a secure revocation
cutoff. Review cannot authorize malformed or cross-shop facts. Imported staff identities
have no usable local credential until separately provisioned; secrets never replicate.
Independent authorized offline credit sales both stand even if their combined balance
exceeds the pre-existing limit.

## Receipt and legacy semantics

Sending is offered, never delivered. A receipt must be signed by the expected receiver
and refer to exact digests from a real offered batch. Repeated receipts are harmless;
applied acknowledgments cannot be downgraded. Progress belongs to a destination;
missing events are represented individually, never skipped using a maximum sequence.
A server cursor belongs to that server, not a peer.

Migration 17 copies v1 outbox/inbox IDs, positions and delivery metadata into an immutable
archive and declares unsigned baseline provenance. Original queues remain unchanged;
old events and pruned history are never invented or retroactively signed. The HTTP v1
engine accepts unconverted legacy workspaces only. New configured workspaces require
signed v2 exchange; Nest parity is F6. Peer receipts cannot clear old cloud work.
No pruning is enabled without backup/baseline and peer retention rules.

## F3 backup and trusted file exchange

F3 implements `createBackup`, `previewBackup`, `restoreWorkspace`, `createPairingInvite`,
`acceptPairingInvite`, `confirmPairing`, `completePairing`, `exportBundle`, `previewBundle`,
`importBundle`, `exportReceipt` and `importReceipt`. Mobile has native file screens;
desktop has native crypto/active-slot/file-dialog adapters, with renderer work in F5.

AES-256-GCM with fresh nonce/salt and PBKDF2-SHA256/600,000 iterations protects the F2
signed batches/receipts. File passwords are independent of unlock PINs. Input is bounded
before allocation/KDF/application: 24 MiB encrypted file, 8 MiB batch, 16 MiB SQLite
snapshot. No compressed archive is accepted. Previews have no business effects and
actual imports recheck authority. Receipts can be regenerated after loss/cancellation;
exports remain offered until the correct receiver's receipt arrives.

Snapshots include committed WAL writes and remove all local credential/session/native
references before compaction. Exact schema, integrity, foreign keys, shop, owner and
signed boundary are validated in an isolated candidate before forward migration. A new
installation/key starts at sequence 1, while original facts preserve their identities.
A FULL-synchronous active-slot transaction selects the new file; the old file stays.
Existing rollback requires explicit current-owner recovery mode. Restored keys need
new peer approval. Re-pairing an active restored shop preserves its newer local sales.

Pairing compares source fingerprints and request-bound codes independently. The owner
must approve a native-key possession request before the recipient-bound snapshot can
initialize a shop. Secondary membership authority is separately approved. Diagnostic
IDs have French/English recovery descriptions. See
[ADR-022](../adr/ADR-022-encrypted-files-and-approved-snapshots.md) for formats, limits,
recovery/cancellation rules, activation/crash behavior and remaining native gates.

## F8 Bluetooth framing

Bluetooth carries the same authenticated batch/receipt format. Framing needs transfer
ID, negotiated byte limits, ordered chunks, authentication, bounded buffers, resumption
and final receipt. End-to-end shop/device authentication remains required with OS pairing.
BLE/classic selection and supported hardware require the F8 device spikes.

## Evidence

Core tests use real SQLite replicas with approved fixture baselines and distinct real
Ed25519 keys. They cover two offline sales, negative stock, reordered dependencies,
purchases/debt/payments/transfers/reversals, branch preservation, onward relay, receipt
loss, ID/position collisions, forged tokens/proofs, SQL rollback/retry, authority changes,
late-event review and retained cloud queues. These fixtures prove shared replay behavior;
F3 additionally tests real pairing, encrypted files and restore/re-pair workflows.
Actual Linux Electron/OS-vault backup/restore/new-sale passed. Android/Windows device
and crash/power-loss acceptance remain open.


## F4 catalogue and return events

Schema 19 adds category detail device ordering; schema 20 adds append-only source-linked
partial returns. `CATEGORY_SAVED`, `SALE_RETURNED` and `PURCHASE_RETURNED` use the existing
signed v2 envelope/batch/receipt transport. Older clients retain unknown verified types
without application and must upgrade to read schema-20 snapshots. Category references
remain dependencies. Return successors depend on the original transaction/items and
predecessor. They replay the same exact discount/quantity entitlement and compensating
money/stock/debt fan-out. A competing predecessor is quarantined as `return_conflict`,
with actionable French/English diagnostics and no extra effects. It is not an automatic
merge/winner selection: affected sources need owner reconciliation on both tills before
convergence is claimed. See [ADR-023](../adr/ADR-023-partial-returns-and-source-ordering.md).
