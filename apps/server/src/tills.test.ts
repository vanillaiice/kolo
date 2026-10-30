import assert from "node:assert/strict";
import { after, it } from "node:test";
import { randomUUIDv7, sign } from "node:crypto";
import { Migrator } from "kysely/migration";
import { sessionSigningMessage } from "@kolo/contracts/sync";
import { SyncTransportError, serverConnections, synchronizeServer } from "@kolo/core/application/server-sync";
import { setExchangeDeviceActive } from "@kolo/core/application/exchange";
import { startJoin } from "@kolo/core/application/join";
import { migrateToLatest, openDatabase, SERVER_MIGRATIONS } from "./database.js";
import { CLI_ACTOR, issueCode, listCodes, recordShopPayment, setTillLimit, shopDetail } from "./admin/operations.js";
import { entitlementOf } from "./billing.js";
import { hasPlace, tillPlace } from "./sync/tills.js";
import { cleanup, connect, crypto, freshDatabase, owner, paired, query, started, sync, type Device, type Server } from "./sync.fixtures.js";

after(cleanup);
const day = 86_400_000;
const refusal = (code: string, status?: number) => (error: unknown) => error instanceof SyncTransportError && error.code === code && (status === undefined || error.status === status);
const plan = async (device: Device, target: Server) => {
  const challenge = await target.transport.challenge({ purpose: "session", business_id: device.install.businessId, device_id: device.install.deviceId });
  const claim = { format: "kolo.server-session" as const, format_version: 1 as const, challenge_id: challenge.challenge_id, nonce: challenge.nonce, server_device_id: target.key.deviceId, business_id: device.install.businessId, device_id: device.install.deviceId };
  const { token } = await target.transport.session({ claim, signature: sign(null, Buffer.from(sessionSigningMessage(claim)), device.privateKey).toString("hex") });
  const response = await fetch(new URL("/api/v2/plan", target.url), { headers: { authorization: `Bearer ${token}` } });
  return response.json() as Promise<{ max_tills: number | null; tills: number }>;
};
const held = async (target: Server, device: Device) => (await query(target, `SELECT held FROM shop_devices WHERE device_id=$1`, [device.install.deviceId]))[0]?.held as boolean | undefined;
/** An owner attached with a code carrying `maxTills`, and its paired tills trusted on the server through its sync. */
async function shop(maxTills: number | null, tills: readonly string[]) {
  const target = await started(), a = await owner(), others: Device[] = [];
  for (const label of tills) others.push(await paired(a, label));
  await connect(a, target, (await target.invite("Limited shop", 7, 0, { maxTills })).token);
  await sync(a, target); // The owner's trust facts reach the server here, in the order the tills were paired.
  return { target, a, others, db: openDatabase(target.databaseUrl) };
}

it("a shop at its till limit holds the next till: stored, refused a session, while the others keep syncing", async () => {
  const { target, a, others: [b, c], db } = await shop(2, ["Till B", "Till C"]);
  try {
    assert.equal(await held(target, b!), false); assert.equal(await held(target, c!), true, "the third till waits");
    await connect(b!, target); await sync(b!, target);
    // Connecting opens a session, so a held till learns why before anything is stored as connected.
    await assert.rejects(connect(c!, target), refusal("till_limit_reached", 403));
    assert.deepEqual(await serverConnections(c!.context, crypto), []);
    assert.deepEqual(await plan(a, target), { max_tills: 2, tills: 2 });
    // The owner's till records the plan on each pass, read before transfer, for "your plan allows 2 tills".
    await sync(a, target);
    assert.deepEqual((({ maxTills, tills }) => ({ maxTills, tills }))((await serverConnections(a.context, crypto))[0]!), { maxTills: 2, tills: 2 });
    // A server from before the plan endpoint (404) leaves the last known plan in place and the pass succeeds.
    const older = { ...target.transport, plan: async () => { throw new SyncTransportError("not_found", 404, false); } };
    await synchronizeServer(a.context, a.destination!, older, crypto);
    assert.equal((await serverConnections(a.context, crypto))[0]!.maxTills, 2);
    const detail = await shopDetail(db, a.install.businessId);
    assert.equal(detail.maxTills, 2); assert.equal(detail.heldTills, 1); assert.equal(detail.devices, 2, "held tills hold no place");
    assert.equal(detail.deviceList.find(device => device.deviceId === c!.install.deviceId)?.held, true);
    // Raising the limit releases the waiting till at once.
    assert.deepEqual(await setTillLimit(db, CLI_ACTOR, a.install.businessId, 3), [c!.install.deviceId]);
    await connect(c!, target); await sync(c!, target);
    assert.equal(await held(target, c!), false);
    const [entry] = await query(target, `SELECT action, detail FROM admin_audit WHERE action='shop.till_limit'`);
    assert.deepEqual(entry.detail, { from: 2, to: 3, released: 1 });
  } finally { await db.destroy(); }
});

