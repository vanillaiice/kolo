import assert from "node:assert/strict";
import { after, it } from "node:test";
import { randomUUIDv7 } from "node:crypto";
import { TOTP, Secret } from "otpauth";
import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { migrateToLatest, openDatabase, SERVER_MIGRATIONS, type ServerDatabase } from "./database.js";
import { generateServerKey } from "./identity.js";
import { audit, createAdmin } from "./admin/accounts.js";
import { createAdminApplication } from "./admin/admin-app.js";
import { CLI_ACTOR, createMetrics, integrityReport } from "./admin/operations.js";
import { cleanup, freshDatabase } from "./sync.fixtures.js";

const skip = false;
const closers: (() => Promise<unknown>)[] = [];
after(async () => { for (const close of closers.splice(0)) await close(); await cleanup(); });

const PASSWORD = "correct horse battery";
interface Dashboard { base: string; clock: { now: Date }; db: Kysely<ServerDatabase>; metrics: ReturnType<typeof createMetrics> }
async function dashboard(edition: "selfhost" | "hosted" = "selfhost"): Promise<Dashboard> {
  const url = await freshDatabase(), db = openDatabase(url), metrics = createMetrics();
  await migrateToLatest(db);
  // Real time: rows stamped by the database's now() must fall inside the periods the dashboard computes.
  const clock = { now: new Date() };
  const app = await createAdminApplication({ db, key: generateServerKey().key, publicUrl: "https://sync.example.com", metrics, version: "test", uiDir: undefined, now: () => clock.now, rateLimitMax: 3000, edition: { edition, graceDays: 7 } });
  app.addHook("onClose", async () => { await db.destroy(); });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  closers.push(() => app.close());
  return { base, clock, db, metrics };
}
const code = (secret: string, username: string, at: Date): string => new TOTP({ issuer: "kolo", label: username, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: at.getTime() });
async function call(d: Dashboard, method: string, path: string, options: { body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { origin: d.base };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  const response = await fetch(`${d.base}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const text = await response.text();
  let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json: json as Record<string, unknown> & { error?: { code: string } }, text, headers: response.headers };
}
/** Signs in one authenticator step after the previous code, so codes are never reused by accident. */
async function operator(d: Dashboard, username: string, role: "admin" | "viewer" = "admin", password = PASSWORD) {
  const { secret, adminId } = await createAdmin(d.db, { username, password, role });
  d.clock.now = new Date(d.clock.now.getTime() + 30_000);
  const response = await call(d, "POST", "/admin/api/session", { body: { username, password, code: code(secret, username, d.clock.now) } });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const confirm = async (pass = password) => { d.clock.now = new Date(d.clock.now.getTime() + 30_000); return call(d, "POST", "/admin/api/session/confirm", { cookie, body: { password: pass, code: code(secret, username, d.clock.now) } }); };
  return { cookie, secret, adminId, confirm };
}
/** A shop; a paid-until date is reached the only way the server allows, through a (long past) payment. */
async function shop(d: Dashboard, name: string, extra: Partial<{ status: "active" | "suspended" | "removed"; paid_until: Date; max_tills: number | null; remove_after: Date | null }> = {}): Promise<string> {
  const id = randomUUIDv7(), { paid_until: paidUntil, ...columns } = extra;
  await d.db.insertInto("shops").values({ business_id: id, name, owner_id: randomUUIDv7(), enrolled_by: randomUUIDv7(), enrolled_at: d.clock.now, status_changed_at: null, remove_after: null, connection_code_id: null, paid_until: null, max_tills: null, ...columns }).execute();
  if (paidUntil !== undefined) {
    await d.db.insertInto("payments").values({ payment_id: randomUUIDv7(), business_id: id, months: 1, amount_minor: "0", currency: "XAF", method: "other", reference: null, source: "code", external_id: null,
      recorded_by: "seed", recorded_at: new Date("2025-01-01T00:00:00.000Z"), paid_until_before: null, paid_until_after: paidUntil }).execute();
    await d.db.updateTable("shops").set({ paid_until: paidUntil }).where("business_id", "=", id).execute();
  }
  return id;
}
async function till(d: Dashboard, shopId: string, extra: Partial<{ held: boolean; last_seen_at: Date | null }> = {}): Promise<string> {
  const id = randomUUIDv7();
  await d.db.insertInto("shop_devices").values({ business_id: shopId, device_id: id, public_key: "-----BEGIN PUBLIC KEY-----", label: "Till", platform: "DESKTOP", authority_allowed: false, active: true, last_seen_at: d.clock.now, ...extra }).execute();
  return id;
}

it("the audit log is a hash chain the database keeps: upgrades chain old entries, parallel writes stay linear, tampering is found", { skip }, async () => {
  const url = await freshDatabase(), db = openDatabase(url);
  try {
    const before = Object.fromEntries(Object.entries(SERVER_MIGRATIONS).filter(([name]) => name < "0010"));
    await new Migrator({ db, provider: { getMigrations: async () => before } }).migrateToLatest();
    for (const action of ["test.one", "test.two", "test.three"]) await audit(db, { adminId: null, username: "cli" }, action, "x", null, { n: action, nested: { "é": [1, "two"] } });
    assert.deepEqual(await migrateToLatest(db), ["0010_audit_chain"]);
    const now = new Date();
    let report = await integrityReport(db, now);
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.equal(report.audit.entries, 3); assert.equal(report.audit.headSeq, "3"); assert.match(report.audit.headHash!, /^[a-f0-9]{64}$/);
    // Twenty parallel writers, plus one statement inserting several rows: one linear chain.
    await Promise.all(Array.from({ length: 20 }, (_, index) => db.transaction().execute(tx => audit(tx, CLI_ACTOR, "test.parallel", String(index), null, null))));
    await db.insertInto("admin_audit").values([{ admin_id: null, username: "cli", action: "test.batch", target: "a", address: null, detail: null }, { admin_id: null, username: "cli", action: "test.batch", target: "b", address: null, detail: null }]).execute();
    const rows = await db.selectFrom("admin_audit").select(["seq", "prev_hash", "hash"]).orderBy("seq").execute();
    assert.deepEqual(rows.map(row => Number(row.seq)), Array.from({ length: 25 }, (_, index) => index + 1));
    rows.forEach((row, index) => assert.equal(row.prev_hash, index === 0 ? "0".repeat(64) : rows[index - 1]!.hash));
    report = await integrityReport(db, now);
    assert.equal(report.ok, true); assert.equal(report.audit.headSeq, "25");
    // The append-only trigger still refuses edits; anything that bypasses it breaks the chain at that entry.
    await assert.rejects(db.updateTable("admin_audit").set({ username: "someone" }).where("seq", "=", "7").execute(), /append-only/);
    await db.transaction().execute(async tx => {
      await sql`ALTER TABLE admin_audit DISABLE TRIGGER admin_audit_append_only`.execute(tx);
      await tx.updateTable("admin_audit").set({ username: "someone" }).where("seq", "=", "7").execute();
      await sql`ALTER TABLE admin_audit ENABLE TRIGGER admin_audit_append_only`.execute(tx);
    });
    report = await integrityReport(db, now);
    assert.deepEqual(report.checks.find(check => check.name === "audit_chain"), { name: "audit_chain", ok: false, targets: ["7"] });
    // A deleted entry leaves a gap and a broken link.
    const other = openDatabase(await freshDatabase()); await migrateToLatest(other);
    try {
      for (const action of ["test.a", "test.b", "test.c"]) await audit(other, CLI_ACTOR, action, null, null, null);
      await other.transaction().execute(async tx => {
        await sql`ALTER TABLE admin_audit DISABLE TRIGGER admin_audit_append_only`.execute(tx);
        await tx.deleteFrom("admin_audit").where("seq", "=", "2").execute();
        await sql`ALTER TABLE admin_audit ENABLE TRIGGER admin_audit_append_only`.execute(tx);
      });
      assert.deepEqual((await integrityReport(other, now)).checks[0]!.targets, ["3"]);
    } finally { await other.destroy(); }
  } finally { await db.destroy(); }
});

it("strict schemas refuse unknown fields and wrong types with stable codes, after the session and role are checked", { skip }, async () => {
  const d = await dashboard("hosted"), admin = await operator(d, "admin"), viewer = await operator(d, "viewer", "viewer"), id = await shop(d, "Boutique");
  const refused = async (method: string, path: string, body: unknown, expected: string, cookie = admin.cookie) => assert.deepEqual((await call(d, method, path, { cookie, body })).json.error?.code, expected, `${path} ${JSON.stringify(body)}`);
  await refused("POST", "/admin/api/codes", { label: "Shop", days: 7, maxTills: null, extra: true }, "invalid_request");
  await refused("POST", "/admin/api/codes", { label: "Shop", days: "7", maxTills: null }, "invalid_expiry");
  await refused("POST", "/admin/api/codes", { label: 12, days: 7, maxTills: null }, "invalid_label");
  await refused("POST", "/admin/api/codes", { label: "Shop", days: 7, maxTills: "3" }, "invalid_till_limit");
  await refused("POST", "/admin/api/codes", { days: 7, maxTills: null }, "invalid_request");
  await refused("POST", "/admin/api/codes", { label: "Shop", days: 7, maxTills: null, extra: true }, "read_only", viewer.cookie);
  await refused("POST", `/admin/api/shops/${id}/payments`, { months: "1", amountMinor: 5000, method: "cash", requestId: randomUUIDv7() }, "invalid_months");
  await refused("POST", `/admin/api/shops/${id}/payments`, { months: 1, amountMinor: 5000, method: "cash", requestId: "not-a-uuid" }, "invalid_request");
  await refused("POST", `/admin/api/shops/${id}/payments`, { months: 1, amountMinor: 5000, method: "cash" }, "invalid_request");
  await refused("POST", `/admin/api/shops/${id}/till-limit`, { maxTills: 2, by: "me" }, "invalid_request");
  await refused("POST", "/admin/api/session", { username: "admin", password: PASSWORD, code: "123456", remember: true }, "invalid_request");
  assert.equal((await call(d, "GET", "/admin/api/shops?search=a&debug=1", { cookie: viewer.cookie })).json.error?.code, "invalid_request");
  assert.equal((await call(d, "GET", "/admin/api/shops?sort=secret", { cookie: viewer.cookie })).json.error?.code, "invalid_request");
  assert.equal((await call(d, "GET", "/admin/api/audit?from=yesterday", { cookie: viewer.cookie })).json.error?.code, "invalid_request");
  assert.equal((await call(d, "GET", "/admin/api/shops/not-an-id", { cookie: viewer.cookie })).status, 404);
  // Without a session nothing is validated or revealed.
  assert.equal((await call(d, "POST", "/admin/api/codes", { body: { nonsense: 1 } })).json.error?.code, "signed_out");
});

it("a payment is recorded once per request ID and a till limit is changed only from the value the operator saw", { skip }, async () => {
  const d = await dashboard("hosted"), admin = await operator(d, "admin"), id = await shop(d, "Boutique");
  const requestId = randomUUIDv7(), body = { months: 3, amountMinor: 15000, method: "mtn_momo", reference: "MM-1", requestId };
  const [first, second] = await Promise.all([call(d, "POST", `/admin/api/shops/${id}/payments`, { cookie: admin.cookie, body }), call(d, "POST", `/admin/api/shops/${id}/payments`, { cookie: admin.cookie, body })]);
  assert.deepEqual([first.status, second.status].sort(), [200, 200].sort());
  const retry = await call(d, "POST", `/admin/api/shops/${id}/payments`, { cookie: admin.cookie, body });
  assert.equal(retry.json["duplicate"], true); assert.equal(retry.json["paidUntilAfter"], first.json["paidUntilAfter"]);
  assert.equal((await d.db.selectFrom("payments").select(eb => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n, "1");
  assert.equal((await d.db.selectFrom("admin_audit").select(eb => eb.fn.countAll().as("n")).where("action", "=", "payment.record").executeTakeFirstOrThrow()).n, "1");
  assert.equal((await call(d, "POST", `/admin/api/shops/${id}/payments`, { cookie: admin.cookie, body: { ...body, months: 6 } })).json.error?.code, "payment_conflict");
  const limit = `/admin/api/shops/${id}/till-limit`;
  assert.deepEqual((await call(d, "POST", limit, { cookie: admin.cookie, body: { maxTills: 3, expected: null } })).json, { released: 0 });
  assert.equal((await call(d, "POST", limit, { cookie: admin.cookie, body: { maxTills: 5, expected: null } })).json.error?.code, "stale", "another operator already set 3");
  assert.deepEqual((await call(d, "POST", limit, { cookie: admin.cookie, body: { maxTills: 5, expected: 3 } })).json, { released: 0 });
});

it("step-up confirmations expire, spend a fresh code, count failures, and guard removal, recovery, password and operator changes", { skip }, async () => {
  const d = await dashboard(), admin = await operator(d, "admin"), id = await shop(d, "Boutique");
  assert.equal((await call(d, "POST", "/admin/api/codes", { cookie: admin.cookie, body: { label: "", days: 1, recoveryShopId: id } })).json.error?.code, "step_up_required");
  assert.equal((await call(d, "POST", "/admin/api/operators", { cookie: admin.cookie, body: { username: "second", role: "viewer" } })).json.error?.code, "step_up_required");
  assert.equal((await call(d, "POST", "/admin/api/account/password", { cookie: admin.cookie, body: { password: "a brand new passphrase" } })).json.error?.code, "step_up_required");
  assert.equal((await admin.confirm("wrong password!!")).json.error?.code, "invalid_credentials");
  assert.equal((await d.db.selectFrom("admins").select("failed_attempts").where("username", "=", "admin").executeTakeFirstOrThrow()).failed_attempts, 1);
  const confirmed = await admin.confirm();
  assert.equal(confirmed.status, 200); assert.equal(confirmed.json["confirmedUntil"], new Date(d.clock.now.getTime() + 5 * 60_000).toISOString());
  // The same code cannot confirm twice.
  assert.equal((await call(d, "POST", "/admin/api/session/confirm", { cookie: admin.cookie, body: { password: PASSWORD, code: code(admin.secret, "admin", d.clock.now) } })).json.error?.code, "invalid_credentials");
  const recovery = await call(d, "POST", "/admin/api/codes", { cookie: admin.cookie, body: { label: "", days: 1, recoveryShopId: id } });
  assert.equal(recovery.status, 200);
  d.clock.now = new Date(d.clock.now.getTime() + 6 * 60_000);
  assert.equal((await call(d, "POST", `/admin/api/shops/${id}/remove`, { cookie: admin.cookie, body: { confirm: id } })).json.error?.code, "step_up_required", "five minutes later the confirmation has lapsed");
  await admin.confirm();
  assert.equal((await call(d, "POST", `/admin/api/shops/${id}/remove`, { cookie: admin.cookie, body: { confirm: id, extra: 1 } })).json.error?.code, "confirmation_required");
  assert.equal((await call(d, "POST", `/admin/api/shops/${id}/remove`, { cookie: admin.cookie, body: { confirm: id } })).status, 204);
  const actions = (await d.db.selectFrom("admin_audit").select("action").execute()).map(row => row.action);
  for (const action of ["admin.confirm", "admin.confirm_failed", "code.issue_recovery", "shop.remove"]) assert.ok(actions.includes(action), action);
});

it("operators manage their own sessions and password; admins manage other operators but never themselves or the last admin", { skip }, async () => {
  const d = await dashboard(), admin = await operator(d, "admin"), viewer = await operator(d, "viewer", "viewer");
  // A second session for the admin, then the list, a revoke, and signing out the others.
  d.clock.now = new Date(d.clock.now.getTime() + 30_000);
  const other = (await call(d, "POST", "/admin/api/session", { body: { username: "admin", password: PASSWORD, code: code(admin.secret, "admin", d.clock.now) } })).headers.get("set-cookie")!.split(";")[0]!;
  const sessions = (await call(d, "GET", "/admin/api/account/sessions", { cookie: admin.cookie })).json["sessions"] as { id: string; current: boolean }[];
  assert.equal(sessions.length, 2); assert.equal(sessions.filter(item => item.current).length, 1);
  const viewerSession = ((await call(d, "GET", "/admin/api/account/sessions", { cookie: viewer.cookie })).json["sessions"] as { id: string }[])[0]!;
  assert.equal((await call(d, "DELETE", `/admin/api/account/sessions/${viewerSession.id}`, { cookie: admin.cookie })).status, 404, "nobody ends another operator's session here");
  assert.deepEqual((await call(d, "POST", "/admin/api/account/sessions/sign-out-others", { cookie: admin.cookie })).json, { ended: 1 });
  assert.equal((await call(d, "GET", "/admin/api/me", { cookie: other })).status, 401);
  assert.equal((await call(d, "GET", "/admin/api/me", { cookie: viewer.cookie })).status, 200);
  // The viewer changes their own password after a step-up; it must be strong.
  await viewer.confirm();
  assert.equal((await call(d, "POST", "/admin/api/account/password", { cookie: viewer.cookie, body: { password: "short" } })).json.error?.code, "weak_password");
  assert.equal((await call(d, "POST", "/admin/api/account/password", { cookie: viewer.cookie, body: { password: "a brand new passphrase" } })).status, 204);
  assert.equal((await call(d, "GET", "/admin/api/operators", { cookie: viewer.cookie })).json.error?.code, "read_only");
  // Admins: create, then change another operator; never themselves, never the last admin.
  await admin.confirm();
  const created = await call(d, "POST", "/admin/api/operators", { cookie: admin.cookie, body: { username: "Night.Shift", role: "admin" } });
  assert.equal(created.status, 200); assert.equal(created.json["username"], "night.shift"); assert.match(String(created.json["password"]), /^[A-Za-z0-9_-]{24}$/);
  assert.match(String(created.json["uri"]), /^otpauth:\/\/totp\//); assert.match(String(created.json["qr"]), /^<svg/);
  assert.equal((await call(d, "POST", "/admin/api/operators", { cookie: admin.cookie, body: { username: "night.shift", role: "viewer" } })).json.error?.code, "username_taken");
  const night = String(created.json["adminId"]);
  assert.equal((await call(d, "POST", `/admin/api/operators/${admin.adminId}/deactivate`, { cookie: admin.cookie })).json.error?.code, "self_change");
  assert.equal((await call(d, "POST", `/admin/api/operators/${admin.adminId}/reset-totp`, { cookie: admin.cookie })).json.error?.code, "self_change");
  assert.equal((await call(d, "POST", `/admin/api/operators/${night}/role`, { cookie: admin.cookie, body: { role: "viewer" } })).status, 204);
  assert.equal((await call(d, "POST", `/admin/api/operators/${night}/role`, { cookie: admin.cookie, body: { role: "owner" } })).json.error?.code, "invalid_role");
  assert.equal((await call(d, "POST", `/admin/api/operators/${viewer.adminId}/deactivate`, { cookie: admin.cookie })).status, 204);
  assert.equal((await call(d, "GET", "/admin/api/me", { cookie: viewer.cookie })).status, 401, "deactivation signs the operator out");
  assert.equal((await call(d, "POST", `/admin/api/operators/${viewer.adminId}/activate`, { cookie: admin.cookie })).status, 204);
  const reset = await call(d, "POST", `/admin/api/operators/${night}/reset-totp`, { cookie: admin.cookie });
  assert.equal(reset.json["username"], "night.shift"); assert.match(String(reset.json["uri"]), /^otpauth:/);
  const list = (await call(d, "GET", "/admin/api/operators", { cookie: admin.cookie })).json["operators"] as { username: string; role: string; active: boolean }[];
  assert.deepEqual(list.map(item => [item.username, item.role, item.active]), [["admin", "admin", true], ["night.shift", "viewer", true], ["viewer", "viewer", true]]);
  // The last active admin cannot be demoted or deactivated, even by another admin racing them.
  await d.db.updateTable("admins").set({ role: "admin" }).where("admin_id", "=", night).execute();
  const nightAdmin = { adminId: night, username: "night.shift", address: null };
  const { changeOperator } = await import("./admin/accounts.js");
  const results = await Promise.allSettled([changeOperator(d.db, nightAdmin, admin.adminId, { kind: "deactivate" }), changeOperator(d.db, { adminId: admin.adminId, username: "admin", address: null }, night, { kind: "deactivate" })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1, "one of two admins deactivating each other wins");
  assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /last_admin/);
  const actions = (await d.db.selectFrom("admin_audit").select("action").execute()).map(row => row.action);
  for (const action of ["admin.create", "admin.role", "admin.deactivate", "admin.activate", "admin.reset_totp", "admin.password_change", "admin.session_revoke"]) assert.ok(actions.includes(action), action);
  assert.equal(JSON.stringify(await d.db.selectFrom("admin_audit").select("detail").execute()).includes(String(created.json["password"])), false, "generated passwords never reach the audit log");
});

it("lists filter, sort, page and export, and a name search no longer matches ID prefixes", { skip }, async () => {
  const d = await dashboard("hosted"), viewer = await operator(d, "viewer", "viewer"), day = 86_400_000;
  const akwa = await shop(d, "Boutique Akwa", { paid_until: new Date(d.clock.now.getTime() + 20 * day) });
  const bonamoussadi = await shop(d, "Bonamoussadi", { paid_until: new Date(d.clock.now.getTime() - 2 * day) });
  const deido = await shop(d, "Deido =1+1", { status: "suspended" });
  await till(d, akwa); await till(d, akwa); await till(d, bonamoussadi);
  const get = async (query: string) => (await call(d, "GET", `/admin/api/shops${query}`, { cookie: viewer.cookie })).json as unknown as { shops: { shopId: string; name: string; service: string }[]; total: number };
  assert.deepEqual((await get("?sort=name&dir=asc")).shops.map(item => item.name), ["Bonamoussadi", "Boutique Akwa", "Deido =1+1"]);
  assert.deepEqual((await get("?search=akwa")).shops.map(item => item.shopId), [akwa]);
  assert.deepEqual((await get(`?search=${akwa.slice(0, 30)}`)).shops.map(item => item.shopId), [akwa], "an ID prefix still finds its shop");
  assert.deepEqual((await get("?service=grace")).shops.map(item => item.shopId), [bonamoussadi]);
  assert.deepEqual((await get("?service=inactive")).shops.map(item => item.shopId), [deido]);
  assert.deepEqual((await get("?status=suspended")).shops.map(item => item.shopId), [deido]);
  const paged = await get("?sort=name&dir=asc&offset=1&limit=1");
  assert.equal(paged.total, 3); assert.deepEqual(paged.shops.map(item => item.name), ["Boutique Akwa"]);
  const exported = await call(d, "GET", "/admin/api/shops.csv?sort=name&dir=asc", { cookie: viewer.cookie });
  assert.match(exported.headers.get("content-type")!, /text\/csv/); assert.ok(exported.text.includes(`"Deido =1+1"`));
  assert.equal(exported.text.split("\n").length, 4);
  // Codes by state with a total.
  const admin = await operator(d, "admin");
  for (const label of ["One", "Two", "Three"]) await call(d, "POST", "/admin/api/codes", { cookie: admin.cookie, body: { label, days: 1, maxTills: null } });
  const cancel = ((await call(d, "GET", "/admin/api/codes?limit=1", { cookie: viewer.cookie })).json["codes"] as { codeId: string }[])[0]!.codeId;
  await call(d, "POST", `/admin/api/codes/${cancel}/cancel`, { cookie: admin.cookie });
  const unused = (await call(d, "GET", "/admin/api/codes?state=unused", { cookie: viewer.cookie })).json;
  assert.equal(unused["total"], 2); assert.equal((await call(d, "GET", "/admin/api/codes?state=cancelled", { cookie: viewer.cookie })).json["total"], 1);
  // Audit by action prefix, operator, target and period, also as CSV.
  const audit = async (query: string) => ((await call(d, "GET", `/admin/api/audit${query}`, { cookie: viewer.cookie })).json["entries"] as { action: string; seq: string }[]);
  assert.deepEqual((await audit("?action=code.")).map(item => item.action).sort(), ["code.cancel", "code.issue", "code.issue", "code.issue"]);
  assert.deepEqual((await audit(`?target=${cancel}`)).map(item => item.action).sort(), ["code.cancel", "code.issue"]);
  assert.ok((await audit("?username=viewer")).every(item => item.action.startsWith("admin.")));
  assert.equal((await audit(`?from=${new Date(d.clock.now.getTime() + day).toISOString()}`)).length, 0);
  assert.match((await call(d, "GET", "/admin/api/audit.csv?action=code.cancel", { cookie: viewer.cookie })).text, /^id,at,username,action,target,address,detail\n[^\n]+code\.cancel[^\n]+$/);
});

it("the overview counts the server and lists what needs attention; billing and integrity report hosted money and broken guarantees", { skip }, async () => {
  const d = await dashboard("hosted"), admin = await operator(d, "admin"), day = 86_400_000;
  const paused = await shop(d, "Never paid"), grace = await shop(d, "In grace", { paid_until: new Date(d.clock.now.getTime() - day) });
  const ending = await shop(d, "Ending soon", { paid_until: new Date(d.clock.now.getTime() + 3 * day) }), stale = await shop(d, "Quiet", { paid_until: new Date(d.clock.now.getTime() + 90 * day) });
  await till(d, stale, { last_seen_at: new Date(d.clock.now.getTime() - 20 * day) });
  const limited = await shop(d, "Full", { paid_until: new Date(d.clock.now.getTime() + 90 * day), max_tills: 1 });
  await till(d, limited); await till(d, limited, { held: true });
  const removed = await shop(d, "Leaving", { status: "removed", remove_after: new Date(d.clock.now.getTime() + day) });
  await call(d, "POST", "/admin/api/codes", { cookie: admin.cookie, body: { label: "Tomorrow", days: 1, maxTills: 2 } });
  await call(d, "POST", `/admin/api/shops/${ending}/payments`, { cookie: admin.cookie, body: { months: 1, amountMinor: 5000, method: "cash", requestId: randomUUIDv7() } });
  await call(d, "POST", `/admin/api/shops/${stale}/payments`, { cookie: admin.cookie, body: { months: 2, amountMinor: 10000, method: "orange_money", requestId: randomUUIDv7() } });
  d.metrics.serverErrors = 2;
  const view = (await call(d, "GET", "/admin/api/overview", { cookie: admin.cookie })).json as unknown as {
    shops: Record<string, number>; services: Record<string, number>; tills: { used: number; held: number }; activity: { day: string; facts: number }[]; revenue: { amountMinor: number; payments: number };
    attention: { kind: string; target: string | null; count: number | null }[]; integrity: { ok: boolean; failing: string[] } };
  assert.deepEqual(view.shops, { active: 5, suspended: 0, removed: 1 });
  assert.deepEqual(view.tills, { used: 2, held: 1 });
  assert.equal(view.activity.length, 14); assert.equal(view.activity.at(-1)!.day, d.clock.now.toISOString().slice(0, 10));
  assert.deepEqual(view.revenue, { amountMinor: 15000, payments: 2, days: 30 });
  const kinds = (kind: string) => view.attention.filter(item => item.kind === kind).map(item => item.target);
  assert.deepEqual(kinds("service_inactive"), [paused]); assert.deepEqual(kinds("service_grace"), [grace]);
  assert.deepEqual(kinds("held_tills"), [limited]); assert.deepEqual(kinds("stale_shop"), [stale]); assert.deepEqual(kinds("purge_soon"), [removed]);
  assert.equal(kinds("code_expiring").length, 1); assert.equal(view.attention.find(item => item.kind === "server_errors")?.count, 2);
  assert.equal(view.integrity.ok, true);
  // Billing over the period, by method, with the subscriptions that end soon or lapsed.
  const billing = (await call(d, "GET", "/admin/api/billing", { cookie: admin.cookie })).json as unknown as { total: { payments: number; amountMinor: number }; byMethod: { key: string; amountMinor: number }[]; ending: { shopId: string; service: string }[] };
  assert.deepEqual(billing.total, { payments: 2, amountMinor: 15000 });
  assert.deepEqual(billing.byMethod.map(item => [item.key, item.amountMinor]).sort(), [["cash", 5000], ["orange_money", 10000]]);
  assert.deepEqual(billing.ending.map(item => item.shopId).sort(), [paused, grace].sort(), "the shop paid a month more no longer ends within 30 days");
  assert.match((await call(d, "GET", "/admin/api/billing.csv", { cookie: admin.cookie })).text.split("\n")[0]!, /^payment_id,recorded_at,shop_id/);
  assert.equal((await call(d, "GET", "/admin/api/billing?from=2026-11-01&to=2026-10-01", { cookie: admin.cookie })).json.error?.code, "invalid_period");
  // A paid-until date written with microseconds (outside the server) chains with the next payment, read in milliseconds.
  const precise = await shop(d, "Precise");
  await sql`INSERT INTO payments (payment_id, business_id, months, amount_minor, currency, method, source, recorded_by, recorded_at, paid_until_before, paid_until_after)
    VALUES (${randomUUIDv7()}, ${precise}, 1, 0, 'XAF', 'other', 'code', 'seed', '2025-01-01', NULL, now() + interval '1 day 0.000123 seconds')`.execute(d.db);
  await sql`UPDATE shops SET paid_until = (SELECT paid_until_after FROM payments WHERE business_id = ${precise}) WHERE business_id = ${precise}`.execute(d.db);
  await call(d, "POST", `/admin/api/shops/${precise}/payments`, { cookie: admin.cookie, body: { months: 1, amountMinor: 1, method: "cash", requestId: randomUUIDv7() } });
  assert.equal(((await call(d, "GET", "/admin/api/integrity", { cookie: admin.cookie })).json as unknown as { ok: boolean }).ok, true, "no false alarm from sub-millisecond precision");
  // Each guarantee, broken on purpose, is reported against its shop.
  await d.db.updateTable("shops").set({ paid_until: new Date("2030-01-01T00:00:00.000Z") }).where("business_id", "=", ending).execute();
  await d.db.updateTable("shops").set({ max_tills: 5 }).where("business_id", "=", limited).execute();
  await d.db.updateTable("shops").set({ status: "suspended" }).where("business_id", "=", stale).execute();
  const device = (await d.db.selectFrom("shop_devices").select("device_id").where("business_id", "=", stale).executeTakeFirstOrThrow()).device_id;
  await d.db.insertInto("sessions").values({ token_hash: "a".repeat(64), business_id: stale, device_id: device, expires_at: new Date(d.clock.now.getTime() + 3_600_000) }).execute();
  await d.db.updateTable("shops").set({ remove_after: new Date(d.clock.now.getTime() - 3 * 3_600_000) }).where("business_id", "=", removed).execute();
  await d.db.insertInto("payments").values({ payment_id: randomUUIDv7(), business_id: grace, months: 1, amount_minor: "1", currency: "XAF", method: "cash", reference: null, source: "manual", external_id: null,
    recorded_by: "sql", paid_until_before: new Date("2020-01-01T00:00:00.000Z"), paid_until_after: new Date(d.clock.now.getTime() - 2 * day) }).execute();
  const integrity = (await call(d, "GET", "/admin/api/integrity", { cookie: admin.cookie })).json as unknown as { ok: boolean; checks: { name: string; ok: boolean; targets: string[] }[] };
  assert.equal(integrity.ok, false);
  assert.deepEqual(Object.fromEntries(integrity.checks.map(check => [check.name, check.targets])), {
    audit_chain: [], payment_chain: [grace], paid_until: [ending], held_with_free_places: [limited], sessions_on_stopped_shops: [stale], purge_overdue: [removed] });
  const failing = (await call(d, "GET", "/admin/api/overview", { cookie: admin.cookie })).json as unknown as { attention: { kind: string; label: string }[] };
  assert.deepEqual(failing.attention.filter(item => item.kind === "integrity").map(item => item.label), ["payment_chain", "paid_until", "held_with_free_places", "sessions_on_stopped_shops", "purge_overdue"]);
});

it("a background refresh does not keep an unattended session alive", { skip }, async () => {
  const d = await dashboard(), viewer = await operator(d, "viewer", "viewer");
  const poll = async () => (await fetch(`${d.base}/admin/api/overview`, { headers: { cookie: viewer.cookie, "x-kolo-poll": "1" } })).status;
  for (let minute = 0; minute < 25; minute += 5) { d.clock.now = new Date(d.clock.now.getTime() + 5 * 60_000); assert.equal(await poll(), 200); }
  d.clock.now = new Date(d.clock.now.getTime() + 6 * 60_000);
  assert.equal(await poll(), 401, "thirty minutes after the last real request, polling alone has not kept it open");
});

it("a self-hosted server has no billing", { skip }, async () => {
  const d = await dashboard(), viewer = await operator(d, "viewer", "viewer");
  assert.equal((await call(d, "GET", "/admin/api/billing", { cookie: viewer.cookie })).json.error?.code, "not_hosted");
  assert.equal((await call(d, "GET", "/admin/api/overview", { cookie: viewer.cookie })).json["revenue"], null);
});
