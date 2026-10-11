import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { generateKeyPairSync, sign, verify, createHash, randomUUIDv7 } from "node:crypto";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate, MIGRATIONS } from "../data/database/migrations.ts";
import type { Database } from "../data/database/driver.ts";
import { createWorkspace, unlockWorkspace } from "../identity/workspace.ts";
import type { WorkspacePorts, OperationContext, Installation } from "../identity/types.ts";
import type { ExchangeCrypto } from "../exchange/types.ts";
import type { JournalEnvelope, SignedJournalEvent } from "@kolo/contracts/events";
import { batchSigningMessage } from "@kolo/contracts/delivery";
import { registerExchangeDestination, setExchangeDeviceActive, publishDeviceRoster, eventSigningMessage, verifyEvent } from "./exchange.ts";
import { applyEvent } from "./event-application.ts";
import { createJournalBatch, importJournalBatch } from "./event-delivery.ts";
import { normalizeServerUrl, SyncTransportError } from "./server-sync.ts";
import { createHttpSyncTransport, type FetchPort } from "./http-sync-transport.ts";
import * as commands from "./operations.ts";

const at = "2026-10-11T06:00:00.000Z", secret = "fixture-owner-secret";
const crypto: ExchangeCrypto = { sha256: async message => createHash("sha256").update(message).digest("hex"), verify: async (key, message, signature) => verify(null, Buffer.from(message), key, Buffer.from(signature, "hex")) };
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

