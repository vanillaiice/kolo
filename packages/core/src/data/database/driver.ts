/**
 * The narrow surface the data layer needs from a SQLite driver.
 *
 * The application runs a native SQLite module; tests run `node:sqlite`. The
 * same SQL executes against both, so a query is exercised for real rather than
 * mocked, the same reasoning that puts the server's repository tests against a
 * real PostgreSQL (ADR-013, ADR-014). Only this thin adapter differs.
 *
 * It is deliberately small. Anything richer would be a second query builder to
 * keep working, and would tempt the data layer into depending on one driver's
 * conveniences.
 */

/** A value SQLite can store. */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** A row as returned by a query, keyed by column name. */
export type Row = Record<string, SqlValue>;

/** What a write reports back. */
export interface WriteResult {
  /** How many rows the statement changed. */
  readonly changes: number;
}

/**
 * A connection that can read and write.
 *
 * Every method takes the full SQL and its parameters. Parameters are always
 * bound, never interpolated: a product name with an apostrophe in it is
 * ordinary in this market, and string-built SQL would break on it long before
 * anyone tried anything malicious.
 */
export interface Queryable {
  /** Runs a statement that returns no rows. */
  run(sql: string, parameters?: readonly SqlValue[]): WriteResult;
  /** Returns every row a query produces. */
  all(sql: string, parameters?: readonly SqlValue[]): Row[];
  /** Returns the first row a query produces, or undefined. */
  get(sql: string, parameters?: readonly SqlValue[]): Row | undefined;
}

/**
 * A database.
 *
 * `transaction` is the only way to write. ADR-014 requires a business write and
 * its outbox event to commit together, and a connection that could be written
 * to directly would make it possible to write one without the other.
 */
export interface Database extends Queryable {
  /**
   * Runs work inside a transaction, committing if it returns and rolling back
   * if it throws.
   *
   * Nested calls join the outer transaction rather than starting a new one, so
   * a repository method is free to call another without either needing to know
   * which of them owns the transaction.
   */
  transaction<T>(work: (tx: Queryable) => T): T;

  /** Closes the database. */
  close(): void;
}

/**
 * Raised when the driver rejects a statement.
 *
 * It carries the SQL, because a constraint violation reported without the
 * statement that caused it is close to undiagnosable. Parameters are
 * deliberately not carried: they hold business data, and an error that reaches
 * a log should not take a customer's phone number with it.
 */
export class DatabaseError extends Error {
  readonly sql: string;

  constructor(message: string, sql: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseError";
    this.sql = sql;
  }
}
