/** Build a locally installable, bundled Android test APK from Expo's generated project. */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const mobile = join(root, "apps/mobile");
const require = createRequire(join(mobile, "package.json"));
const expo = join(dirname(require.resolve("expo/package.json")), "bin/cli");
/**
 * Gradle needs the Android SDK. Use ANDROID_HOME or ANDROID_SDK_ROOT when set, otherwise Android Studio's default
 * location for this system; prebuild regenerates android/, so a local.properties there would not last.
 */
function androidSdk() {
  for (const value of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) if (value) return value;
  const candidates = process.platform === "win32" ? [join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Android", "Sdk")]
    : process.platform === "darwin" ? [join(homedir(), "Library", "Android", "sdk")] : [join(homedir(), "Android", "Sdk"), join(homedir(), "Android", "sdk")];
  const found = candidates.find(path => existsSync(join(path, "platform-tools")) || existsSync(join(path, "platforms")));
  if (found === undefined) { process.stderr.write(`Android SDK not found: set ANDROID_HOME (looked in ${candidates.join(", ")})\n`); process.exit(1); }
  process.stdout.write(`Android SDK: ${found}\n`);
  return found;
}
const sdk = androidSdk();
function run(command, args, cwd, shell = false) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell, env: { ...process.env, ANDROID_HOME: sdk } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, [expo, "prebuild", "--platform", "android", "--no-install"], mobile);
run(process.platform === "win32" ? "gradlew.bat" : "./gradlew", [":app:assembleRelease", "--no-daemon", "--console=plain", "--max-workers=2"], join(mobile, "android"), process.platform === "win32");
const version = JSON.parse(readFileSync(join(mobile, "app.json"), "utf8")).expo.version;
const output = join(root, "release/mobile");
mkdirSync(output, { recursive: true });
// One APK per architecture plus a universal fallback (apps/mobile/plugins/with-abi-splits.js).
const built = join(mobile, "android/app/build/outputs/apk/release");
for (const abi of ["arm64-v8a", "armeabi-v7a", "universal"]) {
  const artifact = join(output, `KOLO-${version}-android-${abi}.apk`);
  cpSync(join(built, `app-${abi}-release.apk`), artifact);
  process.stdout.write(`Android APK (${abi}): ${artifact}\n`);
}
process.stdout.write("These use generated test signing, not a production Play Store identity.\n");
