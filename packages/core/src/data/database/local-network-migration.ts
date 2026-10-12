import type { Migration } from "./migrations.ts";
/** Per-installation local network settings and direct-peer delivery status; never copied into backups/pairing snapshots. */
export const LOCAL_NETWORK_MIGRATION:Migration={version:29,name:"direct local network pairing and sync",statements:[
  `CREATE TABLE local_network_listener (id INTEGER PRIMARY KEY CHECK(id=1),port INTEGER NOT NULL CHECK(port BETWEEN 1024 AND 65535),enabled INTEGER NOT NULL CHECK(enabled IN(0,1))) STRICT`,
  `CREATE TABLE local_peer_connections (business_id TEXT NOT NULL,device_id TEXT NOT NULL,url TEXT,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),last_attempt_at TEXT,last_success_at TEXT,last_error TEXT,PRIMARY KEY(business_id,device_id),FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE RESTRICT) STRICT`
]};
