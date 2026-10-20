import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlatformCheck, type PlatformCheck, type PlatformCheckResult } from "@kolo/core/application/platform-check";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { desktopSealingCrypto, desktopTransferCrypto } from "./local-credentials.ts";

/**
 * The desktop runtime checks itself: every crypto primitive against known answers in Electron's BoringSSL, and its
 * storage path (node:sqlite, every migration, the snapshot copy in a worker thread loaded from inside the asar).
 * `--self-check` runs this in a packaged build; electron-runtime.test.ts runs it in the test suite. A packaged build
 * passes its resources directory: electron-updater must load from the asar and the build must carry its update feed.
 */
export async function desktopSelfCheck(resources?: string): Promise<PlatformCheck> {
  const crypto = await runPlatformCheck(desktopTransferCrypto, desktopSealingCrypto), started = Date.now();
  let storage: PlatformCheckResult;
  const directory = mkdtempSync(join(tmpdir(), "kolo-self-check-"));
  try {
    const files = nodeWorkspaceFiles(directory), database = files.openActive();
    try {
      migrate(database);
      const snapshot = await files.capture(database), image = await snapshot.image();
      try { if (image.size < 4096) throw new Error("snapshot image is empty"); } finally { await image.close(); await snapshot.discard(); }
    } finally { database.close(); files.close(); }
    storage = { name: "sqlite-snapshot", ok: true, ms: Date.now() - started };
  } catch (error) {
    storage = { name: "sqlite-snapshot", ok: false, ms: Date.now() - started, detail: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "failed" };
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const checks = [...crypto.checks, storage];
  if (resources !== undefined) {
    const started = Date.now();
    try {
      const { NsisUpdater, AppImageUpdater } = (await import("electron-updater")).default;
      if (typeof NsisUpdater !== "function" || typeof AppImageUpdater !== "function") throw new Error("electron-updater is incomplete");
      if (!existsSync(join(resources, "app-update.yml"))) throw new Error("app-update.yml is missing");
      checks.push({ name: "updater", ok: true, ms: Date.now() - started });
    } catch (error) {
      checks.push({ name: "updater", ok: false, ms: Date.now() - started, detail: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "failed" });
    }
  }
  return { ok: checks.every(check => check.ok), checks };
}
