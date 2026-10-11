import assert from "node:assert/strict";
import { after, it } from "node:test";
import { createHash, randomUUIDv7, sign } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Migrator } from "kysely/migration";
import { setExchangeDeviceActive } from "@kolo/core/application/exchange";
import { connectServer, disconnectServer, pendingShopServer, serverConnections, SyncTransportError } from "@kolo/core/application/server-sync";
import { createJournalBatch, importJournalBatch } from "@kolo/core/application/event-delivery";
import { createSyncBatch, shopKeys } from "@kolo/core/application/sealed-sync";
import { stockOf } from "@kolo/core/data/inventory/movements";
import { CLEAR_EVENT_TYPES, enrollmentSigningMessage, sessionSigningMessage, syncBatchSigningMessage, type SyncBatch } from "@kolo/contracts/sync";
import { migrateToLatest, openDatabase, SERVER_MIGRATIONS } from "./database.js";
import { loadServerKey } from "./identity.js";
import { CLI_ACTOR, cancelCode, purgeRemovedShops, setShopStatus } from "./admin/operations.js";
import { adminUrl, cleanup, connect, count, crypto, freshDatabase, owner, paired, product, query, sale, started, sync, type Device, type Server } from "./sync.fixtures.js";

const skip = adminUrl === undefined;
after(cleanup);

async function session(device: Device, target: Server): Promise<string> {
  const challenge = await target.transport.challenge({ purpose: "session", business_id: device.install.businessId, device_id: device.install.deviceId });
  const claim = { format: "kolo.server-session" as const, format_version: 1 as const, challenge_id: challenge.challenge_id, nonce: challenge.nonce, server_device_id: target.key.deviceId, business_id: device.install.businessId, device_id: device.install.deviceId };
  return (await target.transport.session({ claim, signature: sign(null, Buffer.from(sessionSigningMessage(claim)), device.privateKey).toString("hex") })).token;
}
const refusal = (code: string, status?: number) => (error: unknown) => error instanceof SyncTransportError && error.code === code && (status === undefined || error.status === status);
/** Send everything one till holds for a peer by file, the way F3 exchange does. */
async function byFile(from: Device, to: Device) {
  const destination = String(from.db.get(`SELECT id FROM exchange_destinations WHERE receiver_device_id=? AND kind='peer'`, [to.install.deviceId])!["id"]);
  const batch = await createJournalBatch(from.context, destination, crypto, 1000);
  if (batch !== undefined) await importJournalBatch(to.context, batch, crypto);
}
/** Everything the server stores that could carry business content, as one string. */
async function storedText(target: Server): Promise<string> {
  const rows = await query(target, `SELECT coalesce(canonical,'') || coalesce(sealed::text,'') AS t FROM journal UNION ALL SELECT coalesce(canonical,'') || coalesce(sealed::text,'') FROM journal_conflicts UNION ALL SELECT canonical FROM receipts`);
  return rows.map(row => String(row.t)).join("\n");
}
async function settle(devices: readonly Device[], target: Server, rounds = 3) { for (let round = 0; round < rounds; round++) for (const device of devices) await sync(device, target); }

