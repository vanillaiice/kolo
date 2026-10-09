# Mobile app guidance

The active architecture is the [implementation guide](../../docs/implementation/README.md)
and ADR-017–022. The reusable data/domain code and tests now live in `packages/core`.
Historical mobile notes are preserved in `docs/history/legacy-mobile-guidance.md`.

`src/data/database/open-on-device.ts` wires expo-sqlite into the shared native adapter;
`src/data/auth/store-on-device.ts` wires expo-secure-store into the shared keystore port.
These are the only native imports for those capabilities. App screens import narrow
`@kolo/core/...` paths; never import the Node SQLite adapter into Metro.

Current UI: permission-aware F4 operational navigation, product/category/stock, split/credit
POS, counterpart payments, purchases/returns, finance/counts, expenses/reports and
receipt sharing; offline create/unlock/pending setup/owner recovery/legacy migration,
owner staff controls, authorized POS/product creation, backup/restore, pairing and
encrypted file/receipt exchange with diagnostics. Native credentials use
QuickCrypto/Nitro plus protected Expo SecureStore; rebuild the native app when these
modules change. Boot/background lock is independent of cloud sessions. The explicit
`npm run dev:mobile:demo` seed alone enables developer fixture migration authority.
File/backup restoration is implemented in F3; Bluetooth remains F8. Configured
workspaces use signed v2 events; HTTP v1 is restricted to unconverted legacy data.
Native file handling uses the SDK-matched expo-file-system adapter. Replacement
activation updates the durable active slot and App database handle together.
Preserve all cached records/IDs/events in explicit owner-proven legacy migration.
See [native acceptance](../../docs/implementation/f1-native-validation.md).

Run commands from the repository root: `npm run typecheck`, `npm test`,
`npm run bundle:mobile`, `npm run dev:mobile`. Expo uses package source through the
react-native export condition; rely on Expo's monorepo resolution. SDK owns React,
React Native and native module versions. API URL configuration is build-time legacy
configuration until optional endpoint enrollment is implemented.

Bundling/typechecking cannot prove native SQLite/keystore, hardware scanners, printers,
Bluetooth or device startup. Use actual dev/production builds and record hardware/OS.
Keep business arithmetic/authorization in shared operations, not screens. Active setup/staff/transfer and operational UI use keyed French/English strings.
Language selection is available before setup and persists in a separate device preference
database, outside business snapshots/events. Pure localization and real SQLite preference
tests run with `npm run test -w @kolo/mobile`; installed rendering remains a native gate. See the F4 mobile guide.
