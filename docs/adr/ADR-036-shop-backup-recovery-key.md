# ADR-036: Shop backup recovery key

**Status:** Accepted, 2026-10-17; implemented in milestone 1 (installed-device runs open). Companion to [ADR-035](ADR-035-binary-encrypted-container.md), whose
recipient key slots encrypt to the key defined here. Implemented in milestone 1.

## Context

Automatic backups cannot ask for a password, and a backup is only useful if the owner can open it after
losing every till. ADR-030 left this open: losing every device loses the shop key, and local encrypted
backups are the recovery path.

KOLO already has an owner recovery code, but it cannot serve here. It is created per till when the
owner's PIN is set up there, kept only in that till's native vault, used only to reset the owner PIN on
that till, and replaced each time it is used (`credentials.ts`). Two tills of one shop have different
codes, and a backup encrypted to anything derived from one would become unopenable when that till is
lost or the code is used.

The owner chose a separate, shop-wide key for backups and keeps the per-till PIN recovery code
unchanged. Reusing one secret for both would have meant redesigning PIN recovery (ADR-020) first.

## Decision

### The secret and its key pair

- The **backup recovery key** is 32 random bytes S from the native generator, created by the owner on
  an authority-approved till after a fresh PIN proof.
- The recovery key pair is RFC 9180 `DeriveKeyPair(S)` for DHKEM(X25519, HKDF-SHA256). HPKE's labelled
  derivation separates it from every other KOLO key; S is used for nothing else.
- `key_id` = the first 16 bytes, in hex, of SHA-256(`"kolo.backup-recovery-key.v1\0"` ‖ public key).
- S has 256 bits of entropy, so no password KDF is applied to it.

### Showing it once

- S is written as Crockford base32 (52 symbols) plus 4 checksum symbols from SHA-256(S): 56 symbols in
  14 groups of four, e.g. `K7QM-…`. The checksum catches typing errors before any decryption.
- The owner sees it once, on screen and as a printable sheet (existing print/PDF path) with the shop
  name, key ID, creation date and what it opens, and confirms by typing three randomly chosen groups.
- S is then discarded. It is never written to SQLite, the native vault, a backup, the server, logs or
  diagnostics. No till can show it again; a lost key is replaced by rotation.
- The interface names the two secrets differently: the **PIN recovery code** resets the owner PIN on
  one till; the **backup recovery key** opens the shop's backups on any device.

### Pinning the public key

- The public key travels only as an owner-signed authority fact,
  `SHOP_BACKUP_KEY { key_id, version, public_key, created_at }`, applied after the existing checks:
  the signature verifies against a device key already in the receiving till's own trusted roster,
  that device is authority-approved, the signer is the owner at the current authority revision. A
  public key that arrives with the fact, or from the server, is never itself a reason to trust it. It moves between tills
  like any other fact (file exchange, local network, sealed server sync); the server cannot read or
  forge it.
- A forward migration adds `backup_recovery_keys` (shop, key ID, version, public key, creation time,
  creating device, event ID). Snapshots carry it, so restored and newly paired tills know every key.
- A till seals a recipient slot only to the **current** key read from its own database: the highest
  `version`, ties broken by the greater `key_id` (two owner tills rotating offline both stay valid).
  It never takes a recovery key from the network, a file, or user input when making a backup.
- A compromised server can withhold a newer key fact, so a till may keep using an older owner key; it
  cannot make a till encrypt to an attacker's key.

### Rotation and loss

- Creating a new key adds a fact with `version + 1`. Earlier keys stay pinned as history; new backups
  use the new key, and every backup records the `key_id` it needs. Restore and the key list show which
  key (ID and creation date) opens which backup.
- Old backups are not re-encrypted: a till holds only public keys and no file keys. The owner keeps
  each sheet until the backups that need it are gone.
- A leaked key still opens the backups made with it. The response is rotation, a new backup, and
  deleting the old files; the interface says so.

### Using it

- **Automatic backups** need a pinned key and carry only a recipient slot. Without a key they are off,
  and the backup screen asks the owner to create one.
- **Manual backups** carry the password slot and, when a key is pinned, a recipient slot too, so the
  recovery key opens every backup made after it existed.
- **Restore on a fresh device:** choose the backup, choose "backup recovery key", type it. The checksum
  is checked, the key pair derived, the slot with the matching `key_id` opened, and the existing
  restore rules apply (ADR-022): staging validation, confirmation of the shop name, a new local PIN, and
  a new device identity. No original till, server or network is needed.
- The recovery key opens backups only. It signs nothing, resets no PIN and grants no authority by
  itself; the restored till's authority comes from the restore, exactly as with a password.

### Resuming synchronization after losing every till

Requirement: a full-shop disaster recovery restores business state and permits secure re-establishment
of synchronization without any original till. Device identities and credentials are never cloned.

- Shop data keys (ADR-030) exist only as grants sealed to each till's own device key, so a backup
  restored on a fresh device could not open them, and facts other tills synced after the backup was
  made would stay unreadable on the server.
- A backup therefore carries the shop data keys its till holds, inside the encrypted content (never in
  the restored database). Restore re-grants them to the new device's own encryption key, discards the
  plain copies, and the restored owner till opens a new key epoch for future traffic.
- The restored till has a new identity and signing key. Server sessions and device tokens are issued
  again through the usual connection flow; whether the server needs an owner-recovery path to accept a
  restored owner device is established during milestone 1 and recorded here.
- Enrollment snapshots keep using grants; only backups carry the keys.

### Migration

Existing beta shops have no key. Nothing is generated automatically, because the owner has to record
it; the backup screen prompts the owner, and manual password backups keep working without one.

## Consequences

- One shop-wide secret opens every backup made after it was created, from any device, while tills hold
  only its public half: losing or compromising a till does not expose a key that opens old backups.
- The owner must keep a sheet safe. Losing both the sheet and every till loses automatic backups that
  had no password slot; that trade-off is stated when the key is created.
- Tests: RFC 9180 `DeriveKeyPair` and base-mode vectors; checksum and typo handling; a backup made by
  one till restored on a fresh installation with only the file and the key; a forged, unsigned or
  non-owner `SHOP_BACKUP_KEY` fact refused and never used for sealing; concurrent offline rotations
  converging on one current key; restore choosing the right historical key.
- The deciding milestone 1 test: delete every till, restore from one backup and the printed key on a
  fresh device, sell, then resume synchronization and read facts other tills synced after the backup.
- Open for a later ADR: signed backup generations, rollback detection and anchoring fresh-device
  restores to the recovery secret, for cloud recovery.
