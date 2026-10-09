# Working on KOLO

Read [SPECIFICATION.md](SPECIFICATION.md), the relevant [implementation guide](docs/implementation/README.md),
and [phase plan](docs/implementation/plan.md) before changing behavior. User decisions
on 2026-10-05 supersede the old Go/server-required setup architecture through ADR-017–019.

## Current state

The active repository is an npm workspace: TypeScript core/contracts, Expo mobile,
Electron desktop, NestJS server. Existing business/data logic and tests moved into
`packages/core/src` without redesigning behavior. `archive/legacy-go` preserves the
previous server and pre-existing work. Historical root guidance is preserved in
`docs/history/legacy-project-guidance.md`.

Mobile has offline setup/unlock/recovery/staff and F4 operational screens/partial returns; demo is opt-in.
F1 native acceptance remains pending; see the progress log and native validation guide. Desktop has a migrated
local setup/unlock/recovery, product/opening-stock and cash till/receipt screens behind
a validated command bridge. Broader management/transfer UI and Windows acceptance remain. Nest has health/readiness/capabilities,
not synchronization. F2 provides shared exact rules, strict signed payloads, replay and destination receipts;
F3 adds owner-confirmed pairing, encrypted backups/files and mobile transfer screens.
Android/Windows transfer acceptance remains open; broader desktop workflows remain F5. Active mobile
forms have keyed French/English text and durable device language selection.
User priority on 2026-10-06 is desktop/web first; F5 is the next active phase.
See [desktop implementation](docs/implementation/desktop.md); browser support is not
implemented and its runtime remains to be chosen. Further mobile work waits behind
the desktop workflow. Read [progress](docs/implementation/progress.md) before claiming
a capability exists.

## Boundaries

- Platform SDK wiring stays in apps. Shared code never imports Expo, React, Electron,
  or Nest. Only the explicit Node SQLite adapter may import Node in the core.
- `core/domain` holds existing pure screen/domain functions. Cart currently imports
  arithmetic from `core/rules`; compatibility exports remain in the data layer.
  Server code must not import the SQLite data layer.
- Use `@kolo/core/...` and `@kolo/contracts` between workspaces. No relative app/package
  imports or aggregate core barrel that pulls native adapters into a renderer.
- A business write and its event commit in one SQLite transaction. UI reads SQLite;
  no network call is required to complete a core operation.
- Stock, debt, and account balances derive from immutable transactions. Corrections
  compensate. Money is integer XAF; quantity is thousandths; rounding is half away
  from zero. Permission/tenant checks belong inside operations, not just screens.
- Preserve origin identity when forwarding. Delivery is per destination. The v1 queue remains for compatibility;
  HTTP v1 sync is restricted to unconverted legacy workspaces.
- SQLite migrations 1–20 are immutable. Migration 18 adds F3 pairing progress; 19 adds category ordering/indexes, 20 immutable returns. Add forward migrations; do not rewrite shipped
  schemas. Keep the Node/Expo synchronous transaction interface synchronous.
- Go is an archived reference. Port rules/behavior, not repository plumbing.

## Verification and documentation

Run `npm run check` and `npm run bundle:mobile` after structural/app changes.
Test business rules, rollback, replay, tenant isolation, authorization, malformed
inputs, and schema upgrades. Use real SQLite/PostgreSQL for repository tests; mocks
are for transport failures. Node tests do not prove native storage, keystore,
Bluetooth, printers, or packaged Electron; use the platform gates in the guide.

Document exports/public methods with JSDoc; regenerate `npm run docs:api`. Update the
progress log and relevant contract when behavior changes. Label planned methods and
endpoints. Keep dependencies modest; upgrade one platform/framework at a time.

Do not commit, deploy, publish, delete business databases, or reset existing volumes
unless requested. Routine reversible implementation and verification are authorized.
