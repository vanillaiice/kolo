# Offline identity, authorization and account attachment

## Implemented F1 behavior

`core/identity` owns offline setup, local unlock, owner recovery, staff credentials,
permissions and explicit legacy migration. `core/application/operations` and
`core/application/reports` enforce current authority. SQLite migrations 15 and 16
append to the unchanged migrations 1–14. Native platform adapters keep verifier bytes,
recovery codes and private keys outside SQLite.

Mobile boots locked and presents create, unlock, pending-setup completion, legacy
migration and owner access recovery screens. The POS invokes authorized product/sale
commands; a fresh owner can add a product and sell without a server. Backgrounding or
locking invalidates in-flight unlocks and clears the session. Staff controls allow
credential creation/reset, suspension, grants/revocations and protected owner recovery
code retrieval. Demo data requires `npm run dev:mobile:demo` and a developer build.

Android native acceptance and Windows credential/storage benchmarks remain unverified.
The desktop credential adapter exists; desktop setup/POS UI remains F5. Encrypted
backup restoration and owner-confirmed replacement-device enrollment are implemented in F3. Owner access
recovery on the same intact installation is implemented and is distinct from backup
restoration. See [native validation](f1-native-validation.md).

## Independent identities

| Identity | Lifecycle | Purpose |
|---|---|---|
| Business/shop UUID | Created offline; preserved across editions | Owns records and trust domain |
| Local user/actor UUID | Owner creates staff; membership carries grants | Attribution and permissions |
| Installation/device UUID + key pair | Created on install; replacement requires F3 owner proof | Immutable origin and signatures |
| Local unlock session | Local lock/unlock; independent of billing/network | Allows operations on that device |
| Cloud account/session | Optional hosted/self-host enrollment (ADR-029/030: owner-signed enrollment with a single-use connection code, device-signed challenge sessions) | Authenticates network transfer |
| Device encryption key | X25519 key in the native vault beside the signing key, announced by `DEVICE_ENCRYPTION_KEY` (ADR-030) | Receives shop keys sealed by the owner; only agreements leave the vault |
| Operator account | Server-side only: scrypt password + TOTP, `admin`/`viewer` (F6c) | Runs the server; never a shop identity and never sees shop records |
| Destination identity | One per paired peer/server | Independent delivery/progress in F2 |

A locally created owner has authority without a server. Cloud session expiry does not
stop local operations. Network account attachment is a separate future enrollment
operation and must prove ownership while retaining existing IDs.

## Setup and crash recovery

`createWorkspace` validates XAF, shop/owner/device fields and local credential strength,
then reserves all UUIDv7 identifiers in a public `workspace_setup` intent before native
provisioning. The injected native port writes a salted verifier, Ed25519 key pair and
independent recovery code, then a readiness manifest. A retry verifies existing
credentials and never silently replaces keys. SQLite completion atomically writes the
business, owner, device, opening accounts (default Caisse), local membership,
installation and `WORKSPACE_CREATED` audit, then removes intent.

`recoverWorkspaceSetup` completes already durable provisioning without a saved PIN.
`resumeWorkspaceProvisioning` retries incomplete native provisioning using the original
IDs. A crash before or after either native write remains recoverable; SQL failures
roll back business rows and audit together. Conflicting setup input is refused.

Boot states are `empty`, `pending`, `legacy`, `locked` and `unlocked`. No raw secret,
verifier, private key or authority proof token enters setup JSON or audit. Bootstrap
and membership facts enter the immutable v2 journal and are signed with the protected
device key. Imported authority requires approved authority-capable keys and revisions;
secrets remain device local. They are not sent as v1 events. See [exchange](exchange.md).

## Native credential policy

[ADR-020](../adr/ADR-020-local-credential-policy.md) records the implemented candidate
and its outstanding platform gate. PINs contain 6–8 digits; passwords contain 12–256
characters and are not entirely digits. PBKDF2-HMAC-SHA256 uses 600,000 iterations,
independent random 128-bit salts and constant-time 256-bit verifier comparison.
Native/OpenSSL derivation is asynchronous. No JavaScript digest fallback exists.

Mobile uses react-native-quick-crypto with Nitro modules and Expo SecureStore configured
with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. A rebuilt development/production app is required;
Expo Go or an old installed binary cannot load the new crypto module. Expo Android
backup excludes encrypted SecureStore records. Desktop uses Node/OpenSSL and an atomic
OS-encrypted vault through Electron async safeStorage; missing encryption and Linux
`basic_text`/`unknown` backends fail closed. Vault paths come from main-process callers,
not renderer input. OS storage protects records; the current Ed25519 private key is
exportable PEM encrypted at rest, not a claimed non-exportable hardware key.

