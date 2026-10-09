import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { LATEST_VERSION } from "@kolo/core/data/database/migrations";
import { desktopStatus, openDesktopDatabase } from "./database.ts";

it("migrates and reopens a persistent desktop database without fabricating a shop", () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-desktop-"));
  try {
    const path = join(directory, "kolo.db");
    const first = openDesktopDatabase(path);
    assert.deepEqual(desktopStatus(first), { schemaVersion: LATEST_VERSION, shopName: null });
    first.run("INSERT INTO businesses (id, name, currency, created_at, updated_at) VALUES (?, ?, 'XAF', ?, ?)",
      ["shop", "Chez Jean", "2026-10-05T10:00:00Z", "2026-10-05T10:00:00Z"]);
    first.close();
    const reopened = openDesktopDatabase(path);
    try { assert.equal(desktopStatus(reopened).shopName, "Chez Jean"); } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true }); }
});
