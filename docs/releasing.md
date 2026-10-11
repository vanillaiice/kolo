# Releasing KOLO

Desktop and Android version separately, so each has its own tag prefix. Releases follow
the Rebar Studio pattern: a pushed tag builds in CI into a **draft** GitHub pre-release,
which you review and publish by hand.

## A release

1. Make sure `master` is green (Active workspaces and Desktop Windows acceptance).
2. Bump the version, commit `chore: bump desktop to vX.Y.Z` (and/or mobile), and tag:
   - Desktop: `apps/desktop/package.json`, then `git tag -a desktop-vX.Y.Z -m "KOLO desktop vX.Y.Z"`.
   - Android: `apps/mobile/package.json` and `app.json` (`expo.version`, and raise
     `android.versionCode`), then `git tag -a mobile-vX.Y.Z -m "KOLO mobile vX.Y.Z"`.
   - Run `npm install --package-lock-only` so the lockfile carries the new version.
3. Push the commit, then the tag: `git push origin master desktop-vX.Y.Z`.
4. **Desktop release** builds Linux (AppImage, deb) and Windows (NSIS installer, portable),
   runs the checks and the packaged Windows workflow, and uploads the installers, update
   files (`latest*.yml`) and `SHA256SUMS-*.txt` to the draft. Android is built locally
   instead (below); pushing a `mobile-v*` tag starts nothing.
5. Check the draft, write its notes, publish it. Releases are pre-releases while KOLO is in beta.

## Local releases

`make release-android`, `make release-linux`, `make release-windows` (through wine), or
`make release` for all three, build on this machine and upload to the draft release
(`scripts/release.mjs`). Each refuses to run unless the tree is clean and the version tag points
at HEAD and is already on origin, creates the draft when missing, never touches a published
release, and uploads only this version's files with their `SHA256SUMS-*.txt`.

Android is always released this way: a cold CI runner needs over 40 minutes for the native
modules. The manual **Android release** workflow remains for a CI-built artifact. Desktop tags
still build in CI, which also runs the packaged Windows acceptance; a local desktop upload
replaces files of the same name in that draft.

## Local builds

`npm run dist:desktop:linux`, `npm run dist:desktop:win` (on Linux through wine) and
`npm run build:mobile:android` (with `ANDROID_HOME`) write to `release/`. Local Windows
builds skip the packaged acceptance that CI runs.

## Signing and updates

Desktop builds sign when `CSC_LINK` and `CSC_KEY_PASSWORD` secrets exist and are unsigned
otherwise, so Windows SmartScreen warns. The Windows signing options are those described in
Rebar Studio's releasing guide (SignPath Foundation, Azure Trusted Signing, an OV certificate).
The APK uses generated test signing; a Play Store identity is not configured.

KOLO has no in-app updater: users install the next version over the old one (see
[desktop release](implementation/desktop-release.md)). The draft carries `latest*.yml` so an
updater can be added later; electron-updater would need the desktop tags without the
`desktop-` prefix or a custom provider, and public releases.
