import assert from "node:assert/strict";
import { after, it } from "node:test";
import { createHmac, randomUUIDv7 } from "node:crypto";
import { SyncTransportError } from "@kolo/core/application/server-sync";
import { serverConnections } from "@kolo/core/application/server-sync";
import { openDatabase } from "./database.js";
import { CLI_ACTOR, recordShopPayment, purgeRemovedShops, setShopStatus } from "./admin/operations.js";
import { entitlementOf } from "./billing.js";
import { adminUrl, cleanup, connect, count, crypto, owner, paired, product, query, sale, started, sync } from "./sync.fixtures.js";

const skip = adminUrl === undefined;
after(cleanup);
const day = 86_400_000;
const inactive = (error: unknown) => error instanceof SyncTransportError && error.code === "hosted_service_inactive" && error.status === 403;

it("entitlement status follows the paid period and grace exactly, and self-hosted shops never expire", () => {
  const hosted = { edition: "hosted" as const, graceDays: 7 }, paid = new Date("2026-11-01T00:00:00.000Z");
  assert.equal(entitlementOf({ edition: "selfhost", graceDays: 7 }, null, new Date()).status, "unlimited");
  assert.equal(entitlementOf(hosted, null, paid).status, "inactive", "never paid");
  assert.equal(entitlementOf(hosted, paid, new Date(paid.getTime() - 1)).status, "active");
  assert.equal(entitlementOf(hosted, paid, paid).status, "grace", "the paid period ends at its instant");
  assert.equal(entitlementOf(hosted, paid, new Date(paid.getTime() + 7 * day - 1)).status, "grace");
  assert.equal(entitlementOf(hosted, paid, new Date(paid.getTime() + 7 * day)).status, "inactive");
  assert.equal(entitlementOf({ edition: "hosted", graceDays: 0 }, paid, paid).status, "inactive");
});

it("a hosted shop syncs only while paid; tills keep trading, the server keeps everything, and renewal delivers the backlog", { skip }, async () => {
  let clock = new Date("2026-10-11T06:00:00.000Z");
  const target = await started({ edition: "hosted", graceDays: 7, now: () => clock }), a = await owner(), b = await paired(a, "Till B"), p = product(a);
  await connect(a, target); // A code without paid months: attached, but not yet paid.
  await assert.rejects(sync(a, target), inactive);
  assert.equal((await serverConnections(a.context, crypto))[0]?.service, "inactive", "the till learned why before transfer was refused");
  sale(a, p); assert.equal(count(a, "sales"), 1, "local trading never waits for the server");
  const db = openDatabase(target.databaseUrl);
  try {
    const paid = await recordShopPayment(db, CLI_ACTOR, { shopId: a.install.businessId, months: 1, amountMinor: 5000, method: "mtn_momo", reference: "MP2610.1234" }, clock);
    assert.equal(paid.paidUntilAfter, "2026-11-11T06:00:00.000Z", "one calendar month from today");
    await sync(a, target); await connect(b, target);
    for (let round = 0; round < 3; round++) { await sync(b, target); await sync(a, target); }
    assert.equal(count(b, "sales"), 1);
    const [connection] = await serverConnections(b.context, crypto);
    assert.equal(connection?.service, "active"); assert.equal(connection?.paidUntil, "2026-11-11T06:00:00.000Z");
    // Renewing early extends from the end of the paid period, not from today.
    assert.equal((await recordShopPayment(db, CLI_ACTOR, { shopId: a.install.businessId, months: 12, amountMinor: 50000, method: "cash" }, clock)).paidUntilAfter, "2027-11-11T06:00:00.000Z");
    // Past the paid period: grace keeps sync running and tells the tills.
    clock = new Date("2027-11-12T06:00:00.000Z");
    await sync(a, target);
    assert.equal((await serverConnections(a.context, crypto))[0]?.service, "grace");
    // Past grace: transfer pauses while facts keep accumulating on the tills.
    clock = new Date("2027-11-19T06:00:01.000Z");
    sale(a, p); sale(b, p);
    await assert.rejects(sync(a, target), inactive); await assert.rejects(sync(b, target), inactive);
    assert.equal(count(a, "sales"), 2); assert.equal(count(b, "sales"), 2);
    // Renewal from a lapsed date starts today; every waiting fact flows in the next passes.
    assert.equal((await recordShopPayment(db, CLI_ACTOR, { shopId: a.install.businessId, months: 1, amountMinor: 5000, method: "orange_money" }, clock)).paidUntilAfter, "2027-12-19T06:00:01.000Z");
    for (let round = 0; round < 3; round++) { await sync(a, target); await sync(b, target); }
    assert.equal(count(a, "sales"), 3); assert.equal(count(b, "sales"), 3);
    // Payments are append-only and audited; refused inputs change nothing.
    await assert.rejects(recordShopPayment(db, CLI_ACTOR, { shopId: a.install.businessId, months: 0, amountMinor: 1, method: "cash" }, clock), /invalid_months/);
    await assert.rejects(recordShopPayment(db, CLI_ACTOR, { shopId: a.install.businessId, months: 1, amountMinor: -1, method: "cash" }, clock), /invalid_amount/);
    await assert.rejects(recordShopPayment(db, CLI_ACTOR, { shopId: randomUUIDv7(), months: 1, amountMinor: 1, method: "cash" }, clock), /not_found/);
    assert.equal(Number((await query(target, `SELECT count(*)::int AS n FROM payments`))[0].n), 3);
    await assert.rejects(query(target, `UPDATE payments SET months=36`), /append-only/);
    assert.equal(Number((await query(target, `SELECT count(*)::int AS n FROM admin_audit WHERE action='payment.record'`))[0].n), 3);
    // Purging a removed shop takes its payments with it, and nothing else.
    await setShopStatus(db, CLI_ACTOR, a.install.businessId, "remove", clock);
    assert.deepEqual(await purgeRemovedShops(db, CLI_ACTOR, new Date(clock.getTime() + 31 * day)), [a.install.businessId]);
    assert.equal(Number((await query(target, `SELECT count(*)::int AS n FROM payments`))[0].n), 0);
  } finally { await db.destroy(); }
});

