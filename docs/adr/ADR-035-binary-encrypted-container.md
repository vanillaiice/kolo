# ADR-035: Encrypted container with key slots

**Status:** Accepted 2026-10-17 after two external reviews; milestone 1 is implemented (see its status
below). The first revision (a single password-derived key, PBKDF2) was never released and is gone. Installed-device
acceptance and the Argon2id parameter freeze remain open.
**Supersedes:** the JSON/base64 envelope of [ADR-022](ADR-022-encrypted-files-and-approved-snapshots.md)
and [ADR-026](ADR-026-compressed-transfer-files.md), and the standard/large size profiles of
[ADR-027](ADR-027-large-files-and-product-photos.md). Their snapshot framing, validation, approval and
"nothing is pruned" rules remain. KOLO is in beta: files written before this decision are not read.
**Depends on:** [ADR-036](ADR-036-shop-backup-recovery-key.md) for the recovery public key that
recipient slots encrypt to.

## Context

Backups, enrollment snapshots, exchange bundles and receipts were one JSON document,
`{header, ciphertext, tag}`: base64 of a single AES-256-GCM message over the deflated content. On the
10 000-product fixture (77.4 MiB SQLite image) the file was 16.9 MiB, a third of it base64. Readers
parsed the whole file as one JavaScript string (capped near 512 MiB), nothing could be authenticated
before the last byte, and every copy of the shop sat in memory several times over.

Automatic and cloud backups are planned. They need files that can be produced and read as a stream,
by a till that is selling at the same time, and that the owner can open after losing every till,
without the till that made them ever holding the secret that opens all of them.

Options considered for the container: a SQLCipher database (no compression, about six times larger,
a different SQLite build per runtime), age (JavaScript ChaCha20/scrypt, against ADR-022's native
cryptography rule), a ZIP archive (no authenticated encryption), and a binary chunked container over
native primitives (chosen). For keys: a key derived directly from a password (the first revision) or
envelope encryption with key slots (chosen), so one file can be opened by a password, by the shop's
recovery key, or by both.

## Decision

### Layout

All integers are unsigned big-endian.

```
offset 0        magic            8 bytes   89 4B 4F 4C 4F 0D 0A 1A   ("\x89KOLO\r\n\x1a")
offset 8        header length    4 bytes   H, 1 ≤ H ≤ 4096
offset 12       content header   H bytes   canonical JSON, printable ASCII
offset 12+H     slots length     4 bytes   S, 1 ≤ S ≤ 16384
offset 16+H     key slots        S bytes   canonical JSON, printable ASCII
offset 16+H+S   records          n × (chunk ciphertext ‖ 16-byte GCM tag)
```

The **prefix** is bytes `[0, 12+H)`: magic, header length and content header. It never changes after
the file is written and is the additional data of every chunk. The key-slot section may be rewritten
(slots added or removed) without touching the records; only the bytes before the records move.

**Canonical JSON** is RFC 8785 restricted as in `@kolo/contracts/canonical`: object keys sorted by
UTF-16 code units, no insignificant whitespace, numbers are safe integers written in decimal, strings
use JSON escapes. Both sections must also be printable ASCII (0x20–0x7E) — every field value below is
ASCII — and a reader refuses a section whose bytes differ from the canonical encoding of its parsed
value, so each file has exactly one valid encoding.

### Content header

| Field | Value |
|---|---|
| `format`, `format_version` | `"kolo.encrypted"`, `3` |
| `purpose` | `"backup"`, `"enrollment"`, `"exchange"` or `"receipt"` |
| `file_id` | lowercase UUID |
| `cipher` | `"AES-256-GCM"` |
| `compression` | `"deflate"` (raw DEFLATE, RFC 1951) |
| `nonce_prefix` | 7 random bytes, lowercase hex |
| `chunk_bytes` | power of two from 4 096 to 4 194 304; writers use 1 048 576 |
| `content_bytes` | exact decompressed length, from 1 to the content limit |
| `recipients` | sorted `key_id`s of the recipient slots sealed when the file was written (may be empty) |

