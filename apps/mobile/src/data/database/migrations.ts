/**
 * The local schema and how a device gets to it.
 *
 * Migrations are forward-only and run from wherever a device happens to be. One
 * that has been offline for months arrives several versions behind, so the
 * runner steps through every migration it has not applied rather than assuming
 * it is one behind (ADR-014).
 *
 * There are no down migrations. There is no operator on a device to run one,
 * and rolling back would discard business records the server has not yet seen.
 */

import { DatabaseError, type Database, type Queryable } from "./driver.ts";

/** One step of the schema's history. */
export interface Migration {
  /** Version this migration brings the schema to. Sequential from 1. */
  readonly version: number;
  /** What it does, for logs and for reading the history. */
  readonly name: string;
  /** Statements to run, in order. */
  readonly statements: readonly string[];
}

/**
 * The schema's history, in order.
 *
 * A migration here is permanent once released: a device in the field has
 * already applied it, and editing it would mean two devices disagree about what
 * version 1 was. Changes are made by appending.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "tenant, users and devices",
    statements: [
      // The tenant. A device holds exactly one business's data, but the column
      // is present on every table anyway: it keeps the local schema shaped like
      // the server's, and makes a query that forgot its tenant a bug that shows
      // up locally rather than only after sync.
      `CREATE TABLE businesses (
         id          TEXT    PRIMARY KEY,
         name        TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
         currency    TEXT    NOT NULL CHECK (length(currency) = 3),
         active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
         created_at  TEXT    NOT NULL,
         updated_at  TEXT    NOT NULL,
         CHECK (updated_at >= created_at)
       ) STRICT`,

      `CREATE TABLE branches (
         id          TEXT    PRIMARY KEY,
         business_id TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         name        TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
         active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
         created_at  TEXT    NOT NULL,
         updated_at  TEXT    NOT NULL,
         CHECK (updated_at >= created_at)
       ) STRICT`,

      `CREATE INDEX branches_by_business ON branches (business_id, name)`,

      `CREATE TABLE users (
         id          TEXT    NOT NULL PRIMARY KEY,
         business_id TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         branch_id   TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
         name        TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
         role        TEXT    NOT NULL
                             CHECK (role IN ('OWNER', 'MANAGER', 'CASHIER', 'INVENTORY', 'ACCOUNTANT')),
         -- Permission overrides arrive from the server as JSON arrays. SQLite
         -- has no array type, and these are read whole rather than queried
         -- into, so JSON is the honest representation.
         granted     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(granted)),
         revoked     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(revoked)),
         active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
         created_at  TEXT    NOT NULL,
         updated_at  TEXT    NOT NULL,
         CHECK (updated_at >= created_at)
       ) STRICT`,

      `CREATE INDEX users_by_business ON users (business_id, name)`,

      `CREATE TABLE devices (
         id           TEXT    PRIMARY KEY,
         business_id  TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         branch_id    TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
         label        TEXT    NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
         platform     TEXT    NOT NULL CHECK (platform IN ('ANDROID', 'IOS', 'WEB', 'DESKTOP')),
         active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
         created_at   TEXT    NOT NULL,
         updated_at   TEXT    NOT NULL,
         last_seen_at TEXT    NOT NULL,
         CHECK (updated_at >= created_at)
       ) STRICT`,
    ],
  },

  {
    version: 2,
    name: "the sync outbox",
    statements: [
      // The queue of events waiting to reach the server.
      //
      // Appended in the same transaction as the business rows it describes, so
      // a device can never hold a sale the server will never hear about
      // (ADR-014). This table is the queue: there is no in-memory copy to lose
      // on a crash.
      `CREATE TABLE sync_outbox (
         -- The globally unique identifier the server deduplicates on, so a
         -- retry after an unacknowledged push is safe (ADR-006).
         event_id     TEXT    PRIMARY KEY,
         business_id  TEXT    NOT NULL,
         -- Who and what device the event happened on, for audit and conflict
         -- resolution on the server (§27, §28, §39).
         user_id      TEXT    NOT NULL,
         device_id    TEXT    NOT NULL,
         type         TEXT    NOT NULL CHECK (length(trim(type)) > 0),
         payload      TEXT    NOT NULL CHECK (json_valid(payload)),
         -- When the business event happened, not when it was queued. A device
         -- offline for days sends events whose timestamps are days old, and
         -- those are the true ones.
         occurred_at  TEXT    NOT NULL,
         -- Monotonic within this device, giving the order the outbox drains in.
         sequence     INTEGER NOT NULL,
         -- Delivery state. Rows are appended and then only ever move forward
         -- through these: nothing goes back to pending once acknowledged.
         state        TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending', 'delivered', 'rejected')),
         attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
         last_error   TEXT,
         delivered_at TEXT,
         CHECK (state <> 'delivered' OR delivered_at IS NOT NULL)
       ) STRICT`,

      // Draining reads the pending rows in order; this is the query that runs
      // on every sync attempt.
      `CREATE INDEX sync_outbox_pending ON sync_outbox (state, sequence)`,

      // Sequence numbers are handed out from here rather than from a rowid, so
      // that pruning delivered rows cannot make the next event look older than
      // one already sent.
      `CREATE TABLE sync_sequence (
         id       INTEGER PRIMARY KEY CHECK (id = 1),
         next     INTEGER NOT NULL DEFAULT 1 CHECK (next >= 1)
       ) STRICT`,

      `INSERT INTO sync_sequence (id, next) VALUES (1, 1)`,

      // What this device has received from the server, so a pull resumes rather
      // than starting again after a multi-day gap (§45).
      `CREATE TABLE sync_state (
         id            INTEGER PRIMARY KEY CHECK (id = 1),
         last_pulled_at TEXT,
         cursor         TEXT
       ) STRICT`,

      `INSERT INTO sync_state (id) VALUES (1)`,
    ],
  },

  {
    version: 3,
    name: "products and the stock ledger",
    statements: [
      `CREATE TABLE categories (
         id          TEXT    PRIMARY KEY,
         business_id TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         name        TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
         active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
         created_at  TEXT    NOT NULL,
         updated_at  TEXT    NOT NULL,
         CHECK (updated_at >= created_at)
       ) STRICT`,

      `CREATE TABLE products (
         id                    TEXT    PRIMARY KEY,
         business_id           TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         category_id           TEXT    REFERENCES categories (id) ON DELETE RESTRICT,
         name                  TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
         -- Both optional: a shopkeeper entering stock at the till has neither
         -- yet, and requiring them would stop the sale.
         sku                   TEXT,
         barcode               TEXT,
         description           TEXT,
         brand                 TEXT,
         unit                  TEXT    NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 24),
         divisible             INTEGER NOT NULL DEFAULT 0 CHECK (divisible IN (0, 1)),
         -- Null when the business does not yet know what it paid. A guess
         -- would be worse than an honest gap.
         purchase_price_minor  INTEGER CHECK (purchase_price_minor IS NULL OR purchase_price_minor >= 0),
         selling_price_minor   INTEGER NOT NULL CHECK (selling_price_minor >= 0),
         currency              TEXT    NOT NULL CHECK (length(currency) = 3),
         tax_rate_basis_points INTEGER NOT NULL DEFAULT 0
                                       CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
         minimum_stock         INTEGER NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
         active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
         created_at            TEXT    NOT NULL,
         updated_at            TEXT    NOT NULL,
         CHECK (updated_at >= created_at),
         -- A product sold whole cannot have a reorder point of half a unit.
         CHECK (divisible = 1 OR minimum_stock % 1000 = 0)
       ) STRICT`,

      // Codes identify a product within one business, not globally: two shops
      // may each sell the same manufacturer's barcode.
      `CREATE UNIQUE INDEX products_sku_per_business
         ON products (business_id, sku) WHERE sku IS NOT NULL`,
      `CREATE UNIQUE INDEX products_barcode_per_business
         ON products (business_id, barcode) WHERE barcode IS NOT NULL`,
      // Product search must be fast on cheap hardware (§46).
      `CREATE INDEX products_by_business ON products (business_id, name)`,

      `CREATE TABLE inventory_movements (
         id                 TEXT    PRIMARY KEY,
         business_id        TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         branch_id          TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
         product_id         TEXT    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
         type               TEXT    NOT NULL
                                    CHECK (type IN ('PURCHASE', 'SALE', 'SALE_RETURN',
                                                    'PURCHASE_RETURN', 'DAMAGE', 'ADJUSTMENT',
                                                    'STOCK_COUNT', 'TRANSFER_OUT', 'TRANSFER_IN',
                                                    'OPENING_BALANCE')),
         -- Signed thousandths: positive adds stock, negative removes it, so
         -- summing the ledger is plain addition.
         quantity           INTEGER NOT NULL CHECK (quantity <> 0),
         unit_cost_minor    INTEGER CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
         unit_cost_currency TEXT,
         reference_kind     TEXT,
         reference_id       TEXT,
         reason             TEXT,
         user_id            TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
         device_id          TEXT    NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
         -- When the stock actually moved. On a device offline for days that is
         -- days ago, and reports slice on it.
         occurred_at        TEXT    NOT NULL,
         -- When this row was written. Deliberately a separate column.
         recorded_at        TEXT    NOT NULL,

         -- A sign contradicting the type is a mistake caught here rather than
         -- as an inexplicable stock level weeks later. Corrections go either
         -- way, because a count can find more or less than the ledger says.
         CHECK (
           (type IN ('PURCHASE', 'SALE_RETURN', 'TRANSFER_IN', 'OPENING_BALANCE') AND quantity > 0)
           OR (type IN ('SALE', 'PURCHASE_RETURN', 'DAMAGE', 'TRANSFER_OUT') AND quantity < 0)
           OR type IN ('ADJUSTMENT', 'STOCK_COUNT')
         ),
         -- Corrections and write-offs are where stock changes with no sale or
         -- delivery to explain it.
         CHECK (type NOT IN ('ADJUSTMENT', 'STOCK_COUNT', 'DAMAGE')
                OR length(trim(coalesce(reason, ''))) > 0),
         CHECK (type NOT IN ('PURCHASE', 'SALE', 'SALE_RETURN', 'PURCHASE_RETURN',
                             'TRANSFER_IN', 'TRANSFER_OUT')
                OR (reference_kind IS NOT NULL AND reference_id IS NOT NULL)),
         CHECK ((reference_kind IS NULL) = (reference_id IS NULL)),
         CHECK ((unit_cost_minor IS NULL) = (unit_cost_currency IS NULL))
       ) STRICT`,

      // Deriving stock is the query this table exists to serve.
      `CREATE INDEX inventory_movements_for_stock
         ON inventory_movements (business_id, product_id, occurred_at)`,

      // The ledger is append-only, enforced here as it is on the server. The
      // repository offers no way to edit a movement, but a future screen, a
      // migration, or a support build could reach the table directly, and a
      // correction must be another movement (§41, ADR-009).
      `CREATE TRIGGER inventory_movements_no_update
         BEFORE UPDATE ON inventory_movements
       BEGIN
         SELECT RAISE(ABORT, 'inventory_movements is append-only: record a correcting movement');
       END`,
      `CREATE TRIGGER inventory_movements_no_delete
         BEFORE DELETE ON inventory_movements
       BEGIN
         SELECT RAISE(ABORT, 'inventory_movements is append-only: record a correcting movement');
       END`,
    ],
  },

  {
    version: 4,
    name: "the sync inbox",
    statements: [
      // Events pulled from other devices, held before they are applied.
      //
      // A pull cannot simply apply what it receives and move on. Events arrive
      // in the order the server learned of them, and a movement can reach this
      // device before the product it moves — a till selling something the
      // owner's phone created while both were offline. Applying that fails, and
      // neither dropping it nor blocking every event behind it is acceptable.
      //
      // So an arrival is durable first and applied second. The cursor advances
      // once the event is safely here, and a deferred event is retried on later
      // syncs, when whatever it was waiting for has usually arrived.
      `CREATE TABLE sync_inbox (
         event_id        TEXT    PRIMARY KEY,
         business_id     TEXT    NOT NULL,
         device_id       TEXT    NOT NULL,
         user_id         TEXT    NOT NULL,
         type            TEXT    NOT NULL,
         payload         TEXT    NOT NULL CHECK (json_valid(payload)),
         occurred_at     TEXT    NOT NULL,
         -- The server's sequence, which orders events across every device. A
         -- device's own sequence means nothing here.
         server_sequence INTEGER NOT NULL,
         received_at     TEXT    NOT NULL,
         state           TEXT    NOT NULL DEFAULT 'deferred'
                                 CHECK (state IN ('deferred', 'applied', 'unusable')),
         attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
         last_error      TEXT,
         applied_at      TEXT,

         CHECK ((state = 'applied') = (applied_at IS NOT NULL))
       ) STRICT`,

      // Finding what still needs applying is the query this table exists for.
      `CREATE INDEX sync_inbox_deferred ON sync_inbox (state, server_sequence)`,
    ],
  },

  {
    version: 5,
    name: "product conflict resolution",
    statements: [
      // Which device made the last edit, used only to break a tie between two
      // edits stamped the same instant (ADR-015).
      //
      // Last-write-wins needs a total order, and a timestamp alone is not one.
      // Breaking a tie by arrival order would let two devices holding the same
      // two edits settle on different prices — permanently, silently, and with
      // nothing able to detect it. The device identifier is arbitrary but
      // deterministic, which is the property that matters.
      //
      // Nullable for rows written before this, and a null sorts below any
      // device, so a real edit always beats one from before the column existed.
      `ALTER TABLE products ADD COLUMN updated_by_device TEXT
         REFERENCES devices (id) ON DELETE RESTRICT`,
    ],
  },

  {
    version: 6,
    name: "sales, their lines and their payments",
    statements: [
      `CREATE TABLE sales (
         id             TEXT    PRIMARY KEY,
         business_id    TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         branch_id      TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
         -- Optional: a cash sale at a till names nobody (§12). Required only
         -- when something is still owed, which the application enforces
         -- because it needs the payments to know.
         customer_id    TEXT,
         -- What the receipt says. For people; the system uses the identifier.
         number         TEXT    NOT NULL CHECK (length(trim(number)) BETWEEN 1 AND 120),
         discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
         currency       TEXT    NOT NULL CHECK (length(currency) = 3),
         note           TEXT,
         user_id        TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
         device_id      TEXT    NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
         -- When the sale happened; on a till offline for days, days ago.
         occurred_at    TEXT    NOT NULL,
         -- When the row was written. Reports slice on occurred_at.
         recorded_at    TEXT    NOT NULL,

         CHECK (recorded_at >= occurred_at)
       ) STRICT`,

      // A receipt number identifies a sale within one business, not globally.
      `CREATE UNIQUE INDEX sales_number_per_business ON sales (business_id, number)`,
      // The query every sales report starts from (§21).
      `CREATE INDEX sales_by_business_and_time ON sales (business_id, occurred_at DESC)`,
      `CREATE INDEX sales_by_customer ON sales (business_id, customer_id, occurred_at DESC)
         WHERE customer_id IS NOT NULL`,

      `CREATE TABLE sale_items (
         id          TEXT    PRIMARY KEY,
         sale_id     TEXT    NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
         business_id TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         product_id  TEXT    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
         -- The product's name as it was when it sold. A receipt reprinted next
         -- year must show what was charged, and the product will have been
         -- renamed and repriced by then (§41).
         name        TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
         unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
         -- Thousandths, always positive: a negative line would be a refund
         -- wearing a sale's clothes, and §41 wants that as its own transaction.
         quantity    INTEGER NOT NULL CHECK (quantity > 0),
         discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
         tax_rate_basis_points INTEGER NOT NULL DEFAULT 0
                             CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
         -- Null when the business has never recorded what it paid. An honest
         -- gap: profit is reported only for the lines that have it (§6).
         unit_cost_minor INTEGER CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
         currency    TEXT    NOT NULL CHECK (length(currency) = 3)
       ) STRICT`,

      `CREATE INDEX sale_items_by_sale ON sale_items (sale_id)`,
      `CREATE INDEX sale_items_by_product ON sale_items (business_id, product_id)`,

      `CREATE TABLE sale_payments (
         id          TEXT    PRIMARY KEY,
         sale_id     TEXT    NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
         business_id TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         branch_id   TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
         -- Where the money went. An account, never a payment type: that is what
         -- keeps MTN and Orange configurable (§10). The accounts table arrives
         -- with §17, so this is not yet a foreign key.
         account_id  TEXT    NOT NULL,
         amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
         currency    TEXT    NOT NULL CHECK (length(currency) = 3),
         -- The provider's number: how a Mobile Money payment is found later.
         reference   TEXT,
         note        TEXT,
         user_id     TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
         device_id   TEXT    NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
         occurred_at TEXT    NOT NULL,
         recorded_at TEXT    NOT NULL,

         CHECK (recorded_at >= occurred_at)
       ) STRICT`,

      `CREATE INDEX sale_payments_by_sale ON sale_payments (sale_id)`,
      `CREATE INDEX sale_payments_by_account
         ON sale_payments (business_id, account_id, occurred_at)`,

      // Financial history is immutable here as on the server (§41, ADR-007). A
      // correction is a compensating transaction, and a future screen or a
      // support build must not be able to reach past that.
      ...["sales", "sale_items", "sale_payments"].flatMap((table) => [
        `CREATE TRIGGER ${table}_no_update
           BEFORE UPDATE ON ${table}
         BEGIN
           SELECT RAISE(ABORT, '${table} is immutable: record a compensating transaction');
         END`,
        `CREATE TRIGGER ${table}_no_delete
           BEFORE DELETE ON ${table}
         BEGIN
           SELECT RAISE(ABORT, '${table} is immutable: record a compensating transaction');
         END`,
      ]),
    ],
  },
];

/** The version the code in this build expects. */
export const LATEST_VERSION: number =
  MIGRATIONS.length === 0 ? 0 : (MIGRATIONS.at(-1)?.version ?? 0);

