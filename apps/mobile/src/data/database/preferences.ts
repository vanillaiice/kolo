import type { Database } from "@kolo/core/data/database/driver";
import type { Language } from "../../app/strings.ts";

/** Device preferences survive business restore and never enter business snapshots/events. */
export interface LanguageStorage {
  read(): unknown;
  write(language: Language): void;
}

/** Uses a dedicated local database with atomic single-value updates; no business migration. */
export function sqlitePreferences(database: Database): LanguageStorage {
  database.run(`CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
  return {
    read: () => database.get(`SELECT value FROM preferences WHERE key = 'language'`)?.["value"],
    write: language => {
      database.run(`INSERT INTO preferences(key, value) VALUES ('language', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [language]);
    },
  };
}

/** Unsupported/corrupt language values fall back to French; storage errors remain visible. */
export function preferredLanguage(storage: LanguageStorage): { language: Language; failed: boolean } {
  try { return { language: storage.read() === "en" ? "en" : "fr", failed: false }; }
  catch { return { language: "fr", failed: true }; }
}
