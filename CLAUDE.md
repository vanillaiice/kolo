# Working on KOLO

Read [SPECIFICATION.md](SPECIFICATION.md), the relevant [implementation guide](docs/implementation/README.md),
and [phase plan](docs/implementation/plan.md) before changing behavior. User decisions
on 2026-10-05 supersede the old Go/server-required setup architecture through ADR-017–019.

## Current state

The active repository is an npm workspace: TypeScript core/contracts, Expo mobile,
Electron desktop, Fastify server (ADR-025). Existing business/data logic and tests moved into
`packages/core/src` without redesigning behavior. The previous Go server is no longer tracked;
it remains in git history (and may exist locally, gitignored, under `archive/legacy-go`). Historical root guidance is preserved in
`docs/history/legacy-project-guidance.md`.

Mobile has a parity reorganization (Sell/Products/Activity/More, all desktop business workflows, reports, analytics, photos, print/PDF); installed Android acceptance remains open; see docs/implementation/mobile-parity.md. Demo is opt-in.
F1 native acceptance remains pending; see the progress log and native validation guide. Desktop has a migrated
local setup/unlock/recovery, product/category editing, stock movements/counts, split/credit
till, customers, suppliers/purchases, accounts/expenses, reports, returns, staff, backup/pairing/exchange and receipt screens behind a validated command bridge. Broader management/transfer UI and Windows acceptance remain. The Fastify server (AGPL-3.0) relays signed facts
between a shop's tills (F6a, ADR-029): enrollment, signed-challenge sessions, push/pull/receipts over PostgreSQL;
desktop and mobile connect by pasted connection code (or the owner's shared address) and sync automatically. F6b (ADR-030) made sync end-to-end encrypted: tills seal facts with owner-granted shop keys (migration 26), the server stores only trust/key/address facts in the clear and never applies business rules. F6c is the operator dashboard (`apps/admin`, AGPL) on its own loopback listener: codes, shops, suspension, health, audit. F7 (ADR-031): `KOLO_EDITION=hosted` shops sync while paid (manual payments, grace, transfer-only pause); self-hosting kit in docs/implementation/selfhost.md. ADR-032: with a server, a till is added by a 10-character code/QR and the owner's Allow (file pairing kept offline); desktop menu order is a per-computer setting. Server migrations now `0001`–`0005`. F2 provides shared exact rules, strict signed payloads, replay and destination receipts;
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
  or Fastify. Only the explicit Node SQLite adapter may import Node in the core.
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
- SQLite migrations 1–27 are immutable. Migration 18 adds F3 pairing progress; 19 adds category ordering/indexes, 20 immutable returns, 21 trigger-maintained accent-folded `search_name` keys (SQL pinned by a digest test), 22 photos, 23 extra categories, 24 full-text search, 25 the `SERVER` device platform, roster revisions and server endpoints, 26 encryption keys, shop-key grants and the shared server address, 27 the reported hosted service status. Server PostgreSQL migrations (`0001`–`0005`) live in `apps/server/src/database.ts` and are forward-only too. Add forward migrations; do not rewrite shipped
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
