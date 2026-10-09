# @kolo/core

Shared implementation extracted from mobile on 2026-10-05. `src/data` holds local
SQLite operations, migrations, replay, and the current HTTP sync engine;
`src/domain` holds cart/login-form rules and formatting. `src/identity` supplies
standalone setup/recovery and opaque local unlock contexts; `src/application/operations`
checks current authority and shop scope around SQLite commands;
`src/application/reports` protects report queries. Credential provisioning/recovery,
staff administration and legacy owner-proof migration share durable intent recovery.
Tests stay beside code.

```ts
import { completeSale } from "@kolo/core/application/operations";
import { formatMoney } from "@kolo/core/domain/money";
```

Node/Electron consume compiled `dist` exports; Expo consumes source through the
`react-native` condition. Build shared packages before standalone workspace checks.
The Node SQLite adapter is the only Node-specific subpath. No framework imports
belong here. SQLite operations are not PostgreSQL repositories; server-safe pure
calculations will be extracted under `rules/` in F2.

See [business methods](../../docs/implementation/business-core.md),
[public API](../../docs/reference/typescript-api.md), and [testing](../../docs/implementation/testing.md).
