/** Exercise the actual Electron UI twice using the same caller-owned disposable user data. */
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const packaged = process.argv.includes("--packaged");
const runtime = process.env.KOLO_DESKTOP_EXECUTABLE ?? (packaged ? resolve(process.platform === "win32" ? "release/desktop/win-unpacked/KOLO.exe" : "release/desktop/linux-unpacked/kolo") : require("electron"));
const directory = mkdtempSync(join(tmpdir(), "kolo-desktop-workflow-"));
const installer = process.env.KOLO_DESKTOP_INSTALLER;
const installDirectory = installer ? mkdtempSync(join(tmpdir(), "kolo-desktop-install-")) : undefined;
const install = path => {
  const result = spawnSync(path, ["/S", `/D=${installDirectory}`], { stdio: "inherit", timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error("Silent installer failed");
};
const execute = installDirectory ? join(installDirectory, "KOLO.exe") : runtime;
async function phase(name) {
  return await new Promise(resolve => {
    const crash = name === "crash-commit";
    const child = spawn(execute, [...(installDirectory || packaged || process.env.KOLO_DESKTOP_EXECUTABLE ? [] : ["apps/desktop"]), "--workflow-smoke"], { stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, KOLO_DESKTOP_SMOKE_DIR: directory, KOLO_DESKTOP_SMOKE_PHASE: name, KOLO_DESKTOP_AXE_PATH: axePath } });
    let killed = false, timedOut = false, output = "";
    child.stdout.on("data", bytes => {
      process.stdout.write(bytes); output += bytes.toString();
      if (crash && !killed && output.includes("KOLO_CRASH_READY")) { killed = true; child.kill("SIGKILL"); }
    });
    const timer = setTimeout(() => { timedOut = true; process.stderr.write("Desktop workflow phase timed out\n"); child.kill("SIGKILL"); }, 90000);
    child.once("error", () => { process.stderr.write("Electron could not start\n"); });
    child.once("close", code => { clearTimeout(timer); resolve(!timedOut && crash && killed ? 0 : code ?? 1); });
  });
}
/**
 * Independent check of what the real app wrote: the CLI authenticates the desktop's own backup, runs core's
 * integrity checks over it and reads the sales report. A broken backup or inconsistent shop fails the smoke.
 */
function crossCheckBackup() {
  const backup = join(directory, "last.kolo-backup"), cli = resolve("apps/cli/dist/main.js");
  if (!existsSync(backup)) { process.stderr.write("Desktop workflow saved no backup to cross-check\n"); process.exitCode = 1; return; }
  const env = { ...process.env, KOLO_BACKUP_PASSWORD: "correct horse battery" };
  const kolo = args => {
    const result = spawnSync(process.execPath, [cli, ...args, backup], { env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`kolo ${args.join(" ")} failed: ${result.stderr.trim()}`);
    return JSON.parse(result.stdout);
  };
  try {
    const verified = kolo(["backup", "verify"]);
    if (verified.verified !== true || verified.businessName !== "Desktop validation") throw new Error("backup does not describe the validated shop");
    const integrity = kolo(["check", "--backup"]);
    if (integrity.consistent !== true) throw new Error(`integrity findings: ${JSON.stringify(integrity.issues)}`);
    const sales = kolo(["report", "sales", "--backup"]);
    // Two sales (250 + 500 FCFA) less the 500 FCFA bag returned before the backup was taken.
    if (sales.transactions !== 2 || sales.totalMinor !== 250) throw new Error(`unexpected sales in backup: ${JSON.stringify(sales)}`);
    process.stdout.write("CLI verified the desktop backup: signature, integrity checks and sales report passed\n");
  } catch (error) { process.stderr.write(`Desktop backup cross-check failed: ${error.message}\n`); process.exitCode = 1; }
}
try {
  if (installer) install(process.env.KOLO_DESKTOP_BASELINE_INSTALLER ?? installer);
  for (const name of ["create", "reopen", "entry-recovery", "resilience", "crash-commit", "crash-reopen", "import-replace", "import-reopen", "start-over", "remember-on", "remember-reopen", "remember-locked", "customer-credit"]) {
    if (installer && name === "reopen") install(installer);
    const code = await phase(name); if (code !== 0) { process.exitCode = code; break; }
  }
  if (!process.exitCode) crossCheckBackup();
}
finally {
  if (installDirectory) {
    const uninstaller = join(installDirectory, "Uninstall KOLO.exe");
    if (existsSync(uninstaller)) {
      const result = spawnSync(uninstaller, ["/S", `_?=${installDirectory}`], { stdio: "inherit", timeout: 120000 });
      if (result.error || result.status !== 0) process.exitCode = 1;
    }
    rmSync(installDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
