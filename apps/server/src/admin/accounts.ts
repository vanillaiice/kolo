import { randomBytes, randomUUIDv7, scrypt, timingSafeEqual } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { ServerDatabase } from "../database.js";
import { sha256 } from "../identity.js";

/** Operator roles: `admin` changes things, `viewer` only reads. */
export type AdminRole = "admin" | "viewer";
/** The signed-in operator, resolved from a session cookie on every request. */
export interface Admin { readonly adminId: string; readonly username: string; readonly role: AdminRole }
/** A resolved dashboard session: who, which session (by token hash), and when it was last confirmed (step-up). */
export interface AdminSession { readonly admin: Admin; readonly tokenHash: string; readonly expiresAt: Date; readonly confirmedAt: Date | null }
/** Who wrote an audit entry; the CLI writes as `cli` with no ID. */
export interface AuditActor { readonly adminId: string | null; readonly username: string; readonly address?: string | null }

/** Stable admin failure; the code is the whole client-visible explanation. */
export class AdminError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(code); this.name = "AdminError"; this.status = status; this.code = code; }
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const LOCK_AFTER = 5, LOCK_MINUTES = 15;
const CLI: AuditActor = { adminId: null, username: "cli", address: null };
/** Session lifetimes: idle sign-out and an absolute cap. */
export const ADMIN_IDLE_MINUTES = 30, ADMIN_SESSION_HOURS = 12;
/** How long a step-up confirmation lets a session make sensitive changes (ADR-045). */
export const STEP_UP_MINUTES = 5;
// Spent on unknown names, so timing does not reveal which accounts exist.
const DUMMY_HASH = "scrypt$32768$8$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000";

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, SCRYPT, (error, key) => error === null ? resolve(key) : reject(error)));
}

/** Rejects passwords an operator could guess or mistype into something weak. */
export function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < 12 || password.length > 256 || /^\d+$/.test(password)) throw new AdminError(400, "weak_password");
}

/** A random 24-character password for a new operator, shown once. */
export function generatePassword(): string { return randomBytes(18).toString("base64url"); }

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
export async function createAdmin(db: Kysely<ServerDatabase>, input: { readonly username: string; readonly password: string; readonly role: AdminRole }, actor: AuditActor = CLI): Promise<{ readonly adminId: string; readonly username: string; readonly secret: string; readonly uri: string }> {
  const username = String(input.username).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new AdminError(400, "invalid_username");
  if (!["admin", "viewer"].includes(input.role)) throw new AdminError(400, "invalid_role");
  const secret = new Secret({ size: 20 }).base32, adminId = randomUUIDv7(), passwordHash = await hashPassword(input.password);
  await db.transaction().execute(async tx => {
    if (await tx.selectFrom("admins").select("admin_id").where("username", "=", username).executeTakeFirst() !== undefined) throw new AdminError(409, "username_taken");
    await tx.insertInto("admins").values({ admin_id: adminId, username, role: input.role, password_hash: passwordHash, totp_secret: secret, totp_last_step: null, locked_until: null, last_login_at: null }).execute();
    await audit(tx, actor, "admin.create", username, actor.address ?? null, { role: input.role });
  });
  return { adminId, username, secret, uri: totp(username, secret).toString() };
}

/** Replaces an operator's authenticator secret, for a lost phone, by username or ID. Unlocks the account and signs every session out. */
export async function resetTotp(db: Kysely<ServerDatabase>, who: string | { readonly adminId: string }, actor: AuditActor = CLI): Promise<{ readonly username: string; readonly secret: string; readonly uri: string }> {
  const secret = new Secret({ size: 20 }).base32;
  const username = await db.transaction().execute(async tx => {
    const admin = await (typeof who === "string" ? tx.selectFrom("admins").select(["admin_id", "username"]).where("username", "=", who) : tx.selectFrom("admins").select(["admin_id", "username"]).where("admin_id", "=", who.adminId)).forUpdate().executeTakeFirst();
    if (admin === undefined) throw new AdminError(404, "not_found");
    await tx.updateTable("admins").set({ totp_secret: secret, totp_last_step: null, failed_attempts: 0, locked_until: null }).where("admin_id", "=", admin.admin_id).execute();
    await tx.deleteFrom("admin_sessions").where("admin_id", "=", admin.admin_id).execute();
    await audit(tx, actor, "admin.reset_totp", admin.username, actor.address ?? null, null);
    return admin.username;
  });
  return { username, secret, uri: totp(username, secret).toString() };
}

