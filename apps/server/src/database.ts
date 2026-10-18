import { Kysely, PostgresDialect, sql, type Generated } from "kysely";
import { CLEAR_EVENT_TYPES } from "@kolo/contracts/sync";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { Pool } from "pg";

/** Typed PostgreSQL schema. Every business table is keyed by `business_id`; repositories always bind it. */
export interface ServerDatabase {
  shops: { business_id: string; name: string; owner_id: string; enrolled_by: string; enrolled_at: Generated<Date>;
    status: Generated<"active" | "suspended" | "removed">; status_changed_at: Date | null; remove_after: Date | null; connection_code_id: string | null; paid_until: Date | null };
  shop_devices: { business_id: string; device_id: string; public_key: string; label: string; platform: string;
    authority_allowed: boolean; active: boolean; roster_revision: Generated<string>; updated_at: Generated<Date>; last_seen_at: Date | null };
  challenges: { challenge_id: string; purpose: "enrollment" | "session"; business_id: string; device_id: string; nonce: string; expires_at: Date; used_at: Date | null };
  sessions: { token_hash: string; business_id: string; device_id: string; created_at: Generated<Date>; expires_at: Date };
  /** Clear rows (`canonical`, `signature`, `event_type`) hold only trust, key and address facts; every other fact is `sealed` ciphertext. */
  journal: { seq: Generated<string>; business_id: string; event_id: string; origin_device_id: string; origin_sequence: string; event_type: string | null;
    event_version: number | null; canonical: string | null; digest: string; signature: string | null; sealed: string | null; subject_device_id: string | null; roster_revision: string | null;
    received_from: string; received_at: Generated<Date> };
  journal_conflicts: { id: Generated<string>; business_id: string; event_id: string; digest: string; canonical: string | null; signature: string | null; sealed: string | null; received_from: string; detected_at: Generated<Date> };
  push_batches: { business_id: string; batch_id: string; sender_device_id: string; digest: string; received_at: Generated<Date> };
  offered_batches: { business_id: string; batch_id: string; device_id: string; created_at: Date };
  offered_batch_events: { business_id: string; batch_id: string; event_id: string; digest: string };
  deliveries: { business_id: string; device_id: string; event_id: string; state: "stored" | "applied" | "deferred" | "unsupported"; updated_at: Generated<Date> };
  receipts: { business_id: string; receipt_id: string; device_id: string; digest: string; canonical: string; signature: string; received_at: Generated<Date> };
  connection_codes: { code_id: string; token_hash: string; label: string; created_by: string; created_at: Generated<Date>; expires_at: Date;
    used_at: Date | null; used_by: string | null; cancelled_at: Date | null; included_months: Generated<number>;
    /** Set for an owner-recovery code: it may only attach a restored owner device to this existing shop (ADR-036). */
    recovery_business_id: string | null };
  /** Short-lived pairing mailboxes (ADR-032); the server holds only signed or encrypted blobs, keyed by a hash of the code. */
  join_sessions: { join_id: string; business_id: string; owner_device_id: string; offer: unknown; request: unknown | null; enrollment: string | null; sealed_password: unknown | null;
    created_at: Generated<Date>; expires_at: Date };
  /** Append-only record of hosted payments; each one moves the shop's paid-until date forward. */
  payments: { payment_id: string; business_id: string; months: number; amount_minor: string; currency: "XAF"; method: "cash" | "mtn_momo" | "orange_money" | "bank" | "card" | "other";
    reference: string | null; source: "manual" | "webhook" | "code"; external_id: string | null; recorded_by: string; recorded_at: Generated<Date>; paid_until_before: Date | null; paid_until_after: Date };
  admins: { admin_id: string; username: string; role: "admin" | "viewer"; password_hash: string; totp_secret: string; totp_last_step: string | null;
    active: Generated<boolean>; failed_attempts: Generated<number>; locked_until: Date | null; created_at: Generated<Date>; last_login_at: Date | null };
  admin_sessions: { token_hash: string; admin_id: string; created_at: Generated<Date>; expires_at: Date; last_seen_at: Date; address: string };
  admin_audit: { id: Generated<string>; at: Generated<Date>; admin_id: string | null; username: string; action: string; target: string | null; address: string | null; detail: string | null };
}

