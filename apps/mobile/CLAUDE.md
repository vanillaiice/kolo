# Mobile app guidance

The active architecture is the [implementation guide](../../docs/implementation/README.md)
and ADR-017–022. The reusable data/domain code and tests now live in `packages/core`.
Historical mobile notes are preserved in `docs/history/legacy-mobile-guidance.md`.

`src/data/database/open-on-device.ts` wires expo-sqlite into the shared native adapter;
`src/data/auth/store-on-device.ts` wires expo-secure-store into the shared keystore port.
These are the only native imports for those capabilities. App screens import narrow
`@kolo/core/...` paths; never import the Node SQLite adapter into Metro.

Current UI: see [mobile](../../docs/implementation/mobile.md) and the [parity checklist](../../docs/implementation/mobile-parity.md).
Four destinations (Sell, Products, Activity, More) with stack navigation in `features/shell`;
screens read the session via `app/session.tsx` and keep transient work in session drafts.
Native photo/print adapters live in `src/data/photos` and `src/data/output`; system UI goes
through `session.systemUi`. Boot/background lock is independent of cloud sessions. The explicit
`npm run dev:mobile:demo` seed alone enables developer fixture migration authority.
Native file handling uses the SDK-matched expo-file-system adapter. Replacement
activation updates the durable active slot and App database handle together.
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
