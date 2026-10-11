/** Build a locally installable, bundled Android test APK from Expo's generated project. */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const mobile = join(root, "apps/mobile");
const require = createRequire(join(mobile, "package.json"));
const expo = join(dirname(require.resolve("expo/package.json")), "bin/cli");
function run(command, args, cwd, shell = false) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell });
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
