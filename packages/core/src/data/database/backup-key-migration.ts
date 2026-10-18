import type { Migration } from "./migrations.ts";
/**
 * Shop backup recovery keys (ADR-036): the public halves the owner pinned through signed `SHOP_BACKUP_KEY` facts.
 * Business data, so snapshots carry it; the secret is never stored anywhere.
 */
export const BACKUP_KEY_MIGRATION:Migration={version:30,name:"shop backup recovery keys",statements:[
  `CREATE TABLE backup_recovery_keys (
     business_id TEXT NOT NULL,
     key_id      TEXT NOT NULL CHECK (length(key_id) = 32 AND key_id NOT GLOB '*[^0-9a-f]*'),
     version     INTEGER NOT NULL CHECK (version > 0),
     public_key  TEXT NOT NULL CHECK (length(public_key) = 64 AND public_key NOT GLOB '*[^0-9a-f]*'),
     created_at  TEXT NOT NULL,
     device_id   TEXT NOT NULL,
     event_id    TEXT NOT NULL UNIQUE,
     PRIMARY KEY (business_id, key_id),
     FOREIGN KEY (business_id) REFERENCES businesses (id)
   ) STRICT`,
  `CREATE INDEX backup_recovery_keys_current ON backup_recovery_keys (business_id, version DESC, key_id DESC)`,
]};
