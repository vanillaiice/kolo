import { domainsForWrite, publishChanges, type ChangedDomain } from "./changes.ts";
/**
 * A {@link Database} backed by the device's native SQLite (ADR-016).
 *
 * The counterpart of `node-sqlite.ts`. Both are real SQLite, so the schema, the
 * constraints and every query behave the same on a till as they do in a test —
 * only this adapter differs. What no amount of Node testing covers is the
 * native module itself, which needs a device.
 *
 * ## Why the handle is passed in
 *
 * This file does not import `expo-sqlite`. It takes a handle satisfying
 * {@link NativeDatabase} — the four synchronous methods the data layer needs —
 * and the app entry passes `openDatabaseSync(...)` in.
 *
 * That is not indirection for its own sake. It means the claim "expo-sqlite's
 * API looks like this" is checked at exactly **one** call site, the line that
 * hands the real handle over. If a future SDK renames `getFirstSync`, that line
 * fails to compile and says so, rather than this file quietly describing an API
 * that no longer exists. It also lets these code paths be tested without a
 * device, by passing anything with the same four methods.
 */

import {
  DatabaseError,
  type Database,
  type Queryable,
  type Row,
  type SqlValue,
  type WriteResult,
} from "./driver.ts";

/**
 * The slice of a native SQLite handle this adapter uses.
 *
 * Synchronous throughout, which ADR-016 makes a requirement rather than a
 * preference: `Database.transaction` runs a function to completion so that a
 * business write and its outbox event commit together (ADR-014), and a promise
 * in the middle of that is a seam a caller could break.
 */
export interface NativeDatabase {
  /** Runs statements that take no parameters and return nothing. */
  execSync(source: string): void;
  /** Runs a statement, reporting how many rows it changed. */
  runSync(source: string, params: NativeBindValue[]): { readonly changes: number };
  /** Returns every row a query produces. */
  getAllSync(source: string, params: NativeBindValue[]): unknown[];
  /** Returns the first row a query produces, or null. */
  getFirstSync(source: string, params: NativeBindValue[]): unknown;
  /** Closes the handle. */
  closeSync(): void;
}

/**
 * What the native driver can bind, which is **not** quite {@link SqlValue}.
 *
 * The difference is `bigint`, and it matters. The data layer's value type allows
 * one because `node:sqlite` hands back a bigint for an integer too large for a
 * double; the native driver has no such case and refuses it. Rather than widen
 * the interface to a lie or narrow `SqlValue` and lose what tests read back,
 * {@link bind} converts at this boundary and refuses what cannot survive it.
 *
 * The list is mutable because the driver's own signature is, and a readonly
 * array is not assignable to it.
 */
export type NativeBindValue = string | number | boolean | null | Uint8Array | ArrayBuffer;

/**
 * Converts the data layer's parameters into what the driver can bind.
 *
 * A bigint becomes a number when it fits exactly, and is refused when it does
 * not. Silently truncating is the one thing this must not do: past a safe
 * integer the value is no longer exact, and money that is not exact is not
 * money (ADR-010). Nothing in this application binds one today — every amount
 * is a whole-franc `number` — so this is a guard against a future caller, and
 * it fails loudly rather than rounding somebody's takings.
 */
function bind(parameters: readonly SqlValue[], sql: string): NativeBindValue[] {
  return parameters.map((value) => {
    if (typeof value !== "bigint") {
      return value;
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new DatabaseError(
        `a parameter of ${value} is too large to bind exactly`,
        sql,
      );
    }
    return Number(value);
  });
}

/**
 * Wraps a native handle, applying the same settings the test adapter uses.
 *
 * The pragmas are repeated rather than shared because they are per-connection
 * and this is a different connection, and because a device that silently ran
 * without foreign keys would behave differently from every test, which is the
 * one divergence that would be hardest to find.
 */