type AdminRow = Selectable<ServerDatabase["admins"]>;
interface Credentials { readonly code: string; readonly address: string; readonly now: Date; readonly totp?: boolean }

/**
 * Decides one credential attempt inside the caller's transaction: lockout, password (derived beforehand) and, unless
 * the second factor is off, a fresh authenticator step claimed under the row lock so it can never be spent twice.
 * A failure is counted in SQL (parallel failures each add one) and audited as `failure`; the refusal is returned,
 * not thrown, so the transaction commits the counter and the audit entry it describes. On success `onSuccess` columns
 * are set alongside the claim.
 */
async function claimCredentials(tx: Transaction<ServerDatabase>, row: AdminRow | undefined, username: string, passwordOk: boolean, input: Credentials, failure: string, onSuccess: { last_login_at?: Date }): Promise<AdminError | undefined> {
  const fail = async (reason: string): Promise<AdminError> => {
    if (row !== undefined) await tx.updateTable("admins").set({ failed_attempts: sql`failed_attempts + 1`,
      locked_until: sql`CASE WHEN failed_attempts + 1 >= ${LOCK_AFTER} THEN ${new Date(input.now.getTime() + LOCK_MINUTES * 60_000)} ELSE locked_until END` }).where("admin_id", "=", row.admin_id).execute();
    await audit(tx, { adminId: row?.admin_id ?? null, username: username || "unknown" }, failure, null, input.address, { reason });
    return new AdminError(401, "invalid_credentials");
  };
  if (row === undefined || !row.active) return fail("unknown");
  if (row.locked_until !== null && row.locked_until > input.now) { await audit(tx, { adminId: row.admin_id, username }, "admin.sign_in_locked", null, input.address, null); return new AdminError(423, "account_locked"); }
  if (!passwordOk) return fail("password");
  let step: number | null = null;
  if (input.totp ?? true) {
    const delta = /^\d{6}$/.test(String(input.code)) ? totp(username, row.totp_secret).validate({ token: String(input.code), timestamp: input.now.getTime(), window: 1 }) : null;
    step = Math.floor(input.now.getTime() / 30_000) + (delta ?? 0);
    if (delta === null || (row.totp_last_step !== null && step <= Number(row.totp_last_step))) return fail("code");
  }
  // Claimed conditionally: a parallel attempt that already spent this step, or a lockout that landed after the read, wins.
  const claimed = await tx.updateTable("admins").set({ failed_attempts: 0, locked_until: null, ...(step === null ? {} : { totp_last_step: String(step) }), ...onSuccess })
    .where("admin_id", "=", row.admin_id).where("active", "=", true).where(where => where.or([where("locked_until", "is", null), where("locked_until", "<=", input.now)]))
    .$if(step !== null, query => query.where(where => where.or([where("totp_last_step", "is", null), where("totp_last_step", "<", String(step))])))
    .executeTakeFirst();
  return claimed.numUpdatedRows === 1n ? undefined : fail("code");
}

/**
 * Password plus a fresh TOTP code (or the password alone where the operator turned TOTP off on a loopback-only
 * dashboard). Repeated failures lock the account for a while; a code is accepted once only.
 * Every outcome is audited. Returns a session token for an HttpOnly cookie; only its hash is stored.
 */