it("devices that never met converge through the server, and the server never holds a business record in the clear", { skip }, async () => {
  const target = await started(), a = await owner(), b = await paired(a, "Till B"), p = product(a, "Secret Rice Blend");
  await connect(a, target); await sync(a, target);
  await connect(b, target); await sync(b, target);
  const c = await paired(a, "Till C"); // B has never met C.
  await sync(a, target); await connect(c, target); await sync(c, target);
  await settle([a, b, c], target); // Keys are granted once the owner has seen each till's encryption key.
  const numbers = [sale(a, p, "V-ALPHA-0001"), sale(b, p, "V-BRAVO-0002"), sale(c, p, "V-CHARLIE-0003")];
  await settle([a, b, c], target);
  for (const device of [a, b, c]) {
    assert.equal(count(device, "sales"), 3);
    assert.equal(stockOf(device.db, device.install.businessId, p).onHandThousandths, -3000);
    assert.deepEqual(device.db.all(`SELECT e.event_type,a.status,a.reason FROM applied_events a JOIN event_journal e ON e.event_id=a.event_id WHERE a.status<>'applied'`), []);
    assert.equal((await shopKeys(device.context, crypto)).length, 1, "every till holds the one shop key");
  }
  assert.equal(b.db.get(`SELECT active FROM trusted_exchange_devices WHERE device_id=?`, [c.install.deviceId])?.["active"], 1, "B learned C's key from the owner");
  // What the server holds: trust, keys and addresses in the clear; nothing else.
  const clear = await query(target, `SELECT DISTINCT event_type FROM journal WHERE canonical IS NOT NULL`);
  assert.ok(clear.every(row => (CLEAR_EVENT_TYPES as readonly string[]).includes(row.event_type)), JSON.stringify(clear));
  assert.ok(Number((await query(target, `SELECT count(*)::int AS n FROM journal WHERE sealed IS NOT NULL`))[0].n) >= 5);
  const stored = await storedText(target);
  for (const secretText of ["Secret Rice Blend", "Fixture shop", "Owner", ...numbers, "SALE_COMPLETED", "PRODUCT_SAVED"]) assert.equal(stored.includes(secretText), false, `server holds ${secretText}`);
  const [connection] = await serverConnections(b.context, crypto);
  assert.equal(connection?.fingerprint, target.key.fingerprint); assert.equal(connection?.pending, 0); assert.equal(connection?.lastError, null);
  // A repeated pass moves nothing and repeats no effect.
  assert.deepEqual(await sync(b, target), { pushed: 0, rejected: 0, pulled: 0, untrusted: 0, locked: 0 });
  assert.equal(count(b, "sales"), 3);
});

it("a till without a shop key keeps its facts until the owner grants one, then delivers them", { skip }, async () => {
  const target = await started(), a = await owner(), b = await paired(a, "Till B"), p = product(a);
  await connect(a, target); await sync(a, target); await connect(b, target);
  await byFile(a, b); // B holds the product, as pairing leaves it.
  sale(b, p, "V-WAITING");
  const first = await sync(b, target);
  assert.ok(first.locked > 0, "B's sale waits for a key and A's facts cannot be opened yet");
  assert.equal(Number((await query(target, `SELECT count(*)::int AS n FROM journal WHERE origin_device_id=$1 AND sealed IS NOT NULL`, [b.install.deviceId]))[0].n), 0, "nothing of B's was sent unsealed or sealed");
  await sync(a, target); // A learns B's encryption key and grants the shop key.
  const second = await sync(b, target);
  assert.equal(second.locked, 0); assert.ok(second.pushed > 0);
  await sync(a, target);
  assert.equal(count(a, "sales"), 1);
});

it("lost push responses and replayed batches never duplicate facts, and stored facts are append-only", { skip }, async () => {
  const target = await started(), a = await owner(), b = await paired(a, "Till B"), p = product(a);
  await connect(a, target); await sync(a, target); await connect(b, target); await settle([b, a, b], target, 1);
  sale(a, p);
  const keys = await shopKeys(a.context, crypto), { signed } = await createSyncBatch(a.context, a.destination!, crypto, keys), token = await session(a, target);
  const first = await target.transport.push(token, signed!), replay = await target.transport.push(token, signed!);
  assert.ok(first.results.every(result => result.status === "stored"));
  assert.ok(replay.results.every(result => result.status === "duplicate"));
  // The same fact sealed again (fresh nonce, new batch) is still a duplicate, never a conflict.
  const again = await createSyncBatch(a.context, a.destination!, crypto, keys);
  if (again.signed !== undefined) assert.ok((await target.transport.push(token, again.signed)).results.every(result => result.status === "duplicate"));
  await sync(a, target); await sync(b, target); await sync(b, target);
  assert.equal(count(b, "sales"), 1); assert.equal(count(b, "sale_payments"), 1);
  await assert.rejects(query(target, `UPDATE journal SET digest=repeat('0',64)`), /append-only/);
  await assert.rejects(query(target, `DELETE FROM journal`), /append-only/);
});

