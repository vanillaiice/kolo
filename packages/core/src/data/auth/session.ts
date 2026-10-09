/**
 * Who this till is, and what it holds to prove it (ADR-012).
 *
 * A device is enrolled once — a shop, a person, an installation — and then
 * works offline for as long as the session lasts, which is deliberately a long
 * time: a session that lapsed mid-trading would lock a shop out of its own till,
 * exactly the failure ADR-001 exists to prevent.
 *
 * Two stores are involved and the split is the point. The *record* of being
 * enrolled is a row in SQLite, where a screen can read it while drawing. The
 * *token* is in the platform keystore (§37), because it is the one thing here
 * that lets its holder act as this till against the server.
 */

import type { Database, Queryable } from "../database/driver.ts";
import { SESSION_TOKEN_KEY, type SecretStore } from "./secure-store.ts";

/** The identity every write is recorded against. */
export interface Session {
  readonly sessionId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly branchId?: string | undefined;
  readonly userId: string;
  readonly userName: string;
  readonly role: string;
  /**
   * What the server said this user may do, as the server said it.
   *
   * A courtesy for the screens — it is what lets a till hide what a cashier
   * cannot do — and never the enforcement: every request is checked again on
   * the server (§37), which is authoritative (§29).
   */
  readonly permissions: readonly string[];
  readonly deviceId: string;
  /** When the session lapses, as an ISO instant. */
  readonly expiresAt: string;
}

/** What a successful login yields, in the shape the server sends it. */
export interface Enrolment {
  readonly token: string;
  readonly business: {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
  };
  /**
   * The branches this login refers to — the user's, the device's, or neither,
   * which is the MVP's single-branch case (§42).
   *
   * They arrive with the login because the device has no other way to learn
   * them, and it stores its records against them: a branch identifier with no
   * branch behind it names something the device cannot place.
   */
  readonly branches: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly branchId?: string | undefined;
    readonly permissions: readonly string[];
  };
  readonly device: {
    readonly id: string;
    readonly label: string;
    readonly platform: string;
    readonly branchId?: string | undefined;
  };
  readonly session: {
    readonly id: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  };
}

/** Raised when a login cannot be stored on this device. */
export class EnrolmentError extends Error {
  /** A stable code, because the screen speaks French and English (§44). */
  readonly code: EnrolmentProblem;

  constructor(code: EnrolmentProblem, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EnrolmentError";
    this.code = code;
  }
}

/** What can stop a login being stored. */
export type EnrolmentProblem =
  /** The device already holds another shop's data. */
  | "another_business"
  /** The business does not trade in XAF, which is all this build handles. */
  | "unsupported_currency";

/** The only currency this build knows (§46, spec §63). */
const CURRENCY = "XAF";

/**
 * Stores a login, so the device is enrolled and can trade offline.
 *
 * The order is deliberate: **the token is written first**, then the rows. If
 * the second half fails the device is left with a secret nothing reads, which
 * the next login overwrites; the other order would leave a device that looks
 * enrolled and cannot authenticate — a till that appears to work and whose
 * every sync is refused.
 */
export async function enrol(
  database: Database,
  secrets: SecretStore,
  enrolment: Enrolment,
  now: Date = new Date(),
): Promise<Session> {
  if (enrolment.business.currency !== CURRENCY) {
    // Refused rather than stored, because nothing above this point carries a
    // currency: every amount on the device is minor units of XAF (§46), and
    // accepting a shop that trades in something else would relabel every price
    // in it rather than convert it.
    throw new EnrolmentError(
      "unsupported_currency",
      `this build handles ${CURRENCY} only, and the business trades in ${enrolment.business.currency}`,
    );
  }

  const held = businessOnDevice(database);
  if (held !== undefined && held !== enrolment.business.id) {
    // One device, one shop. Mixing two tenants into one file is the failure
    // ADR-008 exists to prevent, and it cannot be undone afterwards: the rows
    // are already interleaved by the time anyone notices.
    throw new EnrolmentError(
      "another_business",
      "this device already holds another business's data",
    );
  }

  await secrets.write(SESSION_TOKEN_KEY, enrolment.token);

  const at = now.toISOString();
  database.transaction((tx) => {
    writeBusiness(tx, enrolment, at);
    // Before the user and the device, both of which may point at one.
    writeBranches(tx, enrolment, at);
    writeUser(tx, enrolment, at);
    writeDevice(tx, enrolment, at);
    tx.run(
      `INSERT INTO device_session
         (id, session_id, business_id, user_id, device_id, issued_at, expires_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         session_id = excluded.session_id,
         business_id = excluded.business_id,
         user_id = excluded.user_id,
         device_id = excluded.device_id,
         issued_at = excluded.issued_at,
         expires_at = excluded.expires_at`,
      [
        enrolment.session.id,
        enrolment.business.id,
        enrolment.user.id,
        enrolment.device.id,
        enrolment.session.issuedAt,
        enrolment.session.expiresAt,
      ],
    );
  });

  const session = storedSession(database);
  if (session === undefined) {
    // Unreachable unless the row was removed between the write and this read;
    // reported rather than asserted, since the caller is about to draw a screen
    // with it.
    throw new EnrolmentError("another_business", "the session was not stored");
  }
  return session;
}