/** Raised when the schema cannot be brought up to date. */
export class MigrationError extends Error {
  readonly version: number;

  constructor(message: string, version: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
    this.version = version;
  }
}

/** What a migration run did. */
export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly Migration[];
}

/**
 * Brings the schema up to the latest version, applying only what is missing.
 *
 * Each migration runs in its own transaction, so a failure part-way leaves the
 * schema at the last version that fully applied rather than somewhere between
 * two.
 */
export function migrate(database: Database): MigrationResult {
  ensureVersionTable(database);

  const from = schemaVersion(database);
  if (from > LATEST_VERSION) {
    // The device is running an older build against a newer database, which
    // happens if an install is rolled back. Refusing is the safe answer: the
    // older code does not know what the newer schema means, and guessing could
    // corrupt business records.
    throw new MigrationError(
      `the database is at version ${from} but this build only knows up to ${LATEST_VERSION}`,
      from,
    );
  }

  const applied: Migration[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) {
      continue;
    }
    applyOne(database, migration);
    applied.push(migration);
  }

  return { from, to: schemaVersion(database), applied };
}

function applyOne(database: Database, migration: Migration): void {
  try {
    database.transaction((tx) => {
      for (const statement of migration.statements) {
        tx.run(statement);
      }
      tx.run(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
        [migration.version, migration.name, new Date().toISOString()],
      );
    });
  } catch (cause) {
    const detail = cause instanceof DatabaseError ? `: ${cause.message}` : "";
    throw new MigrationError(
      `migration ${migration.version} (${migration.name}) failed${detail}`,
      migration.version,
      { cause },
    );
  }
}

/** Returns the version the database is currently at; zero if none applied. */
export function schemaVersion(database: Queryable): number {
  const row = database.get(`SELECT MAX(version) AS version FROM schema_migrations`);
  const version = row?.["version"];
  return typeof version === "number" ? version : 0;
}

function ensureVersionTable(database: Database): void {
  database.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT    NOT NULL,
       applied_at TEXT    NOT NULL
     ) STRICT`,
  );
}