it("a code issued after payment carries its months, so the shop syncs from its first pass", { skip }, async () => {
  const clock = new Date("2026-10-11T06:00:00.000Z");
  const target = await started({ edition: "hosted", now: () => clock }), a = await owner();
  await connect(a, target, (await target.invite("Paid shop", 7, 3)).token);
  assert.ok((await sync(a, target)).pushed > 0);
  assert.deepEqual((await query(target, `SELECT months, amount_minor::int AS amount, source, paid_until_after FROM payments`)).map(row => [row.months, row.amount, row.source, new Date(row.paid_until_after).toISOString()]),
    [[3, 0, "code", "2027-01-11T06:00:00.000Z"]]);
});

it("the signed payment webhook verifies, is idempotent per provider event, refuses stale or forged calls, and exists only when configured", { skip }, async () => {
  const secret = "w".repeat(40), target = await started({ edition: "hosted", webhookSecret: secret }), a = await owner();
  await connect(a, target);
  const send = async (body: unknown, options: { secret?: string; at?: number; raw?: string } = {}) => {
    const raw = options.raw ?? JSON.stringify(body), t = String(options.at ?? Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", options.secret ?? secret).update(`${t}.${raw}`).digest("hex");
    const response = await fetch(`${target.url}/internal/billing/webhooks/generic`, { method: "POST", headers: { "content-type": "application/json", "x-kolo-signature": `t=${t},v1=${signature}` }, body: raw });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
  const event = { event_id: "evt_1", shop_id: a.install.businessId, months: 1, amount_minor: 5000, method: "mtn_momo", reference: "MP-1" };
  const first = await send(event);
  assert.equal(first.status, 201); assert.equal(first.json["duplicate"], false);
  const again = await send(event);
  assert.equal(again.status, 200); assert.equal(again.json["duplicate"], true); assert.equal(again.json["paid_until"], first.json["paid_until"], "a retried webhook never extends twice");
  assert.deepEqual((await send({ ...event, months: 2 })).json, { error: { code: "payment_conflict", retry: false } });
  assert.deepEqual((await send({ ...event, event_id: "evt_2" }, { secret: "x".repeat(40) })).json, { error: { code: "invalid_signature", retry: false } });
  assert.deepEqual((await send({ ...event, event_id: "evt_3" }, { at: Math.floor(Date.now() / 1000) - 600 })).json, { error: { code: "stale_signature", retry: false } });
  assert.deepEqual((await send({ ...event, event_id: "evt_4", shop_id: randomUUIDv7() })).json, { error: { code: "not_found", retry: false } });
  assert.deepEqual((await send({ ...event, event_id: "evt_5", method: "bitcoin" })).json, { error: { code: "invalid_payload", retry: false } });
  assert.equal((await send(undefined, { raw: "not json" })).status, 400);
  const unsigned = await fetch(`${target.url}/internal/billing/webhooks/generic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
  assert.equal(unsigned.status, 401);
  assert.equal(Number((await query(target, `SELECT count(*)::int AS n FROM payments`))[0].n), 1);
  assert.ok((await sync(a, target)).pushed > 0, "paid by webhook, the shop syncs");
  const selfHosted = await started({ webhookSecret: secret });
  assert.equal((await fetch(`${selfHosted.url}/internal/billing/webhooks/generic`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404, "no billing on a self-hosted server");
  const b = await owner(); await connect(b, selfHosted);
  await sync(b, selfHosted);
  assert.equal((await serverConnections(b.context, crypto))[0]?.service, "unlimited");
});

it("the dashboard records payments for admins only and shows each shop's subscription", { skip }, async () => {
  const { createAdminApplication } = await import("./admin/admin-app.js"), { createAdmin } = await import("./admin/accounts.js"), { createMetrics } = await import("./admin/operations.js");
  const { generateServerKey } = await import("./identity.js"), { TOTP, Secret } = await import("otpauth");
  const clock = { now: new Date("2026-10-11T06:00:00.000Z") };
  const target = await started({ edition: "hosted", now: () => clock.now }), a = await owner("Boutique Payée");
  await connect(a, target);
  const db = openDatabase(target.databaseUrl);
  const app = await createAdminApplication({ db, key: generateServerKey().key, publicUrl: target.url, metrics: createMetrics(), version: "test", uiDir: undefined, now: () => clock.now, rateLimitMax: 1000, edition: { edition: "hosted", graceDays: 7 } });
  app.addHook("onClose", async () => { await db.destroy(); });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const signIn = async (username: string, password: string, role: "admin" | "viewer") => {
      const { secret } = await createAdmin(db, { username, password, role });
      const code = new TOTP({ issuer: "kolo", label: username, secret: Secret.fromBase32(secret) }).generate({ timestamp: clock.now.getTime() });
      const response = await fetch(`${base}/admin/api/session`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ username, password, code }) });
      return response.headers.get("set-cookie")!.split(";")[0]!;
    };
    const admin = await signIn("cashier-desk", "correct horse battery", "admin"), viewer = await signIn("auditor", "staple battery horse", "viewer");
    const post = (cookie: string, body: unknown) => fetch(`${base}/admin/api/shops/${a.install.businessId}/payments`, { method: "POST", headers: { "content-type": "application/json", origin: base, cookie }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() as Record<string, unknown> }));
    assert.deepEqual((await post(viewer, { months: 1, amountMinor: 5000, method: "cash" })).json, { error: { code: "read_only" } });
    assert.deepEqual((await post(admin, { months: 1, amountMinor: 5000, method: "bitcoin" })).json, { error: { code: "invalid_method" } });
    const paid = await post(admin, { months: 6, amountMinor: 27000, method: "orange_money", reference: "OM-77" });
    assert.equal(paid.status, 200); assert.equal(paid.json["paidUntilAfter"], "2027-04-11T06:00:00.000Z");
    const shops = await fetch(`${base}/admin/api/shops`, { headers: { cookie: viewer } }).then(r => r.json()) as { edition: string; shops: { service: string; paidUntil: string }[] };
    assert.equal(shops.edition, "hosted"); assert.equal(shops.shops[0]!.service, "active"); assert.equal(shops.shops[0]!.paidUntil, "2027-04-11T06:00:00.000Z");
    const detail = await fetch(`${base}/admin/api/shops/${a.install.businessId}`, { headers: { cookie: viewer } }).then(r => r.json()) as { payments: { method: string; reference: string; recordedBy: string }[]; graceUntil: string };
    assert.deepEqual(detail.payments.map(item => [item.method, item.reference, item.recordedBy]), [["orange_money", "OM-77", "cashier-desk"]]);
    assert.equal(detail.graceUntil, "2027-04-18T06:00:00.000Z");
    assert.ok((await sync(a, target)).pushed > 0);
  } finally { await app.close(); }
});
