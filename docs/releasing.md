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

## Android release (local)

A cold CI runner needs over 40 minutes for the native modules, so the APK is built here:

```sh
git push origin master mobile-vX.Y.Z
ANDROID_HOME=~/Android/Sdk npm run build:mobile:android
cd release/mobile && sha256sum KOLO-X.Y.Z-android-test.apk > SHA256SUMS-android.txt && cd -
gh release create mobile-vX.Y.Z --draft --prerelease --verify-tag --title "KOLO Android X.Y.Z" \
  --notes "Android test build with generated test signing: install by allowing unknown sources. Not a Play Store build."
gh release upload mobile-vX.Y.Z release/mobile/KOLO-X.Y.Z-android-test.apk release/mobile/SHA256SUMS-android.txt
```

Build from a clean checkout of the tag. The manual **Android release** workflow remains for a
CI-built artifact.

The tag must match the app version; the workflow stops otherwise. Running either workflow
by hand builds artifacts without a release.

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
