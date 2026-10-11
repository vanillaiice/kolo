# ADR-032: Adding a till with a short code

Date: 2026-10-11. Status: accepted by the user and implemented for the owner's side on desktop and phone and the new
till's side on the phone; a computer joining by code is not built yet. Extends ADR-022 (pairing) and ADR-030.

## Context

File pairing (ADR-022) needs four hand-offs between two devices: an invite file, a 32-character fingerprint to compare and
type, a request file, a 32-character code to compare and type, a password, and an encrypted shop file. The user judged
it too long for shops. A shop with a sync server already has a channel both tills can reach.

## Decision

When the owner's till is connected to a server, adding a till uses a code:

1. The owner taps "Add a till → Show a code" (optionally allowing management). The till creates the usual signed invite,
   draws a 10-character Crockford base32 code (50 bits, shown `XXXX-XXXX-XX`) and opens a mailbox on the server under
   `SHA-256("kolo.join-id.v1\0" + code)`. The QR code carries `kolo://join?u=<server>&f=<fingerprint>&c=<code>`.
2. The new phone scans the QR (or types the code and the server address), reads the invite and checks its tag:
   `HMAC-SHA256(HKDF(code), …)` over the invite digest. It shows the shop and owner, the person names the phone and
   chooses its own code, and the phone posts its signed pairing request and X25519 key, tagged the same way.
3. The owner's till checks that tag and that the request answers its invite, and asks "Allow <name>?".
4. On Allow it pins the key exactly as file pairing does, builds the same encrypted shop file with a random password,
   seals that password to the new phone's X25519 key and posts both. The new phone opens and installs the shop, then
   connects to the server it joined through.

Why this is safe without comparisons: replacing the invite or the request requires the code, which never reaches the
server; guessing it online is bounded by 10-minute expiry, single use, rate limits and the owner's Allow step. The shop
file's password is not derived from the code, so a server that later brute-forces a code still cannot open the file.
The server stores only a hash of the code and signed or encrypted blobs, and checks that the invite is signed by an
active authority till of that shop. Refusing, cancelling or expiry deletes the mailbox. File pairing stays for shops
without a server ("No internet? Use files").

## Consequences

- Server migration `0005_join` and `/api/v2/join` routes; `application/join` in core; `hmac` added to the sealing port;
  `expo-camera` on mobile for scanning (also used for server connection codes); the QR code on desktop via `qrcode`.
- Snapshots no longer carry the source till's own server connections or opt-outs (`server_endpoints`,
  `server_endpoint_declined`), so a new till starts clean and connects through the owner's shared address.
- A second authority till of an attached shop now joins the server like any till instead of being refused.