/** Raises on any change to rows that record received facts. */
const immutable = (table: string) => [
  sql.raw(`CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION kolo_append_only()`),
  sql.raw(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION kolo_append_only()`),
];

/** Forward-only migrations, embedded so a deployed build carries the schema it expects. Never edit a shipped one. */
export const SERVER_MIGRATIONS: Readonly<Record<string, Migration>> = {
  "0001_relay": { async up(db) {
    for (const statement of [
      sql`CREATE FUNCTION kolo_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only table %', TG_TABLE_NAME; END $$`,
      sql`CREATE TABLE shops (
        business_id uuid PRIMARY KEY, name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
        owner_id uuid NOT NULL, enrolled_by uuid NOT NULL, enrolled_at timestamptz NOT NULL DEFAULT now())`,
      sql`CREATE TABLE shop_devices (
        business_id uuid NOT NULL REFERENCES shops (business_id), device_id uuid NOT NULL,
        public_key text NOT NULL CHECK (length(public_key) BETWEEN 1 AND 8192),
        label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
        platform text NOT NULL CHECK (platform IN ('ANDROID','IOS','DESKTOP','SERVER')),
        authority_allowed boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
        roster_revision bigint NOT NULL DEFAULT 0 CHECK (roster_revision >= 0), updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, device_id))`,
      sql`CREATE TABLE challenges (
        challenge_id uuid PRIMARY KEY, purpose text NOT NULL CHECK (purpose IN ('enrollment','session')),
        business_id uuid NOT NULL, device_id uuid NOT NULL, nonce text NOT NULL CHECK (nonce ~ '^[a-f0-9]{64}$'),
        expires_at timestamptz NOT NULL, used_at timestamptz)`,
      sql`CREATE INDEX challenges_expiry ON challenges (expires_at)`,
      sql`CREATE TABLE sessions (
        token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'), business_id uuid NOT NULL, device_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
        FOREIGN KEY (business_id, device_id) REFERENCES shop_devices (business_id, device_id))`,
      sql`CREATE INDEX sessions_expiry ON sessions (expires_at)`,
      sql`CREATE TABLE journal (
        seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE, business_id uuid NOT NULL REFERENCES shops (business_id),
        event_id uuid NOT NULL, origin_device_id uuid NOT NULL, origin_sequence bigint NOT NULL CHECK (origin_sequence > 0),
        event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80), event_version integer NOT NULL CHECK (event_version > 0),
        canonical text NOT NULL CHECK (octet_length(canonical) <= 1048576), digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
        signature text NOT NULL CHECK (signature ~ '^[a-f0-9]{128}$'),
        subject_device_id uuid, roster_revision bigint CHECK (roster_revision > 0), CHECK ((subject_device_id IS NULL) = (roster_revision IS NULL)),
        received_from uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, event_id), UNIQUE (business_id, origin_device_id, origin_sequence),
        FOREIGN KEY (business_id, origin_device_id) REFERENCES shop_devices (business_id, device_id),
        FOREIGN KEY (business_id, received_from) REFERENCES shop_devices (business_id, device_id))`,
      sql`CREATE INDEX journal_by_shop ON journal (business_id, seq)`,
      sql`CREATE INDEX journal_roster ON journal (business_id, subject_device_id, roster_revision) WHERE subject_device_id IS NOT NULL`,
      sql`CREATE TABLE journal_conflicts (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, business_id uuid NOT NULL REFERENCES shops (business_id),
        event_id uuid NOT NULL, digest text NOT NULL, canonical text NOT NULL, signature text NOT NULL, received_from uuid NOT NULL,
        detected_at timestamptz NOT NULL DEFAULT now(), UNIQUE (business_id, event_id, digest))`,
      sql`CREATE TABLE push_batches (
        business_id uuid NOT NULL REFERENCES shops (business_id), batch_id uuid NOT NULL, sender_device_id uuid NOT NULL,
        digest text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (business_id, batch_id))`,
      sql`CREATE TABLE offered_batches (
        business_id uuid NOT NULL, batch_id uuid NOT NULL, device_id uuid NOT NULL, created_at timestamptz NOT NULL,
        PRIMARY KEY (business_id, batch_id), FOREIGN KEY (business_id, device_id) REFERENCES shop_devices (business_id, device_id))`,
      sql`CREATE TABLE offered_batch_events (
        business_id uuid NOT NULL, batch_id uuid NOT NULL, event_id uuid NOT NULL, digest text NOT NULL,
        PRIMARY KEY (business_id, batch_id, event_id),
        FOREIGN KEY (business_id, batch_id) REFERENCES offered_batches (business_id, batch_id),
        FOREIGN KEY (business_id, event_id) REFERENCES journal (business_id, event_id))`,
      sql`CREATE TABLE deliveries (
        business_id uuid NOT NULL, device_id uuid NOT NULL, event_id uuid NOT NULL,
        state text NOT NULL CHECK (state IN ('stored','applied','deferred','unsupported')), updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, device_id, event_id),
        FOREIGN KEY (business_id, device_id) REFERENCES shop_devices (business_id, device_id),
        FOREIGN KEY (business_id, event_id) REFERENCES journal (business_id, event_id))`,
      sql`CREATE TABLE receipts (
        business_id uuid NOT NULL, receipt_id uuid NOT NULL, device_id uuid NOT NULL, digest text NOT NULL, canonical text NOT NULL,
        signature text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (business_id, receipt_id),
        FOREIGN KEY (business_id, device_id) REFERENCES shop_devices (business_id, device_id))`,
      ...immutable("journal"), ...immutable("journal_conflicts"), ...immutable("receipts"),
    ]) await statement.execute(db);
  } },
  /**
   * End-to-end encrypted sync and connection codes (ADR-030). Business facts become sealed ciphertext; only trust, key
   * and address facts may be stored clear. A database still holding F6a plaintext business facts is refused unless the
   * operator ran `migrate --discard-plaintext`, which deletes those facts (tills still hold them and send them again sealed).
   */
  "0002_sealed_sync_and_codes": { async up(db) {
    for (const statement of [
      sql.raw(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM journal WHERE event_type NOT IN (${clearTypes})) OR EXISTS (SELECT 1 FROM journal_conflicts WHERE (canonical::jsonb->>'event_type') NOT IN (${clearTypes})) THEN
          IF current_setting('kolo.discard_plaintext', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'plaintext business facts are stored; run "migrate --discard-plaintext" to delete them';
          END IF;
          ALTER TABLE journal DISABLE TRIGGER journal_append_only; ALTER TABLE journal_conflicts DISABLE TRIGGER journal_conflicts_append_only;
          DELETE FROM offered_batch_events o USING journal j WHERE o.business_id=j.business_id AND o.event_id=j.event_id AND j.event_type NOT IN (${clearTypes});
          DELETE FROM deliveries d USING journal j WHERE d.business_id=j.business_id AND d.event_id=j.event_id AND j.event_type NOT IN (${clearTypes});
          DELETE FROM journal WHERE event_type NOT IN (${clearTypes});
          DELETE FROM journal_conflicts WHERE (canonical::jsonb->>'event_type') NOT IN (${clearTypes});
          ALTER TABLE journal ENABLE TRIGGER journal_append_only; ALTER TABLE journal_conflicts ENABLE TRIGGER journal_conflicts_append_only;
        END IF;
      END $$`),
      sql`ALTER TABLE journal ADD COLUMN sealed jsonb`,
      sql`ALTER TABLE journal ALTER COLUMN canonical DROP NOT NULL, ALTER COLUMN signature DROP NOT NULL, ALTER COLUMN event_type DROP NOT NULL, ALTER COLUMN event_version DROP NOT NULL`,
      sql`ALTER TABLE journal ADD CONSTRAINT journal_clear_or_sealed CHECK (
        (sealed IS NULL AND canonical IS NOT NULL AND signature IS NOT NULL AND event_type IS NOT NULL AND event_version IS NOT NULL) OR
        (sealed IS NOT NULL AND canonical IS NULL AND signature IS NULL AND event_type IS NULL AND event_version IS NULL AND subject_device_id IS NULL))`,
      sql.raw(`ALTER TABLE journal ADD CONSTRAINT journal_clear_types CHECK (event_type IS NULL OR event_type IN (${clearTypes}))`),
      sql`ALTER TABLE journal ADD CONSTRAINT journal_sealed_size CHECK (sealed IS NULL OR octet_length(sealed::text) <= 1600000)`,
      sql`ALTER TABLE journal_conflicts ADD COLUMN sealed jsonb`,
      sql`ALTER TABLE journal_conflicts ALTER COLUMN canonical DROP NOT NULL, ALTER COLUMN signature DROP NOT NULL`,
      sql.raw(`ALTER TABLE journal_conflicts ADD CONSTRAINT journal_conflicts_clear_or_sealed CHECK (
        (sealed IS NULL AND canonical IS NOT NULL AND signature IS NOT NULL AND (canonical::jsonb->>'event_type') IN (${clearTypes})) OR
        (sealed IS NOT NULL AND canonical IS NULL AND signature IS NULL))`),
      sql`CREATE TABLE connection_codes (
        code_id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
        label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120), created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 120),
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
        used_at timestamptz, used_by uuid REFERENCES shops (business_id), cancelled_at timestamptz,
        CHECK ((used_at IS NULL) = (used_by IS NULL)), CHECK (used_at IS NULL OR cancelled_at IS NULL))`,
      sql`CREATE INDEX connection_codes_recent ON connection_codes (created_at DESC)`,
      sql`ALTER TABLE shops ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
        ADD COLUMN status_changed_at timestamptz, ADD COLUMN remove_after timestamptz,
        ADD COLUMN connection_code_id uuid REFERENCES connection_codes (code_id),
        ADD CONSTRAINT shops_removal CHECK ((status = 'removed') = (remove_after IS NOT NULL))`,
    ]) await statement.execute(db);
  } },
  /**
   * Operator administration (F6c): accounts with password and TOTP, short sessions and an append-only audit log.
   * Purging a removed shop is the one permitted deletion of append-only rows, inside a transaction that says so.
   */
  "0003_admin": { async up(db) {
    for (const statement of [
      sql`CREATE OR REPLACE FUNCTION kolo_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('journal','journal_conflicts','receipts') THEN
          IF OLD.business_id::text = current_setting('kolo.purging_shop', true) THEN RETURN OLD; END IF;
        END IF;
        RAISE EXCEPTION 'append-only table %', TG_TABLE_NAME; END $$`,
      sql`CREATE TABLE admins (
        admin_id uuid PRIMARY KEY, username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,64}$'),
        role text NOT NULL CHECK (role IN ('admin','viewer')), password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 32 AND 512),
        totp_secret text NOT NULL CHECK (totp_secret ~ '^[A-Z2-7]{32}$'), totp_last_step bigint,
        active boolean NOT NULL DEFAULT true, failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0), locked_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz)`,
      sql`CREATE TABLE admin_sessions (
        token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'), admin_id uuid NOT NULL REFERENCES admins (admin_id),
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
        address text NOT NULL CHECK (length(address) <= 64))`,
      sql`CREATE INDEX admin_sessions_expiry ON admin_sessions (expires_at)`,
      sql`CREATE TABLE admin_audit (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), admin_id uuid REFERENCES admins (admin_id),
        username text NOT NULL CHECK (length(username) BETWEEN 1 AND 64), action text NOT NULL CHECK (action ~ '^[a-z_.]{3,64}$'),
        target text CHECK (length(target) <= 200), address text CHECK (length(address) <= 64), detail jsonb CHECK (octet_length(detail::text) <= 4096))`,
      sql`CREATE INDEX admin_audit_recent ON admin_audit (at DESC)`,
      sql`ALTER TABLE shop_devices ADD COLUMN last_seen_at timestamptz`,
      ...immutable("admin_audit"),
    ]) await statement.execute(db);
  } },
  /**
   * Hosted subscriptions with manual billing (ADR-031): one plan per shop, a paid-until date moved forward by
   * append-only payments, and codes that may include paid months. Self-hosted servers ignore all of it.
   */
  "0004_hosted": { async up(db) {
    for (const statement of [
      sql`ALTER TABLE shops ADD COLUMN paid_until timestamptz`,
      sql`ALTER TABLE connection_codes ADD COLUMN included_months integer NOT NULL DEFAULT 0 CHECK (included_months BETWEEN 0 AND 36)`,
      sql`CREATE TABLE payments (
        payment_id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES shops (business_id),
        months integer NOT NULL CHECK (months BETWEEN 1 AND 36), amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
        currency text NOT NULL CHECK (currency = 'XAF'), method text NOT NULL CHECK (method IN ('cash','mtn_momo','orange_money','bank','card','other')),
        reference text CHECK (length(reference) <= 120), source text NOT NULL CHECK (source IN ('manual','webhook','code')),
        external_id text UNIQUE CHECK (length(external_id) BETWEEN 1 AND 200), recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 120),
        recorded_at timestamptz NOT NULL DEFAULT now(), paid_until_before timestamptz, paid_until_after timestamptz NOT NULL,
        CHECK (paid_until_before IS NULL OR paid_until_after > paid_until_before))`,
      sql`CREATE INDEX payments_by_shop ON payments (business_id, recorded_at DESC)`,
      sql`CREATE OR REPLACE FUNCTION kolo_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('journal','journal_conflicts','receipts','payments') THEN
          IF OLD.business_id::text = current_setting('kolo.purging_shop', true) THEN RETURN OLD; END IF;
        END IF;
        RAISE EXCEPTION 'append-only table %', TG_TABLE_NAME; END $$`,
      ...immutable("payments"),
    ]) await statement.execute(db);
  } },
  /** Join-by-code mailboxes (ADR-032): ten minutes, one per code, holding signed or encrypted pairing messages only. */
  "0005_join": { async up(db) {
    for (const statement of [
      sql`CREATE TABLE join_sessions (
        join_id text PRIMARY KEY CHECK (join_id ~ '^[a-f0-9]{64}$'), business_id uuid NOT NULL REFERENCES shops (business_id),
        owner_device_id uuid NOT NULL, offer jsonb NOT NULL, request jsonb, enrollment text, sealed_password jsonb,
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
        FOREIGN KEY (business_id, owner_device_id) REFERENCES shop_devices (business_id, device_id),
        CHECK ((enrollment IS NULL) = (sealed_password IS NULL)), CHECK (enrollment IS NULL OR request IS NOT NULL))`,
      sql`CREATE INDEX join_sessions_expiry ON join_sessions (expires_at)`,
    ]) await statement.execute(db);
  } },
  /**
   * Owner recovery (ADR-036): an operator-issued code bound to one existing shop attaches a restored owner device after
   * every till was lost. Ordinary codes still only create shops.
   */
  "0006_recovery": { async up(db) {
    await sql`ALTER TABLE connection_codes ADD COLUMN recovery_business_id uuid REFERENCES shops (business_id)`.execute(db);
  } },
  /** Pull offers a shop's clear trust and key facts before its sealed backlog, so a new till reaches its key grant first. */
  "0007_clear_first": { async up(db) {
    await sql`CREATE INDEX journal_clear_by_shop ON journal (business_id, seq) WHERE sealed IS NULL`.execute(db);
  } },
};

const provider: MigrationProvider = { getMigrations: async () => ({ ...SERVER_MIGRATIONS }) };

const clearTypes = CLEAR_EVENT_TYPES.map(type => `'${type}'`).join(",");

/** Opens a bounded pool with connection and statement deadlines. */
export function openDatabase(url: string): Kysely<ServerDatabase> {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 10_000, statement_timeout: 10_000, max: 10 });
  // An idle PostgreSQL connection can fail between requests. Never log credentials.
  pool.on("error", () => { process.stderr.write("PostgreSQL connection unavailable\n"); });
  return new Kysely<ServerDatabase>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Applies pending migrations in order inside Kysely's migration lock; refuses unknown newer ones. `discardPlaintext`
 * lets migration 0002 delete F6a plaintext business facts; it is set on the one connection the migrations run on.
 */
export async function migrateToLatest(db: Kysely<ServerDatabase>, options: { readonly discardPlaintext?: boolean } = {}): Promise<readonly string[]> {
  return db.connection().execute(async connection => {
    await sql`SELECT set_config('kolo.discard_plaintext', ${options.discardPlaintext === true ? "on" : "off"}, false)`.execute(connection);
    try {
      const { error, results } = await new Migrator({ db: connection, provider }).migrateToLatest();
      if (error !== undefined) throw new Error("migration failed", { cause: error });
      return (results ?? []).filter(result => result.status === "Success").map(result => result.migrationName);
    } finally { await sql`SELECT set_config('kolo.discard_plaintext', 'off', false)`.execute(connection); }
  });
}

/** True only when every embedded migration has been applied. */
export async function schemaCurrent(db: Kysely<ServerDatabase>): Promise<boolean> {
  const migrations = await new Migrator({ db, provider }).getMigrations();
  return migrations.every(migration => migration.executedAt !== undefined);
}
