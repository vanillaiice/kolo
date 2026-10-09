/** Run the actual Electron boot/IPC/SQLite stack using a disposable user-data directory. */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const runtime = require("electron");
const directory = mkdtempSync(join(tmpdir(), "kolo-electron-smoke-"));
const child = spawn(runtime, ["apps/desktop", "--smoke-test"], {
  stdio: "inherit", env: { ...process.env, KOLO_DESKTOP_SMOKE_DIR: directory },
});
const timer = setTimeout(() => {
  process.stderr.write("Desktop runtime smoke timed out after 30 seconds\n");
  child.kill("SIGTERM");
}, 30000);
child.once("error", error => { process.stderr.write(`${error.message}\n`); });
child.once("close", code => {
  clearTimeout(timer);
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = code === 0 ? 0 : 1;
});
