/**
 * Build one platform locally and upload it to its draft GitHub pre-release (docs/releasing.md).
 * Usage: node scripts/release.mjs <android|linux|windows>
 *
 * The working tree must be clean and the version tag (mobile-vX.Y.Z or desktop-vX.Y.Z) must
 * point at HEAD and already be on origin, so the pushed commit passed the pre-push check.
 * The draft is created when missing; a published release is never modified.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const platform = process.argv[2];
const json = path => JSON.parse(readFileSync(join(root, path), "utf8"));
const targets = {
  android: { version: () => json("apps/mobile/app.json").expo.version, prefix: "mobile-v", directory: "release/mobile", title: "KOLO Android",
    build: ["npm", ["run", "build:mobile:android"]], sums: "SHA256SUMS-android.txt", hashed: name => name.endsWith(".apk"),
    uploads: (name, version) => name === `KOLO-${version}-android-test.apk`,
    notes: "Android test build with generated test signing: install by allowing unknown sources. Not a Play Store build." },
  linux: { version: () => json("apps/desktop/package.json").version, prefix: "desktop-v", directory: "release/desktop", title: "KOLO Desktop",
    build: ["npm", ["run", "dist:desktop:linux"]], sums: "SHA256SUMS-linux.txt", hashed: name => /\.(AppImage|deb)$/.test(name),
    uploads: (name, version) => name.startsWith(`KOLO-${version}-linux-`) || name === "latest-linux.yml",
    notes: "Windows and Linux desktop. Unsigned builds: Windows SmartScreen warns until signing is configured." },
  windows: { version: () => json("apps/desktop/package.json").version, prefix: "desktop-v", directory: "release/desktop", title: "KOLO Desktop",
    build: ["npm", ["run", "dist:desktop:win"]], sums: "SHA256SUMS-windows.txt", hashed: name => name.endsWith(".exe"),
    uploads: (name, version) => name.startsWith(`KOLO-${version}-win-`) || name === "latest.yml",
    notes: "Windows and Linux desktop. Unsigned builds: Windows SmartScreen warns until signing is configured." },
};
const target = targets[platform];
if (target === undefined) { process.stderr.write(`Usage: node scripts/release.mjs <${Object.keys(targets).join("|")}>\n`); process.exit(2); }

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", env: { ...process.env, ...options.env } });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) { if (options.capture) process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
  return result;
}
const output = (command, args) => run(command, args, { capture: true }).stdout.trim();
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }

const version = target.version(), tag = `${target.prefix}${version}`;
if (output("git", ["status", "--porcelain"]) !== "") fail("The working tree has changes; release from a clean checkout.");
if (run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { capture: true, allowFailure: true }).status !== 0) fail(`Tag ${tag} does not exist; bump the version and tag first.`);
if (output("git", ["rev-list", "-n", "1", tag]) !== output("git", ["rev-parse", "HEAD"])) fail(`${tag} is not HEAD; check out the tag before releasing.`);
if (output("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) === "") fail(`${tag} is not on origin; push it first (git push origin ${tag}).`);

const existing = run("gh", ["release", "view", tag, "--json", "isDraft", "--jq", ".isDraft"], { capture: true, allowFailure: true });
if (existing.status === 0 && existing.stdout.trim() !== "true") fail(`${tag} is already published; refusing to change it.`);

const environment = platform === "android" ? { ANDROID_HOME: process.env.ANDROID_HOME ?? join(process.env.HOME ?? "", "Android/Sdk") }
  : { CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_LINK ? "true" : "false" };
run(target.build[0], target.build[1], { env: environment });

const directory = join(root, target.directory);
const built = readdirSync(directory).filter(name => target.uploads(name, version));
const hashed = built.filter(target.hashed);
if (hashed.length === 0) fail(`No ${platform} artifacts for ${version} in ${target.directory}.`);
const sums = hashed.map(name => `${createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")}  ${name}\n`).join("");
writeFileSync(join(directory, target.sums), sums);
process.stdout.write(sums);

if (existing.status !== 0) run("gh", ["release", "create", tag, "--draft", "--prerelease", "--verify-tag", "--title", `${target.title} ${version}`, "--notes", target.notes]);
run("gh", ["release", "upload", tag, ...[...built, target.sums].map(name => join(directory, name)), "--clobber"]);
process.stdout.write(`${platform} ${version} uploaded to the draft release ${tag}\n`);
