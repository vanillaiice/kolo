import type { Database } from "@kolo/core/data/database/driver";
import type { Language } from "../../app/strings.ts";
import type { Appearance } from "../../components/theme.ts";

/** Device preference names; values never enter business snapshots or events. */
export type PreferenceKey = "language" | "appearance" | "rememberSession";

/** Device preferences survive business restore and never enter business snapshots/events. */
export interface PreferenceStorage {
  read(key: PreferenceKey): unknown;
  write(key: PreferenceKey, value: string): void;
}

/** Uses a dedicated local database with atomic single-value updates; no business migration. */
export function sqlitePreferences(database: Database): PreferenceStorage {
  database.run(`CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
  return {
    read: key => database.get(`SELECT value FROM preferences WHERE key = ?`, [key])?.["value"],
    write: (key, value) => {
      database.run(`INSERT INTO preferences(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
    },
  };
}

/** Unsupported/corrupt language values fall back to French; storage errors remain visible. */
export function preferredLanguage(storage: PreferenceStorage): { language: Language; failed: boolean } {
  try { return { language: storage.read("language") === "en" ? "en" : "fr", failed: false }; }
  catch { return { language: "fr", failed: true }; }
}

/** Unsupported/corrupt appearance values follow the system; storage errors remain visible. */
export function preferredAppearance(storage: PreferenceStorage): { appearance: Appearance; failed: boolean } {
  try { const value = storage.read("appearance"); return { appearance: value === "light" || value === "dark" ? value : "system", failed: false }; }
  catch { return { appearance: "system", failed: true }; }
}
