import type { Migration } from "./migrations.ts";

const immutable = (table: string): string[] => [
  `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable exchange fact'); END`,
  `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable exchange fact'); END`,
];
// The largest unit price × quantity (thousandths) whose rounded line total is still a safe integer; anything above
// overflows SQLite's 64-bit arithmetic in report SQL. The shared rules already refuse it; this guards every writer.
const LINE_PRODUCT_LIMIT = "9007199254740991000";

/**
 * Forward-only review and acceptance policy (ADR-040–042):
 * - `accepted_through`/`accepted_revision`: how far the owner accepted a revoked device's history
 *   (`DEVICE_HISTORY_ACCEPTED`); later facts wait for review instead of being refused.
 * - `event_exception_reviews`: the owner's approval of one exact fact for a reason the older `event_reviews` (authority
 *   only) does not cover: a revoked device beyond its cutoff, or a return that raced another.
 * - `return_fork_links`: the predecessor an approved concurrent return was signed against, when the local chain had
 *   to link it after a different return.
 * - `membership_revisions`: each member's role, overrides and state as they stood at every earlier revision, captured
 *   by trigger whenever a revision changes, so a fact signed under an older revision is judged by what it allowed.
 * - Line product guards on sale and delivery lines.
 */
export const REVIEW_POLICY_MIGRATION: Migration = {
  version: 34, name: "revoked history, exception reviews and membership revisions", statements: [
    `ALTER TABLE trusted_exchange_devices ADD COLUMN accepted_through INTEGER NOT NULL DEFAULT 0 CHECK (accepted_through >= 0)`,
    `ALTER TABLE trusted_exchange_devices ADD COLUMN accepted_revision INTEGER NOT NULL DEFAULT 0 CHECK (accepted_revision >= 0)`,
    `CREATE TABLE event_exception_reviews (
      event_id TEXT NOT NULL REFERENCES event_journal(event_id), kind TEXT NOT NULL CHECK (kind IN ('device_revoked','return_conflict')),
      business_id TEXT NOT NULL, reviewer_id TEXT NOT NULL, digest TEXT NOT NULL, reviewed_at TEXT NOT NULL,
      PRIMARY KEY (event_id, kind), FOREIGN KEY (business_id, reviewer_id) REFERENCES users(business_id, id)
    ) STRICT`,
    ...immutable("event_exception_reviews"),
    `CREATE TABLE return_fork_links (
      business_id TEXT NOT NULL, return_id TEXT NOT NULL, signed_prior_key TEXT NOT NULL,
      PRIMARY KEY (business_id, return_id), FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id)
    ) STRICT`,
    ...immutable("return_fork_links"),
    `CREATE TABLE membership_revisions (
      business_id TEXT NOT NULL, user_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
      role TEXT NOT NULL, custom_role_id TEXT, granted TEXT NOT NULL, revoked TEXT NOT NULL, active INTEGER NOT NULL CHECK (active IN (0,1)),
      PRIMARY KEY (business_id, user_id, revision)
    ) STRICT`,
    `CREATE TRIGGER membership_revision_history BEFORE UPDATE OF revision ON local_memberships WHEN NEW.revision <> OLD.revision
      BEGIN INSERT OR IGNORE INTO membership_revisions(business_id,user_id,revision,role,custom_role_id,granted,revoked,active)
        VALUES (OLD.business_id,OLD.user_id,OLD.revision,OLD.role,OLD.custom_role_id,OLD.granted,OLD.revoked,OLD.active); END`,
    ...["sale_items:unit_price_minor", "purchase_items:unit_cost_minor"].map(entry => {
      const [table, price] = entry.split(":");
      return `CREATE TRIGGER ${table}_line_limit BEFORE INSERT ON ${table} WHEN NEW.quantity > 0 AND NEW.${price} > ${LINE_PRODUCT_LIMIT} / NEW.quantity
        BEGIN SELECT RAISE(ABORT,'line total out of range'); END`;
    }),
  ],
};
