import type { Migration } from "./migrations.ts";
/**
 * Forward-only tax, payment terms and notification state (ADR-033).
 *
 * Tax settings, product tax rules and payment terms are last-write-wins records carried by their own signed events, so
 * an older till keeps those events unapplied instead of rejecting a changed payload. Immutable ledgers are untouched:
 * due dates and tax amounts are derived. `notification_state` is this device's read/announced marks, never synced.
 */
export const TAX_TERMS_MIGRATION: Migration = {
  version: 28, name: "tax settings, payment terms and notification state", statements: [
    `CREATE TABLE shop_tax_settings (
       id                         TEXT    NOT NULL PRIMARY KEY,
       business_id                TEXT    NOT NULL UNIQUE REFERENCES businesses (id) ON DELETE RESTRICT,
       enabled                    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
       label                      TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 20),
       standard_rate_basis_points INTEGER NOT NULL CHECK (standard_rate_basis_points BETWEEN 0 AND 10000),
       registration               TEXT    CHECK (registration IS NULL OR length(registration) BETWEEN 1 AND 40),
       updated_at                 TEXT    NOT NULL,
       updated_by_device          TEXT    NOT NULL,
       CHECK (id = business_id)
     ) STRICT`,
    `CREATE TABLE product_tax_rules (
       id                TEXT    NOT NULL PRIMARY KEY REFERENCES products (id) ON DELETE RESTRICT,
       business_id       TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
       rule              TEXT    NOT NULL CHECK (rule IN ('STANDARD', 'EXEMPT', 'RATE')),
       rate_basis_points INTEGER CHECK (rate_basis_points IS NULL OR rate_basis_points BETWEEN 1 AND 10000),
       updated_at        TEXT    NOT NULL,
       updated_by_device TEXT    NOT NULL,
       CHECK ((rule = 'RATE') = (rate_basis_points IS NOT NULL))
     ) STRICT`,
    // A party's own terms are keyed by its ID; the shop defaults by "<business>:<party>".
    `CREATE TABLE payment_terms (
       id                TEXT    NOT NULL PRIMARY KEY,
       business_id       TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
       party             TEXT    NOT NULL CHECK (party IN ('CUSTOMER', 'SUPPLIER')),
       party_id          TEXT,
       days              INTEGER CHECK (days IS NULL OR days BETWEEN 0 AND 3650),
       updated_at        TEXT    NOT NULL,
       updated_by_device TEXT    NOT NULL,
       CHECK (days IS NOT NULL OR party_id IS NOT NULL),
       CHECK ((party_id IS NULL) = (id = business_id || ':' || party))
     ) STRICT`,
    `CREATE INDEX payment_terms_by_party ON payment_terms (business_id, party, party_id)`,
    `CREATE TABLE notification_state (
       business_id  TEXT NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
       user_id      TEXT NOT NULL,
       key          TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
       fingerprint  TEXT NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 200),
       read_at      TEXT,
       announced_at TEXT,
       PRIMARY KEY (business_id, user_id, key)
     ) STRICT`,
  ],
};