export async function signIn(db: Kysely<ServerDatabase>, input: { readonly username: string; readonly password: string } & Credentials): Promise<{ readonly token: string; readonly admin: Admin }> {
  const username = String(input.username).trim().toLowerCase().slice(0, 64), address = input.address.slice(0, 64);
  const row = await db.selectFrom("admins").selectAll().where("username", "=", username).executeTakeFirst();
  const passwordOk = await passwordMatches(String(input.password).slice(0, 256), row?.password_hash ?? DUMMY_HASH);
  const outcome = await db.transaction().execute(async (tx): Promise<{ token: string; admin: Admin } | AdminError> => {
    const refused = await claimCredentials(tx, row, username, passwordOk, { ...input, address }, "admin.sign_in_failed", { last_login_at: input.now });
    if (refused !== undefined) return refused;
    const token = randomBytes(32).toString("base64url");
    await tx.deleteFrom("admin_sessions").where("expires_at", "<", input.now).execute();
    await tx.insertInto("admin_sessions").values({ token_hash: sha256(token), admin_id: row!.admin_id, expires_at: new Date(input.now.getTime() + ADMIN_SESSION_HOURS * 3_600_000), last_seen_at: input.now, address }).execute();
    await audit(tx, { adminId: row!.admin_id, username }, "admin.sign_in", null, address, (input.totp ?? true) ? null : { second_factor: "off" });
    return { token, admin: { adminId: row!.admin_id, username, role: row!.role } };
  });
  if (outcome instanceof AdminError) throw outcome;
  return outcome;
}

/**
 * Step-up (ADR-045): the signed-in operator re-enters their password and a fresh authenticator code, which marks this
 * session confirmed for `STEP_UP_MINUTES`. Failures count toward the same lockout as sign-in.
 */
export async function confirmSession(db: Kysely<ServerDatabase>, session: AdminSession, input: { readonly password: string } & Credentials): Promise<void> {
  const row = await db.selectFrom("admins").selectAll().where("admin_id", "=", session.admin.adminId).executeTakeFirst();
  const passwordOk = await passwordMatches(String(input.password).slice(0, 256), row?.password_hash ?? DUMMY_HASH);
  const refused = await db.transaction().execute(async tx => {
    const failure = await claimCredentials(tx, row, session.admin.username, passwordOk, input, "admin.confirm_failed", {});
    if (failure !== undefined) return failure;
    await tx.updateTable("admin_sessions").set({ confirmed_at: input.now }).where("token_hash", "=", session.tokenHash).execute();
    await audit(tx, session.admin, "admin.confirm", null, input.address, null);
    return undefined;
  });
  if (refused !== undefined) throw refused;
}

/** Refuses a sensitive change unless this session was confirmed within `STEP_UP_MINUTES`. */
export function requireConfirmed(session: AdminSession, now: Date): void {
  if (session.confirmedAt === null || now.getTime() - session.confirmedAt.getTime() > STEP_UP_MINUTES * 60_000) throw new AdminError(403, "step_up_required");
}

/**
 * Resolves a session token, enforcing idle and absolute expiry and that the account is still active. With `touch`
 * false (a page refreshing itself in the background) the session is not kept alive, so an unattended dashboard still
 * signs out after `ADMIN_IDLE_MINUTES`.
 */
export async function resolveSession(db: Kysely<ServerDatabase>, token: string | undefined, now: Date, touch = true): Promise<AdminSession> {
  if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AdminError(401, "signed_out");
  const hash = sha256(token);
  const row = await db.selectFrom("admin_sessions as s").innerJoin("admins as a", "a.admin_id", "s.admin_id").select(["a.admin_id", "a.username", "a.role", "a.active", "s.expires_at", "s.last_seen_at", "s.confirmed_at"])
    .where("s.token_hash", "=", hash).executeTakeFirst();
  if (row === undefined || !row.active || row.expires_at <= now || row.last_seen_at.getTime() + ADMIN_IDLE_MINUTES * 60_000 <= now.getTime()) {
    if (row !== undefined) await db.deleteFrom("admin_sessions").where("token_hash", "=", hash).execute();
    throw new AdminError(401, "signed_out");
  }
  if (touch) await db.updateTable("admin_sessions").set({ last_seen_at: now }).where("token_hash", "=", hash).execute();
  return { admin: { adminId: row.admin_id, username: row.username, role: row.role }, tokenHash: hash, expiresAt: row.expires_at, confirmedAt: row.confirmed_at };
}

