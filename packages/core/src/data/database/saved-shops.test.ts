import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nodeWorkspaceFiles } from "./node-sqlite.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const step of cleanup.splice(0).reverse()) step(); });

/** A set-aside shop file holding only what `saved()` reads: the business name. */
function shopFile(directory: string, name: string, usedAt: Date): string {
  const filename = `workspace-${randomUUIDv7()}.db`, path = join(directory, filename);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  db.prepare("INSERT INTO businesses VALUES (?, ?)").run(randomUUIDv7(), name);
  db.close();
  utimesSync(path, usedAt, usedAt);
  return filename;
}

it("set-aside shops come newest first with when they were last used, a newer WAL counting as use", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-saved-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const files = nodeWorkspaceFiles(directory), active = files.openActive();
  cleanup.push(() => { active.close(); files.close(); });
  const older = shopFile(directory, "Same name", new Date("2026-01-01T10:00:00Z"));
  const newer = shopFile(directory, "Same name", new Date("2026-03-01T10:00:00Z"));
  const walled = shopFile(directory, "Kept in WAL", new Date("2025-12-01T10:00:00Z"));
  // Its last writes still sit in the WAL, which is newer than the main file.
  writeFileSync(join(directory, `${walled}-wal`), "");
  utimesSync(join(directory, `${walled}-wal`), new Date("2026-05-01T10:00:00Z"), new Date("2026-05-01T10:00:00Z"));
  writeFileSync(join(directory, `workspace-${randomUUIDv7()}.db`), "not a database");

  const saved = await files.saved();
  assert.deepEqual(saved.map(shop => shop.id), [walled, newer, older], "newest use first; a damaged file is never offered");
  assert.deepEqual(saved.map(shop => shop.lastUsedAt), ["2026-05-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "2026-01-01T10:00:00.000Z"]);
  assert.ok(!saved.some(shop => shop.id === files.activeId()), "the active shop is not listed");
});
