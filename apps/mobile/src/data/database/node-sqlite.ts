/**
 * A {@link Database} backed by Node's built-in SQLite.
 *
 * This is what tests run against. It is real SQLite — the same engine the
 * device uses — so the schema, the constraints, and every query are exercised
 * rather than simulated. What it does not cover is the native module the app
 * loads, which needs a device.
 */

import { DatabaseSync } from "node:sqlite";

import {
  DatabaseError,
  type Database,
  type Queryable,
  type Row,
  type SqlValue,
  type WriteResult,
} from "./driver.ts";

/** Options for opening a database. */
export interface OpenOptions {
  /**
   * Where the file lives. Defaults to `:memory:`, which is what tests want:
   * each one gets a database of its own and nothing survives between them.
   */
  readonly location?: string;
}

/**
 * Opens a SQLite database with the settings this application needs.
 */
export function openDatabase(options: OpenOptions = {}): Database {
  const connection = new DatabaseSync(options.location ?? ":memory:");

  // Foreign keys are off by default in SQLite, which would silently disable
  // every relationship the schema declares. Nothing else here matters if this
  // is missed.
  connection.exec("PRAGMA foreign_keys = ON");

  // Write-ahead logging lets a read run while a write is in flight. On a till
  // that means a product search does not block behind a sale being recorded.
  connection.exec("PRAGMA journal_mode = WAL");

  // NORMAL rather than FULL: with WAL this still survives a process crash, and
  // only loses the last transactions if the whole device loses power. The
  // alternative is an fsync per commit, which on cheap Android storage is the
  // difference between a till that feels instant and one that does not.
  connection.exec("PRAGMA synchronous = NORMAL");

  // Wait rather than fail immediately if another connection holds a write lock.
  connection.exec("PRAGMA busy_timeout = 5000");

  return new NodeSqliteDatabase(connection);
}

class NodeSqliteDatabase implements Database {
  #connection: DatabaseSync;
  /** Depth of nested transaction calls; only the outermost commits. */
  #depth = 0;

  constructor(connection: DatabaseSync) {
    this.#connection = connection;
  }

  run(sql: string, parameters: readonly SqlValue[] = []): WriteResult {
    try {
      const statement = this.#connection.prepare(sql);
      const result = statement.run(...(parameters as SqlValue[]));
      return { changes: Number(result.changes) };
    } catch (cause) {
      throw new DatabaseError(describe(cause), sql, { cause });
    }
  }

  all(sql: string, parameters: readonly SqlValue[] = []): Row[] {
    try {
      const statement = this.#connection.prepare(sql);
      return statement.all(...(parameters as SqlValue[])) as Row[];
    } catch (cause) {
      throw new DatabaseError(describe(cause), sql, { cause });
    }
  }

  get(sql: string, parameters: readonly SqlValue[] = []): Row | undefined {
    try {
      const statement = this.#connection.prepare(sql);
      return statement.get(...(parameters as SqlValue[])) as Row | undefined;
    } catch (cause) {
      throw new DatabaseError(describe(cause), sql, { cause });
    }
  }

  transaction<T>(work: (tx: Queryable) => T): T {
    // A nested call joins the outer transaction. Starting a real inner one
    // would mean an inner rollback could leave the outer half-applied, which is
    // precisely what ADR-014 forbids: a business write and its outbox event
    // must be all or nothing together.
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return work(this);
      } finally {
        this.#depth -= 1;
      }
    }

    this.#connection.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    try {
      const result = work(this);
      this.#connection.exec("COMMIT");
      return result;
    } catch (error) {
      // Rolling back must not mask the error that caused it. If the rollback
      // itself fails there is nothing useful left to do, and the original
      // failure is the one worth reporting.
      try {
        this.#connection.exec("ROLLBACK");
      } catch {
        // Intentionally ignored; see above.
      }
      throw error;
    } finally {
      this.#depth = 0;
    }
  }

  close(): void {
    this.#connection.close();
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
