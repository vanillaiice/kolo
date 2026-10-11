import type { Migration } from "./migrations.ts";
/**
 * Forward-only optional-server support: a `SERVER` device platform, the owner-signed roster revision of each
 * trusted key, and the endpoint of a connected sync server. The devices table is rebuilt to widen its platform
 * check without rewriting child references.
 */
export const SERVER_SYNC_MIGRATION: Migration = {
  version: 25, name: "optional sync server and propagated device trust", statements: [
    // Copy, drop and recreate under deferred foreign keys: re-inserting every device row satisfies each child
    // reference again before commit. Renaming would rewrite child references while foreign keys are enforced.
    `PRAGMA defer_foreign_keys = ON`,
    `CREATE TABLE devices_v24 AS SELECT id,business_id,branch_id,label,platform,active,created_at,updated_at,last_seen_at FROM devices`,
    `DROP TABLE devices`,
    `CREATE TABLE devices (
       id           TEXT    PRIMARY KEY,
       business_id  TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
       branch_id    TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
       label        TEXT    NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
       platform     TEXT    NOT NULL CHECK (platform IN ('ANDROID', 'IOS', 'WEB', 'DESKTOP', 'SERVER')),
       active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
       created_at   TEXT    NOT NULL,
       updated_at   TEXT    NOT NULL,
       last_seen_at TEXT    NOT NULL,
       CHECK (updated_at >= created_at)
     ) STRICT`,
    `CREATE UNIQUE INDEX devices_identity_scope ON devices (business_id, id)`,
    `INSERT INTO devices (id,business_id,branch_id,label,platform,active,created_at,updated_at,last_seen_at)
       SELECT id,business_id,branch_id,label,platform,active,created_at,updated_at,last_seen_at FROM devices_v24`,
    `DROP TABLE devices_v24`,
    `ALTER TABLE trusted_exchange_devices ADD COLUMN roster_revision INTEGER NOT NULL DEFAULT 0 CHECK (roster_revision >= 0)`,
    `CREATE TABLE server_endpoints (
       destination_id  TEXT PRIMARY KEY, business_id TEXT NOT NULL,
       url             TEXT NOT NULL CHECK (length(url) BETWEEN 8 AND 2048),
       connected_at    TEXT NOT NULL, last_attempt_at TEXT, last_success_at TEXT,
       last_error      TEXT CHECK (last_error IS NULL OR length(last_error) <= 64),
       FOREIGN KEY (business_id, destination_id) REFERENCES exchange_destinations (business_id, id)
     ) STRICT`,
  ],
};
