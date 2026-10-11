import type { Migration } from "./migrations.ts";
/**
 * Forward-only end-to-end encrypted sync (ADR-030): each device's X25519 key, owner grants of shop keys sealed
 * to those keys, the shop's chosen server address, and how this device came to be connected. Shop keys are
 * never stored in the clear: a device re-opens its own grants with the private key held by its native vault.
 */
export const SEALED_SYNC_MIGRATION: Migration = {
  version: 26, name: "end-to-end encrypted sync and shared server address", statements: [
    `CREATE TABLE device_encryption_keys (
       business_id TEXT NOT NULL, device_id TEXT NOT NULL,
       public_key  TEXT NOT NULL CHECK (length(public_key) BETWEEN 1 AND 1024),
       event_id    TEXT NOT NULL,
       PRIMARY KEY (business_id, device_id),
       FOREIGN KEY (business_id, device_id) REFERENCES devices (business_id, id)
     ) STRICT`,
    `CREATE TABLE shop_key_grants (
       business_id TEXT NOT NULL, key_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK (epoch > 0), device_id TEXT NOT NULL,
       sealed      TEXT NOT NULL CHECK (length(sealed) BETWEEN 1 AND 4096),
       event_id    TEXT NOT NULL,
       PRIMARY KEY (business_id, key_id, device_id),
       FOREIGN KEY (business_id, device_id) REFERENCES devices (business_id, id)
     ) STRICT`,
    `CREATE INDEX shop_key_grants_by_epoch ON shop_key_grants (business_id, epoch, key_id)`,
    `CREATE TABLE shop_server_endpoint (
       business_id      TEXT PRIMARY KEY, server_device_id TEXT NOT NULL,
       url              TEXT CHECK (url IS NULL OR length(url) BETWEEN 8 AND 2048),
       fingerprint      TEXT CHECK (fingerprint IS NULL OR length(fingerprint) = 32),
       revision         INTEGER NOT NULL CHECK (revision > 0),
       CHECK ((url IS NULL) = (fingerprint IS NULL))
     ) STRICT`,
    // A person on this device chose to stop syncing with the shop's server; automatic connection respects it.
    `CREATE TABLE server_endpoint_declined (
       business_id TEXT NOT NULL, server_device_id TEXT NOT NULL, declined_at TEXT NOT NULL,
       PRIMARY KEY (business_id, server_device_id)
     ) STRICT`,
    `ALTER TABLE server_endpoints ADD COLUMN source TEXT NOT NULL DEFAULT 'code' CHECK (source IN ('code', 'shop'))`,
  ],
};