/**
 * Reads the session this device holds, or undefined if it is not enrolled.
 *
 * Undefined is a real answer, not a failure: an app installed and never logged
 * in has no business and no user, and inventing one would be worse than saying
 * so — it would attribute a shop's sales to a user nobody registered.
 *
 * An expired session is still returned. Whether the device may keep trading on
 * it is a decision for the screen above, and one this layer must not make
 * silently: a till that went blank because a token lapsed overnight would lose
 * the shop its morning.
 */
export function storedSession(database: Queryable): Session | undefined {
  const row = database.get(
    `SELECT s.session_id, s.expires_at,
            b.id AS business_id, b.name AS business_name,
            u.id AS user_id, u.name AS user_name, u.role, u.permissions, u.branch_id,
            d.id AS device_id
       FROM device_session s
       JOIN businesses b ON b.id = s.business_id
       JOIN users u ON u.id = s.user_id
       JOIN devices d ON d.id = s.device_id
      WHERE s.id = 1`,
  );
  if (row === undefined) {
    return undefined;
  }

  const branchId = row["branch_id"];
  return {
    sessionId: String(row["session_id"]),
    businessId: String(row["business_id"]),
    businessName: String(row["business_name"]),
    branchId: branchId === null ? undefined : String(branchId),
    userId: String(row["user_id"]),
    userName: String(row["user_name"]),
    role: String(row["role"]),
    permissions: parsePermissions(row["permissions"]),
    deviceId: String(row["device_id"]),
    expiresAt: String(row["expires_at"]),
  };
}

/** Whether a session has lapsed at the given moment. */
export function hasExpired(session: Session, now: Date = new Date()): boolean {
  return Date.parse(session.expiresAt) <= now.getTime();
}

/**
 * Whether the session holds a permission (§38).
 *
 * A lookup, not a rule: the server resolved role defaults, grants and
 * revocations when it issued the session, and re-deriving that here would hand
 * back a permission the server had revoked — a role's defaults would put it
 * straight back.
 */
export function may(session: Session, permission: string): boolean {
  return session.permissions.includes(permission);
}

/** The token to present to the server, or undefined if there is none. */
export async function sessionToken(secrets: SecretStore): Promise<string | undefined> {
  return await secrets.read(SESSION_TOKEN_KEY);
}

/**
 * Ends the session on this device, keeping everything the shop recorded.
 *
 * The business data stays deliberately. A till may have a day of sales that
 * have not reached the server, and signing out is not a decision to discard
 * them — the next login on the same business finds them still queued.
 *
 * The order mirrors {@link enrol}: the row goes first, so a keystore that fails
 * leaves a secret nothing reads rather than a device that still looks enrolled.
 */
export async function signOut(database: Database, secrets: SecretStore): Promise<void> {
  database.run(`DELETE FROM device_session WHERE id = 1`);
  await secrets.forget(SESSION_TOKEN_KEY);
}

/** The business whose data this device already holds, if any. */
function businessOnDevice(database: Queryable): string | undefined {
  const row = database.get(`SELECT id FROM businesses LIMIT 1`);
  return row === undefined ? undefined : String(row["id"]);
}

function writeBusiness(tx: Queryable, enrolment: Enrolment, at: string): void {
  tx.run(
    `INSERT INTO businesses (id, name, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name,
       currency = excluded.currency,
       updated_at = excluded.updated_at`,
    [enrolment.business.id, enrolment.business.name, enrolment.business.currency, at, at],
  );
}

function writeBranches(tx: Queryable, enrolment: Enrolment, at: string): void {
  for (const branch of enrolment.branches) {
    tx.run(
      `INSERT INTO branches (id, business_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at`,
      [branch.id, enrolment.business.id, branch.name, at, at],
    );
  }
}

function writeUser(tx: Queryable, enrolment: Enrolment, at: string): void {
  tx.run(
    `INSERT INTO users (id, business_id, branch_id, name, role, permissions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       branch_id = excluded.branch_id,
       name = excluded.name,
       role = excluded.role,
       permissions = excluded.permissions,
       updated_at = excluded.updated_at`,
    [
      enrolment.user.id,
      enrolment.business.id,
      enrolment.user.branchId ?? null,
      enrolment.user.name,
      enrolment.user.role,
      JSON.stringify([...enrolment.user.permissions]),
      at,
      at,
    ],
  );
}

function writeDevice(tx: Queryable, enrolment: Enrolment, at: string): void {
  tx.run(
    `INSERT INTO devices (id, business_id, branch_id, label, platform, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       branch_id = excluded.branch_id,
       label = excluded.label,
       platform = excluded.platform,
       updated_at = excluded.updated_at,
       last_seen_at = excluded.last_seen_at`,
    [
      enrolment.device.id,
      enrolment.business.id,
      enrolment.device.branchId ?? null,
      enrolment.device.label,
      enrolment.device.platform,
      at,
      at,
      at,
    ],
  );
}

/** Reads the stored permission list, tolerating anything that is not one. */
function parsePermissions(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    // A device that could not read its permission list is told it has none,
    // which hides buttons rather than showing ones the server will refuse.
    return [];
  }
}
