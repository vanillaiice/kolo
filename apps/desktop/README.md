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

The planned offline software is implemented: catalogue/stock, checkout/credit/discounts,
customers, suppliers/purchases, finance/expenses, reports, returns, staff, encrypted
backup/restore, pairing/file exchange and OS-dialog receipt printing.

From root, `npm run pack:desktop` creates an unpacked production app;
`npm run dist:desktop:win` creates NSIS and portable Windows artifacts without publishing.
`npm run dist:desktop:linux` creates an x64 AppImage for Linux testing.
`npm run smoke:desktop:packaged` runs the workflow, renderer-crash and forced-termination
checks against the unpacked executable. `npm run benchmark:desktop` measures a disposable
10k-product/100k-movement fixture. Windows CI runs actual OS-vault and installed-upgrade
checks. Configuring those jobs does not establish a passing Windows result.

Forgot your codes? The locked screen offers owner recovery with your saved key, or
"Start a new shop" to set up a fresh empty shop with new codes.

See the [release procedure](../../docs/implementation/desktop-release.md) for signing,
updates, data retention and pending platform acceptance. Physical hardware and
cross-device testing are deferred; Bluetooth and paid-server sync remain later work.

See [desktop implementation](../../docs/implementation/desktop.md),
[phases](../../docs/implementation/plan.md), and [testing](../../docs/implementation/testing.md).

To return to a shop retained after starting fresh, choose **Ouvrir une boutique conservée** on the welcome/locked screen, select its name, and enter its existing password. Both databases stay saved.

The desktop welcome screen explains each starting option and shows retained shops alongside it. New-shop setup uses two steps: shop details and owner access. Login, code recovery, backup restore and joining share a wide task panel with contextual guidance to the side.