it("plain business facts are refused, forged clear facts are refused, and a forged sealed fact cannot reach any till", { skip }, async () => {
  const target = await started(), a = await owner(), b = await paired(a, "Till B"), p = product(a);
  await connect(a, target); await sync(a, target); await connect(b, target); await settle([b, a, b], target, 1);
  sale(a, p);
  const keys = await shopKeys(a.context, crypto), { signed } = await createSyncBatch(a.context, a.destination!, crypto, keys), token = await session(a, target);
  const sealed = signed!.batch.events.find(item => "sealed" in item)!;
  // A business fact sent in the clear by a buggy or old till.
  const plain = (await createJournalBatch(a.context, String(a.db.get(`SELECT id FROM exchange_destinations WHERE kind='peer'`)!["id"]), crypto))!.batch.events.find(event => event.envelope.event_type === "SALE_COMPLETED")!;
  // A clear trust fact whose signature does not match its content.
  const roster = a.db.get(`SELECT canonical FROM event_journal WHERE event_type='DEVICE_TRUSTED' LIMIT 1`)!, envelope = JSON.parse(String(roster["canonical"]));
  const forgedClear = { envelope: { ...envelope, payload: { ...envelope.payload, authority_allowed: true } }, digest: "0".repeat(64), signature: "0".repeat(128) };
  // Same identity, different content: kept as a conflict, never overwriting.
  const changed = { sealed: { ...("sealed" in sealed ? sealed.sealed : ({} as never)), digest: "f".repeat(64) } };
  await target.transport.push(token, signed!);
  const batch: SyncBatch = { ...signed!.batch, batch_id: randomUUIDv7(), events: [{ clear: plain }, { clear: forgedClear }, changed] };
  const message = syncBatchSigningMessage(batch);
  const response = await target.transport.push(token, { batch, digest: createHash("sha256").update(message).digest("hex"), signature: sign(null, Buffer.from(message), a.privateKey).toString("hex") });
  assert.deepEqual(response.results.map(result => result.code), ["plaintext_refused", "invalid_signature", "event_identity_conflict"]);
  assert.equal(response.receipt, null, "nothing in that batch was accepted");
  assert.ok(Number((await query(target, `SELECT count(*)::int AS n FROM journal_conflicts`))[0].n) >= 1);
  // A trusted till seals garbage under another device's identity: the server cannot tell, every till refuses it, and nothing else is blocked.
  const forgedId = randomUUIDv7(), forgedEvent = { ...("sealed" in sealed ? sealed.sealed : ({} as never)), event_id: forgedId, origin_sequence: 9999, digest: "e".repeat(64) };
  const garbage: SyncBatch = { ...signed!.batch, batch_id: randomUUIDv7(), events: [{ sealed: forgedEvent }] }, garbageMessage = syncBatchSigningMessage(garbage);
  await target.transport.push(token, { batch: garbage, digest: createHash("sha256").update(garbageMessage).digest("hex"), signature: sign(null, Buffer.from(garbageMessage), a.privateKey).toString("hex") });
  await sync(b, target); await sync(b, target);
  assert.equal(count(b, "sales"), 1, "the real sale arrived");
  assert.equal(b.db.get(`SELECT event_id FROM event_journal WHERE event_id=?`, [forgedId]), undefined, "the forged fact was never stored");
  // A batch whose own signature does not match is refused as a whole.
  await assert.rejects(target.transport.push(token, { ...signed!, signature: "0".repeat(128) }), refusal("invalid_signature", 401));
});

