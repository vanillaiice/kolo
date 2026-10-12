import assert from "node:assert/strict";
import { after, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOTP, Secret } from "otpauth";
import type { FastifyInstance } from "fastify";
import { parseConnectionCode } from "@kolo/contracts/sync";
import { migrateToLatest, openDatabase, SERVER_MIGRATIONS } from "./database.js";
import { generateServerKey } from "./identity.js";
import { createAdmin, resetTotp } from "./admin/accounts.js";
import { createAdminApplication } from "./admin/admin-app.js";
import { createMetrics } from "./admin/operations.js";
import { cleanup, connect, freshDatabase, owner, started, sync } from "./sync.fixtures.js";

const skip = false;
const closers: (() => Promise<unknown>)[] = [];
after(async () => { for (const close of closers.splice(0)) await close(); await cleanup(); });

interface Dashboard { app: FastifyInstance; base: string; origin: string; clock: { now: Date }; ui: string; databaseUrl: string }
async function dashboard(databaseUrl?: string): Promise<Dashboard> {
  const url = databaseUrl ?? await freshDatabase(), db = openDatabase(url);
  if (databaseUrl === undefined) await migrateToLatest(db);
  const ui = mkdtempSync(join(tmpdir(), "kolo-admin-ui-"));
  mkdirSync(join(ui, "assets")); writeFileSync(join(ui, "index.html"), "<!doctype html><title>kolo admin</title>"); writeFileSync(join(ui, "assets", "app.js"), "export {};");
  writeFileSync(join(tmpdir(), "kolo-admin-outside.html"), "secret");
  const clock = { now: new Date() };
  const app = await createAdminApplication({ db, key: generateServerKey().key, publicUrl: "https://sync.example.com", metrics: createMetrics(), version: "test", uiDir: ui, now: () => clock.now, rateLimitMax: 1000 });
  app.addHook("onClose", async () => { await db.destroy(); rmSync(ui, { recursive: true, force: true }); });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  closers.push(() => app.close());
  return { app, base, origin: base, clock, ui, databaseUrl: url };
}
function code(secret: string, username: string, at: Date): string { return new TOTP({ issuer: "kolo", label: username, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: at.getTime() }); }
async function call(d: Dashboard, method: string, path: string, options: { body?: unknown; cookie?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  if (options.origin !== null && method !== "GET") headers["origin"] = options.origin ?? d.origin;
  const response = await fetch(`${d.base}${path}`, { method, headers, redirect: "manual", ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const text = await response.text();
  let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json: json as Record<string, unknown>, headers: response.headers, text };
}
async function signedIn(d: Dashboard, username: string, password: string, secret: string): Promise<string> {
  const response = await call(d, "POST", "/admin/api/session", { body: { username, password, code: code(secret, username, d.clock.now) } });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\/admin/);
  return cookie.split(";")[0]!;
}

it("operators sign in with a password and a single-use authenticator code; failures lock the account and every attempt is audited", { skip }, async () => {
  const d = await dashboard(), db = openDatabase(d.databaseUrl);
  try {
    const { secret } = await createAdmin(db, { username: "Operator", password: "correct horse battery", role: "admin" });
    await assert.rejects(createAdmin(db, { username: "operator", password: "another long password", role: "admin" }), /username_taken/);
    await assert.rejects(createAdmin(db, { username: "short", password: "123456789012", role: "admin" }), /weak_password/);
    assert.equal((await call(d, "GET", "/admin/api/me")).status, 401);
    assert.equal((await call(d, "POST", "/admin/api/session", { body: { username: "operator", password: "wrong password!!", code: code(secret, "operator", d.clock.now) } })).status, 401);
    assert.equal((await call(d, "POST", "/admin/api/session", { body: { username: "operator", password: "correct horse battery", code: "000000" } })).status, 401);
    assert.equal((await call(d, "POST", "/admin/api/session", { body: { username: "nobody", password: "correct horse battery", code: "123456" } })).status, 401);
    const cookie = await signedIn(d, "operator", "correct horse battery", secret);
    assert.deepEqual((await call(d, "GET", "/admin/api/me", { cookie })).json, { username: "operator", role: "admin", idleMinutes: 30 });
    // The same code cannot be used twice, even within its 30 seconds.
    assert.equal((await call(d, "POST", "/admin/api/session", { body: { username: "operator", password: "correct horse battery", code: code(secret, "operator", d.clock.now) } })).status, 401);
    for (let attempt = 0; attempt < 5; attempt++) await call(d, "POST", "/admin/api/session", { body: { username: "operator", password: "wrong password!!", code: "111111" } });
    d.clock.now = new Date(d.clock.now.getTime() + 60_000);
    const locked = await call(d, "POST", "/admin/api/session", { body: { username: "operator", password: "correct horse battery", code: code(secret, "operator", d.clock.now) } });
    assert.deepEqual([locked.status, locked.json], [423, { error: { code: "account_locked" } }]);
    d.clock.now = new Date(d.clock.now.getTime() + 16 * 60_000);
    await signedIn(d, "operator", "correct horse battery", secret);
    // Idle sessions end; signing out ends a session at once.
    d.clock.now = new Date(d.clock.now.getTime() + 31 * 60_000);
    assert.equal((await call(d, "GET", "/admin/api/me", { cookie })).status, 401);
    const fresh = await signedIn(d, "operator", "correct horse battery", secret);
    assert.equal((await call(d, "DELETE", "/admin/api/session", { cookie: fresh })).status, 204);
    assert.equal((await call(d, "GET", "/admin/api/me", { cookie: fresh })).status, 401);
    // A reset secret signs every session out.
    d.clock.now = new Date(d.clock.now.getTime() + 30_000);
    const another = await signedIn(d, "operator", "correct horse battery", secret);
    const reset = await resetTotp(db, "operator");
    assert.equal((await call(d, "GET", "/admin/api/me", { cookie: another })).status, 401);
    d.clock.now = new Date(d.clock.now.getTime() + 60_000);
    await signedIn(d, "operator", "correct horse battery", reset.secret);
    const actions = (await db.selectFrom("admin_audit").select("action").orderBy("id").execute()).map(row => row.action);
    for (const action of ["admin.create", "admin.sign_in_failed", "admin.sign_in", "admin.sign_in_locked", "admin.sign_out", "admin.reset_totp"]) assert.ok(actions.includes(action), action);
    const audit = await db.selectFrom("admin_audit").select(["detail"]).execute();
    assert.equal(JSON.stringify(audit).includes("correct horse"), false, "passwords never reach the audit log");
  } finally { await db.destroy(); }
});

it("viewers read, admins change, foreign origins are refused, and codes, shops and audit are managed through the API", { skip }, async () => {
  const target = await started(), d = await dashboard(target.databaseUrl), db = openDatabase(d.databaseUrl);
  try {
    const admin = await createAdmin(db, { username: "admin", password: "correct horse battery", role: "admin" });
    const viewer = await createAdmin(db, { username: "viewer", password: "staple battery horse", role: "viewer" });
    const cookie = await signedIn(d, "admin", "correct horse battery", admin.secret), readOnly = await signedIn(d, "viewer", "staple battery horse", viewer.secret);
    assert.deepEqual((await call(d, "POST", "/admin/api/codes", { cookie: readOnly, body: { label: "Shop", days: 7 } })).json, { error: { code: "read_only" } });
    assert.deepEqual((await call(d, "POST", "/admin/api/codes", { cookie, origin: "https://evil.example", body: { label: "Shop", days: 7 } })).json, { error: { code: "bad_origin" } });
    assert.deepEqual((await call(d, "POST", "/admin/api/codes", { cookie, origin: null, body: { label: "Shop", days: 7 } })).json, { error: { code: "bad_origin" } });
    assert.deepEqual((await call(d, "POST", "/admin/api/codes", { cookie, body: { label: " ", days: 7 } })).json, { error: { code: "invalid_label" } });
    assert.deepEqual((await call(d, "POST", "/admin/api/codes", { cookie, body: { label: "Shop", days: 365 } })).json, { error: { code: "invalid_expiry" } });
    const issued = await call(d, "POST", "/admin/api/codes", { cookie, body: { label: "Boutique Akwa", days: 7 } });
    assert.equal(issued.status, 200);
    const parsed = parseConnectionCode(String(issued.json["code"]))!;
    assert.equal(parsed.url, "https://sync.example.com"); assert.match(parsed.token!, /^[a-f0-9]{32}$/);
    assert.match(String(issued.json["qr"]), /^<svg/);
    assert.equal(JSON.stringify((await call(d, "GET", "/admin/api/codes", { cookie: readOnly })).json).includes(parsed.token!), false, "a listing never shows a token");
    const second = await call(d, "POST", "/admin/api/codes", { cookie, body: { label: "To cancel", days: 1 } });
    assert.equal((await call(d, "POST", `/admin/api/codes/${String(second.json["codeId"])}/cancel`, { cookie })).status, 204);
    assert.equal((await call(d, "POST", `/admin/api/codes/${String(second.json["codeId"])}/cancel`, { cookie })).status, 409);
    // A shop attaches with a code issued for the real server, then appears with its devices but no business data.
    const a = await owner("Boutique Akwa");
    await connect(a, target); await sync(a, target); await sync(a, target);
    const shops = (await call(d, "GET", "/admin/api/shops?search=akwa", { cookie: readOnly })).json["shops"] as { shopId: string; name: string; devices: number; facts: number }[];
    assert.equal(shops.length, 1); assert.equal(shops[0]!.name, "Boutique Akwa"); assert.equal(shops[0]!.devices, 1); assert.ok(shops[0]!.facts > 0);
    const detail = (await call(d, "GET", `/admin/api/shops/${shops[0]!.shopId}`, { cookie: readOnly })).json;
    assert.equal(detail["keyEpoch"], 1); assert.equal((detail["deviceList"] as unknown[]).length, 1);
    assert.equal((await call(d, "GET", `/admin/api/shops/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, { cookie })).status, 404);
    assert.deepEqual((await call(d, "POST", `/admin/api/shops/${shops[0]!.shopId}/suspend`, { cookie: readOnly })).json, { error: { code: "read_only" } });
    assert.equal((await call(d, "POST", `/admin/api/shops/${shops[0]!.shopId}/suspend`, { cookie })).status, 204);
    await assert.rejects(sync(a, target), (error: unknown) => (error as { code?: string }).code === "shop_suspended");
    assert.equal((await call(d, "POST", `/admin/api/shops/${shops[0]!.shopId}/resume`, { cookie })).status, 204);
    assert.deepEqual((await call(d, "POST", `/admin/api/shops/${shops[0]!.shopId}/remove`, { cookie, body: { confirm: "wrong" } })).json, { error: { code: "confirmation_required" } });
    assert.equal((await call(d, "POST", `/admin/api/shops/${shops[0]!.shopId}/remove`, { cookie, body: { confirm: shops[0]!.shopId } })).status, 204);
    assert.equal((await call(d, "POST", `/admin/api/shops/${shops[0]!.shopId}/restore`, { cookie })).status, 204);
    const health = (await call(d, "GET", "/admin/api/health", { cookie: readOnly })).json;
    assert.deepEqual(health["shops"], { active: 1, suspended: 0, removed: 0 });
    assert.deepEqual((health["migrations"] as { name: string }[]).map(item => item.name), Object.keys(SERVER_MIGRATIONS).sort());
    assert.deepEqual((await call(d, "POST", `/admin/api/shops/${shops[0]!.shopId}/payments`, { cookie, body: { months: 1, amountMinor: 5000, method: "cash" } })).json, { error: { code: "not_hosted" } }, "a self-hosted server has no subscriptions");
    const entries = (await call(d, "GET", "/admin/api/audit", { cookie: readOnly })).json["entries"] as { action: string; username: string }[];
    for (const action of ["code.issue", "code.cancel", "shop.suspend", "shop.resume", "shop.remove", "shop.restore"]) assert.ok(entries.some(entry => entry.action === action && entry.username === "admin"), action);
    const csv = await call(d, "GET", "/admin/api/audit.csv", { cookie: readOnly });
    assert.match(csv.headers.get("content-type")!, /text\/csv/); assert.match(csv.text, /^id,at,username,action/);
    const page = await call(d, "GET", "/admin/api/shops", { cookie });
    assert.equal(page.headers.get("cache-control"), "no-store"); assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  } finally { await db.destroy(); }
});

it("with the second factor turned off, a loopback dashboard signs in with the password alone and says so", { skip }, async () => {
  const url = await freshDatabase(), db = openDatabase(url); await migrateToLatest(db);
  const app = await createAdminApplication({ db, key: generateServerKey().key, publicUrl: undefined, metrics: createMetrics(), version: "test", uiDir: undefined, rateLimitMax: 1000, totp: false });
  app.addHook("onClose", async () => { await db.destroy(); });
  const base = await app.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => app.close());
  await createAdmin(db, { username: "solo", password: "correct horse battery", role: "admin" });
  assert.deepEqual(await (await fetch(`${base}/admin/api/config`)).json(), { totp: false });
  const post = (password: string) => fetch(`${base}/admin/api/session`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ username: "solo", password }) });
  assert.equal((await post("wrong password!!")).status, 401, "the password still matters");
  assert.equal((await post("correct horse battery")).status, 200);
  assert.deepEqual((await db.selectFrom("admin_audit").select("detail").where("action", "=", "admin.sign_in").executeTakeFirstOrThrow()).detail, { second_factor: "off" });
});

it("the dashboard is served from its own directory only", { skip }, async () => {
  const d = await dashboard();
  assert.equal((await call(d, "GET", "/")).status, 302);
  const index = await call(d, "GET", "/admin/");
  assert.equal(index.status, 200); assert.match(index.text, /kolo admin/); assert.match(index.headers.get("content-type")!, /text\/html/);
  assert.match((await call(d, "GET", "/admin/shops/123")).text, /kolo admin/, "client routes fall back to the page");
  assert.equal((await call(d, "GET", "/admin/assets/app.js")).headers.get("cache-control"), "public, max-age=31536000, immutable");
  for (const path of ["/admin/../kolo-admin-outside.html", "/admin/%2e%2e/kolo-admin-outside.html", "/admin/..%2fkolo-admin-outside.html", "/admin/assets/missing.js", "/admin/api/unknown"]) {
    const response = await call(d, "GET", path);
    assert.notEqual(response.text, "secret", path); assert.ok(response.status === 404 || /kolo admin/.test(response.text), `${path} ${response.status}`);
  }
});
