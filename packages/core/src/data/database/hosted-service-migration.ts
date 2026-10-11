import type { Migration } from "./migrations.ts";
/**
 * Forward-only: what a connected server last said about this shop's hosted service (ADR-031), so the till can warn
 * before sync pauses and explain why it did. Local trading never reads it.
 */
export const HOSTED_SERVICE_MIGRATION: Migration = {
  version: 27, name: "hosted service status of connected servers", statements: [
    `ALTER TABLE server_endpoints ADD COLUMN service_status TEXT CHECK (service_status IS NULL OR service_status IN ('unlimited','active','grace','inactive'))`,
    `ALTER TABLE server_endpoints ADD COLUMN paid_until TEXT`,
    `ALTER TABLE server_endpoints ADD COLUMN grace_until TEXT`,
  ],
};
