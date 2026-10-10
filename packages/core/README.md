# @kolo/core

Shared business implementation: `data` (SQLite operations, migrations, replay),
`application` (authorized operations and reports), `identity` (setup, unlock,
recovery), `domain` and `rules` (pure calculations). Tests sit beside the code.

```ts
import { completeSale } from "@kolo/core/application/operations";
import { formatMoney } from "@kolo/core/domain/money";
```

Node and Electron use the compiled `dist` exports; Expo uses source through the
`react-native` condition. No framework imports belong here; the Node SQLite adapter is
the only Node-specific subpath.

See [business core](../../docs/implementation/business-core.md) and the
[API reference](../../docs/reference/typescript-api.md).
