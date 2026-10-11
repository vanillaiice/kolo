/**
 * Render the app icons from assets/brand/*.svg: the desktop icon (electron-builder makes the
 * Windows .ico and Linux sizes from it) and the Android icon, adaptive foreground, themed
 * monochrome layer and launch-screen logo (Expo prebuild makes the mipmaps).
 * Usage: node scripts/render-icons.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, ".."), brand = join(root, "assets/brand");
const outputs = [
  ["kolo-icon.svg", "apps/desktop/build/icon.png"],
  ["kolo-icon.svg", "apps/mobile/assets/icon.png"],
  ["kolo-adaptive-foreground.svg", "apps/mobile/assets/adaptive-icon.png"],
  ["kolo-monochrome.svg", "apps/mobile/assets/monochrome-icon.png"],
  ["kolo-splash.svg", "apps/mobile/assets/splash-icon.png"],
];
for (const [, output] of outputs) mkdirSync(dirname(join(root, output)), { recursive: true });
const electron = createRequire(import.meta.url)("electron");
// A private Xvfb display keeps the offscreen window at exactly 1024 px on any desktop.
const xvfb = process.platform === "linux" && spawnSync("which", ["Xvfb"]).status === 0;
const display = ":88", server = xvfb ? spawn("Xvfb", [display, "-screen", "0", "1280x1280x24", "-nolisten", "tcp"], { stdio: "ignore" }) : undefined;
try {
  const result = spawnSync(electron, ["--force-device-scale-factor=1", ...(xvfb ? ["--ozone-platform=x11"] : []), join(root, "scripts/brand/render-icons.cjs"), "--",
    ...outputs.flatMap(([svg, png]) => [join(brand, svg), join(root, png)])],
    { stdio: "inherit", env: { ...process.env, ...(xvfb ? { DISPLAY: display, WAYLAND_DISPLAY: "" } : {}) } });
  if (result.status !== 0) process.exit(result.status ?? 1);
  process.stdout.write(`Rendered ${outputs.length} icons\n`);
} finally { server?.kill(); }
