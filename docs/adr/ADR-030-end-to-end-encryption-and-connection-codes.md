# ADR-030: End-to-end encrypted sync and single-use connection codes

Date: 2026-10-11. Status: accepted and implemented (F6b, F6c) the same day; installed Android/Windows acceptance against
a real server remains. "Implementation notes" below records where the build refined the decision. Amends
[ADR-029](ADR-029-sync-server-relay.md): replaces its deployment-wide enrollment code and its
"the server holds signed business facts in plaintext" consequence, and drops server-side business
application and centralized reports from F6.
Amended by [ADR-040](ADR-040-revoked-device-history.md) (revoked origins are still relayed) and
[ADR-043](ADR-043-vouched-positions.md) (only a vouched fact holds its origin position).

## Context

F6a stores every shop's signed facts in plaintext PostgreSQL. Whoever operates the server, a
compromised server process or a leaked database dump exposes every sale, price, customer and debt
of every shop. The server already applies no business rules (ADR-029); every till computes stock,
balances and reports locally.

Enrollment uses one `KOLO_ENROLLMENT_CODE` for the whole deployment, so anyone holding it can attach
any number of shops, and the operator cannot issue, track or withdraw access per shop. Connecting a
till takes five steps (address, check, read fingerprint, retype it, code).

Nothing is deployed, so changing the stored format now costs no data migration.

Options considered for data protection: (A) plaintext with TLS and disk encryption; (B) encryption
at rest with server-held per-shop keys, which defeats a stolen dump but not the operator or a
compromised process; (C) end-to-end encryption with keys held only by the shop's tills. For
enrollment: (A) single-use connection codes; (B) owner accounts with phone/email login, which would
put credentials and an SMS/email dependency on the server; (C) a list of shared codes.

## Decision: end-to-end encryption (option C)

**The server can authenticate and route facts but cannot read business records.**

- **Device encryption keys.** Each device gets an X25519 key pair next to its Ed25519 signing key,
  in the same native keystore. Its public half joins the owner-signed `DEVICE_TRUSTED` fact (a new
  fact version; older versions remain readable).
- **Shop data key.** The owner's authority device creates a random 256-bit key per *epoch*, starting
  at 1. It grants the key to each trusted device with an owner-signed `SHOP_KEY_GRANTED
  { epoch, device_id, sealed_key }`, sealed to that device's X25519 key with RFC 9180 HPKE
  (DHKEM-X25519-HKDF-SHA256, AES-256-GCM, additional data binding shop, epoch and device). Use a
  maintained HPKE implementation or native primitives; a spike must prove it on Hermes and Electron
  before the format is fixed. No hand-written cryptography.
- **Sealed events.** Over HTTP a fact travels as a sealed event: a cleartext header (shop, event ID,
  origin device and sequence, key epoch, format version, ciphertext digest) and AES-256-GCM
  ciphertext of the unchanged F2 signed event, with the header as additional data. The origin
  signs the header. The server checks that outer signature against the roster; a till decrypts,
  then verifies and stores the inner signed event exactly as today. Event type and payload are
  hidden. File exchange keeps its password-encrypted files (ADR-022) and is not changed.
- **Cleartext facts.** Only what the server must read stays clear: `DEVICE_TRUSTED`,
  `DEVICE_REVOKED`, `SHOP_KEY_GRANTED` and the server-endpoint fact below. They contain public
  keys, device labels and sealed keys, never business records.
- **Rotation.** Revoking a device makes the owner's till open a new epoch and grant it to the
  remaining devices. Devices seal with the highest epoch they hold and keep older epochs to read
  history. A newly trusted device is granted every epoch. A revoked device keeps what it already
  received but cannot read anything newer.
- **Operator view.** The operator sees shop display names, device IDs, labels and platforms,
  counts, sizes and timing. This metadata leak is accepted and stated in the hosted terms.
- **Recovery.** Losing every device loses the key; local encrypted backups remain the recovery
  path. A server-stored, password-sealed key backup is possible later but must be designed together
  with owner-identity recovery (F1), so it is not part of this decision.

## Decision: single-use connection codes (option A)

- **Codes.** The operator issues a code per shop from the admin dashboard or a server CLI command
  (`node dist/main.js invite`). The server keeps only a SHA-256 hash of a 128-bit token, with label,
  expiry (default seven days), use and cancellation. Hosted billing (F7) may issue codes after payment.
- **Format.** One versioned string carrying the server address, its fingerprint and the token,
  shown as a QR code and copyable text. The till accepts the string or a pasted link containing it.
- **Connecting.** The owner pastes or scans the code and confirms the shop and server address once.
  The till pins the fingerprint from the code and refuses a server presenting another one; nobody
  retypes a fingerprint. Using the code and attaching the shop commit in one transaction. Refusals:
  `invalid_connection_code`, `connection_code_expired`, `connection_code_used`, rate-limited.