it("one shop can never read or write another shop's facts", { skip }, async () => {
  const target = await started(), a = await owner("Shop A"), x = await owner("Shop X"), p = product(a);
  await connect(a, target); await connect(x, target); sale(a, p); await sync(a, target);
  const token = await session(x, target);
  assert.equal((await target.transport.pull(token, null, 100)).batch, null, "shop X sees none of shop A's facts");
  assert.equal((await target.transport.status(token)).pending, 0);
  sale(a, p);
  const { signed } = await createSyncBatch(a.context, a.destination!, crypto, await shopKeys(a.context, crypto));
  await assert.rejects(target.transport.push(token, signed!), (error: unknown) => error instanceof SyncTransportError && error.status === 403);
  const aToken = await session(a, target), cursor = (await target.transport.pull(aToken, null, 1)).cursor;
  if (cursor !== null) await assert.rejects(target.transport.pull(token, cursor, 1), refusal("invalid_cursor"));
  await assert.rejects(target.transport.pull(token, "bm90LWEtY3Vyc29y", 1), refusal("invalid_cursor"));
  // Shop X's till cannot open shop A's sealed facts even if a server handed them over.
  const foreign = await query(target, `SELECT sealed FROM journal WHERE business_id=$1 AND sealed IS NOT NULL LIMIT 1`, [a.install.businessId]);
  const { openSealedEvent } = await import("@kolo/core/application/sealed-sync");
  assert.equal(await openSealedEvent(crypto, a.install.businessId, await shopKeys(x.context, crypto), foreign[0].sealed), undefined);
});

it("connection codes work once, expire, can be cancelled, and a shop cannot be claimed from another device", { skip }, async () => {
  const target = await started(), a = await owner();
  const attach = (device: Device, token?: string, fingerprint = target.key.fingerprint) => connectServer(device.context, target.transport, { url: target.url, fingerprint, ...(token === undefined ? {} : { token }) }, crypto);
  await assert.rejects(attach(a), refusal("invalid_connection_code", 403), "a new shop needs a code");
  await assert.rejects(attach(a, "0".repeat(32)), refusal("invalid_connection_code"));
  const expired = await target.invite("Old", 1);
  await query(target, `UPDATE connection_codes SET created_at=now()-interval '3 days', expires_at=now()-interval '1 second' WHERE token_hash=encode(sha256($1::bytea),'hex')`, [expired.token]);
  await assert.rejects(attach(a, expired.token), refusal("connection_code_expired"));
  const cancelled = await target.invite("Cancelled"), db = openDatabase(target.databaseUrl);
  try { await cancelCode(db, CLI_ACTOR, String((await query(target, `SELECT code_id FROM connection_codes WHERE label='Cancelled'`))[0].code_id), new Date()); } finally { await db.destroy(); }
  await assert.rejects(attach(a, cancelled.token), refusal("invalid_connection_code"));
  await assert.rejects(attach(a, (await target.invite()).token, "0".repeat(32)), (error: unknown) => (error as { code?: string }).code === "fingerprint_mismatch");
  const code = await target.invite("Shop A");
  await attach(a, code.token);
  await attach(a); // Reconnecting from the enrolling device is idempotent and needs no new code.
  assert.deepEqual((await query(target, `SELECT c.label, s.name FROM connection_codes c JOIN shops s ON s.business_id=c.used_by`)).map(row => [row.label, row.name]), [["Shop A", "Fixture shop"]]);
  const other = await owner("Other shop");
  await assert.rejects(attach(other, code.token), refusal("connection_code_used"));
  // Another device claiming shop A is a conflict, with or without a code.
  const impostor = await owner();
  const { token: fresh } = await target.invite();
  const challenge = await target.transport.challenge({ purpose: "enrollment", business_id: a.install.businessId, device_id: impostor.install.deviceId });
  const claim = { format: "kolo.server-enrollment" as const, format_version: 1 as const, challenge_id: challenge.challenge_id, nonce: challenge.nonce, server_device_id: target.key.deviceId,
    business: { id: a.install.businessId, name: "Taken" }, owner_id: a.install.ownerId, device: { id: impostor.install.deviceId, label: "Impostor", platform: "DESKTOP" as const, public_key: impostor.publicKey } };
  const signature = sign(null, Buffer.from(enrollmentSigningMessage(claim)), impostor.privateKey).toString("hex");
  await assert.rejects(target.transport.enroll({ claim, signature, connection_code: fresh }), refusal("enrollment_conflict", 409));
  await assert.rejects(target.transport.enroll({ claim, signature, connection_code: fresh }), "a replayed challenge is single-use");
  assert.equal((await query(target, `SELECT used_at FROM connection_codes WHERE token_hash=encode(sha256($1::bytea),'hex')`, [fresh]))[0].used_at, null, "a refused enrollment consumes no code");
});

