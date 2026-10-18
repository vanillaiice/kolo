import assert from "node:assert/strict";
import { it } from "node:test";
import { desktopSelfCheck } from "./self-check.ts";

// The packaged app runs on Electron's BoringSSL and its own node:sqlite, not the system Node's OpenSSL: Argon2 is
// missing there, for one. `npm test` runs every desktop test in Electron's runtime (scripts/test-in-electron.mjs).
it("desktop tests run in Electron's runtime, where the desktop self-check passes", async () => {
  assert.ok(process.versions["electron"] !== undefined, "run the desktop tests with `npm test -w @kolo/desktop`, which uses Electron's runtime");
  const result = await desktopSelfCheck();
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter(item => !item.ok)));
  assert.ok(result.checks.some(item => item.name === "argon2id") && result.checks.some(item => item.name === "sqlite-snapshot"));
});
