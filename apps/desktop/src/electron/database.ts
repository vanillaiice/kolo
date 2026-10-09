import { openDatabase } from "@kolo/core/data/database/node-sqlite";
import { migrate, schemaVersion } from "@kolo/core/data/database/migrations";
import type { Database } from "@kolo/core/data/database/driver";
import type { DesktopStatus } from "./ipc.js";

/** Open a caller-owned location and migrate it before exposing any business reads. */
export function openDesktopDatabase(location: string): Database {
  const database = openDatabase({ location });
  try { migrate(database); return database; } catch (error) { database.close(); throw error; }
}

/** Read boot status; a missing shop requires setup rather than fabricated demo data. */
export function desktopStatus(database: Database): DesktopStatus {
  const shop = database.get("SELECT name FROM businesses ORDER BY id LIMIT 1");
  return { schemaVersion: schemaVersion(database), shopName: typeof shop?.["name"] === "string" ? shop["name"] : null };
}