interface Device { db: Database; context: OperationContext; install: Installation; publicKey: string; privateKey: string }
function native(db: Database) {
  const pair = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const material = { publicKey: pair.publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, newId: randomUUIDv7, now: () => at, credentials: { provision: async () => material, inspect: async () => material,
    verify: async (reference, pin) => reference === material.credentialReference && pin === secret, sign: async (_reference, message) => sign(null, Buffer.from(message), pair.privateKey).toString("hex") } };
  return { ports, material, publicKey: pair.publicKey, privateKey: pair.privateKey };
}
async function owner(): Promise<Device> {
  const db = openDatabase(); databases.push(db); migrate(db); const n = native(db);
  const install = await createWorkspace({ businessName: "Fixture shop", ownerName: "Owner", deviceLabel: "A", platform: "DESKTOP", currency: "XAF", secret }, n.ports);
  return { db, install, publicKey: n.publicKey, privateKey: n.privateKey, context: await unlockWorkspace({ userId: install.ownerId, secret }, n.ports) };
}
/** Paired with the owner only; `register` false leaves the owner unaware, as before trust propagated. */
async function paired(source: Device, register = true): Promise<Device> {
  const db = openDatabase(); databases.push(db); migrate(db); const n = native(db), device = randomUUIDv7();
  for (const table of ["businesses", "users", "devices", "financial_accounts"]) for (const row of source.db.all(`SELECT * FROM ${table}`)) {
    const columns = Object.keys(row); db.run(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, Object.values(row));
  }
  db.run(`INSERT INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES (?,?,'Replica','ANDROID',?,?,?)`, [device, source.install.businessId, at, at, at]);
  db.run(`INSERT INTO local_installation(id,installation_id,business_id,owner_id,device_id,public_key,key_reference,configured_at) VALUES (1,?,?,?,?,?,?,?)`, [randomUUIDv7(), source.install.businessId, source.install.ownerId, device, n.publicKey, n.material.keyReference, at]);
  db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,'OWNER')`, [source.install.businessId, source.install.ownerId, n.material.credentialReference]);
  db.run(`INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,0,?)`, [source.install.businessId, device, n.publicKey, source.install.ownerId]);
  db.run(`INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,1,?)`, [source.install.businessId, source.install.deviceId, source.publicKey, source.install.ownerId]);
  const context = await unlockWorkspace({ userId: source.install.ownerId, secret }, n.ports);
  db.run(`INSERT INTO exchange_destinations(id,business_id,receiver_device_id,kind,label) VALUES (?,?,?,'peer','Owner')`, [randomUUIDv7(), source.install.businessId, source.install.deviceId]); // As completed pairing leaves it.
  if (register) registerExchangeDestination(source.context, { deviceId: device, publicKey: n.publicKey, label: "Replica", platform: "ANDROID", kind: "peer" });
  return { db, install: { ...source.install, deviceId: device, publicKey: n.publicKey }, publicKey: n.publicKey, privateKey: n.privateKey, context };
}
const destination = (from: Device, to: Device) => String(from.db.get(`SELECT id FROM exchange_destinations WHERE receiver_device_id=?`, [to.install.deviceId])!["id"]);
async function send(from: Device, to: Device) { const batch = await createJournalBatch(from.context, destination(from, to), crypto); assert.ok(batch); return importJournalBatch(to.context, batch, crypto); }
const pin = (device: Device, id: string) => device.db.get(`SELECT active,authority_allowed,roster_revision FROM trusted_exchange_devices WHERE device_id=?`, [id]);
function product(device: Device): string {
  const id = randomUUIDv7();
  commands.saveProduct(device.context, { id, name: "Rice", unit: "bag", divisible: false, active: true, sellingPriceMinor: 500, purchasePriceMinor: 300, currency: "XAF", taxRateBasisPoints: 0, minimumStock: 0, createdAt: at, updatedAt: at });
  return id;
}
async function signed(device: Device, envelope: JournalEnvelope): Promise<SignedJournalEvent> {
  const message = eventSigningMessage(envelope); return { envelope, digest: await crypto.sha256(message), signature: sign(null, Buffer.from(message), device.privateKey).toString("hex") };
}
function rosterFact(device: Device, payload: JournalEnvelope["payload"], type: "DEVICE_TRUSTED" | "DEVICE_REVOKED", sequence: number): JournalEnvelope {
  return { event_id: randomUUIDv7(), business_id: device.install.businessId, origin_device_id: device.install.deviceId, actor_id: device.install.ownerId, origin_sequence: sequence,
    event_type: type, event_version: 2, occurred_at: at, branch_id: null, authority_revision: 1, required_permissions: ["users.manage"], payload };
}

it("a device learns keys it never paired with from owner-signed trust and accepts their relayed facts in any order", async () => {
  const a = await owner(), b = await paired(a), c = await paired(a);
  const p = product(c);
  await send(c, a); // The owner holds C's product; B has never met C.
  const outcomes = await send(a, b);
  assert.ok(outcomes.length > 0 && outcomes.every(outcome => outcome.outcome === "applied" || outcome.outcome === "duplicate"), JSON.stringify(outcomes));
  assert.equal(pin(b, c.install.deviceId)?.["active"], 1);
  assert.equal(b.db.get(`SELECT id FROM products WHERE id=?`, [p])?.["id"], p);
  assert.equal(b.db.get(`SELECT platform FROM devices WHERE id=?`, [c.install.deviceId])?.["platform"], "ANDROID");
});

it("facts from an origin still unknown are skipped without storage and accepted once trust arrives", async () => {
  const a = await owner(), b = await paired(a), c = await paired(a);
  product(c); await send(c, a);
  // The owner's batch arrives without C's trust fact, as if it had been delivered separately and lost.
  const full = (await createJournalBatch(a.context, destination(a, b), crypto))!;
  const batch = { ...full.batch, batch_id: randomUUIDv7(), events: full.batch.events.filter(event => !(event.envelope.event_type === "DEVICE_TRUSTED" && (event.envelope.payload["device"] as { id: string }).id === c.install.deviceId)) };
  const message = batchSigningMessage(batch);
  const first = await importJournalBatch(b.context, { batch, digest: await crypto.sha256(message), signature: sign(null, Buffer.from(message), a.privateKey).toString("hex") }, crypto);
  assert.ok(first.some(outcome => outcome.outcome === "untrusted"));
  assert.equal(b.db.get(`SELECT count(*) AS n FROM products`)!["n"], 0, "nothing from C was stored");
  assert.equal(b.db.get(`SELECT count(*) AS n FROM event_journal WHERE origin_device_id=?`, [c.install.deviceId])!["n"], 0);
  const second = await importJournalBatch(b.context, full, crypto);
  assert.ok(second.every(outcome => outcome.outcome !== "untrusted"), JSON.stringify(second));
  assert.equal(b.db.get(`SELECT count(*) AS n FROM products`)!["n"], 1);
});

it("earlier pairings are published once, revocation propagates, and stale or conflicting roster facts never win", async () => {
  const a = await owner(), b = await paired(a), c = await paired(a);
  a.db.run(`UPDATE trusted_exchange_devices SET roster_revision=0`); // As before trust propagated.
  assert.equal(publishDeviceRoster(a.context), 2); assert.equal(publishDeviceRoster(a.context), 0);
  setExchangeDeviceActive(a.context, c.install.deviceId, false);
  await send(a, b);
  assert.deepEqual({ ...pin(b, c.install.deviceId) }, { active: 0, authority_allowed: 0, roster_revision: 2 });
  // An older trust fact arriving late changes nothing.
  const stale = await signed(a, rosterFact(a, { device: { id: c.install.deviceId, label: "Replica", platform: "ANDROID", public_key: c.publicKey }, authority_allowed: false, revision: 1 }, "DEVICE_TRUSTED", 900));
  assert.equal(applyEvent(b.context, await verifyEvent(b.context, stale, crypto)), "applied");
  assert.equal(pin(b, c.install.deviceId)?.["active"], 0);
  // The same revision with different content conflicts; a changed key for a known device is refused.
  const conflicting = await signed(a, rosterFact(a, { device: { id: c.install.deviceId, label: "Replica", platform: "ANDROID", public_key: c.publicKey }, authority_allowed: false, revision: 2 }, "DEVICE_TRUSTED", 901));
  assert.equal(applyEvent(b.context, await verifyEvent(b.context, conflicting, crypto)), "quarantined");
  const other = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const rekey = await signed(a, rosterFact(a, { device: { id: c.install.deviceId, label: "Replica", platform: "ANDROID", public_key: other.publicKey }, authority_allowed: false, revision: 9 }, "DEVICE_TRUSTED", 902));
  assert.equal(applyEvent(b.context, await verifyEvent(b.context, rekey, crypto)), "quarantined");
  assert.equal(pin(b, c.install.deviceId)?.["active"], 0);
});

it("roster facts from a device without owner authority grant nothing", async () => {
  const a = await owner(), b = await paired(a), c = await paired(a);
  const stranger = randomUUIDv7(), key = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey;
  const fromB = await signed(b, rosterFact(b, { device: { id: stranger, label: "Stranger", platform: "DESKTOP", public_key: key }, authority_allowed: true, revision: 1 }, "DEVICE_TRUSTED", 900));
  await send(a, c); // C learns B's key from the owner, without authority.
  assert.equal(pin(c, b.install.deviceId)?.["authority_allowed"], 0);
  assert.equal(applyEvent(c.context, await verifyEvent(c.context, fromB, crypto)), "quarantined");
  assert.equal(pin(c, stranger), undefined);
});

it("server destinations require the SERVER platform and never carry authority", async () => {
  const a = await owner(), key = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey;
  for (const input of [{ platform: "DESKTOP" as const, kind: "server" as const }, { platform: "SERVER" as const, kind: "peer" as const }, { platform: "SERVER" as const, kind: "server" as const, authorityAllowed: true }])
    assert.throws(() => registerExchangeDestination(a.context, { deviceId: randomUUIDv7(), publicKey: key, label: "Server", ...input }));
  const id = registerExchangeDestination(a.context, { deviceId: randomUUIDv7(), publicKey: key, label: "Server", platform: "SERVER", kind: "server" });
  assert.equal(a.db.get(`SELECT kind FROM exchange_destinations WHERE id=?`, [id])?.["kind"], "server");
  assert.equal(a.db.get(`SELECT count(*) AS n FROM event_journal WHERE event_type='DEVICE_TRUSTED'`)!["n"], 1);
});

it("schema 24 with devices referenced from sales upgrades to the latest schema keeping every reference", async () => {
  const a = await owner(), p = product(a);
  commands.completeSale(a.context, { id: randomUUIDv7(), number: "V-1", eventId: randomUUIDv7(), occurredAt: at, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, name: "Rice", unitPriceMinor: 500, unitCostMinor: 300, quantity: 1000 }],
    payments: [{ id: randomUUIDv7(), accountId: String(a.db.get(`SELECT id FROM financial_accounts LIMIT 1`)!["id"]), amountMinor: 500 }] });
  // Rewind only migration 25 on a copy with real data, then upgrade it again.
  const old = openDatabase(); databases.push(old);
  old.run(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT`);
  old.transaction(tx => { for (const migration of MIGRATIONS.filter(m => m.version < 25)) { for (const statement of migration.statements) tx.run(statement); tx.run(`INSERT INTO schema_migrations VALUES (?,?,?)`, [migration.version, migration.name, at]); } });
  const tables = ["businesses", "users", "devices", "financial_accounts", "products", "sales", "sale_items", "sale_payments", "inventory_movements"];
  for (const table of tables) for (const row of a.db.all(`SELECT * FROM ${table}`)) {
    const columns = Object.keys(row).filter(column => old.all(`PRAGMA table_info(${table})`).some(info => info["name"] === column));
    old.run(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, columns.map(column => row[column]!));
  }
  assert.throws(() => old.run(`UPDATE devices SET platform='SERVER'`));
  assert.deepEqual(migrate(old).applied.map(m => m.version), [25, 26, 27]);
  assert.deepEqual(old.all(`PRAGMA foreign_key_check`), []);
  assert.equal(old.get(`SELECT count(*) AS n FROM devices`)!["n"], a.db.get(`SELECT count(*) AS n FROM devices`)!["n"]);
  assert.ok(old.all(`PRAGMA foreign_key_list(sales)`).some(fk => fk["table"] === "devices"));
  assert.equal(old.get(`SELECT name FROM sqlite_master WHERE name='devices_v24'`), undefined);
  assert.throws(() => old.run(`DELETE FROM devices`), "devices remain protected by their children");
  old.run(`INSERT INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES (?,?, 'Server','SERVER',?,?,?)`, [randomUUIDv7(), a.install.businessId, at, at, at]);
});

