# KOLO implementation guide

Subsystem guides, validation records and implementation plans. See
[progress](progress.md) for current status and the
[specification](../../SPECIFICATION.md) for business rules.

| Read | Purpose |
|---|---|
| [Architecture](architecture.md) | Editions, stack, modules, data flow, boundaries |
| [Plan](plan.md) | Dependencies, work packages, methods, acceptance gates |
| [Desktop release](desktop-release.md) | Installers, signing, upgrade/recovery checks and platform evidence |
| [Desktop implementation](desktop.md) | Desktop structure, workflows and platform behavior |
| [Mobile operations](mobile.md) | Mobile structure, session/lock, workflows and refresh contract |
| [Mobile parity](mobile-parity.md) | Desktop-to-mobile action checklist, platform differences, device gates |
| [F4 native validation](f4-native-validation.md) | Full offline shop-day, scanner/receipt and measured device gates |
| [Business core](business-core.md) | Operations, invariants and service surface |
| [Exchange](exchange.md) | Journal, import/export, trust, replay, backup, Bluetooth |
| [Identity](identity.md) | Standalone setup, local users, pairing, cloud attachment |
| [Server API](server-api.md) | Sync, enrollment, sessions, join and billing endpoints |
| [F1 native validation](f1-native-validation.md) | Recorded credential/setup evidence and required platform acceptance |
| [F3 native validation](f3-native-validation.md) | Encrypted transfer/restore evidence and remaining device drills |
| [Testing](testing.md) | Tests, datasets, failure cases, device/release gates |
| [Development](development.md) | Commands, deployment, migrations, upgrade methods |
| [Progress](progress.md) | Implementation and verification status |
| [Public API](../reference/typescript-api.md) | Generated declarations and JSDoc from code |

Update the relevant guide and progress entry with implementation changes. Public
API documentation is generated from source JSDoc.
