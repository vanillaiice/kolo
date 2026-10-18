# ADR-027: Opt-in large transfer files and optional product photos

**Status:** Accepted, 2026-10-10. The standard/large profiles and the large-files switch are superseded by
[ADR-035](ADR-035-binary-encrypted-container.md): one 1 GiB snapshot limit and 256 MiB of photos per shop.
**Amends:** the fixed limits in [ADR-026](ADR-026-compressed-transfer-files.md). Its format,
compression, bounded inflation and "nothing is pruned" rules remain.

## Context

ADR-026 sized transfer files for low-cost phones and PCs: 128 MiB raw snapshot, 32 MiB
encrypted payload, 48 MiB file. Files are read whole, so peak memory is several times the
snapshot. Owners with powerful computers asked to lift those limits. Product photos were
requested at the same time; already-compressed images barely deflate, so they spend the
compressed-payload budget almost byte for byte.

## Decision

- Limits are a `TransferLimits` profile from `@kolo/contracts/transfer`. **Standard**
  (unchanged, the default everywhere): 128 MiB snapshot, 32 MiB payload, 48 MiB file.
  **Large** (opt-in): 1 GiB snapshot, 360 MiB payload, 496 MiB file.
- The large profile is not "no limit". A file is parsed as one JavaScript string and
  engines cap strings near 512 MiB, so the file stays below that and the payload below its
  base64 share. Anything larger needs streamed or chunked files (still open).
- File schemas accept up to the large profile; every reader checks the active profile,
  including the header's declared payload and content lengths, before key derivation or
  allocation. Exchange bundles stay under the standard profile.
- The profile is a per-computer setting (desktop: owner-only, `preferences.json` beside the
  database, never in a backup). A `SnapshotPort` exposes `limits()`; backup, restore and
  pairing snapshots read it. Mobile stays on the standard profile.
- Product photos are optional thumbnails in `product_photos` (migration 22): one per
  product, WebP or JPEG, at most 64 KiB and 512 px a side, keyed by SHA-256 digest. Shop
  total: 16 MiB standard, 256 MiB with large files. They live outside the product row and
  its `PRODUCT_SAVED` event and are device-local until photo transfer is designed; only a
  local audit entry is written. Backups include them unless the owner unticks
  "include photos".

## Consequences

A backup made under the large profile that exceeds the standard limits opens only on a
computer with large files on, and reports `too_large` elsewhere. Peak memory on the large
profile is unmeasured; the setting warns that several GB may be needed. Paired devices do
not see each other's photos yet; they show the product initial instead. Photo transfer and
optional server (S3) storage will key on the digest.
