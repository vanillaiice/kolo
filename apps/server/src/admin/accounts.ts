import { randomBytes, randomUUIDv7, scrypt, timingSafeEqual } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ServerDatabase } from "../database.js";
import { sha256 } from "../identity.js";

/** Operator roles: `admin` changes things, `viewer` only reads. */
export type AdminRole = "admin" | "viewer";
/** The signed-in operator, resolved from a session cookie on every request. */
export interface Admin { readonly adminId: string; readonly username: string; readonly role: AdminRole }

/** Stable admin failure; the code is the whole client-visible explanation. */
export class AdminError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(code); this.name = "AdminError"; this.status = status; this.code = code; }
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const LOCK_AFTER = 5, LOCK_MINUTES = 15;
/** Session lifetimes: idle sign-out and an absolute cap. */
export const ADMIN_IDLE_MINUTES = 30, ADMIN_SESSION_HOURS = 12;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, SCRYPT, (error, key) => error === null ? resolve(key) : reject(error)));
}

/** Rejects passwords an operator could guess or mistype into something weak. */
export function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < 12 || password.length > 256 || /^\d+$/.test(password)) throw new AdminError(400, "weak_password");
}

/** `scrypt$N$r$p$salt$key`, so parameters can be raised later without breaking existing hashes. */
export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16), key = await derive(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, key] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(key, "hex");
  const actual = await new Promise<Buffer>((resolve, reject) => scrypt(password, Buffer.from(salt, "hex"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem },
    (error, derived) => error === null ? resolve(derived) : reject(error)));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function totp(username: string, secret: string): TOTP {
  return new TOTP({ issuer: "kolo", label: username, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) });
}

/** A new operator: password hash, a fresh TOTP secret and its `otpauth://` URI for an authenticator app. */
export async function createAdmin(db: Kysely<ServerDatabase>, input: { readonly username: string; readonly password: string; readonly role: AdminRole }): Promise<{ readonly adminId: string; readonly secret: string; readonly uri: string }> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new AdminError(400, "invalid_username");
  if (!["admin", "viewer"].includes(input.role)) throw new AdminError(400, "invalid_role");
  const secret = new Secret({ size: 20 }).base32, adminId = randomUUIDv7(), passwordHash = await hashPassword(input.password);
  await db.transaction().execute(async tx => {
    if (await tx.selectFrom("admins").select("admin_id").where("username", "=", username).executeTakeFirst() !== undefined) throw new AdminError(409, "username_taken");
    await tx.insertInto("admins").values({ admin_id: adminId, username, role: input.role, password_hash: passwordHash, totp_secret: secret, totp_last_step: null, locked_until: null, last_login_at: null }).execute();
    await audit(tx, { adminId: null, username: "cli" }, "admin.create", username, null, { role: input.role });
  });
  return { adminId, secret, uri: totp(username, secret).toString() };
}

/** Replaces an operator's authenticator secret, for a lost phone. Signs every session out. */
export async function resetTotp(db: Kysely<ServerDatabase>, username: string): Promise<{ readonly secret: string; readonly uri: string }> {
  const secret = new Secret({ size: 20 }).base32;
  await db.transaction().execute(async tx => {
    const admin = await tx.selectFrom("admins").select("admin_id").where("username", "=", username).executeTakeFirst();
    if (admin === undefined) throw new AdminError(404, "not_found");
    await tx.updateTable("admins").set({ totp_secret: secret, totp_last_step: null, failed_attempts: 0, locked_until: null }).where("admin_id", "=", admin.admin_id).execute();
    await tx.deleteFrom("admin_sessions").where("admin_id", "=", admin.admin_id).execute();
    await audit(tx, { adminId: null, username: "cli" }, "admin.reset_totp", username, null, null);
  });
  return { secret, uri: totp(username, secret).toString() };
}

/**
 * Password plus a fresh TOTP code (or the password alone where the operator turned TOTP off on a loopback-only
 * dashboard). Repeated failures lock the account for a while; a code is accepted once only.
 * Every outcome is audited. Returns a session token for an HttpOnly cookie; only its hash is stored.
 */