- **Other tills.** The owner's till records an owner-signed `SERVER_ENDPOINT_SET { url,
  fingerprint }` (and `SERVER_ENDPOINT_CLEARED`). Other trusted tills that receive it by pairing or
  file exchange connect automatically, show that they did, and offer a per-till off switch.
- `KOLO_ENROLLMENT_CODE` is removed; it was never released.

## Consequences

- F6b becomes connection codes plus sealed sync. Server-side business application, centralized
  reports and server Go-fixture parity are dropped. Reports remain local; a future web view must
  decrypt in the browser with a granted device key.
- Support cannot inspect a shop's records; diagnostics come from the till.
- The admin dashboard (F6c) manages shops, codes, devices and health, never business data.
- Exchange format and the server journal gain a sealed-event version. Development databases holding
  F6a plaintext rows are recreated; the forward migration refuses to run while such rows exist
  unless the operator explicitly asks it to discard them.
- Native keystores must hold a second private key; mobile and Windows acceptance covers it.

## Implementation notes (2026-10-11)

What was built, and where it refines the decision above:

- **Device keys are self-announced.** Rather than a new `DEVICE_TRUSTED` version, each device signs its own
  `DEVICE_ENCRYPTION_KEY { device_id, public_key }` (required permissions empty, any active member signed in). It is
  accepted only when `device_id` is the signing origin, and a key never changes for a device ID. Trust still comes from
  the owner's roster: an announcement from an untrusted origin is never verified. The X25519 private key lives in the
  native vault beside, not inside, the signing record (`<reference>.x25519`); the vault only returns X25519 agreements.
- **Keys have IDs.** `SHOP_KEY_GRANTED { key_id, epoch, device_id, sealed }`: the highest epoch seals, ties break on
  key ID, so two owner devices creating a key offline both stay valid. Sealing a key uses an ephemeral X25519 agreement,
  HKDF-SHA256 (salt = SHA-256 of both public keys, info `kolo.shop-key.v1`) and AES-256-GCM bound to shop, key, epoch
  and recipient. This is the HPKE base-mode construction from platform primitives (Node/OpenSSL on desktop and server
  tests, react-native-quick-crypto on Android); no HPKE package was added and no primitive is hand-written.
- **Sealed facts carry the inner digest.** The visible header is event ID, origin, origin sequence, the digest of the
  inner signed fact, key ID and epoch; it is the AES-GCM additional data. The digest lets the server recognise the same
  fact sealed twice (new nonce, other key, forwarded by another till) as a duplicate, and keeps receipts identical to
  file exchange. Event type is hidden. Server batches are a new `kolo.sync-batch` v1 container signed by their sender.
- **The server authenticates the sender, not each sealed origin.** It cannot check an origin signature it cannot read,
  so it accepts a sealed fact from the authenticated, batch-signing till for any origin in the shop's roster. Tills open
  each fact and verify its origin proof exactly as for a file. A fact that fails to open or verify is `locked`: not
  stored, not acknowledged, and it does not block the rest of the page. Consequence: a compromised trusted till can
  occupy another device's event identity on the server (it cannot forge a fact); the owner revokes it, the real fact is
  kept in `journal_conflicts`, and file exchange still delivers it.
- **Clear facts:** `CLEAR_EVENT_TYPES` = `DEVICE_TRUSTED`, `DEVICE_REVOKED`, `DEVICE_ENCRYPTION_KEY`, `SHOP_KEY_GRANTED`,
  `SERVER_ENDPOINT_SET`, `SERVER_ENDPOINT_CLEARED`. The server refuses any other clear fact (`plaintext_refused`) and
  PostgreSQL enforces it with a check constraint. Server migration `0002` refuses to run while F6a plaintext business
  facts exist unless `migrate --discard-plaintext` is given.
- **No key yet:** a till holds back its business facts (counted as `locked` in the pass summary) and still sends its clear
  facts, so its encryption key reaches the owner. Each pass runs a second round when keys changed in the first.
- **Connection codes** are `kolo://connect?u=<url>&f=<fingerprint>&t=<token>`, a 128-bit token stored as SHA-256.
  Re-enrolling an attached shop from its enrolling device needs no token. The owner's till shows a share code (no token)
  for tills that were never paired; paired tills connect from `SERVER_ENDPOINT_SET` on their own. Stopping on a till is
  remembered (`server_endpoint_declined`); the owner stopping also clears the shared address.
- **Client migration 26** adds `device_encryption_keys`, `shop_key_grants`, `shop_server_endpoint`,
  `server_endpoint_declined` and `server_endpoints.source`. Server migrations `0002_sealed_sync_and_codes` and
  `0003_admin` add sealed journal rows, connection codes, shop status, operator accounts, sessions and the audit log.
