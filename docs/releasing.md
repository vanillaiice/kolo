# Releasing KOLO

Each KOLO release uses one shared `vX.Y.Z` tag and one GitHub pre-release for Windows,
Linux and Android. The release version comes from the root `package.json`; desktop and
Android retain their own app versions, which appear in filenames and release notes.

## A release

1. Run `npm run check` and the manual **Desktop Windows acceptance** workflow.
2. Bump the root `package.json` release version. Bump changed apps as needed:
   desktop in `apps/desktop/package.json`; Android in `apps/mobile/package.json` and
   `app.json` (`expo.version`, and raise `android.versionCode`). Run
   `npm install --package-lock-only` and commit the changes.
3. Tag that commit: `git tag -a vX.Y.Z -m "KOLO vX.Y.Z"`, then
   `git push origin master vX.Y.Z`.
4. **Desktop release (shared KOLO release)** builds Linux (AppImage, deb) and Windows
   (NSIS installer, portable), runs the checks and packaged Windows smoke, and uploads
   installers, update metadata and checksums to the shared draft.
5. Run `make release-android` from the same tagged clean checkout. Android builds locally
   because a cold CI runner needs over 40 minutes to compile native modules. Alternatively,
   run the manual **Android release** workflow on the shared tag.
6. The last uploader automatically publishes the pre-release once every Windows, Linux
   and Android installer, update file and checksum file is present. Until then it stays
   draft and the publish step lists missing files. Published releases are never overwritten.

Manual workflow runs on a branch produce Actions artifacts only. Old `desktop-v*` and
`mobile-v*` tags remain historical; new releases use only the shared `v*` prefix.

## Local releases

`make release-android`, `make release-linux`, `make release-windows` (through wine), or
`make release` for all three build locally and upload to the same release
(`scripts/release.mjs`). Each requires a clean tree with the shared root-version tag at
HEAD and on origin. Uploads contain only the selected app version's files and checksums.
The draft is created when missing; after each upload the release is published if complete.

Desktop tags still build in CI and run the packaged Windows smoke; local Windows builds
skip that acceptance. Do not run local and CI uploads for the same platform concurrently.
To retry publication after a completed upload, run `node scripts/release-github.mjs publish`
from the tagged checkout. The publication gate is covered by
`node --test scripts/release-info.test.mjs`.

## Local builds

`npm run dist:desktop:linux`, `npm run dist:desktop:win` (on Linux through wine) and
`npm run build:mobile:android` (with `ANDROID_HOME`) write to `release/`. Local Windows
builds skip the packaged acceptance that CI runs.

## Android files per phone type

Android builds write one APK per CPU architecture plus a universal fallback
(`apps/mobile/plugins/with-abi-splits.js`); x86 builds are left out.

| File | For | Size (0.1.2) |
| --- | --- | --- |
| `KOLO-x.y.z-android-arm64-v8a.apk` | Most phones and tablets (64-bit) | 44 MB |
| `KOLO-x.y.z-android-armeabi-v7a.apk` | Older and Android Go phones that run a 32-bit system | 35 MB |
| `KOLO-x.y.z-android-universal.apk` | Not sure which: works on both | 87 MB |

Settings → About on the phone names its type and the file to download. A wrong file is refused at
install; it never half-works. Version codes are `versionCode × 10` plus 0 (universal), 1
(armeabi-v7a) or 2 (arm64-v8a), so any of them updates any earlier release. The universal APK still
carries about 12 MB of x86 React Native libraries, which React Native's Gradle plugin marks pickFirst
and so escape the exclusion. A future Play Store release would upload an app bundle and let the store
pick per device.

## Signing and updates

Desktop builds sign when `CSC_LINK` and `CSC_KEY_PASSWORD` secrets exist and are unsigned
otherwise, so Windows SmartScreen warns. The Windows signing options are those described in
Rebar Studio's releasing guide (SignPath Foundation, Azure Trusted Signing, an OV certificate).
The APK uses generated test signing; a Play Store identity is not configured.

KOLO has no in-app updater: users install the next version over the old one (see
[desktop release](implementation/desktop-release.md)). The release carries `latest*.yml` so an
updater can be added later. Shared tags use the standard `v` prefix; an updater would
still need to select the desktop assets from the combined pre-release.