Unlock reserves an attempt durably before native verification. Wrong credentials,
interrupted attempts and native errors count. Delays are 1/2/4/8/16/32/60 seconds;
ten failed attempts require recovery. Restart does not reset delays. Suspending a
member/shop/device prevents unlock and the next command. App-data tampering, clock
rollback and a rooted/device-owner adversary are outside the local SQL throttle's
security boundary; platform review must verify the stated storage guarantees.

## Recovery and staff

The owner's independent 256-bit recovery code resets the PIN/password and rotates the
code under a new protected credential reference. It requires the existing protected
record, so it does not restore a lost device. Recovery attempts have separate persisted
delays and a ten-attempt limit. Native success followed by SQL failure is completed by
`resumeOwnerRecovery` on next boot; no recovery proof is stored in SQLite. The original
device signing identity and business records remain intact. Recovery codes are displayed
after setup and can be viewed again by the active owner after credential proof.

`createLocalMember` provisions an independent credential under durable public intent,
then commits user, membership and audit. `resumeMemberProvisioning` completes fully
provisioned intents after owner unlock. `resetLocalMemberCredential` lets the owner
reset locked-out staff without changing their IDs, roles, grants or suspension; the
native/SQL gap follows the same recovery mechanism. Old encrypted records are retained
pending a safe cleanup/backup policy; they are no longer current SQL references.

Loss of both owner credential and recovery code cannot be bypassed with a business
UUID, cached OWNER role or cloud token. Loss of the native vault cannot be repaired by
copying SQLite. F3 authenticates encrypted backups, validates isolated snapshots, and issues fresh
installation/device keys while preserving original facts. Current-owner confirmation
is required for existing-device rollback; restoring an empty replacement uses the file
password and explicit shop confirmation. Re-pairing approves its new key without
overwriting newer local sales. See [ADR-022](../adr/ADR-022-encrypted-files-and-approved-snapshots.md).

## Authority and application commands

`unlockWorkspace` returns a frozen context registered privately against database and
ports. A structurally identical object, serialized context or stale/locked context
cannot authorize anything. Every command/report re-reads active shop/device/user,
local membership, the shop's role matrix and granular grants in the same SQLite transaction.
A role's permissions are the shop's edited set or, until the owner edits it, the built-in
defaults ([ADR-037](../adr/ADR-037-role-permission-matrix.md)); a member holding a shop-defined
role uses that role's set instead ([ADR-038](../adr/ADR-038-custom-roles.md)); member grants and revocations
are exceptions on top, and revocation wins. Cached cloud `users.permissions` is not local authority.
Owner alone manages members/grants on an authority-approved device, and cannot revoke
their own `users.manage`. Pairing defaults secondary devices to business operations;
the owner can explicitly approve management. Secondary PIN recovery stays local and
does not invent shared membership revisions.

Application writes override caller-supplied shop/actor/device/time and check related
entity ownership plus branch constraints. Conditional sale discount/price/credit-limit
overrides require separate permissions. Business effects, v1 outbox and immutable audit
commit together. Cash transfers require reciprocal legs; expense reversals compensate
the original entry. Reports derive the shop from the context and use sales, inventory,
customer, supplier or financial permissions. Valuation/dashboard require financial
permission; cashier defaults exclude financial reports. Repository functions remain
lower-level trusted primitives, not application authorization entry points.

## Explicit legacy migration

A database with existing business data and no local installation stays `legacy`.
`adoptLegacyWorkspace` authenticates the owner freshly against the existing server for
that exact shop and device. It requires OWNER, `users.manage`, XAF and unexpired proof;
cached role/session metadata alone is insufficient. It then provisions a new local
credential using durable intent, retains shop/device/proven-owner IDs and all financial,
entity, old session and pending-outbox rows, and appends `LEGACY_WORKSPACE_ADOPTED`.
Existing historical staff rows remain untouched; local memberships are provisioned
explicitly by the owner rather than trusting historical cloud roles.

Incomplete owner-proven migration retries the reserved intent; it does not request a
new proof token or allocate another shop. The explicit developer demo transport exists
only for the fixed development fixture and is gated by `__DEV__` plus the demo flag.
