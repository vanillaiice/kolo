# F1 native validation

## Recorded evidence (2026-10-06)
- Core lifecycle tests use real SQLite and Node/OpenSSL PBKDF2/Ed25519. Desktop vault
  tests use actual filesystem persistence and a simulated OS encryption API; they
  do not prove DPAPI or Android keystore.
- `npm run smoke:credentials` passed with the actual Linux Electron/OS vault: native
  provisioning, reopening, correct/wrong PIN checks and encrypted files. Windows
  DPAPI and Android SecureStore acceptance remain pending.
- Android Metro export and Expo prebuild configuration resolve the added QuickCrypto,
  Nitro, SQLite and SecureStore plugins. They do not load native modules on a device.
- `npm run benchmark:credentials` on Linux: five native PBKDF2 samples
  96.48, 81.85, 81.76, 81.85, 83.03 ms; median 81.85 ms; AMD Ryzen 7 7730U, x64,
  Node 24.18.1. Windows and Android measurements are outstanding.
- `adb devices` detects `emulator-5554 offline`; `adb -s emulator-5554 get-state`
  fails with `device offline`. A non-destructive `adb reconnect offline` removed
  the stale connection and left no attached devices. No usable emulator/device was
  available for acceptance.
  That was the 2026-10-06 environment. On 2026-10-09, SDK/build-tools 36, NDK
  27.1.12297006 and JDK 21 build the actual Android release-variant test APK.
  No device/emulator is attached; SecureStore runtime acceptance remains pending.

## Android acceptance procedure

Use a disposable installation on a supported Android device. Rebuild the app with
`npm exec --workspace @kolo/mobile -- expo run:android`; the old development binary
and Expo Go do not contain the added native crypto module. Record OS/device/build,
SecureStore behavior with/without a configured screen lock and native errors without
printing secrets. Run normally with no demo flag and no remote server.

1. Enable airplane mode. Create a shop, owner and PIN; record the separate recovery
   code securely. Confirm no enrollment/network request is required.
2. Add a product, complete a cash sale and verify local receipt/stock/cash data. Force
   stop the app; reopen, confirm it boots locked, unlock and make another sale.
3. Background the app during unlock and after unlocking. Both cases must require
   another unlock, and no stale context may record a sale.
4. Test wrong PIN delays, restart during the delay and reach ten failures. Recover
   with the owner code, verify the old PIN fails and the new PIN works. Verify the
   recovery code rotates; keep only the current code for subsequent steps.
5. Create a cashier, make a sale as that user, and verify financial reports and
   unauthorized discounts/credit/price overrides fail. Suspend/reset/reactivate staff
   from owner controls; attribution must retain the same staff UUID.
6. Use a test build with injected native/SQL failpoints to interrupt provisioning
   before the manifest, after native success, and during SQL commit. Restart/retry;
   assert one shop/device/owner and one audit fact, with all original reserved IDs.
7. Inspect a disposable SQLite dump: it must contain neither PINs, verifiers,
   private keys, recovery codes nor authority proof tokens. Confirm Android backup
   excludes SecureStore data. A copied database must not provide local unlock proof.
8. Measure native derive latency using `credentialCryptoOnDevice.derive` and
   `CREDENTIAL_ITERATIONS` in a disposable development harness, five samples after
   warm-up; record device/runtime, median/p95 and UI responsiveness. Never log secrets,
   salts, verifiers or private keys. Approve the policy with the platform review.

## Windows acceptance procedure

Run `npm run smoke:credentials` under the declared Electron version on a real Windows
host. This command uses disposable user data and the actual safeStorage API, exits 2
when protected OS storage is unavailable, and never logs credentials. After app readiness,
instantiate `localCredentialsOnDesktop` with a disposable main-process vault directory
and actual Electron `safeStorage`. Verify encryption availability, ciphertext files,
restart verification, wrong-PIN failure, recovery/provisioning crash gaps and fail-closed
behavior if OS storage is unavailable. Run `npm run benchmark:credentials` on that
host and record measurements; additionally measure within Electron if its runtime
version differs. The Linux simulated-storage tests and Wine are insufficient evidence.
Desktop setup/POS screens are F5; this procedure validates the F1 adapter.

## Backup and replacement boundary

Owner access recovery needs the original protected credential record. Losing the vault
or device requires F3 authenticated encrypted backup/restore or trusted pairing with
fresh installation/device keys. The F1 UI has no implemented backup restore command;
its recovery screen must not be presented as restoring records from another device.
