import type { Queryable } from "../data/database/driver.ts";

function exists(tx: Queryable, table: string): boolean {
  return tx.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]) !== undefined;
}

/**
 * Every protected-store key a shop database refers to on this device: each member's local
 * credential, the installation key and its manifest, and a pending setup's installation manifest.
 * A device reset forgets these before deleting the database files, so no secret outlives its shop.
 * References that belong to another device (`remote.*`, after a restore or pairing) are skipped.
 */
export function localSecretKeys(tx: Queryable): string[] {
  const keys = new Set<string>();
  const add = (value: unknown): void => { if (typeof value === "string" && value.startsWith("kolo.")) keys.add(value); };
  if (exists(tx, "local_memberships")) for (const row of tx.all(`SELECT credential_reference FROM local_memberships`)) add(row["credential_reference"]);
  if (exists(tx, "local_installation")) for (const row of tx.all(`SELECT installation_id, key_reference FROM local_installation`)) {
    add(row["key_reference"]); add(`kolo.local.${String(row["installation_id"])}.manifest`);
  }
  for (const table of ["workspace_setup", "workspace_enrollment", "local_member_setup"]) {
    if (!exists(tx, table)) continue;
    for (const row of tx.all(`SELECT intent FROM ${table}`)) {
      try {
        const intent = JSON.parse(String(row["intent"])) as Record<string, unknown>;
        if (typeof intent["installationId"] === "string") add(`kolo.local.${intent["installationId"]}.manifest`);
        for (const value of Object.values(intent)) add(value);
      } catch { /* A malformed intent holds no usable reference. */ }
    }
  }
  return [...keys].sort();
}
