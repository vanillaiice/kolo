import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Database } from "./driver.ts";
import { LATEST_VERSION, MIGRATIONS, MigrationError, migrate, schemaVersion } from "./migrations.ts";
import { openDatabase } from "./node-sqlite.ts";

let database: Database;

beforeEach(() => {
  database = openDatabase();
});

afterEach(() => {
  database.close();
});

describe("the schema history", () => {
  it("is numbered from one, without gaps", () => {
    MIGRATIONS.forEach((migration, index) => {
      assert.equal(
        migration.version,
        index + 1,
        `migration ${migration.name} is version ${migration.version} at position ${index + 1}`,
      );
    });
    assert.equal(LATEST_VERSION, MIGRATIONS.length);
  });

  it("gives every migration a name and something to do", () => {
    for (const migration of MIGRATIONS) {
      assert.ok(migration.name.trim().length > 0, `migration ${migration.version} has no name`);
      assert.ok(migration.statements.length > 0, `migration ${migration.version} does nothing`);
    }
  });
});

describe("migrating", () => {
  it("brings an empty database to the latest version", () => {
    const result = migrate(database);

    assert.equal(result.from, 0);
    assert.equal(result.to, LATEST_VERSION);
    assert.equal(result.applied.length, MIGRATIONS.length);
    assert.equal(schemaVersion(database), LATEST_VERSION);
  });

  it("creates the tables the application expects", () => {
    migrate(database);

    const expected = [
      "businesses",
      "branches",
      "users",
      "devices",
      "sync_outbox",
      "sync_sequence",
      "sync_state",
    ];
    for (const table of expected) {
      const row = database.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [
        table,
      ]);
      assert.ok(row, `the table ${table} was not created`);
    }
  });

  it("applies nothing the second time", () => {
    migrate(database);
    const again = migrate(database);

    assert.equal(again.applied.length, 0, "a redundant run applied migrations");
    assert.equal(again.from, LATEST_VERSION);
    assert.equal(again.to, LATEST_VERSION);
  });

  /**
   * A device offline for months arrives several versions behind, so the runner
   * has to step through everything it has not applied rather than assume it is
   * one behind (ADR-014).
   */
  it("catches a device up across several versions", () => {
    // Apply only the first migration, as an older build would have.
    const [first] = MIGRATIONS;
    assert.ok(first);

    database.run(
      `CREATE TABLE schema_migrations (
         version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
       ) STRICT`,
    );
    database.transaction((tx) => {
      for (const statement of first.statements) {
        tx.run(statement);
      }
      tx.run(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`, [
        first.version,
        first.name,
        "2026-01-01T00:00:00.000Z",
      ]);
    });
    assert.equal(schemaVersion(database), 1);

    const result = migrate(database);

    assert.equal(result.from, 1);
    assert.equal(result.to, LATEST_VERSION);
    assert.deepEqual(
      result.applied.map((migration) => migration.version),
      MIGRATIONS.slice(1).map((migration) => migration.version),
    );
  });

  /**
   * An install rolled back leaves an older build looking at a newer database.
   * Refusing is the safe answer: the older code does not know what the newer
   * schema means, and guessing could corrupt business records.
   */
  it("refuses a database newer than the build understands", () => {
    migrate(database);
    database.run(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`, [
      LATEST_VERSION + 5,
      "from a future build",
      "2027-01-01T00:00:00.000Z",
    ]);

    assert.throws(() => migrate(database), MigrationError);
  });

  it("leaves the schema at the last good version when one fails", () => {
    const broken = openDatabase();
    try {
      broken.run(
        `CREATE TABLE schema_migrations (
           version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
         ) STRICT`,
      );
      // A table the first migration also creates, so that migration collides.
      broken.run(`CREATE TABLE businesses (id TEXT PRIMARY KEY) STRICT`);

      assert.throws(() => migrate(broken), MigrationError);
      assert.equal(schemaVersion(broken), 0, "a failed migration was recorded as applied");
    } finally {
      broken.close();
    }
  });
});

describe("the schema itself", () => {
  beforeEach(() => {
    migrate(database);
  });

  /**
   * SQLite has foreign keys off by default, which would silently disable every
   * relationship the schema declares.
   */
  it("enforces foreign keys", () => {
    assert.throws(() =>
      database.run(
        `INSERT INTO branches (id, business_id, name, created_at, updated_at)
         VALUES ('b', 'no-such-business', 'Nowhere', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z')`,
      ),
    );
  });

  /** STRICT tables mean a column typed TEXT cannot quietly hold a number. */
  it("enforces column types", () => {
    assert.throws(() =>
      database.run(
        `INSERT INTO businesses (id, name, currency, created_at, updated_at)
         VALUES (1, 2, 3, 4, 5)`,
      ),
    );
  });

  it("rejects rows the domain would refuse", () => {
    const rejected: ReadonlyArray<readonly [string, string]> = [
      [
        "a blank business name",
        `INSERT INTO businesses (id, name, currency, created_at, updated_at)
         VALUES ('x', '   ', 'XAF', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z')`,
      ],
      [
        "a business updated before it was created",
        `INSERT INTO businesses (id, name, currency, created_at, updated_at)
         VALUES ('x', 'Boutique', 'XAF', '2026-08-14T09:00:00.000Z', '2026-08-13T09:00:00.000Z')`,
      ],
      [
        "a currency that is not three letters",
        `INSERT INTO businesses (id, name, currency, created_at, updated_at)
         VALUES ('x', 'Boutique', 'FRANC', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z')`,
      ],
      [
        "an unknown platform",
        `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
         VALUES ('d', 'x', 'Till', 'SYMBIAN',
                 '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z')`,
      ],
    ];
    for (const [name, statement] of rejected) {
      assert.throws(() => database.run(statement), `${name} was accepted`);
    }
  });

  it("rejects an outbox row that is not valid JSON", () => {
    assert.throws(() =>
      database.run(
        `INSERT INTO sync_outbox
           (event_id, business_id, user_id, device_id, type, payload, occurred_at, sequence)
         VALUES ('e', 'b', 'u', 'd', 'SALE', 'not json', '2026-08-14T09:00:00.000Z', 1)`,
      ),
    );
  });

  /** A delivered event without a delivery time would make pruning meaningless. */
  it("rejects a delivered outbox row with no delivery time", () => {
    database.run(
      `INSERT INTO sync_outbox
         (event_id, business_id, user_id, device_id, type, payload, occurred_at, sequence)
       VALUES ('e', 'b', 'u', 'd', 'SALE', '{}', '2026-08-14T09:00:00.000Z', 1)`,
    );
    assert.throws(() =>
      database.run(`UPDATE sync_outbox SET state = 'delivered' WHERE event_id = 'e'`),
    );
  });
});

describe("transactions", () => {
  beforeEach(() => {
    migrate(database);
  });

  it("roll back everything when the work throws", () => {
    assert.throws(() =>
      database.transaction((tx) => {
        tx.run(
          `INSERT INTO businesses (id, name, currency, created_at, updated_at)
           VALUES ('rolled-back', 'Boutique', 'XAF',
                   '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z')`,
        );
        throw new Error("the operation failed");
      }),
    );

    assert.equal(database.get(`SELECT id FROM businesses WHERE id = 'rolled-back'`), undefined);
  });

  /**
   * A nested call joins the outer transaction. A real inner one would let an
   * inner rollback leave the outer half-applied, which is exactly what the
   * outbox invariant forbids.
   */
  it("nest without letting an inner failure half-commit the outer", () => {
    assert.throws(() =>
      database.transaction((outer) => {
        outer.run(
          `INSERT INTO businesses (id, name, currency, created_at, updated_at)
           VALUES ('outer', 'Boutique', 'XAF',
                   '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z')`,
        );
        database.transaction(() => {
          throw new Error("the inner operation failed");
        });
      }),
    );

    assert.equal(
      database.get(`SELECT id FROM businesses WHERE id = 'outer'`),
      undefined,
      "the outer write survived an inner failure",
    );
  });

  it("return what the work returns", () => {
    const result = database.transaction(() => 42);
    assert.equal(result, 42);
  });
});
