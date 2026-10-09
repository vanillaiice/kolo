# Desktop shipping and acceptance

The user selected packaging, Windows credentials, recovery, performance/accessibility
and documentation work on 2026-10-09, with mobile next. Physical scanner/printer and
Android↔Windows exchange acceptance are deferred. Two installed offline clients remain
the product; Bluetooth and optional paid-server event sync are separate shared phases.

## Artifacts and updates

Following the local Rebar Studio shipping reference, electron-builder builds a Windows
x64 NSIS installer and portable executable. `npm run dist:desktop:win` builds without
publishing; `npm run pack:desktop` produces an unpacked host-platform app.
`npm run dist:desktop:linux` creates an x64 AppImage for Linux testing in
`release/desktop`. Make it executable and launch it; on systems without FUSE, use
`--appimage-extract-and-run`. Linux target-device acceptance remains separate. The staging
script copies only compiled desktop/shared packages and their production dependency
closure, avoiding workspace symlinks, mobile/server code and development dependencies.
The packaged application uses ASAR and disables Node-mode, Node-options and CLI-inspect
fuses. App identity is `com.hblabs.kolo`; version comes from the desktop package.

The existing `@kolo/desktop` directory under OS app-data stays the persistent shop
location, explicitly pinned across development/packaged product-name changes. NSIS
does not delete app-data on uninstall. Portable means portable application binaries;
it still stores the shop under that Windows user's app-data and OS-protected credentials
remain tied to that user. Move shops using encrypted backup/restore or trusted pairing.

Updates initially use a downloaded full installer: export an encrypted backup, close
KOLO, install the next version, unlock and verify the existing shop. No background
download or automatic update restart is implemented. Database migrations are forward;
do not promise binary downgrade after a schema upgrade. Retain the pre-upgrade backup
and previous installer for a separately verified recovery procedure.

The draft-release workflow accepts manual dispatch (artifact build only) and
`desktop-vVERSION` tags (draft GitHub release with SHA-256 sums). It never publishes
the draft. Tag version must match `apps/desktop/package.json`. Review Windows results,
release notes and signing before publishing. No remote/tag/release has been created
by this implementation work.

Signing uses `CSC_LINK` and `CSC_KEY_PASSWORD` when configured; otherwise builds are
unsigned test artifacts. A production signing provider/certificate is not configured
here. The release workflow produces artifacts, not proof of installer reputation or
target-PC acceptance. No hosted endpoint or subscription is needed for installation.

## Automated acceptance

`Desktop Windows acceptance` runs the repository checks, the real Electron credential
smoke, NSIS/portable builds, and the packaged workflow. It builds a `0.0.0` baseline
from the same source, installs it into a disposable directory, creates a shop, installs
the current-version installer over it, and verifies locked boot/unlock and preserved
business facts. This verifies an installer version transition, not historical schema
compatibility; frozen fixtures must accompany future released schema changes.

The workflow covers setup, OS-vault provisioning, wrong-secret refusal, native owner
recovery/code replacement with preserved receipts, saved operations,
encrypted backup/restore and reopen. Added phases verify keyboard skip-to-content,
minimize locking with stay-signed-in off, renderer termination followed by a locked
reload, stay-signed-in surviving minimize and restart until Lock, and force-killing
the main process after a successful checkout reply. Reopen must show exactly one new
sale and the expected stock. Existing real-SQLite tests cover transaction rollback,
interrupted setup, owner recovery and shutdown waiting for native work.

Installer smoke uses disposable user-data as well as a disposable installation path.
Uninstall is exercised; retention of a real shop in the default app-data directory
still needs a clean Windows-account drill. A forced process kill does not establish
physical power-loss guarantees. Native open/save dialogs and OS lock/suspend require
interactive Windows checks in addition to the automated tests.

## Performance and accessibility evidence

`npm run benchmark:desktop` seeds a disposable database with 10,000 products and
100,000 stock movements, then measures renderer→preload→SQLite search, exact barcode,
stock-value report and signed checkout. It reports median/p95 timings, startup to
renderer load, CPU/RAM and main/renderer memory. Startup excludes process launch and
imports; it is not a measured cold OS launch. The stock fixture does not establish
performance of large sales/debt histories or background imports.

The interface has localized skip-to-content, native labelled controls, visible focus,
modal recovery-key focus, current-page navigation, live errors/loading and darker
secondary text. Sidebar scrolling supports short windows; reduced motion is honored.
The runtime smoke verifies keyboard scanner focus and keyboard skip navigation, and
axe-core WCAG 2 A/AA and 2.1 AA checks on French setup, English till, reports and
backup/devices in both the light and dark system appearance; colors are semantic
tokens that follow the OS theme. These checks pass on the packaged Linux app; they do not replace
interactive assistive-technology testing.
Screen-reader, high-contrast, 200% text zoom and target-PC performance budgets remain
interactive platform checks. Record actual measurements before setting release budgets.

## Remaining evidence before declaring Windows acceptance

- Passing Windows CI and installed upgrade results, with the actual artifact/version.
- Clean offline Windows account: default data location, restart, recovery, native dialogs,
  OS screen-lock/suspend and uninstall/reinstall retention.
- Signing identity and signature verification on the release artifacts.
- Screen-reader/high-contrast/zoom checks and measured low-cost-PC performance budgets.
- Historical released-schema upgrade fixtures once a baseline has shipped.

Physical hardware and desktop/mobile exchange are explicitly deferred. This document
distinguishes implemented tooling from target-platform results; Linux evidence does
not close Windows acceptance.

Tool references: [electron-builder NSIS](https://www.electron.build/docs/nsis/),
[Electron protected storage](https://www.electronjs.org/docs/latest/api/safe-storage).