export async function signIn(db: Kysely<ServerDatabase>, input: { readonly username: string; readonly password: string; readonly code: string; readonly address: string; readonly now: Date; readonly totp?: boolean }): Promise<{ readonly token: string; readonly admin: Admin }> {
  const totpRequired = input.totp ?? true;
  const username = String(input.username).trim().toLowerCase().slice(0, 64), address = input.address.slice(0, 64);
  const row = await db.selectFrom("admins").selectAll().where("username", "=", username).executeTakeFirst();
  // Spend the same work on unknown names, so timing does not reveal which accounts exist.
  const passwordOk = await passwordMatches(String(input.password).slice(0, 256), row?.password_hash ?? "scrypt$32768$8$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000");
  // A refusal is decided and recorded in one transaction that commits, then raised: the counter and the audit
  // entry must survive the failure they describe.
  const outcome = await db.transaction().execute(async (tx): Promise<{ token: string; admin: Admin } | AdminError> => {
    const fail = async (code: string): Promise<AdminError> => {
      // Counted in SQL, not from the row read above: parallel failures must each add one.
      if (row !== undefined) await tx.updateTable("admins").set({ failed_attempts: sql`failed_attempts + 1`,
        locked_until: sql`CASE WHEN failed_attempts + 1 >= ${LOCK_AFTER} THEN ${new Date(input.now.getTime() + LOCK_MINUTES * 60_000)} ELSE locked_until END` }).where("admin_id", "=", row.admin_id).execute();
      await audit(tx, { adminId: row?.admin_id ?? null, username: username || "unknown" }, "admin.sign_in_failed", null, address, { reason: code });
      return new AdminError(401, "invalid_credentials");
    };
    if (row === undefined || !row.active) return fail("unknown");
    if (row.locked_until !== null && row.locked_until > input.now) { await audit(tx, { adminId: row.admin_id, username }, "admin.sign_in_locked", null, address, null); return new AdminError(423, "account_locked"); }
    if (!passwordOk) return fail("password");
    let step: number | null = null;
    if (totpRequired) {
      const delta = /^\d{6}$/.test(String(input.code)) ? totp(username, row.totp_secret).validate({ token: String(input.code), timestamp: input.now.getTime(), window: 1 }) : null;
      step = Math.floor(input.now.getTime() / 30_000) + (delta ?? 0);
      if (delta === null || (row.totp_last_step !== null && step <= Number(row.totp_last_step))) return fail("code");
    }
    // Claimed conditionally under the row lock: a parallel sign-in that already spent this step, or a lockout that
    // landed after the read above, wins.
    const claimed = await tx.updateTable("admins").set({ failed_attempts: 0, locked_until: null, ...(step === null ? {} : { totp_last_step: String(step) }), last_login_at: input.now })
      .where("admin_id", "=", row.admin_id).where(where => where.or([where("locked_until", "is", null), where("locked_until", "<=", input.now)]))
      .$if(step !== null, query => query.where(where => where.or([where("totp_last_step", "is", null), where("totp_last_step", "<", String(step))])))
      .executeTakeFirst();
    if (claimed.numUpdatedRows !== 1n) return fail("code");
    const token = randomBytes(32).toString("base64url");
    await tx.deleteFrom("admin_sessions").where("expires_at", "<", input.now).execute();
    await tx.insertInto("admin_sessions").values({ token_hash: sha256(token), admin_id: row.admin_id, expires_at: new Date(input.now.getTime() + ADMIN_SESSION_HOURS * 3_600_000), last_seen_at: input.now, address }).execute();
    await audit(tx, { adminId: row.admin_id, username }, "admin.sign_in", null, address, totpRequired ? null : { second_factor: "off" });
    return { token, admin: { adminId: row.admin_id, username, role: row.role } };
  });
  if (outcome instanceof AdminError) throw outcome;
  return outcome;
}

/** Resolves a session token, enforcing idle and absolute expiry and that the account is still active. */
export async function sessionAdmin(db: Kysely<ServerDatabase>, token: string | undefined, now: Date): Promise<Admin> {
  if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AdminError(401, "signed_out");
  const hash = sha256(token);
  const row = await db.selectFrom("admin_sessions as s").innerJoin("admins as a", "a.admin_id", "s.admin_id").select(["a.admin_id", "a.username", "a.role", "a.active", "s.expires_at", "s.last_seen_at"])
    .where("s.token_hash", "=", hash).executeTakeFirst();
  if (row === undefined || !row.active || row.expires_at <= now || row.last_seen_at.getTime() + ADMIN_IDLE_MINUTES * 60_000 <= now.getTime()) {
    if (row !== undefined) await db.deleteFrom("admin_sessions").where("token_hash", "=", hash).execute();
    throw new AdminError(401, "signed_out");
  }
  await db.updateTable("admin_sessions").set({ last_seen_at: now }).where("token_hash", "=", hash).execute();
  return { adminId: row.admin_id, username: row.username, role: row.role };
}

/** Ends one session; idempotent. */
export async function signOut(db: Kysely<ServerDatabase>, token: string | undefined, admin: Admin, address: string): Promise<void> {
  await db.transaction().execute(async tx => {
    if (token !== undefined) await tx.deleteFrom("admin_sessions").where("token_hash", "=", sha256(token)).execute();
    await audit(tx, admin, "admin.sign_out", null, address, null);
  });
}

/** Appends one audit entry inside the caller's transaction, so a change and its record commit together. */
export async function audit(tx: Transaction<ServerDatabase> | Kysely<ServerDatabase>, admin: { readonly adminId: string | null; readonly username: string }, action: string, target: string | null, address: string | null, detail: Record<string, unknown> | null): Promise<void> {
  await tx.insertInto("admin_audit").values({ admin_id: admin.adminId, username: admin.username.slice(0, 64), action, target: target?.slice(0, 200) ?? null, address: address?.slice(0, 64) ?? null,
    detail: detail === null ? null : JSON.stringify(detail) }).execute();
}
