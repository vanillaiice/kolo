/** Exercise the actual Electron UI twice using the same caller-owned disposable user data. */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const require = createRequire(import.meta.url);
const runtime = require("electron");
const directory = mkdtempSync(join(tmpdir(), "kolo-desktop-workflow-"));
async function phase(name) {
  return await new Promise(resolve => {
    const child = spawn(runtime, ["apps/desktop", "--workflow-smoke"], { stdio: "inherit",
      env: { ...process.env, KOLO_DESKTOP_SMOKE_DIR: directory, KOLO_DESKTOP_SMOKE_PHASE: name } });
    const timer = setTimeout(() => { process.stderr.write("Desktop workflow phase timed out\n"); child.kill("SIGTERM"); }, 45000);
    child.once("error", () => { process.stderr.write("Electron could not start\n"); });
    child.once("close", code => { clearTimeout(timer); resolve(code ?? 1); });
  });
}
try { const created = await phase("create"); process.exitCode = created === 0 ? await phase("reopen") : created; }
finally { rmSync(directory, { recursive: true, force: true }); }
