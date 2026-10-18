/**
 * Runs the desktop tests in Electron's own Node (BoringSSL, its node:sqlite), where the packaged app runs, instead of the
 * system Node: a primitive missing from Electron then fails the tests rather than a shop's backup.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron");
const result = spawnSync(electron, ["--test", "--experimental-strip-types", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
