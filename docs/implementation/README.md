# KOLO implementation guide

Accepted direction: 2026-10-05. This guide turns the four product editions into an
implementation contract. The specification owns business behavior; ADR-017–019 own
the architecture changes. The plan describes work, not a claim that work is done.

| Read | Purpose |
|---|---|
| [Architecture](architecture.md) | Editions, stack, modules, data flow, boundaries |
| [Plan](plan.md) | Dependencies, work packages, methods, acceptance gates |
| [Desktop release](desktop-release.md) | Installers, signing, upgrade/recovery checks and platform evidence |
| [Desktop implementation](desktop.md) | Desktop-first priority, current foundation and first usable F5 milestone |
| [Mobile operations](mobile.md) | F4 screens, bounded local reads, returns and refresh contract |
| [F4 native validation](f4-native-validation.md) | Full offline shop-day, scanner/receipt and measured device gates |
| [Business core](business-core.md) | Existing operations, invariants, planned service surface |
| [Exchange](exchange.md) | Journal, import/export, trust, replay, backup, Bluetooth |
| [Identity](identity.md) | Standalone setup, local users, pairing, cloud attachment |
| [Server API](server-api.md) | Current endpoints and planned v2 requests/responses |
| [F1 native validation](f1-native-validation.md) | Recorded credential/setup evidence and required platform acceptance |
| [F3 native validation](f3-native-validation.md) | Encrypted transfer/restore evidence and remaining device drills |
| [Testing](testing.md) | Tests, datasets, failure cases, device/release gates |
| [Development](development.md) | Commands, deployment, migrations, upgrade methods |
| [Progress](progress.md) | Implementation and verification status |
| [Public API](../reference/typescript-api.md) | Generated declarations and JSDoc from code |

Every work package updates its relevant guide and progress entry. Public functions
have source JSDoc; private methods are documented inline when transaction, numerical,
security, or retry behavior is non-obvious. Planned API/function names appear in the
guide until implemented, then join the generated reference.
