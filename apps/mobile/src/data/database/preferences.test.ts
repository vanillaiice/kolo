import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "@kolo/core/data/database/node-sqlite";
import { preferredAppearance, preferredLanguage, sqlitePreferences } from "./preferences.ts";

test("device language survives file-backed SQLite restart independently of a replaced business database", () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-language-"));
  const preferencesPath = join(directory, "device-preferences.db");
  let preferences = openDatabase({ location: preferencesPath });
  let business = openDatabase({ location: join(directory, "shop.db") });
  try {
    const storage = sqlitePreferences(preferences);
    assert.deepEqual(preferredLanguage(storage), { language: "fr", failed: false });
    storage.write("language", "en");
    assert.equal(business.get(`SELECT name FROM sqlite_master WHERE name = 'preferences'`), undefined);
    business.close();
    business = openDatabase({ location: join(directory, "restored-shop.db") });
    preferences.close();
    preferences = openDatabase({ location: preferencesPath });
    assert.deepEqual(preferredLanguage(sqlitePreferences(preferences)), { language: "en", failed: false });
    sqlitePreferences(preferences).write("language", "fr");
    preferences.close();
    preferences = openDatabase({ location: preferencesPath });
    assert.equal(preferredLanguage(sqlitePreferences(preferences)).language, "fr");
    assert.equal(business.get(`SELECT name FROM sqlite_master WHERE name = 'preferences'`), undefined);
  } finally { preferences.close(); business.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unsupported language falls back to French and failed reads remain distinguishable", () => {
  const database = openDatabase();
  try {
    const storage = sqlitePreferences(database);
    database.run(`INSERT INTO preferences VALUES ('language', 'unsupported')`);
    assert.deepEqual(preferredLanguage(storage), { language: "fr", failed: false });
    database.run(`DROP TABLE preferences`);
    assert.deepEqual(preferredLanguage(storage), { language: "fr", failed: true });
  } finally { database.close(); }
});

test("a rejected preference update preserves the previous durable language and can be retried", () => {
  const database = openDatabase();
  try {
    const storage = sqlitePreferences(database);
    storage.write("language", "en");
    database.run(`CREATE TRIGGER refuse_language BEFORE UPDATE ON preferences BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`);
    assert.throws(() => storage.write("language", "fr"));
    assert.equal(preferredLanguage(storage).language, "en");
    database.run(`DROP TRIGGER refuse_language`);
    storage.write("language", "fr");
    assert.equal(preferredLanguage(storage).language, "fr");
  } finally { database.close(); }
});

test("appearance is stored beside language and falls back to the system setting", () => {
  const database = openDatabase();
  try {
    const storage = sqlitePreferences(database);
    assert.deepEqual(preferredAppearance(storage), { appearance: "system", failed: false });
    storage.write("appearance", "dark");
    storage.write("language", "en");
    assert.deepEqual(preferredAppearance(storage), { appearance: "dark", failed: false });
    assert.equal(preferredLanguage(storage).language, "en");
    database.run(`UPDATE preferences SET value = 'sepia' WHERE key = 'appearance'`);
    assert.equal(preferredAppearance(storage).appearance, "system");
    database.run(`DROP TABLE preferences`);
    assert.deepEqual(preferredAppearance(storage), { appearance: "system", failed: true });
  } finally { database.close(); }
});
