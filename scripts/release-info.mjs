import { readFileSync } from "node:fs";

const json = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
export const releaseVersion = json("package.json").version;
export const releaseTag = `v${releaseVersion}`;
export const desktopVersion = json("apps/desktop/package.json").version;
export const androidVersion = json("apps/mobile/app.json").expo.version;
export const releaseNotes = `Windows and Linux desktop ${desktopVersion}; Android ${androidVersion}.

Windows: download the setup installer, or the portable executable.
Linux: download the AppImage or Debian package (x64).
Android: arm64-v8a for most phones, armeabi-v7a for older 32-bit phones, or universal when unsure.

Desktop builds are unsigned unless signing is configured; Windows SmartScreen may warn. Android uses generated test signing and is not a Play Store build.
SHA256SUMS files accompany each platform. Install the next version over the old one; no in-app updater is implemented.`;

export function requiredAssets(desktop = desktopVersion, android = androidVersion) {
  return [
    `KOLO-${desktop}-win-x64-setup.exe`,
    `KOLO-${desktop}-win-x64-portable.exe`,
    `KOLO-${desktop}-win-x64-setup.exe.blockmap`,
    `KOLO-${desktop}-linux-x86_64.AppImage`,
    `KOLO-${desktop}-linux-amd64.deb`,
    ...["arm64-v8a", "armeabi-v7a", "universal"].map(abi => `KOLO-${android}-android-${abi}.apk`),
    "latest.yml", "latest-linux.yml",
    ...["windows", "linux", "android"].map(platform => `SHA256SUMS-${platform}.txt`),
  ];
}

export function missingAssets(assets) {
  const uploaded = new Set(assets.filter(asset => asset.state === "uploaded" && asset.size > 0).map(asset => asset.name));
  return requiredAssets().filter(name => !uploaded.has(name));
}