it("server addresses require HTTPS except on loopback and private networks, and never carry credentials", () => {
  assert.equal(normalizeServerUrl(" https://sync.example.com/ "), "https://sync.example.com");
  for (const ok of ["http://localhost:8080", "http://127.0.0.1:8080", "http://192.168.1.20:8080", "http://10.0.0.5", "http://172.20.0.2:8080", "http://kolo.local:8080"]) assert.doesNotThrow(() => normalizeServerUrl(ok), ok);
  for (const bad of ["http://sync.example.com", "http://172.32.0.1", "ftp://host", "https://user:pass@host", "https://host/?token=1", "https://host/#x", "not a url", "http://8.8.8.8"]) assert.throws(() => normalizeServerUrl(bad), bad);
});

it("transport failures map to stable retryable codes without trusting the response body", async () => {
  const answer = (status: number, body: string): FetchPort => async () => ({ status, text: async () => body });
  const call = (fetch: FetchPort, timeoutMs = 1000) => createHttpSyncTransport("https://sync.example.com", { fetch, timeoutMs }).identity();
  const failure = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { assert.ok(error instanceof SyncTransportError); return { code: error.code, status: error.status, retry: error.retry }; } assert.fail("expected a failure"); };
  assert.deepEqual(await failure(call(async () => { throw new Error("ECONNREFUSED secret detail"); })), { code: "network_unavailable", status: 0, retry: true });
  assert.deepEqual(await failure(call(answer(429, `{"error":{"code":"rate_limited","retry":true}}`))), { code: "rate_limited", status: 429, retry: true });
  assert.deepEqual(await failure(call(answer(503, `<html>proxy</html>`))), { code: "invalid_response", status: 503, retry: true });
  assert.deepEqual(await failure(call(answer(502, ``))), { code: "http_error", status: 502, retry: true });
  assert.deepEqual(await failure(call(answer(403, `{"error":{"code":"enrollment_closed","retry":false}}`))), { code: "enrollment_closed", status: 403, retry: false });
  assert.deepEqual(await failure(call(answer(200, `{"api_version":2}`))), { code: "invalid_response", status: 200, retry: false });
  assert.deepEqual(await failure(call((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))), 10)), { code: "network_unavailable", status: 0, retry: true });
  assert.throws(() => createHttpSyncTransport("http://sync.example.com"));
});