it("a second owner till with management approval joins an attached shop without a code, and before approval is told to wait", { skip }, async () => {
  const target = await started(), a = await owner(), b = await paired(a, "Owner phone", true);
  await connect(a, target);
  // The owner's main till has not synced since approving B: the server does not know B yet.
  await assert.rejects(connectServer(b.context, target.transport, { url: target.url, fingerprint: target.key.fingerprint }, crypto), refusal("invalid_session", 401));
  await sync(a, target);
  b.destination = await connectServer(b.context, target.transport, { url: target.url, fingerprint: target.key.fingerprint }, crypto);
  await settle([b, a, b], target, 1);
  assert.equal((await shopKeys(b.context, crypto)).length, 1, "the second owner till received the shop key");
  assert.equal(Number((await query(target, `SELECT count(*)::int AS n FROM connection_codes WHERE used_at IS NOT NULL`))[0].n), 1, "only the first attachment used a code");
});

it("the owner's shared server address connects paired tills on their own, and a till can opt out", { skip }, async () => {
  const target = await started(), a = await owner(), b = await paired(a, "Till B");
  await connect(a, target); await sync(a, target);
  assert.equal(pendingShopServer(a.context), undefined, "the owner is already connected");
  await byFile(a, b); // The owner's SERVER_ENDPOINT_SET reaches B by file exchange.
  const shared = pendingShopServer(b.context);
  assert.deepEqual(shared, { url: target.url, fingerprint: target.key.fingerprint, serverDeviceId: target.key.deviceId });
  b.destination = await connectServer(b.context, target.transport, { ...shared!, source: "shop" }, crypto);
  await settle([b, a, b], target, 1);
  assert.equal((await serverConnections(b.context, crypto))[0]?.source, "shop");
  assert.equal(pendingShopServer(b.context), undefined);
  disconnectServer(b.context, b.destination);
  assert.equal(pendingShopServer(b.context), undefined, "stopping is remembered");
  // The owner stopping withdraws the address for tills that have not connected yet.
  const c = await paired(a, "Till C");
  disconnectServer(a.context, a.destination!);
  await byFile(a, c);
  assert.equal(pendingShopServer(c.context), undefined);
  assert.equal(c.db.get(`SELECT url FROM shop_server_endpoint`)?.["url"], null);
});

