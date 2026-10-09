# KOLO desktop

Electron + React + Vite, with SQLite and protected credentials owned by the main
process. The first offline workflow is available: create/unlock/recover a shop, add
products and opening stock, search/scan by keyboard barcode, enter fractional cash
sales, and reopen saved receipts after restart. French/English React DOM screens use
a replaceable `ShopService` for a later browser adapter.

Named allowlisted IPC validates the caller and requests. Opaque authority, SQLite,
event signing, native credentials and paths remain in the host. Lock/minimize/OS lock/
suspend/renderer reload invalidate sessions; shutdown waits for pending native work.
Navigation/popups/webviews are denied. The renderer uses isolated context and sandbox.

From root: `npm run dev:desktop` builds and launches Electron. `npm run check` includes
real SQLite command/restart/rollback/authorization/IPC tests. `npm run smoke:desktop`
checks native boot; `npm run smoke:desktop:workflow` exercises actual DOM setup, OS
vault, product/opening stock, barcode, fractional cash checkout, receipt and process
restart using disposable user data.

Product/category editing, purchases/credit/finance/returns/reports, staff and transfer
screens, printer adapters and Windows installers remain subsequent F5 work. Host and
Linux Electron checks do not establish Windows DPAPI/installer/device acceptance.
No browser application is implemented yet.

See [desktop implementation](../../docs/implementation/desktop.md),
[phases](../../docs/implementation/plan.md), and [testing](../../docs/implementation/testing.md).
