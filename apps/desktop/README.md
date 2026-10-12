# KOLO desktop

Electron + React + Vite. The main process owns SQLite, event signing and OS-protected
credentials; the sandboxed renderer reaches them only through allowlisted, validated
IPC commands. Screens are French/English and talk to a replaceable `ShopService`.

## Commands (from the root)

Requires Node 24.16+ (24.x), npm 11 and `npm ci`.

| Command | Purpose |
|---|---|
| `npm run dev:desktop` | Build and launch |
| `npm run smoke:desktop:workflow` | Drive setup, sale, receipt and restart on disposable data |
| `npm run pack:desktop` | Unpacked production app |
| `npm run dist:desktop:win` | NSIS and portable Windows builds, unpublished |
| `npm run dist:desktop:store` | Windows Store APPX build, unpublished |
| `npm run dist:desktop:linux` | x64 AppImage and Debian package, unpublished |
| `npm run smoke:desktop:packaged` | Workflow and crash checks on the packaged app |
| `npm run benchmark:desktop` | 10k-product / 100k-movement fixture |

Windows CI runs OS-vault and installed-upgrade checks.

See [desktop implementation](../../docs/implementation/desktop.md) and the
[release procedure](../../docs/implementation/desktop-release.md).

Licensed under [GPL-3.0-only](LICENSE).

## Pair nearby devices without a server

Connect the devices to the same Wi-Fi or hotspot. In **Backup & devices → Pair a new till**, choose **Show a code**.
Scan it with the updated mobile app (**Join a shop**), or copy its link into **Join a nearby shop** on a new desktop.
The owner approves the named device. No internet or separately installed synchronization server is needed.

Keep KOLO open and unlocked on the main desktop; local changes exchange automatically while an authorized
member with shop-settings access is signed in on the client. Windows may ask to allow KOLO on the private
network. Local access closes on lock/shutdown, resumes on the saved port while enabled, and can be stopped
from Backup & devices. If the router changes the desktop IP, edit the main till address in the mobile local
sync controls. Bluetooth and mobile hosting remain separate work. See
[ADR-034](../../docs/adr/ADR-034-local-network-pairing-and-sync.md).
