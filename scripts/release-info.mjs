import { readFileSync } from "node:fs";

const json = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
export const releaseVersion = json("package.json").version;
export const releaseTag = `v${releaseVersion}`;
export const desktopVersion = json("apps/desktop/package.json").version;
export const androidVersion = json("apps/mobile/app.json").expo.version;
/**
 * The CHANGELOG.md section for a version: the lines under its `## <version>` (or `## [<version>]`) heading, up to the
 * next `## `. A release cannot be created or published without one, because installed apps show it before updating.
 */
export function changelogFor(version, changelog) {
  const lines = changelog.split(/\r?\n/), heading = new RegExp(`^## \\[?${version.replace(/[.+]/g, "\\$&")}\\]?(\\s|$)`);
  const start = lines.findIndex(line => heading.test(line));
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section; write what changed before releasing.`);
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  if (section === "") throw new Error(`CHANGELOG.md's "## ${version}" section is empty.`);
  return section;
}

/** GitHub pre-release while KOLO is below 1.0.0 or the version has a pre-release suffix (`-beta.1`); full release otherwise. */
export function isPrerelease(version) { return /^0\./.test(version) || version.includes("-"); }
export const prerelease = isPrerelease(releaseVersion);

/**
 * Release notes: the changelog first, then a rule, then download instructions. The desktop app shows what comes before
 * the rule when it offers the update, for every release since the installed one.
 */
export function releaseNotes(changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")) {
  return `${changelogFor(releaseVersion, changelog)}

---

Windows and Linux desktop ${desktopVersion}; Android ${androidVersion}.

Windows: download the setup installer, or the portable executable.
Linux: download the AppImage or Debian package (x64).
Android: arm64-v8a for most phones, armeabi-v7a for older 32-bit phones, or universal when unsure.

Desktop builds are unsigned unless signing is configured; Windows SmartScreen may warn. Android uses generated test signing and is not a Play Store build.
SHA256SUMS files accompany each platform. Desktop KOLO after 0.8.0 offers this update itself (Settings → Updates); 0.8.0 and earlier install the next version over the old one.`;
}

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
