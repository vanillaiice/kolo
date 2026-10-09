# ADR-022: Encrypted files and owner-approved snapshots

Date: 2026-10-06. Status: implemented F3 core/mobile; Android/Windows native acceptance pending.
Extends [ADR-019](ADR-019-event-exchange-and-destination-delivery.md) and
[ADR-021](ADR-021-signed-journal-and-late-event-policy.md).

## Encryption and bounds

Portable files use native AES-256-GCM, a 128-bit authentication tag, a fresh 96-bit
nonce and 256-bit salt. PBKDF2-SHA256 derives a 256-bit key with 600,000 iterations.
The native implementations are Node/OpenSSL on desktop and react-native-quick-crypto
on mobile; shared framing contains no cryptographic substitute. Passwords contain
12–256 characters, with at least 12 after trimming, and cannot be entirely digits.
They are separate from local unlock PINs. Losing the file password makes its contents
unrecoverable; there is no server-required recovery or escrow.

The canonical header authenticates format/version, purpose, file ID, cipher, KDF,
iteration count, salt, nonce and plaintext length as GCM additional data. Readers
bound input and KDF parameters before deriving; no plaintext is returned before tag
verification. Wrong purpose, altered header/ciphertext/tag or password is refused.
Passwords, keys and private exception details never enter SQLite or diagnostics.
Plaintext byte buffers are cleared after use where owned by the operation. Immutable
JavaScript password/derived-key strings and native buffers cannot offer guaranteed
zeroization; this remains part of the native security review.

Limits: encoded file 24 MiB; signed event batch 8 MiB/1000 complete events; raw SQLite
snapshot 16 MiB; snapshot metadata 1 MiB; pairing proof 64 KiB. No compression or archive
expansion is accepted. Exports fit complete events into bounded independent batches;
receipts acknowledge each batch separately. Oversized snapshots fail explicitly; there
is no pruning feature to silently reduce history. Large-shop capacity and memory
budgets require hardware measurement before release.

Encrypted `.kolo-exchange.json` and `.kolo-receipt.json` wrap the F2 signed formats.
Backups use `.kolo-backup.json`, enrollment `.kolo-enrollment.json`. Snapshot plaintext
is a four-byte big-endian metadata length, signed canonical manifest, then raw SQLite;
it avoids encoding the image twice. Identity-only invitations and possession requests
use `.kolo-invite.json`/`.kolo-request.json`; these contain public identity, never records,
PINs, private keys or usable credentials.

## Consistent snapshots and activation

`VACUUM INTO` captures a consistent image including committed WAL transactions. The
source remains available. A private copy removes installation, credential/session,
provisioning and pending-pairing references, substitutes unusable remote membership
references, then compacts again to purge deleted bytes. It preserves business/entity
IDs, immutable journals/proofs, permanent application identities, origin counters,
legacy archive/boundary and independent delivery/import history.

A manifest signs image hash/length, schema version, shop/owner identity, source device
key, timestamp, audit/application boundary and origin coverage. Signatures use
`kolo.snapshot.v1\0`. Before imported mutations, a private candidate must match the
exact shipped schema (including indexes/triggers) at the declared supported version.
SQLite integrity, foreign keys, one-shop scope, active owner, credential exclusion,
source key and derived boundary are checked, then forward migrations run. Unexpected
executable schema and mixed-shop databases are refused.

Restoration requires the authenticated backup password, explicit confirmation of
its shop, a new local credential and an empty target. Existing-device rollback needs
an unlocked current owner of the same shop through explicit recovery mode. If that
vault cannot unlock, restore onto an empty replacement installation. Historical
facts retain their original origins; the new native installation/device/key starts
at local origin sequence 1. Other peers must approve that new key through pairing.
Backup password possession establishes local recovery authority, not automatic trust
by another till.

The candidate gets a fresh filename. A separate FULL-synchronous SQLite control
transaction compares and switches the active filename/generation. Desktop syncs the
final file and directory before switching; mobile creates a FULL-synchronous SQLite
copy before switching. The previous business file is retained, never overwritten or
deleted. Before the pointer commit, any failure leaves the old active slot. Afterward,
boot selects the new slot. Old operation contexts are locked and the old handle is
retired; native provisioning cannot reopen it for writes. Unused previews can only
discard their owned stage. Mobile cleans owned staging names at startup; it never
cleans business filenames. Missing selected replacement files fail boot explicitly.
Power-loss/file-system durability still needs platform crash drills.

## Pairing and recovery

1. The active owner on an authority-approved device signs an invitation expiring in
   24 hours. The recipient compares the source key's 128-bit fingerprint independently.
2. Acceptance reserves fresh installation/device/request IDs durably before native
   provisioning. Retry uses those exact IDs; no secret is stored in the intent. The
   new protected key signs a possession request containing the exact invitation.
3. Both installations compare a 128-bit request-bound verification code. The current
   owner confirms that code, pins the key and consumes the invite for that one request.
   Repeating the same confirmation is recoverable; a different request is refused.
4. The owner produces an encrypted, recipient/request-bound signed snapshot. Completion
   verifies source identity, request digest, target key and complete snapshot before
   initialization/activation. A business UUID alone grants no trust.

Signatures are domain-separated with `kolo.pairing-invite.v1\0` and
`kolo.pairing-request.v1\0`. Secondary devices default to business operations without
membership authority; the owner can explicitly approve management in the invitation.
Local authority commands require the device's distinct approval as well as membership
permissions. Recovery of a secondary device's own PIN stays local, with no fabricated
shared authority revision/event. Staff credentials remain device-local; management
approval allows existing owner provisioning controls after enrollment.

A restored, already active shop can re-pair through the same proof/code flow. Completion
updates pins/destination and its approved device capability; it preserves concurrent
local history rather than installing the source baseline over it. Existing PIN proof
uses the current credential reference, including after recovery rotation. The copied
candidate is verified and discarded. Pending target invitations can be cancelled;
confirmed source trust requires explicit revocation, not cancellation of an old invite.

## Exchange outcomes and evidence

Read-only previews verify the forwarding sender and each preserved origin. The actual
import rechecks current authority, strict payloads, scope and dependencies, then uses
F2 durable receive/application transactions. Quarantine/dependency/unsupported/conflict
diagnostics retain exact event IDs and French/English recovery descriptions. Receipts
can be regenerated after restart or cancelled file saves. An export is offered;
only an authenticated expected receiver's exact batch receipt advances delivery.

Mobile provides native selected files, backup/recovery confirmation, pairing and import/
receipt/diagnostics screens. Background locking remains enabled; a native file dialog
may require entering the owner PIN again. Desktop has the active-slot/crypto/bounded
file-dialog adapters; renderer setup/till/transfer commands remain F5. The actual Linux
Electron/OS-vault smoke covers encrypted backup, fresh restore and a new sale. Real
SQLite/OpenSSL pairing tests cover two offline credit sales, duplicate exchanges,
stock/debt/cash/report convergence, receipts, fresh restore/re-pair and failure cases.
These checks do not establish Android/Windows installed-device or power-loss acceptance.

References: [SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html),
[Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html),
[OWASP PBKDF2 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
[Expo FileSystem](https://docs.expo.dev/versions/latest/sdk/filesystem/).
