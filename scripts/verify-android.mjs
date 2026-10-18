/**
 * An Android build is not ready until it passes on Android: Node tests do not run Hermes or quick-crypto.
 *
 * Usage: node scripts/verify-android.mjs [apk]
 *
 * Installs the APK matching the connected device's CPU (or the one given) over the existing app, opens
 * kolo://self-check and reads the app's platform check from logcat: every crypto primitive against known answers,
 * key imports, NFC passwords, and the golden backup opened by password and by recovery key. Fails unless the install
 * replaced the app at app.json's version, so a stale APK or one with another app ID cannot pass on the existing app.
 * Without an APK argument, the built APK must also be newer than every source file it bundles, so a failed or skipped
 * build cannot be verified with the previous one.
 * Never uninstalls: that would erase the phone's shop. Needs exactly one device or emulator with USB debugging.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const PACKAGE = "xyz.hblabs.kolo";
function adb(args, options = {}) {
  const run = spawnSync("adb", args, { encoding: "utf8", timeout: options.timeout ?? 120_000 });
  if (run.error) throw new Error(`adb ${args[0]} failed: ${run.error.message}`);
  if (run.status !== 0 && !options.allowFailure) throw new Error(`adb ${args.join(" ")} failed: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout;
}
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
// What goes into the APK: the app's source and configuration, the shared packages it bundles, and the lockfile.
const SOURCES = ["apps/mobile/src", "apps/mobile/plugins", "apps/mobile/assets", "apps/mobile/app.json", "apps/mobile/index.ts", "apps/mobile/package.json",
  "apps/mobile/babel.config.cjs", "packages/core/src", "packages/core/package.json", "packages/contracts/src", "packages/contracts/package.json", "package-lock.json"];
/** The newest source file, so an APK built before a change (committed or not) is caught; a failed build leaves the old one. */
function newestSource() {
  let newest = { path: "", mtimeMs: 0 };
  const visit = path => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) { for (const entry of readdirSync(path)) visit(join(path, entry)); return; }
    if (/\.test\.[cm]?[jt]sx?$/.test(path)) return; // Tests are not bundled.
    if (stat.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: stat.mtimeMs };
  };
  for (const source of SOURCES) visit(join(root, source));
  return newest;
}
// The phone's build of the app. Installing an APK with another app ID succeeds but adds a second app, and the
// self-check would then run whatever build was already installed.
function installed() {
  const dump = adb(["shell", "dumpsys", "package", PACKAGE], { allowFailure: true });
  return { version: /versionName=(\S+)/.exec(dump)?.[1], updated: /lastUpdateTime=(.+)/.exec(dump)?.[1].trim() };
}

try {
  const devices = adb(["devices"]).split("\n").slice(1).filter(line => /\tdevice$/.test(line));
  if (devices.length !== 1) throw new Error(`need exactly one device or emulator with USB debugging, found ${devices.length} (adb devices)`);
  const abi = adb(["shell", "getprop", "ro.product.cpu.abi"]).trim();
  const version = JSON.parse(readFileSync(join(root, "apps/mobile/app.json"), "utf8")).expo.version;
  const split = ["arm64-v8a", "armeabi-v7a"].includes(abi) ? abi : "universal";
  const apk = resolve(process.argv[2] ?? join(root, "release/mobile", `KOLO-${version}-android-${split}.apk`));
  if (!existsSync(apk)) throw new Error(`no APK at ${apk}; build it first (npm run build:mobile:android)`);
  // A Gradle run outside build:mobile:android leaves the copy in release/mobile behind.
  const gradle = join(root, "apps/mobile/android/app/build/outputs/apk/release", `app-${split}-release.apk`);
  if (process.argv[2] === undefined && existsSync(gradle) && statSync(gradle).mtimeMs > statSync(apk).mtimeMs)
    throw new Error(`${apk} is older than Gradle's ${gradle}; rebuild with npm run build:mobile:android or pass the APK`);
  const source = newestSource();
  if (process.argv[2] === undefined && source.mtimeMs > statSync(apk).mtimeMs)
    throw new Error(`${apk} is older than ${source.path.slice(root.length + 1)}; rebuild with npm run build:mobile:android (or pass an APK to test it as it is)`);
  const before = installed();
  process.stdout.write(`Installing ${apk} on ${devices[0].split("\t")[0]} (${abi})\n`);
  const install = spawnSync("adb", ["install", "-r", apk], { encoding: "utf8", timeout: 300_000 });
  if (install.status !== 0) {
    const reason = `${install.stdout}${install.stderr}`.trim();
    throw new Error(/UPDATE_INCOMPATIBLE|signatures do not match/i.test(reason)
      ? "the installed KOLO is signed with another key; uninstalling would erase its shop, so use another device or back it up and uninstall it yourself"
      : `install failed: ${reason}`);
  }
  const after = installed();
  if (after.updated === undefined || after.updated === before.updated)
    throw new Error(`${apk} installed but did not update ${PACKAGE}; it has another app ID`);
  if (after.version !== version) throw new Error(`${PACKAGE} is ${after.version} after install, but app.json is ${version}`);
  adb(["logcat", "-c"]);
  adb(["shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", "kolo://self-check", PACKAGE]);
  let line;
  for (const started = Date.now(); line === undefined && Date.now() - started < 120_000; await sleep(1000))
    line = adb(["logcat", "-d", "-s", "ReactNativeJS:V"], { allowFailure: true }).split("\n").find(entry => entry.includes("KOLO_SELF_CHECK "));
  if (line === undefined) throw new Error("the app logged no self-check result within 2 minutes (adb logcat -s ReactNativeJS)");
  const result = JSON.parse(line.slice(line.indexOf("KOLO_SELF_CHECK ") + "KOLO_SELF_CHECK ".length));
  for (const check of result.checks) process.stdout.write(`  ${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(20)} ${String(check.ms).padStart(5)} ms${check.detail ? `  ${check.detail}` : ""}\n`);
  if (!result.ok) throw new Error("the installed app failed its self-check");
  process.stdout.write("Android build verified on the device.\n");
} catch (error) {
  process.stderr.write(`Android build NOT verified: ${error.message}\n`);
  process.exit(1);
}