### Records

Each file has a fresh random 256-bit file key (DEK) from the native random generator.

1. `payload = deflate(content)`; with C = `chunk_bytes`, it splits into n = ⌈P / C⌉ chunks. Chunk i
   holds payload bytes [i·C, min((i+1)·C, P)); every chunk is non-empty and only the last may be shorter.
2. Chunk i is sealed with AES-256-GCM under the DEK, nonce `nonce_prefix ‖ uint32(i) ‖ final` (`final`
   is `0x01` for the last chunk, `0x00` otherwise), 16-byte tag, additional data = the prefix.
3. Records start at 16+H+S. With B = file length − (16+H+S): n = ⌈B / (C+16)⌉, every record but the
   last is exactly C+16 bytes, the last is 17 to C+16 bytes, and nothing follows it. Any other shape
   is `invalid_file`; any extra, missing, reordered or substituted record fails authentication.

This is the STREAM construction (Hoang, Reyhanitabar, Rogaway, Vizár 2015) with Tink's streaming-AEAD
nonce layout.

### Key slots

The section is `{"slots":[…]}` with 1 to 8 slots, at most one `password` slot and no two `recipient`
slots with the same `key_id`. Each slot wraps the same DEK. Let `h` = SHA-256 of the prefix and
`params` = the canonical JSON of the slot without its `nonce`, `enc` and `wrapped` fields.

**Password slot** (manual backups and file exchange):

