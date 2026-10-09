import type { Migration } from "./migrations.ts";

/** Durable native/SQLite credential and staff provisioning gaps; no secret values. */
export const CREDENTIAL_RECOVERY_MIGRATION: Migration = {
  version: 16,
  name: "recoverable local credential and member provisioning",
  statements: [
    `CREATE TABLE local_credential_recovery (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       business_id TEXT NOT NULL,
       user_id TEXT NOT NULL,
       old_reference TEXT NOT NULL,
       new_reference TEXT NOT NULL,
       event_id TEXT NOT NULL UNIQUE,
       created_at TEXT NOT NULL,
       failures INTEGER NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 10),
       next_attempt_at TEXT,
       FOREIGN KEY (business_id, user_id) REFERENCES local_memberships(business_id, user_id) ON DELETE RESTRICT
     ) STRICT`,
    `CREATE TABLE local_member_setup (
       user_id TEXT PRIMARY KEY,
       business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
       owner_id TEXT NOT NULL,
       intent TEXT NOT NULL CHECK (json_valid(intent)),
       FOREIGN KEY (business_id, owner_id) REFERENCES local_memberships(business_id, user_id) ON DELETE RESTRICT
     ) STRICT`,
  ],
};
