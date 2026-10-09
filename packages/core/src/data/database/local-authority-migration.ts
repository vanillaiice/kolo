import type { Migration } from "./migrations.ts";

/** Forward-only F1 schema. Pending setup stores intent, never credentials. */
export const LOCAL_AUTHORITY_MIGRATION: Migration = {
  version: 15,
  name: "standalone installation and local authority",
  statements: [
    `CREATE UNIQUE INDEX users_identity_scope ON users (business_id, id)`,
    `CREATE UNIQUE INDEX devices_identity_scope ON devices (business_id, id)`,
    `CREATE TABLE workspace_setup (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       intent TEXT NOT NULL CHECK (json_valid(intent)),
       created_at TEXT NOT NULL
     ) STRICT`,
    `CREATE TABLE local_installation (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       installation_id TEXT NOT NULL UNIQUE,
       business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
       owner_id TEXT NOT NULL,
       device_id TEXT NOT NULL,
       public_key TEXT NOT NULL CHECK (length(trim(public_key)) BETWEEN 1 AND 8192),
       key_reference TEXT NOT NULL CHECK (length(trim(key_reference)) BETWEEN 1 AND 512),
       configured_at TEXT NOT NULL,
       FOREIGN KEY (business_id, owner_id) REFERENCES users(business_id, id) ON DELETE RESTRICT,
       FOREIGN KEY (business_id, device_id) REFERENCES devices(business_id, id) ON DELETE RESTRICT
     ) STRICT`,
    `CREATE TABLE local_memberships (
       business_id TEXT NOT NULL,
       user_id TEXT NOT NULL,
       credential_reference TEXT NOT NULL UNIQUE CHECK (length(trim(credential_reference)) BETWEEN 1 AND 512),
       role TEXT NOT NULL CHECK (role IN ('OWNER','MANAGER','CASHIER','INVENTORY','ACCOUNTANT')),
       active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
       granted TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted) AND json_type(granted) = 'array'),
       revoked TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(revoked) AND json_type(revoked) = 'array'),
       revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
       failures INTEGER NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 10),
       next_attempt_at TEXT,
       PRIMARY KEY (business_id, user_id),
       FOREIGN KEY (business_id, user_id) REFERENCES users(business_id, id) ON DELETE RESTRICT
     ) STRICT`,
    `CREATE TABLE local_audit (
       sequence INTEGER PRIMARY KEY AUTOINCREMENT,
       event_id TEXT NOT NULL UNIQUE,
       business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
       user_id TEXT NOT NULL,
       device_id TEXT NOT NULL,
       action TEXT NOT NULL CHECK (length(trim(action)) > 0),
       entity_id TEXT NOT NULL,
       authority_revision INTEGER NOT NULL CHECK (authority_revision > 0),
       occurred_at TEXT NOT NULL,
       payload TEXT NOT NULL CHECK (json_valid(payload)),
       FOREIGN KEY (business_id, user_id) REFERENCES users(business_id, id) ON DELETE RESTRICT,
       FOREIGN KEY (business_id, device_id) REFERENCES devices(business_id, id) ON DELETE RESTRICT
     ) STRICT`,
    `CREATE INDEX local_audit_by_shop ON local_audit(business_id, sequence)`,
    `CREATE TRIGGER local_audit_no_update BEFORE UPDATE ON local_audit
       BEGIN SELECT RAISE(ABORT, 'local audit is immutable'); END`,
    `CREATE TRIGGER local_audit_no_delete BEFORE DELETE ON local_audit
       BEGIN SELECT RAISE(ABORT, 'local audit is immutable'); END`,
  ],
};