it("lowering the limit below current use holds nobody; a revocation frees a place for the oldest waiting till", async () => {
  const { target, a, others: [b, c], db } = await shop(null, ["Till B", "Till C"]);
  try {
    assert.equal(await held(target, c!), false, "unlimited: every till syncs");
    assert.deepEqual(await setTillLimit(db, CLI_ACTOR, a.install.businessId, 1), []);
    await connect(b!, target); await sync(b!, target); await connect(c!, target); await sync(c!, target);
    assert.deepEqual(await plan(a, target), { max_tills: 1, tills: 3 }, "enrolled tills keep syncing over a lowered limit");
    const d = await paired(a, "Till D"), e = await paired(a, "Till E"); await sync(a, target);
    assert.equal(await held(target, d), true); assert.equal(await held(target, e), true);
    // Two places freed for a limit of 1 with three in use: still full, nobody released.
    setExchangeDeviceActive(a.context, b!.install.deviceId, false); await sync(a, target);
    assert.equal(await held(target, d), true);
    setExchangeDeviceActive(a.context, c!.install.deviceId, false); await sync(a, target);
    assert.equal(await held(target, d), true, "one till in use is the limit");
    await setTillLimit(db, CLI_ACTOR, a.install.businessId, 2);
    assert.equal(await held(target, d), false, "the oldest waiting till takes the freed place");
    assert.equal(await held(target, e), true);
    // A held till that is revoked leaves the queue without taking a place.
    setExchangeDeviceActive(a.context, e.install.deviceId, false); await sync(a, target);
    assert.equal(await held(target, e), false);
    assert.deepEqual(await plan(a, target), { max_tills: 2, tills: 2 });
    await assert.rejects(setTillLimit(db, CLI_ACTOR, a.install.businessId, 0), /invalid_till_limit/);
    await assert.rejects(setTillLimit(db, CLI_ACTOR, randomUUIDv7(), 2), /not_found/);
  } finally { await db.destroy(); }
});

it("join by code is refused while the shop is full, before the new till is set up", async () => {
  const { target, a, db } = await shop(1, []);
  try {
    const start = () => startJoin(a.context, target.transport, crypto, { serverDeviceId: target.key.deviceId, url: target.url, fingerprint: target.key.fingerprint, authorityAllowed: false });
    await assert.rejects(start(), refusal("till_limit_reached", 403));
    await setTillLimit(db, CLI_ACTOR, a.install.businessId, null);
    assert.match((await start()).display, /^[0-9A-Z]{4}-/);
  } finally { await db.destroy(); }
});

