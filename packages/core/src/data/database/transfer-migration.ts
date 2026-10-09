import type { Migration } from "./migrations.ts";
/** Forward-only pairing progress: public proofs/opaque native references, never passwords or private keys. */
export const TRANSFER_MIGRATION:Migration={version:18,name:"trusted pairing and snapshot initialization",statements:[
 `CREATE TABLE pairing_invites(invite_id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
 digest TEXT NOT NULL,canonical TEXT NOT NULL CHECK(json_valid(canonical)),expires_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('issued','confirmed','cancelled')),request_digest TEXT,recipient_device_id TEXT) STRICT`,
 `CREATE TABLE workspace_enrollment(id INTEGER PRIMARY KEY CHECK(id=1),intent TEXT NOT NULL CHECK(json_valid(intent))) STRICT`,
]};
