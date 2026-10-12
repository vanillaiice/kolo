import { PHOTOS_MIGRATION } from "./photos-migration.ts";
import { PRODUCT_CATEGORIES_MIGRATION } from "./product-categories-migration.ts";
import { FULL_TEXT_MIGRATION } from "./full-text-migration.ts";
import { RETURNS_MIGRATION } from "./returns-migration.ts";
import { SEARCH_MIGRATION } from "./search-migration.ts";
import { TRANSFER_MIGRATION } from "./transfer-migration.ts";
import { SERVER_SYNC_MIGRATION } from "./server-sync-migration.ts";
import { SEALED_SYNC_MIGRATION } from "./sealed-sync-migration.ts";
import { HOSTED_SERVICE_MIGRATION } from "./hosted-service-migration.ts";
import { TAX_TERMS_MIGRATION } from "./tax-terms-migration.ts";
import { LOCAL_NETWORK_MIGRATION } from "./local-network-migration.ts";
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
import { LOCAL_AUTHORITY_MIGRATION } from "./local-authority-migration.ts";
import { EVENT_JOURNAL_MIGRATION } from "./event-journal-migration.ts";
import { CREDENTIAL_RECOVERY_MIGRATION } from "./credential-recovery-migration.ts";

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

  {
    version: 7,
    name: "customers and their credit ledger",
    statements: [
      // A customer needs only a name. Someone putting a regular on credit at
      // the counter should not have to fill in an address first (§12).
      //
      // No balance column: what a customer owes is the sum of the ledger below,
      // exactly as stock is the sum of its movements (§13, §59).
      `CREATE TABLE customers (
         id                    TEXT    PRIMARY KEY,
         business_id           TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         name                  TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
         phone                 TEXT,
         address               TEXT,
         notes                 TEXT,
         -- Null when no limit has been set, which is not the same as a limit of
         -- zero: null means the shopkeeper has not decided, zero means this
         -- customer may not have credit.
         credit_limit_minor    INTEGER CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0),
         credit_limit_currency TEXT    CHECK (credit_limit_currency IS NULL
                                              OR length(credit_limit_currency) = 3),
         active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
         created_at            TEXT    NOT NULL,
         updated_at            TEXT    NOT NULL,

         CHECK ((credit_limit_minor IS NULL) = (credit_limit_currency IS NULL)),
         CHECK (updated_at >= created_at)
       ) STRICT`,

      `CREATE INDEX customers_by_business ON customers (business_id, name)`,
      // A lookup, not an identity: a household shares one number, and refusing
      // the second person would leave them out of the credit book they are
      // already in on paper. So this index is deliberately not unique.
      `CREATE INDEX customers_by_phone ON customers (business_id, phone)
         WHERE phone IS NOT NULL`,

      `CREATE TABLE customer_transactions (
         id             TEXT    PRIMARY KEY,
         customer_id    TEXT    NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
         business_id    TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         branch_id      TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
         type           TEXT    NOT NULL CHECK (type IN ('CREDIT_SALE', 'PAYMENT', 'RETURN',
                                                         'ADJUSTMENT', 'OPENING_BALANCE',
                                                         'WRITE_OFF')),
         -- Signed minor units: positive adds to what is owed, negative reduces
         -- it. Summing a ledger is then plain addition.
         amount_minor   INTEGER NOT NULL CHECK (amount_minor <> 0),
         currency       TEXT    NOT NULL CHECK (length(currency) = 3),
         reference_kind TEXT,
         reference_id   TEXT,
         reason         TEXT,
         user_id        TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
         device_id      TEXT    NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
         occurred_at    TEXT    NOT NULL,
         recorded_at    TEXT    NOT NULL,

         -- A payment that increased a debt is invisible in a total and
         -- unarguable in a statement, so the sign has to agree with the type
         -- here as it does on the server. Corrections go either way.
         CHECK (
           (type IN ('CREDIT_SALE', 'OPENING_BALANCE') AND amount_minor > 0)
           OR (type IN ('PAYMENT', 'RETURN', 'WRITE_OFF') AND amount_minor < 0)
           OR type = 'ADJUSTMENT'
         ),
         CHECK (type NOT IN ('ADJUSTMENT', 'WRITE_OFF')
                OR length(trim(coalesce(reason, ''))) > 0),
         CHECK (type NOT IN ('CREDIT_SALE', 'RETURN')
                OR (reference_kind IS NOT NULL AND reference_id IS NOT NULL)),
         CHECK ((reference_kind IS NULL) = (reference_id IS NULL)),
         CHECK (recorded_at >= occurred_at)
       ) STRICT`,

      // Deriving a balance is a sum over one customer's entries, and a
      // statement is the same rows in the order things happened.
      `CREATE INDEX customer_transactions_by_customer
         ON customer_transactions (business_id, customer_id, occurred_at, id)`,
      `CREATE INDEX customer_transactions_by_reference
         ON customer_transactions (business_id, reference_kind, reference_id)
         WHERE reference_kind IS NOT NULL`,

      // The ledger is append-only here as on the server (§13, §41, ADR-007). A
      // correction is a compensating entry, and a future screen must not be
      // able to reach past that.
      `CREATE TRIGGER customer_transactions_no_update
         BEFORE UPDATE ON customer_transactions
       BEGIN
         SELECT RAISE(ABORT, 'customer_transactions is immutable: record a compensating transaction');
       END`,
      `CREATE TRIGGER customer_transactions_no_delete
         BEFORE DELETE ON customer_transactions
       BEGIN
         SELECT RAISE(ABORT, 'customer_transactions is immutable: record a compensating transaction');
       END`,
    ],
  },

  {
    version: 8,
    name: "which device's customer edit is in force",
    statements: [
      // The tie-break for two edits stamped the same instant, exactly as
      // version 5 added for products (ADR-015). Without it, two devices holding
      // the same two edits could settle on different names, permanently, with
      // nothing able to detect it.
      //
      // Nullable for rows written before this, and a null sorts below any
      // device, so a real edit always beats one from before the column existed.
      `ALTER TABLE customers ADD COLUMN updated_by_device TEXT
         REFERENCES devices (id) ON DELETE RESTRICT`,
    ],
  },

  {
    version: 9,
    name: "where a customer's payment went",
    statements: [
      // Paying off a debt is two facts: the customer owes less, and the
      // business holds more cash. The ledger entry is the first; this column is
      // the second. An account, never a payment method — that is what keeps MTN
      // and Orange configurable (§10). The accounts table arrives with §17, so
      // this is not yet a foreign key, exactly as sale_payments.account_id is
      // not.
      `ALTER TABLE customer_transactions ADD COLUMN account_id TEXT`,

      // SQLite cannot add a CHECK to an existing table, so the rule that money
      // which moved has to have moved somewhere is kept by a trigger instead.
      // It says the same thing: an account on a write-off would claim a till
      // took money it never saw.
      `CREATE TRIGGER customer_transactions_account_only_when_money_moved
         BEFORE INSERT ON customer_transactions
         WHEN (NEW.account_id IS NOT NULL) <> (NEW.type = 'PAYMENT')
       BEGIN
         SELECT RAISE(ABORT, 'only a payment names an account, and every payment must');
       END`,

      // What each account took from customers settling their debts, which the
      // cash and financial reports sum (§18, §21).
      `CREATE INDEX customer_transactions_by_account
         ON customer_transactions (business_id, account_id, occurred_at)
         WHERE account_id IS NOT NULL`,
    ],
  },

  {
    version: 10,
    name: "financial accounts",
    statements: [
      // Where the business's money sits (§17). Two tables have been naming an
      // account with nothing behind the column; this is that something.
      //
      // No balance column: what an account holds is the sum of what moved
      // through it, and §18 compares that against the drawer. A stored balance
      // would be both the number being checked and the number checking (§59).
      //
      // Which provider a wallet belongs to is its name, never its kind. That is
      // what makes adding Orange Money a row rather than a release (§10).
      `CREATE TABLE financial_accounts (
         id                TEXT    PRIMARY KEY,
         business_id       TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         -- A till belongs to a branch, a bank account to the business (§42).
         branch_id         TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
         name              TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
         kind              TEXT    NOT NULL CHECK (kind IN ('CASH', 'MOBILE_MONEY', 'BANK',
                                                            'CARD', 'OTHER')),
         currency          TEXT    NOT NULL CHECK (length(currency) = 3),
         -- The wallet number, bank number, or till label.
         number            TEXT,
         notes             TEXT,
         active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
         created_at        TEXT    NOT NULL,
         updated_at        TEXT    NOT NULL,
         -- An account is state, and settles like a product and a customer:
         -- last-write-wins ordered by (updated_at, updated_by_device).
         updated_by_device TEXT    REFERENCES devices (id) ON DELETE RESTRICT,

         CHECK (updated_at >= created_at)
       ) STRICT`,

      // A cashier choosing between two accounts called the same thing is
      // choosing at random, and the money goes wherever they happened to tap.
      `CREATE UNIQUE INDEX financial_accounts_name_per_business
         ON financial_accounts (business_id, lower(trim(name)))`,
      `CREATE INDEX financial_accounts_by_business ON financial_accounts (business_id, name)`,
    ],
  },

  {
    version: 11,
    name: "money moved by hand",
    statements: [
      // The float at opening, cash carried to the bank, a transfer between two
      // of the business's own accounts, the correction after a count (§18).
      //
      // Money a sale or a customer payment moved is deliberately absent: those
      // are recorded where they happened, and a balance sums them from there. A
      // second copy could disagree with the first, and then there would be two
      // answers to how much is in the drawer.
      `CREATE TABLE account_movements (
         id             TEXT    PRIMARY KEY,
         account_id     TEXT    NOT NULL REFERENCES financial_accounts (id) ON DELETE RESTRICT,
         business_id    TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         branch_id      TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
         type           TEXT    NOT NULL CHECK (type IN ('OPENING_BALANCE', 'CASH_IN', 'CASH_OUT',
                                                         'TRANSFER_IN', 'TRANSFER_OUT',
                                                         'ADJUSTMENT')),
         -- Signed: positive puts money in, negative takes it out.
         amount_minor   INTEGER NOT NULL CHECK (amount_minor <> 0),
         currency       TEXT    NOT NULL CHECK (length(currency) = 3),
         -- The other account in a transfer. A transfer is two rows, one against
         -- each account, because a balance sums the rows naming it.
         counterpart_id TEXT    REFERENCES financial_accounts (id) ON DELETE RESTRICT,
         reason         TEXT,
         user_id        TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
         device_id      TEXT    NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
         occurred_at    TEXT    NOT NULL,
         recorded_at    TEXT    NOT NULL,

         -- Cash taken out that read as money in would make a drawer look full
         -- that is empty. A correction goes either way: a count can find more
         -- or less.
         CHECK (
           (type IN ('OPENING_BALANCE', 'CASH_IN', 'TRANSFER_IN') AND amount_minor > 0)
           OR (type IN ('CASH_OUT', 'TRANSFER_OUT') AND amount_minor < 0)
           OR type = 'ADJUSTMENT'
         ),
         CHECK (type NOT IN ('ADJUSTMENT', 'CASH_OUT')
                OR length(trim(coalesce(reason, ''))) > 0),
         CHECK ((counterpart_id IS NOT NULL) = (type IN ('TRANSFER_IN', 'TRANSFER_OUT'))),
         CHECK (counterpart_id IS NULL OR counterpart_id <> account_id),
         CHECK (recorded_at >= occurred_at)
       ) STRICT`,

      `CREATE INDEX account_movements_by_account
         ON account_movements (business_id, account_id, occurred_at, id)`,

      // Append-only here as on the server: a count that finds the drawer short
      // records an adjustment saying so rather than editing yesterday.
      `CREATE TRIGGER account_movements_no_update
         BEFORE UPDATE ON account_movements
       BEGIN
         SELECT RAISE(ABORT, 'account_movements is immutable: record a compensating movement');
       END`,
      `CREATE TRIGGER account_movements_no_delete
         BEFORE DELETE ON account_movements
       BEGIN
         SELECT RAISE(ABORT, 'account_movements is immutable: record a compensating movement');
       END`,
    ],
  },

  {
    version: 12,
    name: "expenses",
    statements: [
      // What the business spends that is not stock (§19). A purchase raises
      // inventory and an expense does not, and confusing the two would make the
      // shop's goods look more expensive than they were.
      `CREATE TABLE expenses (
         id           TEXT    PRIMARY KEY,
         business_id  TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         branch_id    TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
         category     TEXT    NOT NULL CHECK (category IN ('RENT', 'ELECTRICITY', 'WATER',
                                                           'TRANSPORT', 'SALARY', 'PACKAGING',
                                                           'MAINTENANCE', 'INTERNET',
                                                           'MARKETING', 'OTHER')),
         -- Where the money came from. An expense naming no account would leave
         -- the business poorer with no drawer any lighter (§17).
         account_id   TEXT    NOT NULL REFERENCES financial_accounts (id) ON DELETE RESTRICT,
         -- Positive for a cost, negative for a reversal, so summing is plain
         -- addition with no rule about skipping the undone ones.
         amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
         currency     TEXT    NOT NULL CHECK (length(currency) = 3),
         description  TEXT,
         reference    TEXT,
         reverses_id  TEXT    REFERENCES expenses (id) ON DELETE RESTRICT,
         user_id      TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
         device_id    TEXT    NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
         occurred_at  TEXT    NOT NULL,
         recorded_at  TEXT    NOT NULL,

         -- A negative expense is a reversal and must say what it undoes; a cost
         -- cannot also claim to be one.
         CHECK ((amount_minor < 0) = (reverses_id IS NOT NULL)),
         CHECK (reverses_id IS NULL OR reverses_id <> id),
         -- "OTHER, 15,000" is the line an owner stares at in a month's report
         -- with no way to find out what it was.
         CHECK (category <> 'OTHER' OR length(trim(coalesce(description, ''))) > 0),
         CHECK (recorded_at >= occurred_at)
       ) STRICT`,

      // An expense is undone once. A second reversal would take the money off
      // the books twice.
      `CREATE UNIQUE INDEX expenses_reversed_once
         ON expenses (reverses_id) WHERE reverses_id IS NOT NULL`,
      `CREATE INDEX expenses_by_business_and_time
         ON expenses (business_id, occurred_at DESC)`,
      `CREATE INDEX expenses_by_category
         ON expenses (business_id, category, occurred_at DESC)`,
      `CREATE INDEX expenses_by_account
         ON expenses (business_id, account_id, occurred_at)`,

      `CREATE TRIGGER expenses_no_update
         BEFORE UPDATE ON expenses
       BEGIN
         SELECT RAISE(ABORT, 'expenses is immutable: record a reversal');
       END`,
      `CREATE TRIGGER expenses_no_delete
         BEFORE DELETE ON expenses
       BEGIN
         SELECT RAISE(ABORT, 'expenses is immutable: record a reversal');
       END`,
    ],
  },

  {
    version: 13,
    name: "suppliers, what they are owed, and the deliveries that put it there",
    statements: [
      // The mirror of customers, and deliberately its own tables rather than a
      // flag on those: what a customer owes the shop and what the shop owes a
      // wholesaler are opposite obligations, and one table with a sign would
      // make it possible to settle a customer's debt with a supplier's payment
      // (§14, §16).
      //
      // No balance column, here as nowhere: what is owed is the sum of the
      // ledger below.
      `CREATE TABLE suppliers (
         id                TEXT    PRIMARY KEY,
         business_id       TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         name              TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
         phone             TEXT,
         address           TEXT,
         -- The person to ask for, which for a wholesaler is not the business's
         -- name and is what a shopkeeper actually remembers (§14).
         contact           TEXT,
         notes             TEXT,
         active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
         created_at        TEXT    NOT NULL,
         updated_at        TEXT    NOT NULL,
         -- Which device's edit is in force, the tie-break for two edits stamped
         -- the same instant (ADR-015).
         updated_by_device TEXT    REFERENCES devices (id) ON DELETE RESTRICT,

         CHECK (updated_at >= created_at)
       ) STRICT`,

      `CREATE INDEX suppliers_by_business ON suppliers (business_id, name)`,
      `CREATE INDEX suppliers_by_phone ON suppliers (business_id, phone)
         WHERE phone IS NOT NULL`,

      `CREATE TABLE supplier_transactions (
         id             TEXT    PRIMARY KEY,
         supplier_id    TEXT    NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
         business_id    TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         branch_id      TEXT    REFERENCES branches (id) ON DELETE RESTRICT,
         type           TEXT    NOT NULL CHECK (type IN ('PURCHASE', 'PAYMENT', 'RETURN',
                                                         'ADJUSTMENT', 'OPENING_BALANCE')),
         -- Signed: positive adds to what the business owes, negative reduces it.
         amount_minor   INTEGER NOT NULL CHECK (amount_minor <> 0),
         currency       TEXT    NOT NULL CHECK (length(currency) = 3),
         -- Where a payment's money came from. Only a payment names one: goods
         -- going back reduce the bill without a franc leaving the till (§16).
         account_id     TEXT    REFERENCES financial_accounts (id) ON DELETE RESTRICT,
         reference_kind TEXT,
         reference_id   TEXT,
         reason         TEXT,
         user_id        TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
         device_id      TEXT    NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
         occurred_at    TEXT    NOT NULL,
         recorded_at    TEXT    NOT NULL,

         -- A payment that increased a bill is invisible in a total and
         -- unarguable in a statement, so the sign has to agree with the type
         -- here as it does on the server. Corrections go either way.
         CHECK (
           (type IN ('PURCHASE', 'OPENING_BALANCE') AND amount_minor > 0)
           OR (type IN ('PAYMENT', 'RETURN') AND amount_minor < 0)
           OR type = 'ADJUSTMENT'
         ),
         CHECK ((account_id IS NOT NULL) = (type = 'PAYMENT')),
         CHECK (type <> 'ADJUSTMENT' OR length(trim(coalesce(reason, ''))) > 0),
         CHECK (type NOT IN ('PURCHASE', 'RETURN')
                OR (reference_kind IS NOT NULL AND reference_id IS NOT NULL)),
         CHECK ((reference_kind IS NULL) = (reference_id IS NULL)),
         CHECK (recorded_at >= occurred_at)
       ) STRICT`,

      `CREATE INDEX supplier_transactions_by_supplier
         ON supplier_transactions (business_id, supplier_id, occurred_at, id)`,
      // A balance sums the rows naming an account, so paying a wholesaler has
      // to be findable by the account it came out of.
      `CREATE INDEX supplier_transactions_by_account
         ON supplier_transactions (business_id, account_id, occurred_at)
         WHERE account_id IS NOT NULL`,

      // Append-only here as on the server (§16, §41, ADR-007).
      `CREATE TRIGGER supplier_transactions_no_update
         BEFORE UPDATE ON supplier_transactions
       BEGIN
         SELECT RAISE(ABORT, 'supplier_transactions is immutable: record a compensating transaction');
       END`,
      `CREATE TRIGGER supplier_transactions_no_delete
         BEFORE DELETE ON supplier_transactions
       BEGIN
         SELECT RAISE(ABORT, 'supplier_transactions is immutable: record a compensating transaction');
       END`,

      // Stock coming in and what it cost (§15). Not an inventory operation: a
      // delivery raises stock and either lowers an account or raises what is
      // owed, which is why the movements it caused, the money it paid, and the
      // ledger entry it left are written in one transaction with it.
      `CREATE TABLE purchases (
         id          TEXT PRIMARY KEY,
         business_id TEXT NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         branch_id   TEXT REFERENCES branches (id) ON DELETE RESTRICT,
         -- Optional: a crate bought at the market names nobody, and requiring a
         -- supplier would stop the stock being recorded at all.
         supplier_id TEXT REFERENCES suppliers (id) ON DELETE RESTRICT,
         -- The supplier's invoice or delivery-note number, when there is one.
         reference   TEXT,
         note        TEXT,
         user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
         device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
         -- When the stock arrived, which for a till offline for days is days ago.
         occurred_at TEXT NOT NULL,
         recorded_at TEXT NOT NULL,

         CHECK (recorded_at >= occurred_at)
       ) STRICT`,

      `CREATE TABLE purchase_items (
         id              TEXT    PRIMARY KEY,
         purchase_id     TEXT    NOT NULL REFERENCES purchases (id) ON DELETE RESTRICT,
         business_id     TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         product_id      TEXT    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
         -- Required, unlike a sale line's: this is where a cost is learned, and
         -- a delivery with no cost tells the shop nothing about what its stock
         -- is worth (§8).
         unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
         -- Thousandths, always positive: goods going back are a return, which
         -- is its own transaction.
         quantity        INTEGER NOT NULL CHECK (quantity > 0),
         currency        TEXT    NOT NULL CHECK (length(currency) = 3)
       ) STRICT`,

      `CREATE INDEX purchase_items_by_purchase ON purchase_items (purchase_id)`,
      // What a product cost over time, the other half of §8's valuation.
      `CREATE INDEX purchase_items_by_product ON purchase_items (business_id, product_id)`,
      `CREATE INDEX purchases_by_business_and_time
         ON purchases (business_id, occurred_at DESC)`,
      `CREATE INDEX purchases_by_supplier
         ON purchases (business_id, supplier_id, occurred_at DESC)
         WHERE supplier_id IS NOT NULL`,

      // Financial history, immutable as everywhere else (§41, ADR-007). Goods
      // going back are a return, which is its own transaction.
      `CREATE TRIGGER purchases_no_update
         BEFORE UPDATE ON purchases
       BEGIN
         SELECT RAISE(ABORT, 'purchases is immutable: record a return');
       END`,
      `CREATE TRIGGER purchases_no_delete
         BEFORE DELETE ON purchases
       BEGIN
         SELECT RAISE(ABORT, 'purchases is immutable: record a return');
       END`,
      `CREATE TRIGGER purchase_items_no_update
         BEFORE UPDATE ON purchase_items
       BEGIN
         SELECT RAISE(ABORT, 'purchase_items is immutable: record a return');
       END`,
      `CREATE TRIGGER purchase_items_no_delete
         BEFORE DELETE ON purchase_items
       BEGIN
         SELECT RAISE(ABORT, 'purchase_items is immutable: record a return');
       END`,
    ],
  },

  {
    version: 14,
    name: "the session this device is enrolled with",
    statements: [
      // What the device holds after logging in (ADR-012). One row, ever: a
      // device is enrolled in one shop as one person, and a second row would
      // be two answers to "who is this till?" with nothing to choose between
      // them. `id = 1` is what makes that structural rather than a convention
      // somebody has to remember.
      //
      // **The token is deliberately not here.** §37 asks for secure token
      // storage, so it lives in the platform keystore behind
      // `data/auth/secure-store.ts`, and this row is what says a device is
      // enrolled at all. The two are written token-first, so the failure mode
      // is an orphan secret nothing reads rather than a device that believes
      // it is enrolled and cannot authenticate.
      `CREATE TABLE device_session (
         id          INTEGER PRIMARY KEY CHECK (id = 1),
         session_id  TEXT    NOT NULL,
         business_id TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
         user_id     TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
         device_id   TEXT    NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
         issued_at   TEXT    NOT NULL,
         expires_at  TEXT    NOT NULL,
         CHECK (expires_at > issued_at)
       ) STRICT`,

      // What the server says this user may do, kept as the server said it.
      //
      // The columns beside it, `granted` and `revoked`, are the *inputs* the
      // server resolves against a role's defaults (§38); this is the answer.
      // Storing the answer rather than re-deriving it is deliberate: a device
      // that recomputed from the role would hand back a permission the server
      // had revoked, since a role's defaults would put it straight back.
      // Permissions are server-authoritative (§29) and refresh at /auth/me.
      `ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'
         CHECK (json_valid(permissions))`,
    ],
  },
  LOCAL_AUTHORITY_MIGRATION,
  CREDENTIAL_RECOVERY_MIGRATION,
  EVENT_JOURNAL_MIGRATION,
  TRANSFER_MIGRATION,
  {
    version: 19, name: "operational queries and category conflict ordering", statements: [
      `ALTER TABLE categories ADD COLUMN updated_by_device TEXT`,
      `CREATE INDEX categories_operational_page ON categories(business_id,active,name,id)`,
      `CREATE INDEX stock_history_page ON inventory_movements(business_id,product_id,occurred_at DESC,id DESC)`,
      `CREATE INDEX expenses_history_page ON expenses(business_id,occurred_at DESC,id DESC)`,
      `CREATE INDEX purchases_history_page ON purchases(business_id,occurred_at DESC,id DESC)`,
      ...["products", "customers", "suppliers", "financial_accounts"].map(table =>
        `CREATE INDEX ${table}_operational_page ON ${table}(business_id,active,name,id)`),
      `CREATE INDEX sales_receipt_page ON sales(business_id,occurred_at DESC,id DESC)`,
      `CREATE INDEX sales_own_receipt_page ON sales(business_id,user_id,occurred_at DESC,id DESC)`,
      ...["customer", "supplier"].map(kind =>
        `CREATE INDEX ${kind}_statement_page ON ${kind}_transactions(business_id,${kind}_id,occurred_at DESC,id DESC)`),
    ],
  },
  RETURNS_MIGRATION,
  SEARCH_MIGRATION,
  PHOTOS_MIGRATION,
  PRODUCT_CATEGORIES_MIGRATION,
  FULL_TEXT_MIGRATION,
  SERVER_SYNC_MIGRATION,
  SEALED_SYNC_MIGRATION,
  HOSTED_SERVICE_MIGRATION,
  TAX_TERMS_MIGRATION,
  LOCAL_NETWORK_MIGRATION,
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
