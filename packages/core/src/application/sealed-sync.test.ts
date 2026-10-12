import assert from "node:assert/strict";
import { closeConsistent } from "../data/database/integrity.ts";
import { afterEach, it } from "node:test";
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, pbkdf2Sync, randomBytes, randomUUIDv7, sign, verify } from "node:crypto";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import type { Database } from "../data/database/driver.ts";
import { createWorkspace, unlockWorkspace } from "../identity/workspace.ts";
import type { WorkspacePorts, OperationContext, Installation } from "../identity/types.ts";
import type { JournalEnvelope, SignedJournalEvent } from "@kolo/contracts/events";
import { nativeTransferCrypto } from "../backup/native-crypto.ts";
import { registerExchangeDestination, setExchangeDeviceActive, eventSigningMessage, verifyEvent } from "./exchange.ts";
import { applyEvent } from "./event-application.ts";
import { createJournalBatch, importJournalBatch } from "./event-delivery.ts";
import { currentShopKey, ensureEncryptionKey, maintainShopKeys, openSealedEvent, sealEvent, shopKeys, type SealingCrypto } from "./sealed-sync.ts";
import { pendingShopServer, shareServerEndpoint } from "./server-sync.ts";

const at = "2026-10-11T06:00:00.000Z", secret = "fixture-owner-secret";
const crypto: SealingCrypto = {
  ...nativeTransferCrypto({
    sha256: async message => createHash("sha256").update(message).digest("hex"),
    verify: async (key, message, signature) => verify(null, Buffer.from(message), key, Buffer.from(signature, "hex")),
    randomHex: bytes => randomBytes(bytes).toString("hex"), derive: async (password, salt, iterations) => pbkdf2Sync(password, Buffer.from(salt, "hex"), iterations, 32, "sha256").toString("hex"),
    sha256Bytes: async bytes => createHash("sha256").update(bytes).digest("hex"),
    encodeText: text => new Uint8Array(Buffer.from(text, "utf8")), decodeText: bytes => Buffer.from(bytes).toString("utf8"),
    encodeBase64: bytes => Buffer.from(bytes).toString("base64"), decodeBase64: text => new Uint8Array(Buffer.from(text, "base64")),
    fromHex: hex => new Uint8Array(Buffer.from(hex, "hex")), toHex: bytes => Buffer.from(bytes).toString("hex"),
    cipher: (key, nonce) => createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(nonce, "hex"), { authTagLength: 16 }),
    decipher: (key, nonce) => createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(nonce, "hex"), { authTagLength: 16 }),
  }),
  ephemeralAgreement: async recipient => {
    const pair = generateKeyPairSync("x25519");
    return { publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), shared: diffieHellman({ privateKey: pair.privateKey, publicKey: createPublicKey(recipient) }).toString("hex") };
  },
  hkdf: async (ikm, salt, info, bytes) => Buffer.from(hkdfSync("sha256", Buffer.from(ikm, "hex"), Buffer.from(salt, "hex"), info, bytes)).toString("hex"),
  hmac: async (key, message) => createHmac("sha256", Buffer.from(key, "hex")).update(message, "utf8").digest("hex"),
};
const databases: Database[] = [];
afterEach(() => { closeConsistent(databases.splice(0)); });

