import { subscribeChanges, changeRevision } from "./changes.ts";
/**
 * The native adapter's own logic, exercised without a device.
 *
 * The handle is injected, so a stand-in with the same four synchronous methods
 * runs every path this adapter has: the pragmas it sets, how it nests
 * transactions, how it reports "no row", and how it wraps a driver error. The
 * stand-in here is `node:sqlite` — real SQLite, so a rollback really rolls back
 * and a constraint really fires.
 *
 * What this still cannot prove is that `expo-sqlite` has these four methods.
 * Nothing but running the app on a device proves that, and ADR-016 says so.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { DatabaseError, type Database, type SqlValue } from "./driver.ts";
import {
  openNativeDatabase,
  type NativeBindValue,
  type NativeDatabase,
} from "./expo-sqlite.ts";

/** What the adapter was told the native driver looks like. */
class FakeNative implements NativeDatabase {
  readonly connection = new DatabaseSync(":memory:");
  /** Every statement run through `execSync`, so the pragmas can be checked. */
  readonly executed: string[] = [];
  closed = false;

  execSync(source: string): void {
    this.executed.push(source);
    this.connection.exec(source);
  }

  runSync(source: string, params: NativeBindValue[]): { readonly changes: number } {
    const result = this.connection.prepare(source).run(...forNode(params));
    return { changes: Number(result.changes) };
  }

  getAllSync(source: string, params: NativeBindValue[]): unknown[] {
    return this.connection.prepare(source).all(...forNode(params));
  }

  /** Null for "no row", which is what the real driver reports. */
  getFirstSync(source: string, params: NativeBindValue[]): unknown {
    return this.connection.prepare(source).get(...forNode(params)) ?? null;
  }

  closeSync(): void {
    this.closed = true;
    this.connection.close();
  }
}

/**
 * The one place the stand-in differs from the real driver.
 *
 * `expo-sqlite` binds a boolean; `node:sqlite` does not. Nothing in the data
 * layer binds one — every flag is stored as the 0 or 1 the schema declares — so
 * this exists to keep the stand-in's *signature* honest rather than to exercise
 * a path anything uses.
 */
function forNode(params: NativeBindValue[]): SqlValue[] {
  return params.map((value) => {
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  });
}

let native: FakeNative;
let database: Database;

beforeEach(() => {
  native = new FakeNative();
  database = openNativeDatabase(native);
  database.run(`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n > 0))`);
});

describe("opening the device's database", () => {
  it("turns foreign keys on, because SQLite does not", () => {
    // Nothing else in the schema matters if this is missed: every relationship
    // it declares would be silently unenforced.
    assert.equal(native.executed.includes("PRAGMA foreign_keys = ON"), true);
    assert.equal(
      database.get(`PRAGMA foreign_keys`)?.["foreign_keys"],
      1,
    );
  });

  it("sets the same pragmas the test adapter does", () => {
    // A device that ran with different settings from every test would be the
    // hardest divergence there is to find.
    for (const pragma of [
      "PRAGMA journal_mode = WAL",
      "PRAGMA synchronous = NORMAL",
      "PRAGMA busy_timeout = 5000",
    ]) {
      assert.equal(native.executed.includes(pragma), true, pragma);
    }
  });
});

describe("reading and writing through the adapter", () => {
  it("reports how many rows a write changed", () => {
    assert.equal(database.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["a", 1]).changes, 1);
    assert.equal(database.run(`UPDATE t SET n = ? WHERE id = ?`, [2, "a"]).changes, 1);
    assert.equal(database.run(`UPDATE t SET n = ? WHERE id = ?`, [2, "missing"]).changes, 0);
  });

  it("returns undefined for no row, not the driver's null", () => {
    // Callers test for undefined throughout, so this translation is the one
    // thing standing between them and a null that reads as a row.
    assert.equal(database.get(`SELECT * FROM t WHERE id = ?`, ["missing"]), undefined);
  });

  it("returns rows keyed by column", () => {
    database.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["a", 7]);
    assert.equal(database.get(`SELECT * FROM t WHERE id = ?`, ["a"])?.["n"], 7);
    assert.equal(database.all(`SELECT * FROM t`).length, 1);
  });

  it("binds parameters rather than interpolating them", () => {
    // A product name with an apostrophe is ordinary in this market.
    database.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["l'huile", 1]);
    assert.notEqual(database.get(`SELECT * FROM t WHERE id = ?`, ["l'huile"]), undefined);
  });

  it("binds a bigint the driver cannot take, when it fits exactly", () => {
    // The data layer's value type allows a bigint because node:sqlite hands one
    // back for a large integer. The native driver has no such type, so the
    // conversion happens here rather than being a runtime surprise on a device.
    database.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["a", 7n]);
    assert.equal(database.get(`SELECT * FROM t WHERE id = ?`, ["a"])?.["n"], 7);
  });

  it("refuses a bigint too large to bind exactly, rather than truncating", () => {
    // Past a safe integer the value is no longer exact, and money that is not
    // exact is not money (ADR-010). Failing loudly beats rounding takings.
    assert.throws(
      () =>
        database.run(`INSERT INTO t (id, n) VALUES (?, ?)`, [
          "a",
          BigInt(Number.MAX_SAFE_INTEGER) + 10n,
        ]),
      DatabaseError,
    );
  });

  it("wraps a driver failure with the statement that caused it", () => {
    // A constraint violation reported without its statement is close to
    // undiagnosable — and the parameters stay out of it, because they hold
    // business data.
    try {
      database.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["a", -1]);
      assert.fail("a violated constraint was accepted");
    } catch (error) {
      assert.equal(error instanceof DatabaseError, true);
      assert.equal((error as DatabaseError).sql.includes("INSERT INTO t"), true);
    }

    for (const read of [
      () => database.get(`SELECT * FROM nope`),
      () => database.all(`SELECT * FROM nope`),
    ]) {
      assert.throws(read, DatabaseError);
    }
  });
});