/** The operator behind a session token; see `resolveSession`. */
export async function sessionAdmin(db: Kysely<ServerDatabase>, token: string | undefined, now: Date): Promise<Admin> {
  return (await resolveSession(db, token, now)).admin;
}

/** Ends one session; idempotent. */
export async function signOut(db: Kysely<ServerDatabase>, token: string | undefined, admin: Admin, address: string): Promise<void> {
  await db.transaction().execute(async tx => {
    if (token !== undefined) await tx.deleteFrom("admin_sessions").where("token_hash", "=", sha256(token)).execute();
    await audit(tx, admin, "admin.sign_out", null, address, null);
  });
}

/** One of the operator's own live sessions; `id` is a prefix of the token hash, never the token. */
export interface SessionView { readonly id: string; readonly createdAt: string; readonly lastSeenAt: string; readonly expiresAt: string; readonly address: string; readonly current: boolean }

/** The operator's live sessions, most recent first. */
export async function listSessions(db: Kysely<ServerDatabase>, session: AdminSession, now: Date): Promise<readonly SessionView[]> {
  const rows = await db.selectFrom("admin_sessions").select(["token_hash", "created_at", "last_seen_at", "expires_at", "address"]).where("admin_id", "=", session.admin.adminId)
    .where("expires_at", ">", now).where("last_seen_at", ">", new Date(now.getTime() - ADMIN_IDLE_MINUTES * 60_000)).orderBy("last_seen_at", "desc").execute();
  return rows.map(row => ({ id: row.token_hash.slice(0, 16), createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    address: row.address, current: row.token_hash === session.tokenHash }));
}

/** Ends one of the operator's own sessions by its listed ID, or every other one with `"others"`. Returns how many ended. */
export async function revokeSessions(db: Kysely<ServerDatabase>, session: AdminSession, which: string, address: string): Promise<number> {
  if (which !== "others" && !/^[a-f0-9]{16}$/.test(which)) throw new AdminError(404, "not_found");
  return db.transaction().execute(async tx => {
    let query = tx.deleteFrom("admin_sessions").where("admin_id", "=", session.admin.adminId);
    query = which === "others" ? query.where("token_hash", "<>", session.tokenHash) : query.where("token_hash", "like", `${which}%`);
    const ended = Number((await query.executeTakeFirst()).numDeletedRows);
    if (which !== "others" && ended === 0) throw new AdminError(404, "not_found");
    await audit(tx, session.admin, "admin.session_revoke", null, address, { sessions: ended, ...(which === "others" ? { others: true } : {}) });
    return ended;
  });
}

/** Replaces the operator's own password and signs their other sessions out. Requires a confirmed session. */
export async function changePassword(db: Kysely<ServerDatabase>, session: AdminSession, password: string, address: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await db.transaction().execute(async tx => {
    await tx.updateTable("admins").set({ password_hash: passwordHash }).where("admin_id", "=", session.admin.adminId).execute();
    await tx.deleteFrom("admin_sessions").where("admin_id", "=", session.admin.adminId).where("token_hash", "<>", session.tokenHash).execute();
    await audit(tx, session.admin, "admin.password_change", session.admin.username, address, null);
  });
}

/** An operator account as listed to admins; never secrets or hashes. */
export interface OperatorView { readonly adminId: string; readonly username: string; readonly role: AdminRole; readonly active: boolean; readonly locked: boolean;
  readonly createdAt: string; readonly lastLoginAt: string | null; readonly sessions: number }

