# F3 native validation

F3 implementation evidence on 2026-10-06:

- Real file-backed SQLite/OpenSSL invitation → possession request → owner confirmation →
  approved snapshot → fresh installation; two offline credit sales, duplicate encrypted
  exchanges/receipts, matching stock/debt/cash/reports, backup/fresh restore/new sale and
  re-pair without overwriting the newer local sale.
- Failed native provisioning preserves reserved IDs; wrong codes/passwords, altered
  authenticated fields, copied previews, unexpected schema, mixed-shop snapshots and
  rejected pointer commits produce no accepted business changes. Compaction removes
  original native key/credential references. Existing recovery retains its old file.
- Real desktop/OpenSSL AES-GCM and bounded file descriptors; cancelled dialogs, invalid
  UTF-8, oversize files and attempts to overwrite an existing file are refused.
- `npm run smoke:credentials`: actual Linux Electron and protected OS vault passed
  encrypted backup, fresh-key restore and a new sale at origin sequence 1, along with
  provisioning/reopen/correct and wrong PIN checks.
- `npm run smoke:desktop`: actual Electron boot, migrated active-slot SQLite and sandboxed
  status/preload IPC passed. Renderer setup/transfer/till UI remains F5.
- Android Metro exports 966 modules including native SQLite, QuickCrypto and FileSystem.
  This proves resolution/bundling, not installed-device native behavior.

## Deferred installed-device acceptance

The user deferred Android/Windows hardware checks. Carry these gates forward; do not
infer them from shared tests or Linux runtime success:

1. Rebuild the native Android app with SDK-matched modules. In airplane mode, create/
   restart/unlock/sell on two devices, compare pairing codes independently, exchange
   encrypted files twice, return signed receipts, and compare balances/reports.
2. Exercise picker cancellation, provider/file disappearance, oversized/invalid files,
   wrong passwords, storage refusal/full disk, background lock and renewed owner proof.
   On iOS the OS picker may make a temporary copy; app reads stay bounded afterward.
3. Back up while WAL contains committed sales. Restore an empty replacement, restart,
   unlock and sell. Confirm fresh keys/sequences and retained historic origins. Re-pair
   an already restored shop after another local sale and confirm that sale is retained.
4. Interrupt native provisioning, snapshot validation, candidate copy/checkpoint and
   active-pointer commit. Before commit, the old slot remains; after commit, restart
   selects the new slot. Run actual power-loss/file-system durability drills, including
   missing active file and retained old file. Never delete business databases as a test.
5. Measure 600,000-iteration PBKDF2 latency, 16 MiB snapshot and 8 MiB batch memory/UI
   responsiveness on low-cost Android and supported Windows hardware. Review native
   AES-GCM/Ed25519, SecureStore/DPAPI, backup exclusion, protected directory permissions,
   plaintext-buffer lifetimes and password handling. Record hardware/OS/app versions.
6. Windows installed-app dialogues, native vault and renderer recovery remain part of
   F5 packaging/acceptance. Reuse the shared formats and approved-key flow.

See [ADR-022](../adr/ADR-022-encrypted-files-and-approved-snapshots.md) for exact algorithms,
limits, activation policy and recovery authority; [F1 native validation](f1-native-validation.md)
retains the underlying credential acceptance gates.