describe("transactions on the device", () => {
  it("commits what the work returns", () => {
    const returned = database.transaction((tx) => {
      tx.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["a", 1]);
      return "done";
    });

    assert.equal(returned, "done");
    assert.equal(database.all(`SELECT * FROM t`).length, 1);
  });

  it("rolls the whole thing back when the work throws", () => {
    assert.throws(() =>
      database.transaction((tx) => {
        tx.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["a", 1]);
        throw new Error("no");
      }),
    );

    assert.equal(database.all(`SELECT * FROM t`).length, 0);
  });

  it("joins a nested call to the outer transaction", () => {
    // Starting a real inner one would let an inner rollback leave the outer
    // half-applied — precisely what ADR-014 forbids, since a business write and
    // its outbox event must be all or nothing together.
    database.transaction((tx) => {
      tx.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["outer", 1]);
      database.transaction((inner) => {
        inner.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["inner", 1]);
      });
    });
    assert.equal(database.all(`SELECT * FROM t`).length, 2);

    // And a failure anywhere inside takes both with it.
    assert.throws(() =>
      database.transaction((tx) => {
        tx.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["a", 1]);
        database.transaction((inner) => {
          inner.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["b", 1]);
          throw new Error("no");
        });
      }),
    );
    assert.equal(database.all(`SELECT * FROM t`).length, 2);
  });

  it("reports the work's error, not the rollback's", () => {
    // The original failure is the one worth reporting.
    assert.throws(
      () =>
        database.transaction(() => {
          throw new Error("the real problem");
        }),
      /the real problem/,
    );
  });

  it("can start a new transaction after one failed", () => {
    // The depth counter has to be cleared even on the failing path, or the till
    // would never write again.
    assert.throws(() =>
      database.transaction(() => {
        throw new Error("no");
      }),
    );

    database.transaction((tx) => tx.run(`INSERT INTO t (id, n) VALUES (?, ?)`, ["a", 1]));
    assert.equal(database.all(`SELECT * FROM t`).length, 1);
  });
});

describe("closing", () => {
  it("closes the handle underneath", () => {
    database.close();
    assert.equal(native.closed, true);
  });
});


describe("committed domain invalidation through the native synchronous adapter", () => {
  it("notifies once after nested commit, permits fresh queries and isolates broken observers", () => {
    database.run(`CREATE TABLE products(id TEXT PRIMARY KEY)`); let notifications=0;
    const unsubscribe=subscribeChanges(database,["products"],()=>{notifications++;assert.equal(database.get(`SELECT count(*) AS n FROM products`)!["n"],2);});
    const broken=subscribeChanges(database,["products"],()=>{throw new Error("view failure");});
    database.transaction(tx=>{tx.run(`INSERT INTO products VALUES ('a')`);database.transaction(inner=>inner.run(`INSERT INTO products VALUES ('b')`));});
    assert.equal(notifications,1);assert.equal(changeRevision(database,["products"]),"1");unsubscribe();broken();database.close();
  });
  it("does not notify for rolled-back writes or zero affected rows", () => {
    database.run(`CREATE TABLE products(id TEXT PRIMARY KEY)`);let notifications=0;
    const unsubscribe=subscribeChanges(database,["products"],()=>{notifications++;});
    assert.throws(()=>database.transaction(tx=>{tx.run(`INSERT INTO products VALUES ('a')`);throw new Error("rollback");}));
    database.run(`UPDATE products SET id='z' WHERE id='missing'`);assert.equal(notifications,0);assert.equal(changeRevision(database,["products"]),"0");unsubscribe();database.close();
  });
});

describe("a retired native handle", () => {
  it("closes once and refuses later queries as an ordinary error instead of touching freed native memory", () => {
    let closes = 0;
    const native = new FakeNative(), original = native.closeSync.bind(native);
    native.closeSync = () => { closes++; original(); };
    const retired = openNativeDatabase(native);
    retired.close(); retired.close();
    assert.equal(closes, 1);
    for (const work of [() => retired.get("SELECT 1"), () => retired.all("SELECT 1"), () => retired.run("SELECT 1"), () => retired.transaction(() => undefined)])
      assert.throws(work, (error: unknown) => error instanceof DatabaseError);
  });
});