export function openNativeDatabase(connection: NativeDatabase): Database {
  // Foreign keys are off by default in SQLite, which would silently disable
  // every relationship the schema declares.
  connection.execSync("PRAGMA foreign_keys = ON");

  // Write-ahead logging lets a read run while a write is in flight. On a till
  // that means a product search does not block behind a sale being recorded.
  connection.execSync("PRAGMA journal_mode = WAL");

  // NORMAL rather than FULL: with WAL this still survives a process crash, and
  // only loses the last transactions if the whole device loses power. The
  // alternative is an fsync per commit, which on cheap Android storage is the
  // difference between a till that feels instant and one that does not (§46).
  connection.execSync("PRAGMA synchronous = NORMAL");

  // Wait rather than fail immediately if another connection holds a write lock.
  connection.execSync("PRAGMA busy_timeout = 5000");

  return new NativeSqliteDatabase(connection);
}

class NativeSqliteDatabase implements Database {
  #connection: NativeDatabase;
  /** Depth of nested transaction calls; only the outermost commits. */
  #depth = 0;
  #changed = new Set<ChangedDomain>();

  constructor(connection: NativeDatabase) {
    this.#connection = connection;
  }

  #closed = false;
  /**
   * The open native handle. A query on a closed expo-sqlite handle corrupts native memory and aborts
   * the app, so it is refused here as an ordinary error instead.
   */
  #live(): NativeDatabase {
    if (this.#closed) throw new DatabaseError("the database is closed", "");
    return this.#connection;
  }

  run(sql: string, parameters: readonly SqlValue[] = []): WriteResult {
    try {
      const result = this.#live().runSync(sql, bind(parameters, sql));
      if (Number(result.changes) > 0) {
        const domains = domainsForWrite(sql);
        if (this.#depth > 0) for (const domain of domains) this.#changed.add(domain);
        else publishChanges(this, new Set(domains));
      }
      return { changes: Number(result.changes) };
    } catch (cause) {
      throw new DatabaseError(describe(cause), sql, { cause });
    }
  }

  all(sql: string, parameters: readonly SqlValue[] = []): Row[] {
    try {
      return this.#live().getAllSync(sql, bind(parameters, sql)) as Row[];
    } catch (cause) {
      throw new DatabaseError(describe(cause), sql, { cause });
    }
  }

  get(sql: string, parameters: readonly SqlValue[] = []): Row | undefined {
    try {
      const row = this.#live().getFirstSync(sql, bind(parameters, sql));
      // The native driver reports "no row" as null; the interface says
      // undefined, and callers test for undefined.
      return row === null || row === undefined ? undefined : (row as Row);
    } catch (cause) {
      throw new DatabaseError(describe(cause), sql, { cause });
    }
  }

  /**
   * Runs work in a transaction, joining an outer one if there is one.
   *
   * `BEGIN IMMEDIATE` explicitly rather than the driver's own transaction
   * helper, so that this adapter and the test adapter have **identical**
   * semantics. A nested call joins the outer transaction: starting a real inner
   * one would mean an inner rollback could leave the outer half-applied, which
   * is precisely what ADR-014 forbids.
   */
  transaction<T>(work: (tx: Queryable) => T): T {
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return work(this);
      } finally {
        this.#depth -= 1;
      }
    }

    this.#live().execSync("BEGIN IMMEDIATE");
    let committed = false;
    this.#changed.clear();
    this.#depth = 1;
    try {
      const result = work(this);
      this.#live().execSync("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      // Rolling back must not mask the error that caused it. If the rollback
      // itself fails there is nothing useful left to do, and the original
      // failure is the one worth reporting.
      try {
        this.#live().execSync("ROLLBACK");
      } catch {
        // Intentionally ignored; see above.
      }
      throw error;
    } finally {
      this.#depth = 0;
      const changed = new Set(this.#changed); this.#changed.clear();
      if (committed) publishChanges(this, changed);
    }
  }

  /** Closes the handle once; later calls are ignored, so a replaced database can be retired safely. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.closeSync();
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
