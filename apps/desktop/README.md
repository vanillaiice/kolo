# KOLO desktop

Electron + React + Vite. The main process owns SQLite, event signing and OS-protected
credentials; the sandboxed renderer reaches them only through allowlisted, validated
IPC commands. Screens are French/English and talk to a replaceable `ShopService`.

## Commands (from the root)

| Command | Purpose |
|---|---|
| `npm run dev:desktop` | Build and launch |
| `npm run smoke:desktop:workflow` | Drive setup, sale, receipt and restart on disposable data |
| `npm run pack:desktop` | Unpacked production app |
| `npm run dist:desktop:win` | NSIS and portable Windows builds, unpublished |
| `npm run dist:desktop:linux` | x64 AppImage for testing |
| `npm run smoke:desktop:packaged` | Workflow and crash checks on the packaged app |
| `npm run benchmark:desktop` | 10k-product / 100k-movement fixture |

Windows CI runs OS-vault and installed-upgrade checks.

See [desktop implementation](../../docs/implementation/desktop.md) and the
[release procedure](../../docs/implementation/desktop-release.md).