it("an owner revocation removes network access at once and rotates the shop key, so the revoked till cannot read newer facts", { skip }, async () => {
  const target = await started(), a = await owner(), b = await paired(a, "Till B"), c = await paired(a, "Till C"), p = product(a);
  await connect(a, target); await sync(a, target); await connect(b, target); await connect(c, target);
  await settle([b, c, a, b, c], target, 1);
  const before = await shopKeys(b.context, crypto);
  assert.equal(before.length, 1);
  const token = await session(b, target);
  setExchangeDeviceActive(a.context, b.install.deviceId, false); await sync(a, target);
  await assert.rejects(target.transport.status(token), refusal("invalid_session"));
  await assert.rejects(sync(b, target), refusal("invalid_session"));
  assert.equal((await serverConnections(b.context, crypto))[0]?.lastError, "invalid_session");
  sale(a, p, "V-AFTER-REVOKE"); await sync(a, target); await sync(c, target); await sync(a, target);
  const newest = (await query(target, `SELECT max((sealed->>'epoch')::int) AS e FROM journal`))[0].e;
  assert.equal(newest, 2, "facts after the revocation are sealed with a new epoch");
  assert.ok((await shopKeys(c.context, crypto)).some(key => key.epoch === 2), "the remaining till holds the new key");
  assert.equal(a.db.get(`SELECT count(*) AS n FROM shop_key_grants WHERE device_id=? AND epoch=2`, [b.install.deviceId])!["n"], 0, "the revoked till was never granted it");
  const sealedSale = await query(target, `SELECT sealed FROM journal WHERE (sealed->>'epoch')::int = 2 LIMIT 1`);
  const { openSealedEvent } = await import("@kolo/core/application/sealed-sync");
  assert.equal(await openSealedEvent(crypto, b.install.businessId, before, sealedSale[0].sealed), undefined);
  assert.equal(count(c, "sales"), 1);
});

it("a suspended or removed shop cannot sync while its tills keep trading, and removal is purged after the grace period", { skip }, async () => {
  let clock = new Date("2026-10-11T06:00:00.000Z");
  const target = await started({ now: () => clock }), a = await owner(), p = product(a);
  await connect(a, target); await sync(a, target);
  const db = openDatabase(target.databaseUrl);
  try {
    await setShopStatus(db, CLI_ACTOR, a.install.businessId, "suspend", clock);
    await assert.rejects(sync(a, target), refusal("shop_suspended", 403));
    sale(a, p); assert.equal(count(a, "sales"), 1, "local trading never waits for the server");
    await assert.rejects(setShopStatus(db, CLI_ACTOR, a.install.businessId, "suspend", clock), /invalid_status_change/);
    await setShopStatus(db, CLI_ACTOR, a.install.businessId, "resume", clock);
    assert.ok((await sync(a, target)).pushed > 0);
    await setShopStatus(db, CLI_ACTOR, a.install.businessId, "remove", clock);
    await assert.rejects(sync(a, target), refusal("shop_removed", 403));
    assert.deepEqual(await purgeRemovedShops(db, CLI_ACTOR, clock), [], "nothing is purged during the grace period");
    clock = new Date(clock.getTime() + 31 * 86_400_000);
    assert.deepEqual(await purgeRemovedShops(db, CLI_ACTOR, clock), [a.install.businessId]);
    for (const table of ["shops", "shop_devices", "journal", "deliveries", "receipts"]) assert.equal(Number((await query(target, `SELECT count(*)::int AS n FROM ${table}`))[0].n), 0, table);
    assert.deepEqual((await query(target, `SELECT action FROM admin_audit ORDER BY id`)).map(row => row.action).filter(action => action.startsWith("shop.")), ["shop.suspend", "shop.resume", "shop.remove", "shop.purge"]);
    await assert.rejects(query(target, `DELETE FROM admin_audit`), /append-only/);
  } finally { await db.destroy(); }
});