it("two tills racing for the last place: the shop row lock lets exactly one take it", async () => {
  const { a, db } = await shop(2, []);
  try {
    const take = (device: string) => db.transaction().execute(async tx => {
      const place = await tillPlace(tx, a.install.businessId, true);
      await new Promise(resolve => setTimeout(resolve, 50)); // Both are inside their transaction before either commits.
      await tx.insertInto("shop_devices").values({ business_id: a.install.businessId, device_id: device, public_key: `key-${device}`, label: "Racer", platform: "ANDROID",
        authority_allowed: false, active: true, held: !hasPlace(place), last_seen_at: null }).execute();
      return hasPlace(place);
    });
    const results = await Promise.all([take(randomUUIDv7()), take(randomUUIDv7())]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.deepEqual(await tillPlace(db, a.install.businessId), { max: 2, used: 2 });
  } finally { await db.destroy(); }
});

it("shops and tills from before the migration stay unlimited and unheld", async () => {
  const url = await freshDatabase(), db = openDatabase(url);
  try {
    const before = Object.fromEntries(Object.entries(SERVER_MIGRATIONS).filter(([name]) => name < "0008"));
    await new Migrator({ db, provider: { getMigrations: async () => before } }).migrateToLatest();
    const shopId = randomUUIDv7(), ownerId = randomUUIDv7();
    await db.insertInto("shops").values({ business_id: shopId, name: "Old shop", owner_id: ownerId, enrolled_by: ownerId, status_changed_at: null, remove_after: null, connection_code_id: null, paid_until: null } as never).execute();
    await db.insertInto("shop_devices").values({ business_id: shopId, device_id: ownerId, public_key: "k", label: "Till", platform: "DESKTOP", authority_allowed: true, active: true, last_seen_at: null } as never).execute();
    assert.deepEqual(await migrateToLatest(db), Object.keys(SERVER_MIGRATIONS).filter(name => name >= "0008").sort());
    assert.deepEqual(await tillPlace(db, shopId), { max: null, used: 1 });
    assert.equal((await db.selectFrom("shop_devices").select("held").executeTakeFirstOrThrow()).held, false);
  } finally { await db.destroy(); }
});

it("trial days on a code: days alone, days with months, then grace and pause from a days-only shop", async () => {
  let clock = new Date("2026-10-24T08:00:00.000Z");
  const target = await started({ edition: "hosted", graceDays: 3, now: () => clock }), a = await owner(), b = await owner("Second shop");
  const db = openDatabase(target.databaseUrl);
  try {
    await connect(a, target, (await target.invite("Trial", 7, 0, { includedDays: 7, maxTills: null })).token);
    await sync(a, target);
    const [trial] = await query(target, `SELECT months, days, source, amount_minor FROM payments WHERE business_id=$1`, [a.install.businessId]);
    assert.deepEqual({ ...trial, amount_minor: Number(trial.amount_minor) }, { months: 0, days: 7, source: "code", amount_minor: 0 });
    assert.equal((await serverConnections(a.context, crypto))[0]?.paidUntil, "2026-10-31T08:00:00.000Z");
    await connect(b, target, (await target.invite("Paid with bonus", 7, 1, { includedDays: 10, maxTills: 2 })).token);
    await sync(b, target);
    assert.equal((await serverConnections(b.context, crypto))[0]?.paidUntil, "2026-12-04T08:00:00.000Z", "one calendar month, then ten days");
    const { codes } = await listCodes(db, clock);
    assert.deepEqual(codes.filter(code => code.state === "used").map(code => [code.includedMonths, code.includedDays, code.maxTills]).sort(), [[0, 7, null], [1, 10, 2]]);
    clock = new Date("2026-11-01T08:00:00.000Z"); await sync(a, target);
    assert.equal((await serverConnections(a.context, crypto))[0]?.service, "grace");
    clock = new Date(Date.parse("2026-10-31T08:00:00.000Z") + 3 * day);
    await assert.rejects(sync(a, target), refusal("hosted_service_inactive", 403));
    assert.equal(entitlementOf({ edition: "hosted", graceDays: 3 }, new Date("2026-10-31T08:00:00.000Z"), clock).status, "inactive");
    // Manual payments stay in whole months.
    await assert.rejects(recordShopPayment(db, CLI_ACTOR, { shopId: a.install.businessId, months: 0, amountMinor: 0, method: "cash" }, clock), /invalid_months/);
    await assert.rejects(issueCode(db, target.key, target.url, CLI_ACTOR, { label: "Too long", days: 7, now: clock, includedDays: 91 }), /invalid_trial_days/);
    await assert.rejects(issueCode(db, target.key, target.url, CLI_ACTOR, { label: "No till", days: 7, now: clock, maxTills: 0 }), /invalid_till_limit/);
    await assert.rejects(issueCode(db, target.key, target.url, CLI_ACTOR, { label: "", days: 1, now: clock, recoveryShopId: a.install.businessId, maxTills: 3 }), /invalid_request/);
  } finally { await db.destroy(); }
});
