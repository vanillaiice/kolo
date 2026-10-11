/**
 * Capture README images from an unlocked English demo shop on a connected Android phone.
 * Usage: node scripts/capture-mobile-screenshots.mjs [output directory, default docs/screenshots]
 * Select a device with ANDROID_SERIAL if several are connected. Start on Sell with an empty cart.
 * Uses accessibility labels rather than fixed screen coordinates. No sale is completed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const output = resolve(process.argv[2] ?? new URL("../docs/screenshots", import.meta.url).pathname);
const dumpPath = "/sdcard/kolo-readme-window.xml";
const pause = () => new Promise(resolve => setTimeout(resolve, 300));
function adb(args, binary = false) {
  const result = spawnSync("adb", args, { encoding: binary ? undefined : "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout;
}
const decode = text => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
async function nodes() {
  await pause();
  adb(["shell", "uiautomator", "dump", dumpPath]);
  const xml = adb(["exec-out", "cat", dumpPath]);
  if (!xml.includes('package="cm.kolo.app"')) throw new Error("KOLO must be open and unlocked on the demo phone.");
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(match => Object.fromEntries(
    [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)]),
  ));
}
async function tap(label, prefix = false) {
  const all = await nodes();
  const matches = value => prefix ? value?.startsWith(label) : value === label;
  const node = all.find(node => matches(node["content-desc"])) ?? all.find(node => matches(node.text));
  if (!node) throw new Error(`Cannot find ${label}; use an unlocked English demo shop.`);
  const bounds = node.bounds.match(/\d+/g).map(Number);
  adb(["shell", "input", "tap", String(Math.round((bounds[0] + bounds[2]) / 2)), String(Math.round((bounds[1] + bounds[3]) / 2))]);
  await pause();
}
async function screenshot(name) {
  await nodes(); // Wait for the screen to settle and confirm KOLO is foreground.
  writeFileSync(join(output, `${name}.png`), adb(["exec-out", "screencap", "-p"], true));
}

try {
  const initial = await nodes();
  if (!initial.some(node => node.text === "ALIMENTATION CHEZ MAMA NGONO")) throw new Error("Open the Alimentation Chez Mama Ngono demo shop first.");
  if (!initial.some(node => node.text === "Scan or add a product to start")) throw new Error("Start on Sell with an empty demo cart.");
  mkdirSync(output, { recursive: true });
  await tap("More"); await tap("Settings"); await tap("Light");
  adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await tap("Sell");
  for (const name of ["Allumettes (x10)", "Café Nescafé 50g"]) await tap(name);
  await screenshot("mobile-sell-cart");
  await tap("Cart ·", true); await screenshot("mobile-cart");
  adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await tap("Products"); await screenshot("mobile-products");
  process.stdout.write(`Mobile screenshots written to ${output}\n`);
} finally {
  adb(["shell", "rm", "-f", dumpPath]);
}
