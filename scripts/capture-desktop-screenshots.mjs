/**
 * Capture the desktop README screenshots from a freshly generated demo shop.
 * Usage: node scripts/capture-desktop-screenshots.mjs [output directory, default docs/screenshots]
 * On Linux, Electron runs on a private Xvfb display (when installed) so a tiling window manager
 * cannot resize the window away from its default 1280×850, rendered at 2× for sharp images.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, ".."), output = resolve(process.argv[2] ?? join(root, "docs/screenshots"));
const work = mkdtempSync(join(tmpdir(), "kolo-screenshots-")), profile = join(work, "profile"), shots = join(work, "shots");
const electron = createRequire(import.meta.url)("electron");
const xvfb = process.platform === "linux" && spawnSync("which", ["Xvfb"]).status === 0;
const display = ":87", server = xvfb ? spawn("Xvfb", [display, "-screen", "0", "2560x1700x24", "-nolisten", "tcp"], { stdio: "ignore" }) : undefined;
const screen = xvfb ? { DISPLAY: display, WAYLAND_DISPLAY: "", XDG_SESSION_TYPE: "x11" } : {};
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}
try {
  run("npm", ["run", "build", "-w", "@kolo/desktop"]);
  run("npm", ["run", "demo:desktop", "--", join(work, "demo"), "60"]);
  const backup = join(work, "demo", readdirSync(join(work, "demo")).find(name => name.endsWith(".kolo-backup")));
  mkdirSync(profile);
  const env = { KOLO_DESKTOP_SMOKE_DIR: profile, KOLO_DESKTOP_SCREENSHOT_DIR: shots, KOLO_DESKTOP_SMOKE_OPEN_FILE: backup,
    KOLO_DESKTOP_SMOKE_OPEN_PASSWORD: "kolo-demo-2026", KOLO_DESKTOP_SMOKE_OPEN_SHOP: "Alimentation Chez Mama Ngono" };
  for (const phase of ["restore-file", "readme-screenshots"]) {
    run(electron, ["apps/desktop", "--workflow-smoke", ...(xvfb ? ["--ozone-platform=x11", "--force-device-scale-factor=2"] : [])], { ...env, ...screen, KOLO_DESKTOP_SMOKE_PHASE: phase });
  }
  mkdirSync(output, { recursive: true });
  for (const name of ["desktop-till", "desktop-till-dark", "desktop-analytics", "desktop-products"]) cpSync(join(shots, `${name}.png`), join(output, `${name}.png`));
  process.stdout.write(`Desktop screenshots written to ${output}\n`);
} finally { server?.kill(); rmSync(work, { recursive: true, force: true }); }
