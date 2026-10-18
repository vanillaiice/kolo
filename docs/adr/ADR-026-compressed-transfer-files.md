# ADR-026: Compressed transfer files and larger snapshots

**Status:** Accepted, 2026-10-09. Superseded for the file format by
[ADR-035](ADR-035-binary-encrypted-container.md): version 2 JSON files are no longer read or written.
**Supersedes:** the size limits and "no compression" rule in
[ADR-022](ADR-022-encrypted-files-and-approved-snapshots.md). Its encryption, KDF,
authentication, validation and approval rules remain.

## Context

A demo shop doing about 24 sales a day, built through the real desktop operations, grows
its SQLite database by about 0.3 MiB per day. Backups refused raw snapshots above 16 MiB,
so a busy shop lost the ability to back up after roughly 50 days. The same snapshot
deflates about 5.6× (a 90-day, 25.5 MiB image becomes 4.5 MiB). Encrypted bytes do not
compress, so compression must happen before encryption.

## Decision

- Encrypted files are written as `kolo.encrypted` **format version 2**: content is
  deflated (level 6, fflate, pure JavaScript on desktop and mobile) and then encrypted
  with the unchanged AES-256-GCM/PBKDF2 scheme. The header records
  `compression: "deflate"`, `plaintext_bytes` (encrypted compressed bytes) and
  `content_bytes` (exact decompressed length). Both lengths are part of the
  authenticated header.
- Version 1 (uncompressed) files remain readable. Unknown versions fail with
  `unsupported_version`.
- Decompression is bounded: content inflates into a buffer one byte larger than the
  authenticated `content_bytes`, and anything but an exact match is `invalid_file`. A
  stream cannot expand beyond the declared, capped size.
- Limits, shared from `@kolo/contracts/transfer`: raw SQLite snapshot 128 MiB (about
  14 months of the busy demo shop), decompressed content 129 MiB, encrypted compressed
  payload 32 MiB, encoded file 48 MiB. Batch (8 MiB), metadata (1 MiB) and pairing-proof
  (64 KiB) limits are unchanged.
- Nothing is pruned: history is never silently dropped to fit a file.

## Consequences

Backups, enrollment snapshots, exchange bundles and receipts all use version 2.
Installations from before this change reject version 2 files with
`unsupported_version`, so devices exchanging files must run a release with this change.
Peak memory during backup or restore grows with shop size (image, compressed copy and
base64 text). The 128 MiB ceiling must be measured on low-cost Android and Windows
hardware before release (F3/F5 native gates). A shop that outgrows it still needs a
designed answer (streamed or chunked backups) rather than pruning. The legacy v1
`sync_outbox` is still included; it compresses well, and excluding it is a separate
compatibility decision.
