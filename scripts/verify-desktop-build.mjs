/**
 * A desktop build is not ready until it passes in its own packaged runtime: Node tests run on another one.
 *
 * Usage: node scripts/verify-desktop-build.mjs linux|win [unpacked directory]
 *
 * 1. The packaged app's `--self-check`: every crypto primitive against known answers in Electron's BoringSSL, the golden
 *    backup opened by password and recovery key, node:sqlite, every migration and the snapshot worker inside the asar.
 * 2. The packaged app's real-UI workflow smoke (setup, sales, backup to a file, restore, exchange, crash recovery), then
 *    the CLI independently verifies the backup the app wrote.
 * On Linux without a display, an Xvfb server is started. Windows built on Linux runs step 1 through wine; the UI
 * workflow for Windows runs on Windows (CI or a Windows machine) and this says so instead of passing quietly.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const platform = process.argv[2];
if (platform !== "linux" && platform !== "win") { process.stderr.write("usage: verify-desktop-build.mjs linux|win [unpacked directory]\n"); process.exit(2); }
const unpacked = resolve(process.argv[3] ?? join(root, "release/desktop", platform === "linux" ? "linux-unpacked" : "win-unpacked"));
const executable = join(unpacked, platform === "linux" ? "kolo" : "KOLO.exe");
if (!existsSync(executable)) { process.stderr.write(`No packaged app at ${executable}; build it first.\n`); process.exit(1); }
const throughWine = platform === "win" && process.platform !== "win32";

/** Runs the packaged app with `--self-check`; the result is read from a file because a GUI app's stdout may be lost. */
function selfCheck(env) {
  const directory = mkdtempSync(join(tmpdir(), "kolo-verify-")), output = join(directory, "self-check.json");
  try {
    const args = [...(throughWine ? [executable] : []), "--self-check", ...(platform === "linux" ? ["--ozone-platform=headless"] : [])];
    // Under wine the app sees Windows paths: Z: maps the Linux root.
    const target = throughWine ? spawnSync("winepath", ["-w", output], { encoding: "utf8" }).stdout.trim() : output;
    // Output goes to a file, not a pipe: Electron under wine hangs writing to a pipe.
    const log = join(directory, "self-check.log"), descriptor = openSync(log, "w");
    let run;
    try { run = spawnSync(throughWine ? "wine" : executable, args, { env: { ...env, KOLO_SELF_CHECK_OUTPUT: target, ...(throughWine ? { WINEDEBUG: "-all" } : {}) }, stdio: ["ignore", descriptor, descriptor], timeout: 180_000 }); }
    finally { closeSync(descriptor); }
    if (!existsSync(output)) throw new Error(`the packaged app wrote no self-check result (exit ${run.status ?? run.signal}): ${readFileSync(log, "utf8").slice(-2000)}`);
    const result = JSON.parse(readFileSync(output, "utf8"));
    for (const check of result.checks) process.stdout.write(`  ${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(20)} ${String(check.ms).padStart(5)} ms${check.detail ? `  ${check.detail}` : ""}\n`);
    if (!result.ok || run.status !== 0) throw new Error("the packaged app failed its self-check");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** A display for the UI workflow: the session's own, or a private Xvfb server stopped afterwards. */
async function withDisplay(work) {
  if (process.platform !== "linux" || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return work(process.env);
  const display = `:${90 + Math.floor(Math.random() * 400)}`, server = spawn("Xvfb", [display, "-screen", "0", "1440x960x24", "-nolisten", "tcp"], { stdio: "ignore" });
  await new Promise((done, fail) => { server.once("error", () => fail(new Error("no display and Xvfb could not start; install xvfb"))); setTimeout(done, 1500); });
  try { return await work({ ...process.env, DISPLAY: display }); } finally { server.kill(); }
}

function step(command, args, env) {
  const run = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (run.status !== 0) throw new Error(`${[command, ...args].join(" ")} failed`);
}

try {
  process.stdout.write(`Packaged ${platform} self-check (${throughWine ? "wine" : "native"}):\n`);
  await withDisplay(async env => {
    selfCheck(env);
    if (platform === "linux" || process.platform === "win32") {
      process.stdout.write("Packaged real-UI workflow smoke:\n");
      // The workflow ends with the CLI verifying the app's backup, so the CLI must be built.
      step("npm", ["run", "build:packages", "--silent"], env); step("npm", ["run", "build", "-w", "@kolo/cli", "--silent"], env);
      step(process.execPath, ["scripts/smoke-desktop-workflow.mjs", "--packaged"], { ...env, KOLO_DESKTOP_EXECUTABLE: executable });
      process.stdout.write(`Desktop ${platform} build verified in its packaged runtime: self-check and real-UI workflow.\n`);
    } else process.stdout.write("Windows self-check passed under wine. The Windows UI workflow is NOT verified here: it needs Windows (`npm run verify:desktop:win` there, or CI).\n");
  });
} catch (error) {
  process.stderr.write(`Desktop ${platform} build NOT verified: ${error.message}\n`);
  process.exit(1);
}