interface Device { db: Database; context: OperationContext; install: Installation; privateKey: string }
function native(db: Database) {
  const pair = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const sealing = generateKeyPairSync("x25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const material = { publicKey: pair.publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, newId: randomUUIDv7, now: () => at, credentials: { provision: async () => material, inspect: async () => material,
    verify: async (reference, pin) => reference === material.credentialReference && pin === secret, sign: async (_reference, message) => sign(null, Buffer.from(message), pair.privateKey).toString("hex"),
    encryptionKey: async () => sealing.publicKey, agree: async (_reference, peer) => diffieHellman({ privateKey: createPrivateKey(sealing.privateKey), publicKey: createPublicKey(peer) }).toString("hex") } };
  return { ports, material, publicKey: pair.publicKey, privateKey: pair.privateKey };
}
async function owner(): Promise<Device> {
  const db = openDatabase(); databases.push(db); migrate(db); const n = native(db);
  const install = await createWorkspace({ businessName: "Fixture shop", ownerName: "Owner", deviceLabel: "A", platform: "DESKTOP", currency: "XAF", secret }, n.ports);
  return { db, install, privateKey: n.privateKey, context: await unlockWorkspace({ userId: install.ownerId, secret }, n.ports) };
}
async function paired(source: Device): Promise<Device> {
  const db = openDatabase(); databases.push(db); migrate(db); const n = native(db), device = randomUUIDv7();
  for (const table of ["businesses", "users", "devices", "financial_accounts"]) for (const row of source.db.all(`SELECT * FROM ${table}`)) {
    const columns = Object.keys(row); db.run(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, Object.values(row));
  }
  db.run(`INSERT INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES (?,?,'Replica','ANDROID',?,?,?)`, [device, source.install.businessId, at, at, at]);
  db.run(`INSERT INTO local_installation(id,installation_id,business_id,owner_id,device_id,public_key,key_reference,configured_at) VALUES (1,?,?,?,?,?,?,?)`, [randomUUIDv7(), source.install.businessId, source.install.ownerId, device, n.publicKey, n.material.keyReference, at]);
  db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,'OWNER')`, [source.install.businessId, source.install.ownerId, n.material.credentialReference]);
  db.run(`INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,0,?)`, [source.install.businessId, device, n.publicKey, source.install.ownerId]);
  const ownerKey = String(source.db.get(`SELECT public_key FROM local_installation`)!["public_key"]);
  db.run(`INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,1,?)`, [source.install.businessId, source.install.deviceId, ownerKey, source.install.ownerId]);
  db.run(`INSERT INTO exchange_destinations(id,business_id,receiver_device_id,kind,label) VALUES (?,?,?,'peer','Owner')`, [randomUUIDv7(), source.install.businessId, source.install.deviceId]);
  registerExchangeDestination(source.context, { deviceId: device, publicKey: n.publicKey, label: "Replica", platform: "ANDROID", kind: "peer" });
  return { db, install: { ...source.install, deviceId: device }, privateKey: n.privateKey, context: await unlockWorkspace({ userId: source.install.ownerId, secret }, n.ports) };
}
async function send(from: Device, to: Device) {
  const destination = String(from.db.get(`SELECT id FROM exchange_destinations WHERE receiver_device_id=?`, [to.install.deviceId])!["id"]);
  const batch = await createJournalBatch(from.context, destination, crypto, 1000);
  return batch === undefined ? [] : importJournalBatch(to.context, batch, crypto);
}
async function signed(device: Device, type: string, payload: JournalEnvelope["payload"], permissions: JournalEnvelope["required_permissions"]): Promise<SignedJournalEvent> {
  const envelope: JournalEnvelope = { event_id: randomUUIDv7(), business_id: device.install.businessId, origin_device_id: device.install.deviceId, actor_id: device.install.ownerId,
    origin_sequence: 900 + Math.floor(Math.random() * 1000), event_type: type, event_version: 2, occurred_at: at, branch_id: null, authority_revision: 1, required_permissions: permissions, payload };
  const message = eventSigningMessage(envelope);
  return { envelope, digest: await crypto.sha256(message), signature: sign(null, Buffer.from(message), device.privateKey).toString("hex") };
}
const grants = (device: Device) => device.db.all(`SELECT device_id,epoch FROM shop_key_grants ORDER BY epoch,device_id`).map(row => `${String(row["device_id"])}@${String(row["epoch"])}`);

it("the owner creates one shop key and grants it to each till once that till has announced its encryption key", async () => {
  const a = await owner(), b = await paired(a);
  assert.equal(await maintainShopKeys(a.context, crypto), 0, "nothing before the owner's own key is announced");
  await ensureEncryptionKey(a.context);
  assert.equal(await ensureEncryptionKey(a.context), await ensureEncryptionKey(a.context), "announced once");
  assert.equal(a.db.get(`SELECT count(*) AS n FROM event_journal WHERE event_type='DEVICE_ENCRYPTION_KEY'`)!["n"], 1);
  assert.equal(await maintainShopKeys(a.context, crypto), 1);
  assert.equal(await maintainShopKeys(a.context, crypto), 0, "idempotent");
  assert.deepEqual(grants(a), [`${a.install.deviceId}@1`]);
  assert.equal(await maintainShopKeys(b.context, crypto), 0, "a till without owner authority never creates keys");
  await ensureEncryptionKey(b.context); await send(b, a);
  assert.equal(await maintainShopKeys(a.context, crypto), 1, "B is granted the existing key, no new epoch");
  await send(a, b);
  const [ownerKey] = await shopKeys(a.context, crypto), [tillKey] = await shopKeys(b.context, crypto);
  assert.ok(ownerKey !== undefined && tillKey !== undefined); assert.deepEqual(tillKey, ownerKey);
  assert.equal(b.db.get(`SELECT count(*) AS n FROM shop_key_grants WHERE device_id=?`, [a.install.deviceId])!["n"], 1, "grants travel like any fact");
  assert.equal(JSON.stringify(b.db.all(`SELECT * FROM shop_key_grants`)).includes(ownerKey.key), false, "a shop key is never stored in the clear");
});

it("a sealed fact opens only with its key, only for its shop and only under its exact header", async () => {
  const a = await owner(); await ensureEncryptionKey(a.context); await maintainShopKeys(a.context, crypto);
  const keys = await shopKeys(a.context, crypto), key = currentShopKey(keys)!;
  const fact = await signed(a, "PRODUCT_SAVED", { product: { id: randomUUIDv7(), name: "Rice", unit: "bag", selling_price_minor: 500, created_at: at, updated_at: at } }, ["products.create"]);
  const sealed = await sealEvent(crypto, a.install.businessId, key, fact);
  assert.equal(sealed.ciphertext.includes("Rice"), false);
  assert.deepEqual(await openSealedEvent(crypto, a.install.businessId, keys, sealed), fact);
  assert.notEqual((await sealEvent(crypto, a.install.businessId, key, fact)).nonce, sealed.nonce, "every sealing uses a fresh nonce");
  for (const change of [{ event_id: randomUUIDv7() }, { origin_sequence: sealed.origin_sequence + 1 }, { digest: "0".repeat(64) }, { origin_device_id: randomUUIDv7() },
    { tag: "0".repeat(32) }, { nonce: "0".repeat(24) }, { ciphertext: `A${sealed.ciphertext.slice(1)}` }, { key_id: randomUUIDv7() }, { epoch: 2 }])
    assert.equal(await openSealedEvent(crypto, a.install.businessId, keys, { ...sealed, ...change }), undefined, JSON.stringify(change).slice(0, 40));
  assert.equal(await openSealedEvent(crypto, randomUUIDv7(), keys, sealed), undefined, "another shop's ID");
  assert.equal(await openSealedEvent(crypto, a.install.businessId, [], sealed), undefined, "no key");
  // A header that lies about the inner fact fails even with the right key.
  const other = await signed(a, "PRODUCT_SAVED", { product: { id: randomUUIDv7(), name: "Oil", unit: "l", selling_price_minor: 900, created_at: at, updated_at: at } }, ["products.create"]);
  const swapped = await sealEvent(crypto, a.install.businessId, key, other);
  assert.equal(await openSealedEvent(crypto, a.install.businessId, keys, { ...swapped, event_id: sealed.event_id }), undefined);
});

it("revoking a till opens a new epoch that the revoked till is never granted, while other tills receive every key", async () => {
  const a = await owner(), b = await paired(a), c = await paired(a);
  for (const device of [a, b, c]) await ensureEncryptionKey(device.context);
  await send(b, a); await send(c, a);
  assert.equal(await maintainShopKeys(a.context, crypto), 3);
  setExchangeDeviceActive(a.context, b.install.deviceId, false);
  assert.equal(await maintainShopKeys(a.context, crypto), 2, "a new key for A and C only");
  assert.deepEqual(grants(a).sort(), [`${a.install.deviceId}@1`, `${b.install.deviceId}@1`, `${c.install.deviceId}@1`, `${a.install.deviceId}@2`, `${c.install.deviceId}@2`].sort());
  assert.equal(await maintainShopKeys(a.context, crypto), 0, "no further rotation while nothing changes");
  await send(a, c);
  assert.deepEqual((await shopKeys(c.context, crypto)).map(key => key.epoch), [1, 2]);
  assert.equal(currentShopKey(await shopKeys(c.context, crypto))!.epoch, 2);
  // A till added later receives the history key and the current one.
  const d = await paired(a); await ensureEncryptionKey(d.context); await send(d, a);
  assert.equal(await maintainShopKeys(a.context, crypto), 2);
  await send(a, d);
  assert.deepEqual((await shopKeys(d.context, crypto)).map(key => key.epoch), [1, 2]);
});

it("a device announces only its own key, keys never change, and only the owner grants keys or sets the server address", async () => {
  const a = await owner(), b = await paired(a), c = await paired(a);
  await ensureEncryptionKey(a.context); await send(a, b); await send(a, c);
  const stolen = String(a.db.get(`SELECT public_key FROM device_encryption_keys`)!["public_key"]);
  const pretend = await signed(b, "DEVICE_ENCRYPTION_KEY", { device_id: a.install.deviceId, public_key: stolen }, []);
  assert.equal(applyEvent(c.context, await verifyEvent(c.context, pretend, crypto)), "quarantined");
  await ensureEncryptionKey(b.context); await send(b, a); await send(a, c); // B's key reaches C through the owner.
  const rekey = await signed(b, "DEVICE_ENCRYPTION_KEY", { device_id: b.install.deviceId, public_key: generateKeyPairSync("x25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey }, []);
  assert.equal(applyEvent(c.context, await verifyEvent(c.context, rekey, crypto)), "quarantined", "a known device's key never changes");
  const grant = await signed(b, "SHOP_KEY_GRANTED", { key_id: randomUUIDv7(), epoch: 1, device_id: c.install.deviceId, sealed: { ephemeral_public_key: stolen, nonce: "0".repeat(24), ciphertext: "AAAA", tag: "0".repeat(32) } }, ["users.manage"]);
  assert.equal(applyEvent(c.context, await verifyEvent(c.context, grant, crypto)), "quarantined");
  const address = await signed(b, "SERVER_ENDPOINT_SET", { server_device_id: randomUUIDv7(), url: "https://evil.example.com", fingerprint: "a".repeat(32), revision: 99 }, ["users.manage"]);
  assert.equal(applyEvent(c.context, await verifyEvent(c.context, address, crypto)), "quarantined");
  assert.equal(c.db.get(`SELECT count(*) AS n FROM shop_key_grants`)!["n"], 0); assert.equal(pendingShopServer(c.context), undefined);
});

it("the owner's latest server address wins on every till, an equal revision must agree, and a declined address stays declined", async () => {
  const a = await owner(), b = await paired(a), server = randomUUIDv7();
  assert.throws(() => shareServerEndpoint(b.context, { serverDeviceId: server, url: "https://one.example.com", fingerprint: "a".repeat(32) }));
  shareServerEndpoint(a.context, { serverDeviceId: server, url: "https://one.example.com", fingerprint: "a".repeat(32) });
  shareServerEndpoint(a.context, { serverDeviceId: server, url: "https://one.example.com", fingerprint: "a".repeat(32) });
  assert.equal(a.db.get(`SELECT count(*) AS n FROM event_journal WHERE event_type='SERVER_ENDPOINT_SET'`)!["n"], 1, "repeating the same address records nothing");
  shareServerEndpoint(a.context, { serverDeviceId: server, url: "https://two.example.com", fingerprint: "b".repeat(32) });
  await send(a, b);
  assert.deepEqual(pendingShopServer(b.context), { url: "https://two.example.com", fingerprint: "b".repeat(32), serverDeviceId: server });
  assert.equal(b.db.get(`SELECT revision FROM shop_server_endpoint`)!["revision"], 2);
  // An older address arriving after a newer one changes nothing; the same revision saying something else is a conflict.
  const older = await signed(a, "SERVER_ENDPOINT_SET", { server_device_id: server, url: "https://old.example.com", fingerprint: "c".repeat(32), revision: 1 }, ["users.manage"]);
  assert.equal(applyEvent(b.context, await verifyEvent(b.context, older, crypto)), "applied");
  assert.equal(pendingShopServer(b.context)?.url, "https://two.example.com");
  const clash = await signed(a, "SERVER_ENDPOINT_SET", { server_device_id: server, url: "https://three.example.com", fingerprint: "c".repeat(32), revision: 2 }, ["users.manage"]);
  assert.equal(applyEvent(b.context, await verifyEvent(b.context, clash, crypto)), "quarantined");
  b.db.run(`INSERT INTO server_endpoint_declined(business_id,server_device_id,declined_at) VALUES (?,?,?)`, [b.install.businessId, server, at]);
  assert.equal(pendingShopServer(b.context), undefined);
});