/** Every operator account, by username. */
export async function listOperators(db: Kysely<ServerDatabase>, now: Date): Promise<readonly OperatorView[]> {
  const rows = await db.selectFrom("admins as a").select(["a.admin_id", "a.username", "a.role", "a.active", "a.locked_until", "a.created_at", "a.last_login_at",
    eb => eb.selectFrom("admin_sessions as s").select(eb.fn.countAll().as("n")).whereRef("s.admin_id", "=", "a.admin_id").where("s.expires_at", ">", now)
      .where("s.last_seen_at", ">", new Date(now.getTime() - ADMIN_IDLE_MINUTES * 60_000)).as("sessions")]).orderBy("a.username").execute();
  return rows.map(row => ({ adminId: row.admin_id, username: row.username, role: row.role, active: row.active, locked: row.locked_until !== null && row.locked_until > now,
    createdAt: row.created_at.toISOString(), lastLoginAt: row.last_login_at?.toISOString() ?? null, sessions: Number(row.sessions ?? 0) }));
}

/** A change to another operator's account. */
export type OperatorChange = { readonly kind: "deactivate" } | { readonly kind: "activate" } | { readonly kind: "unlock" } | { readonly kind: "role"; readonly role: AdminRole };

/**
 * Changes another operator's account, audited as `admin.<kind>`. An operator never changes their own account here
 * (`self_change`), and the last active admin can be neither deactivated nor demoted (`last_admin`): the active admin
 * rows are locked first, so two parallel changes cannot both pass the count. Deactivating signs the account out.
 * A change that is already in effect does nothing and records nothing.
 */
export async function changeOperator(db: Kysely<ServerDatabase>, actor: AuditActor & { readonly adminId: string }, adminId: string, change: OperatorChange): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(adminId)) throw new AdminError(404, "not_found");
  if (change.kind === "role" && change.role !== "admin" && change.role !== "viewer") throw new AdminError(400, "invalid_role");
  if (adminId === actor.adminId) throw new AdminError(409, "self_change");
  await db.transaction().execute(async tx => {
    const admins = await tx.selectFrom("admins").select("admin_id").where("role", "=", "admin").where("active", "=", true).orderBy("admin_id").forUpdate().execute();
    const target = await tx.selectFrom("admins").select(["admin_id", "username", "role", "active", "locked_until"]).where("admin_id", "=", adminId).forUpdate().executeTakeFirst();
    if (target === undefined) throw new AdminError(404, "not_found");
    const losesAdmin = target.active && target.role === "admin" && (change.kind === "deactivate" || change.kind === "role" && change.role === "viewer");
    if (losesAdmin && admins.filter(row => row.admin_id !== adminId).length === 0) throw new AdminError(409, "last_admin");
    const set = change.kind === "deactivate" ? (target.active ? { active: false } : undefined)
      : change.kind === "activate" ? (target.active ? undefined : { active: true, failed_attempts: 0, locked_until: null })
      : change.kind === "unlock" ? (target.locked_until === null ? undefined : { failed_attempts: 0, locked_until: null })
      : (target.role === change.role ? undefined : { role: change.role });
    if (set === undefined) return;
    await tx.updateTable("admins").set(set).where("admin_id", "=", adminId).execute();
    if (change.kind === "deactivate") await tx.deleteFrom("admin_sessions").where("admin_id", "=", adminId).execute();
    await audit(tx, actor, `admin.${change.kind}`, target.username, actor.address ?? null, change.kind === "role" ? { from: target.role, to: change.role } : null);
  });
}

/** Appends one audit entry inside the caller's transaction, so a change and its record commit together. The database chains it (ADR-045). */
export async function audit(tx: Transaction<ServerDatabase> | Kysely<ServerDatabase>, admin: { readonly adminId: string | null; readonly username: string }, action: string, target: string | null, address: string | null, detail: Record<string, unknown> | null): Promise<void> {
  await tx.insertInto("admin_audit").values({ admin_id: admin.adminId, username: admin.username.slice(0, 64), action, target: target?.slice(0, 200) ?? null, address: address?.slice(0, 64) ?? null,
    detail: detail === null ? null : JSON.stringify(detail) }).execute();
}
