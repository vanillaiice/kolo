# ADR-034: Direct local-network pairing and synchronization

Accepted 2026-10-12. Extends ADR-021, ADR-022 and ADR-032. The user requested QR pairing and synchronization
on the standalone desktop without connecting to a hosted or self-hosted server.

## Decision

The desktop hosts an app-local HTTP listener on a private IPv4 Wi-Fi/LAN address. It needs no separate service,
PostgreSQL, internet account or subscription. The user explicitly enables it by showing a local join code.
Its chosen port is retained on this installation; locking, switching shops and quitting close it and forget
open join codes. It resumes on the saved port while the enabled shop is unlocked. The user can stop local
access without removing peer trust or business data. Windows private-network firewall approval may be needed.

A ten-minute `kolo://local` QR carries the host address, signing-key fingerprint and the existing single-use
join secret. A phone scans it; a new desktop can paste it. A signed invitation and request use the existing
code-derived message authentication, recipient-bound snapshot, owner confirmation, X25519-sealed random
snapshot password and native credential provisioning. The owner sees the new device's name and chooses
whether it may manage staff. No shop data is handed to it before approval. Cancelled/expired codes stop working.
The direct host address is written to the verified staging database before atomic activation.

Once paired, the client makes foreground exchanges every minute and soon after a local change. The desktop
must be open and unlocked, and both devices must be on the same Wi-Fi/hotspot. This works without internet.
The client can also synchronize immediately and correct the host address after an IP change. Mobile hosting,
Bluetooth, network discovery, background mobile execution and public/internet-facing direct endpoints are
outside this change. A paired phone/secondary desktop connects to its desktop host; it is not a cloud relay.

Direct sync carries the existing signed journal batches and durable signed receipts. A request/response is
encrypted to the receiving installation's native X25519 key with an ephemeral agreement, HKDF-SHA256 and
AES-256-GCM; a separate domain-specific Ed25519 signature covers the complete header and ciphertext. The
authenticated header binds shop, sender, receiver, packet ID, reply ID and encryption keys. The response must
name the exact request. Current device trust, actor authority, origin signatures, dependencies, duplicate
identity and receipt digests are rechecked by the existing exchange engine. Replayed/lost responses do not
duplicate effects. Deferred and undelivered facts remain durable. Native signing explicitly permits only the
new bounded `kolo.local-sync.v1` domain in addition to the existing domains.

The listener accepts only private/loopback peers, refuses browser Origin requests, limits concurrent work,
request bytes and time, and serves only the join mailbox and encrypted exchange endpoint. URLs are literal
private IPv4 addresses; public addresses, DNS names, paths, credentials, queries and redirects are rejected.
There is no clear business-payload HTTP endpoint. Local trade never waits for networking.

SQLite migration 29 adds device-local listener and peer-address/status tables. Both are sanitized out of
backups and enrollment snapshots and must be empty in incoming signed snapshots. None of these addresses,
ports or delivery-status settings is a synchronized business fact. Existing server and encrypted-file
transports remain available and keep their independent delivery acknowledgements.

## Validation

Real SQLite, OpenSSL and HTTP integration tests cover two desktop installations, owner-approved pairing,
two independent offline sales, exact stock/debt convergence, a lost response after commit, retries, lock/unlock
and stable listener port, wrong codes/fingerprints, cancellation, browser origins, packet/key/header tampering,
response binding and native-vault signing. The Electron workflow checks QR rendering with zero connected
servers. Windows firewall/install and physical Android camera/Wi-Fi acceptance remain separate device gates.
