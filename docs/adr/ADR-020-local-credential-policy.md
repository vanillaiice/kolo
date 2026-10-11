# ADR-020: Local credential policy

Status: Implemented candidate; Android/Windows benchmark and security acceptance pending.
Date: 2026-10-06.

## Context

Standalone shops need a local PIN/password verifier, device signing identity and owner
recovery independently of cloud sessions. SQLite and native secret storage cannot
share a transaction. Mobile uses Expo/React Native; desktop uses Electron/Node.

## Decision under validation

Use asynchronous native PBKDF2-HMAC-SHA256 with 600,000 iterations, random 128-bit salts,
256-bit output and constant-time comparison. Require 6–8 digit PINs or 12–256 character
passwords. Keep the verifier, Ed25519 PEM private key and independent 256-bit recovery
code entirely in protected platform storage. SQLite contains public identity and
opaque references only. Use durable SQL intent and idempotent native writes, with the
native readiness manifest written last, to recover provisioning crash gaps.

The implementation uses QuickCrypto/Nitro and Expo SecureStore on mobile, and Node
OpenSSL/Electron async safeStorage on desktop. Refuse unavailable native storage and
Linux basic_text/unknown backends; never downgrade to plaintext. Node ≥24.16 is needed
for standard-library UUIDv7. Recovery changes the credential reference and rotates
recovery proof while preserving the installation's device key. Owner staff resets
preserve staff identity and permissions. Encrypted backup/installation replacement is
F3 and must create a fresh device identity.

PBKDF2 is a supported cross-platform candidate, not a claim that a short PIN resists
unlimited offline guessing. SecureStore/OS vault isolation, persisted retry controls
and recovery proof are part of the policy. Private keys are encrypted exportable PEM;
non-exportable hardware-backed signing has not been established by this adapter.

## Evidence and acceptance gate

The Linux host's five native derivations measured median 81.85 ms (Node 24.18.1,
AMD Ryzen 7 7730U, x64). This does not measure Android, Windows or actual OS storage.
Native Android airplane-mode setup/restart/unlock/sale, PIN throttling, vault behavior,
background lock, crash recovery and target hardware timing remain required. Windows
must verify DPAPI encryption and timing under the actual Electron runtime. Review PIN
policy, no-screen-lock behavior, app backup exclusion, loss/recovery and device threat
model before treating this candidate as accepted. Record evidence in
[native validation](../implementation/f1-native-validation.md); do not lower KDF work
silently to make a test pass.

## Primary references

- [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [QuickCrypto implementation coverage](https://github.com/margelo/react-native-quick-crypto/blob/main/.docs/implementation-coverage.md)
- [Expo SecureStore documentation](https://docs.expo.dev/versions/latest/sdk/securestore/)
- [Electron safeStorage documentation](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)
- [Node crypto UUIDv7](https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html)