it("a database holding F6a plaintext business facts is migrated only when the operator asks to discard them", { skip }, async () => {
  const url = await freshDatabase(), db = openDatabase(url);
  try {
    await new Migrator({ db, provider: { getMigrations: async () => ({ "0001_relay": SERVER_MIGRATIONS["0001_relay"]! }) } }).migrateToLatest();
    const shop = randomUUIDv7(), device = randomUUIDv7(), event = randomUUIDv7();
    await query({ databaseUrl: url }, `INSERT INTO shops(business_id,name,owner_id,enrolled_by) VALUES ($1,'Shop',$2,$3)`, [shop, randomUUIDv7(), device]);
    await query({ databaseUrl: url }, `INSERT INTO shop_devices(business_id,device_id,public_key,label,platform) VALUES ($1,$2,'-----BEGIN PUBLIC KEY-----','Till','DESKTOP')`, [shop, device]);
    await query({ databaseUrl: url }, `INSERT INTO journal(business_id,event_id,origin_device_id,origin_sequence,event_type,event_version,canonical,digest,signature,received_from) VALUES ($1,$2,$3,1,'SALE_COMPLETED',2,'{"sale":"plain"}',repeat('a',64),repeat('b',128),$3)`, [shop, event, device]);
    await assert.rejects(migrateToLatest(db), (error: unknown) => String((error as { cause?: { message?: string } }).cause?.message).includes("discard-plaintext"));
    assert.equal(Number((await query({ databaseUrl: url }, `SELECT count(*)::int AS n FROM journal`))[0].n), 1, "nothing changed");
    assert.deepEqual(await migrateToLatest(db, { discardPlaintext: true }), Object.keys(SERVER_MIGRATIONS).sort().slice(1));
    assert.equal(Number((await query({ databaseUrl: url }, `SELECT count(*)::int AS n FROM journal`))[0].n), 0);
    await assert.rejects(query({ databaseUrl: url }, `INSERT INTO journal(business_id,event_id,origin_device_id,origin_sequence,event_type,event_version,canonical,digest,signature,received_from) VALUES ($1,$2,$3,2,'SALE_COMPLETED',2,'{}',repeat('a',64),repeat('b',128),$3)`, [shop, randomUUIDv7(), device]), /journal_clear_types/);
    await query({ databaseUrl: url }, `INSERT INTO journal(business_id,event_id,origin_device_id,origin_sequence,event_type,event_version,canonical,digest,signature,received_from) VALUES ($1,$2,$3,3,'DEVICE_ENCRYPTION_KEY',2,'{}',repeat('a',64),repeat('b',128),$3)`, [shop, randomUUIDv7(), device]);
    await assert.rejects(query({ databaseUrl: url }, `DELETE FROM journal`), /append-only/, "the discard switch does not stay on");
  } finally { await db.destroy(); }
});

it("unknown devices cannot open sessions, and request limits answer with stable codes", { skip }, async () => {
  const target = await started({ rateLimitMax: 40 }), a = await owner(), stranger = await owner();
  await connect(a, target);
  await assert.rejects(session(stranger, target), refusal("invalid_session"));
  const token = await session(a, target);
  const big = await fetch(`${target.url}/api/v2/sync/push`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: `"${"x".repeat(9 * 1024 * 1024)}"` });
  assert.equal(big.status, 413); assert.deepEqual(await big.json(), { error: { code: "batch_too_large" } });
  const malformed = await fetch(`${target.url}/api/v2/sync/push`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: `{"batch":1}` });
  assert.equal(malformed.status, 400); assert.deepEqual(await malformed.json(), { error: { code: "invalid_request", retry: false } });
  const unauthenticated = await fetch(`${target.url}/api/v2/sync/pull`);
  assert.equal(unauthenticated.status, 401);
  let limited: Response | undefined;
  for (let attempt = 0; attempt < 10 && limited === undefined; attempt++) {
    const response = await fetch(`${target.url}/api/v2/auth/challenges`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "session", business_id: a.install.businessId, device_id: a.install.deviceId }) });
    if (response.status === 429) limited = response;
  }
  assert.ok(limited); assert.deepEqual(await limited.json(), { error: { code: "rate_limited", retry: true } }); assert.ok(limited.headers.get("retry-after"));
});

it("the server keeps one identity across restarts and creates it with owner-only permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-key-"));
  try {
    const path = join(directory, "key.json"), first = loadServerKey(path), second = loadServerKey(path);
    assert.equal(first.deviceId, second.deviceId); assert.equal(first.publicKey, second.publicKey);
    assert.equal(first.fingerprint, second.fingerprint); if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600, "owner-only on POSIX; Windows has no file modes");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