| Field | Value |
|---|---|
| `type` | `"password"` |
| `kdf` | `"argon2id"` |
| `memory_kib` | power of two from 65 536 to 262 144 (64–256 MiB, Node's 1 KiB blocks) |
| `passes`, `parallelism` | 3 to 10; 1 to 4 |
| `salt` | 16 random bytes, hex |
| `nonce` | 12 random bytes, hex |
| `wrapped` | 48 bytes, hex: AES-256-GCM(KEK, nonce, DEK) ‖ tag |

KEK = Argon2id(password, salt, memory, passes, parallelism, 32 bytes). The parameters live in each
slot so later files can be strengthened without invalidating earlier ones; readers accept only the
bounded ranges above, so a file cannot demand unbounded work, and writers use the frozen values below. The password is normalized to
Unicode NFC and encoded as UTF-8 before validation (12–256 characters, at least 12 after trimming, not
only digits) and before derivation, so the same password typed on a phone and a computer opens the
same file. Additional data: `"kolo.slot.password.v1\0" ‖ h ‖ params`.

**Recipient slot** (automatic and manual backups, to the shop's backup recovery key, ADR-036):

| Field | Value |
|---|---|
| `type` | `"recipient"` |
| `suite` | `"HPKE-base-X25519-SHA256-AES256GCM"` (RFC 9180: KEM 0x0020, KDF 0x0001, AEAD 0x0002) |
| `key_id` | the recovery key's ID (ADR-036), 32 hex |
| `enc` | HPKE encapsulated key (32 bytes), hex |
| `wrapped` | 48 bytes, hex: HPKE ciphertext of the DEK |

Single-shot HPKE base mode: `SealBase(pkR, info = "kolo.backup-slot.v1\0" ‖ h, aad = params, pt = DEK)`.
The writer needs only the pinned public key, so a till can make backups it cannot itself reopen with
that slot.

A reader unwraps one slot it has a secret for (a mismatched slot is `authentication_failed`), requires
a 32-byte DEK, then authenticates the records. A tampered slot cannot yield the real DEK, so it fails
either the unwrap or the first record. Slots are independently authenticated, but deleting one is not
prevented: it is an availability attack. The immutable `recipients` list makes it detectable, so a
recovery key listed there whose slot is missing is reported as a damaged file, not a wrong key.

**Authorship is not confidentiality.** Anyone holding the shop's recovery public key can write a file
that its recipient slot opens, so a successful unwrap proves nothing about who made the backup.
Restore therefore keeps the existing checks mandatory: the signed snapshot manifest, its digest and
signature, and snapshot validation (ADR-022). Restoring into a device that already holds the shop
(recovery mode) also requires the manifest's signing device to be in that device's own trusted roster.
A fresh device has no trusted record; it shows the shop, owner, source till, date and recovery key ID
for confirmation. Anchoring fresh-device restores to the recovery secret is left to the cloud-backup
ADR with signed backup generations.

### Which files carry which slots

| File | Slots |
|---|---|
| Manual backup | a password slot, plus a recipient slot for the shop's current recovery key when one is pinned |
| Automatic backup | a recipient slot for the current recovery key only (no password to ask for) |
| Enrollment snapshot | a password slot (the random password is sealed to the new till, ADR-032/034) |
| Exchange bundle, receipt | a password slot |

Adding or replacing a recipient on an existing backup needs its DEK, so only someone who can open the
file (the owner, with a password or the recovery key) can do it; a till holding only public keys can
make new backups but never manage access to old ones.

### Reading order

Before any key derivation or allocation sized by the file: file length within the caller's limit
(`too_large`); magic, both lengths and both sections well formed, canonical and strict
(`invalid_file`, or `unsupported_version` for a `kolo.encrypted` header of another version); purpose
(`invalid_file`); `content_bytes` within the limit (`too_large`); record shape (`invalid_file`).
Argon2id and HPKE parameters are literals, so a file cannot request more work. Then one slot is
unwrapped, every record is authenticated in order, and the payload inflates into a buffer of exactly
`content_bytes` (one byte more is `invalid_file`). Nothing is returned, and no restore proceeds, until
the final record authenticates.

### Size limits

One limit on every device (`TRANSFER_LIMITS`): a 1 GiB SQLite snapshot, content of that image plus its
framed manifest, and a file bound 1 MiB above the content (deflate's stored-block overhead under 0.01%,
chunk tags, both sections). Exchange bundles and receipts hold one 8 MiB journal batch. An enrollment
crossing a join mailbox is at most 48 MiB of base64 (`MAX_JOIN_ENROLLMENT_CHARS`); a larger shop pairs
by file. Product photos have one 256 MiB budget per shop. The desktop large-files switch is removed.

### Names and transports

Files are `<id>.kolo-backup`, `.kolo-enrollment`, `.kolo-exchange`, `.kolo-receipt`; invitations and
requests stay `.kolo-invite.json`/`.kolo-request.json`. Readers recognize files by content, never by
name. Core APIs take and return file bytes. Join mailboxes carry an enrollment container as strict
padded base64; the mailbox MAC covers the carried text and the server never decrypts it.

### Streaming

The writer needs `content_bytes` up front (the snapshot or JSON object exists) but not the payload
length, and every record is independently positioned and authenticated, so both directions stream.
The codec consumes and emits `Uint8Array` chunks through a small async interface with backpressure
and imports no platform file API; platform adapters read the `VACUUM INTO` snapshot and write files in
chunks. `VACUUM INTO` stays: it gives a consistent snapshot and, with `secure_delete`, physically
purges the credential rows sanitization removes, which the Online Backup API does not. A streaming
reader writes plaintext only into private staging and acts on it only after the final record
authenticates.

### Primitives and parameters

- All primitives are native: Node/OpenSSL on desktop, server and CLI (Node 24, Electron 44 ships
  24.21); react-native-quick-crypto 1.1.7 on mobile. Both provide X25519, HMAC-SHA256, AES-256-GCM
  and Argon2id.
- HPKE is RFC 9180 single-shot base mode built from those primitives (LabeledExtract/LabeledExpand
  over native HMAC). It is validated against the RFC 9180 test vectors for DHKEM(X25519,
  HKDF-SHA256) with HKDF-SHA256 and against the CFRG vectors for AEAD 0x0002. ADR-030's shop-key
  sealing is a similar but non-standard construction and is not changed here.
- Argon2id writer values: 64 MiB (`memory_kib` 65 536) / 3 passes / parallelism 1 / 32-byte key,
  provisional. They measured 141 ms on the development PC (PBKDF2 at 600 000 iterations: 75 ms) and are
  frozen here after a measurement on an installed, relatively inexpensive Android device.

## Milestone 1: reliable local backups

In scope: this container (password and recipient slots), streaming codec and file adapters, desktop
backup work in a worker thread, ADR-036's key creation, pinning and fresh-device restore, failure
injection. Out of scope: cloud uploads, journal segments, retention policies, scheduling beyond
"back up now".

Milestone 1 is complete when restore, not just backup, is proven:

1. The container supports password and recipient slots, with the independent-implementation, golden
   file, RFC 9180 and Unicode-password tests (composed/decomposed accents, non-Latin scripts, emoji).
2. Files written by Electron open on React Native and the reverse.
3. A desktop backup does not block sales: snapshot, compression and encryption run off the main thread.
4. Mobile memory stays bounded by chunk size, and a large backup causes no unacceptable UI stall
   (measured on an installed build).
5. An interrupted backup (crash, power loss, full disk) never replaces the last valid backup: writes go
   to a private temporary file, are synced, then renamed. Free space is checked first.
6. Restore validates the decrypted database in staging before the active slot switches (unchanged).
7. The recovery key restores a backup on a fresh device with no original till and no server.
8. A substituted or unsigned recovery public key cannot redirect backup encryption (ADR-036).
9. Temporary plaintext snapshots stay in private storage, are deleted after success or failure, and
   are excluded from OS backups. Android auto-backup is currently on (Expo's default): set
   `android.allowBackup` to `false`, verify the generated manifest, add data-extraction rules so
   device-to-device transfer (Android 12+) also skips databases and staging, and keep staging under
   the no-backup files directory. On iOS, mark staging and business databases excluded from backup.
   Deletion is not secure erasure on flash.
10. Losing every till: a shop restored from one encrypted backup and the printed recovery key, on a
   fresh device with no original till, resumes selling and establishes fresh synchronization
   (ADR-036). This is the deciding test of the milestone.

Status on 2026-10-17 (Node, Electron main-process and Metro-bundle evidence; see the progress log):

- Proven by tests: 1 (independent implementation, golden file, RFC 9180/9106 vectors, Unicode passwords); 3 for the
  snapshot copy (worker-thread `VACUUM INTO`) with compression and encryption streamed in 1 MiB chunks that yield to
  the event loop, and a sale recorded while a backup runs; 5 except the free-space pre-check (writes go to a private
  temporary file, synced, then copied into a newly created destination, never over an existing file; a full disk
  fails the write and removes the temporary file); 6; 7 and 10 (server lose-every-till drill); 8; 9 on Android by
  generated manifest (`allowBackup="false"` plus data-extraction rules).
- Open: 2 and 4 need installed Electron and Android builds; the free-space pre-check in 5; Argon2id parameters are
  provisional until measured on a low-end Android device; iOS exclusion in 9 waits for an iOS build (none exists).

## Consequences

- One container, one code path and no legacy reader serve all four purposes. Beta users' `.json`
  backups stop opening; they need a new backup from this release.
- A file can be opened by a password, by the recovery key, or both, and slots can change without
  re-encrypting the content.
- Peak memory becomes a few MiB per operation at any shop size once streaming lands; until then a
  backup or restore holds a few copies of the snapshot.
- Freshness is not covered: a valid but older file is still a valid file. Manual restore may want an
  old backup; automatic and cloud recovery will add signed generation manifests and rollback detection
  in their own ADR, as will journal segments and content-addressed media.
