import type { Migration } from "./migrations.ts";

/** Append-only v2 facts/signatures plus mutable, destination-scoped delivery/application state. */
export const EVENT_JOURNAL_MIGRATION: Migration = {
  version: 17,
  name: "immutable event journal and destination delivery",
  statements: [
    `CREATE TABLE journal_origins (
      business_id TEXT NOT NULL REFERENCES businesses(id), device_id TEXT NOT NULL,
      next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence BETWEEN 1 AND 9007199254740991),
      PRIMARY KEY(business_id,device_id), FOREIGN KEY(business_id,device_id) REFERENCES devices(business_id,id)
    ) STRICT`,
    `CREATE TABLE event_journal (
      event_id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      origin_device_id TEXT NOT NULL, actor_id TEXT NOT NULL, origin_sequence INTEGER NOT NULL CHECK(origin_sequence BETWEEN 1 AND 9007199254740991),
      event_type TEXT NOT NULL, event_version INTEGER NOT NULL CHECK(event_version > 0),
      occurred_at TEXT NOT NULL, authority_revision INTEGER NOT NULL CHECK(authority_revision > 0),
      canonical TEXT NOT NULL CHECK(json_valid(canonical)), provenance TEXT NOT NULL CHECK(provenance IN ('local','received')),
      UNIQUE(business_id,origin_device_id,origin_sequence), UNIQUE(business_id,event_id)
    ) STRICT`,
    `CREATE INDEX journal_by_shop_origin ON event_journal(business_id,origin_device_id,origin_sequence)`,
    `CREATE TABLE event_signatures (
      event_id TEXT PRIMARY KEY REFERENCES event_journal(event_id),
      digest TEXT NOT NULL CHECK(length(digest)=64), signature TEXT NOT NULL CHECK(length(signature)=128),
      public_key TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE applied_events (
      event_id TEXT PRIMARY KEY REFERENCES event_journal(event_id), business_id TEXT NOT NULL REFERENCES businesses(id),
      status TEXT NOT NULL CHECK(status IN ('stored','applied','deferred','quarantined','unsupported')),
      reason TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), updated_at TEXT NOT NULL,
      FOREIGN KEY(business_id,event_id) REFERENCES event_journal(business_id,event_id)
    ) STRICT`,
    `CREATE TABLE journal_entity_claims (
      table_name TEXT NOT NULL, entity_id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES event_journal(event_id),
      business_id TEXT NOT NULL, PRIMARY KEY(table_name,entity_id),
      FOREIGN KEY(business_id,event_id) REFERENCES event_journal(business_id,event_id)
    ) STRICT`,
    `CREATE TABLE trusted_exchange_devices (
      business_id TEXT NOT NULL, device_id TEXT NOT NULL, public_key TEXT NOT NULL,
      authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK(authority_allowed IN (0,1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      approved_by TEXT NOT NULL, PRIMARY KEY(business_id,device_id),
      FOREIGN KEY(business_id,device_id) REFERENCES devices(business_id,id),
      FOREIGN KEY(business_id,approved_by) REFERENCES users(business_id,id)
    ) STRICT`,
    `INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by)
      SELECT business_id,device_id,public_key,1,owner_id FROM local_installation`,
    `CREATE TABLE exchange_destinations (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL, receiver_device_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('peer','server')), label TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), UNIQUE(business_id,id),
      FOREIGN KEY(business_id,receiver_device_id) REFERENCES trusted_exchange_devices(business_id,device_id)
    ) STRICT`,
    `CREATE TABLE event_deliveries (
      business_id TEXT NOT NULL, destination_id TEXT NOT NULL, event_id TEXT NOT NULL,
      offered_at TEXT, acknowledged_at TEXT, state TEXT NOT NULL CHECK(state IN ('offered','stored','applied','deferred','unsupported')),
      receipt_id TEXT, PRIMARY KEY(destination_id,event_id),
      FOREIGN KEY(business_id,destination_id) REFERENCES exchange_destinations(business_id,id),
      FOREIGN KEY(business_id,event_id) REFERENCES event_journal(business_id,event_id)
    ) STRICT`,
    `CREATE TABLE import_batches (
      batch_id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), sender_device_id TEXT NOT NULL,
      receiver_device_id TEXT NOT NULL, content_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('processing','complete')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE import_batch_events (
      batch_id TEXT NOT NULL REFERENCES import_batches(batch_id), event_id TEXT NOT NULL, digest TEXT NOT NULL,
      outcome TEXT NOT NULL, PRIMARY KEY(batch_id,event_id)
    ) STRICT`,
    `CREATE TABLE exchange_conflicts (
      business_id TEXT NOT NULL REFERENCES businesses(id), event_id TEXT NOT NULL,
      digest TEXT NOT NULL, canonical TEXT NOT NULL CHECK(json_valid(canonical)),
      signature TEXT NOT NULL, public_key TEXT NOT NULL, detected_at TEXT NOT NULL,
      PRIMARY KEY(business_id,event_id,digest)
    ) STRICT`,
    `CREATE TABLE offered_batches (
      batch_id TEXT PRIMARY KEY, business_id TEXT NOT NULL, destination_id TEXT NOT NULL,
      content_digest TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(business_id,destination_id) REFERENCES exchange_destinations(business_id,id)
    ) STRICT`,
    `CREATE TABLE offered_batch_events (
      batch_id TEXT NOT NULL REFERENCES offered_batches(batch_id), event_id TEXT NOT NULL REFERENCES event_journal(event_id),
      digest TEXT NOT NULL, PRIMARY KEY(batch_id,event_id)
    ) STRICT`,
    `CREATE TABLE peer_receipts (
      receipt_id TEXT PRIMARY KEY, business_id TEXT NOT NULL, destination_id TEXT NOT NULL,
      digest TEXT NOT NULL, canonical TEXT NOT NULL CHECK(json_valid(canonical)), signature TEXT NOT NULL,
      received_at TEXT NOT NULL, FOREIGN KEY(business_id,destination_id) REFERENCES exchange_destinations(business_id,id)
    ) STRICT`,
    `CREATE TABLE event_reviews (
      event_id TEXT PRIMARY KEY REFERENCES event_journal(event_id), reviewer_id TEXT NOT NULL,
      business_id TEXT NOT NULL, digest TEXT NOT NULL, reviewed_at TEXT NOT NULL,
      FOREIGN KEY(business_id,reviewer_id) REFERENCES users(business_id,id)
    ) STRICT`,
    `CREATE TABLE legacy_event_archive (
      event_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('outbox','inbox')),
      business_id TEXT NOT NULL, original TEXT NOT NULL CHECK(json_valid(original)),
      PRIMARY KEY(event_id,direction)
    ) STRICT`,
    `INSERT INTO legacy_event_archive(event_id,direction,business_id,original)
      SELECT event_id,'outbox',business_id,json_object('event_id',event_id,'business_id',business_id,'user_id',user_id,
      'device_id',device_id,'type',type,'payload',json(payload),'occurred_at',occurred_at,'sequence',sequence,
      'state',state,'attempts',attempts,'last_error',last_error,'delivered_at',delivered_at) FROM sync_outbox`,
    `INSERT INTO legacy_event_archive(event_id,direction,business_id,original)
      SELECT event_id,'inbox',business_id,json_object('event_id',event_id,'business_id',business_id,'user_id',user_id,
      'device_id',device_id,'type',type,'payload',json(payload),'occurred_at',occurred_at,'server_sequence',server_sequence,
      'state',state,'attempts',attempts,'last_error',last_error) FROM sync_inbox`,
    `CREATE TABLE legacy_baselines (
      business_id TEXT PRIMARY KEY REFERENCES businesses(id), provenance TEXT NOT NULL CHECK(provenance='unsigned_v1_snapshot'),
      outbox_count INTEGER NOT NULL, inbox_count INTEGER NOT NULL, outbox_next INTEGER NOT NULL, audit_watermark INTEGER NOT NULL
    ) STRICT`,
    `INSERT INTO legacy_baselines SELECT b.id,'unsigned_v1_snapshot',
      (SELECT count(*) FROM sync_outbox o WHERE o.business_id=b.id),
      (SELECT count(*) FROM sync_inbox i WHERE i.business_id=b.id),
      (SELECT next FROM sync_sequence WHERE id=1),
      (SELECT coalesce(max(sequence),0) FROM local_audit a WHERE a.business_id=b.id) FROM businesses b`,
    ...["event_journal", "event_signatures", "journal_entity_claims", "peer_receipts", "event_reviews", "legacy_event_archive", "legacy_baselines", "exchange_conflicts", "offered_batches", "offered_batch_events"].flatMap(table => [
      `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable exchange fact'); END`,
      `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable exchange fact'); END`,
    ]),
    `CREATE TRIGGER applied_events_keep_identity BEFORE DELETE ON applied_events BEGIN SELECT RAISE(ABORT,'permanent applied identity'); END`,
    `CREATE TRIGGER applied_events_keep_application BEFORE UPDATE ON applied_events WHEN OLD.status='applied'
      BEGIN SELECT RAISE(ABORT,'application is final'); END`,
  ],
};
