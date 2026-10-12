import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, pbkdf2Sync, randomBytes, randomUUIDv7, sign, verify } from "node:crypto";
import { Client } from "pg";
import type { FastifyInstance } from "fastify";
import { openDatabase as openSqlite } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { closeConsistent } from "@kolo/core/data/database/integrity";
import type { Database } from "@kolo/core/data/database/driver";
import { createWorkspace, unlockWorkspace } from "@kolo/core/identity/workspace";
import type { Installation, OperationContext, WorkspacePorts } from "@kolo/core/identity/types";
import { nativeTransferCrypto } from "@kolo/core/backup/native-crypto";
import type { SealingCrypto } from "@kolo/core/application/sealed-sync";
import { registerExchangeDestination } from "@kolo/core/application/exchange";
import { connectServer, synchronizeServer, type SyncTransport } from "@kolo/core/application/server-sync";
import { createHttpSyncTransport } from "@kolo/core/application/http-sync-transport";
import * as commands from "@kolo/core/application/operations";
import { parseConnectionCode } from "@kolo/contracts/sync";
import type { CredentialCrypto } from "@kolo/core/identity/credentials";
import type { SecretStore } from "@kolo/core/data/auth/secure-store";
import { generateKeyPair, timingSafeEqual } from "node:crypto";
import { createApplication } from "./app.js";
import { migrateToLatest, openDatabase } from "./database.js";
import { generateServerKey, type ServerKey } from "./identity.js";
import { CLI_ACTOR, issueCode } from "./admin/operations.js";

/** Test-only fixtures for real PostgreSQL and real SQLite tills; only the network address is local. */
export const adminUrl = process.env["KOLO_TEST_DATABASE_URL"];
export const at = "2026-10-11T06:00:00.000Z", secret = "fixture-owner-secret";

/** Node/OpenSSL implementation of the sealing port, as the desktop adapter does it. */
export const crypto: SealingCrypto = {
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

export interface Device { db: Database; ports: WorkspacePorts; context: OperationContext; install: Installation; publicKey: string; privateKey: string; destination?: string }
export interface Server { app: FastifyInstance; url: string; key: ServerKey; transport: SyncTransport; databaseUrl: string; invite(label?: string, days?: number, months?: number): Promise<{ code: string; token: string }> }

const sqlite: Database[] = [], databases: string[] = [], servers: Server[] = [];

/** Real Ed25519 signing and a real X25519 vault key per device; the vault itself is in memory. */
function nativeFixture(db: Database) {
  const pair = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const sealing = generateKeyPairSync("x25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const material = { publicKey: pair.publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, newId: randomUUIDv7, now: () => at, credentials: { provision: async () => material, inspect: async () => material,
    verify: async (reference, pin) => reference === material.credentialReference && pin === secret, sign: async (_reference, message) => sign(null, Buffer.from(message), pair.privateKey).toString("hex"),
    encryptionKey: async () => sealing.publicKey,
    agree: async (_reference, peer) => diffieHellman({ privateKey: createPrivateKey(sealing.privateKey), publicKey: createPublicKey(peer) }).toString("hex") } };
  return { ports, material, publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export async function owner(name = "Fixture shop"): Promise<Device> {
  const db = openSqlite(); sqlite.push(db); migrate(db); const native = nativeFixture(db);
  const install = await createWorkspace({ businessName: name, ownerName: "Owner", deviceLabel: "Till A", platform: "DESKTOP", currency: "XAF", secret }, native.ports);
  return { db, ...native, install, context: await unlockWorkspace({ userId: install.ownerId, secret }, native.ports) };
}

/** A device paired with the owner's device only, the way F3 pairing leaves it: it knows the owner, nobody else. */
export async function paired(source: Device, label: string, authority = false): Promise<Device> {
  const db = openSqlite(); sqlite.push(db); migrate(db); const native = nativeFixture(db), device = randomUUIDv7();
  for (const table of ["businesses", "users", "devices", "financial_accounts"]) for (const row of source.db.all(`SELECT * FROM ${table}`)) {
    const columns = Object.keys(row); db.run(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, Object.values(row));
  }
  db.run(`INSERT INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES (?,?,?,'ANDROID',?,?,?)`, [device, source.install.businessId, label, at, at, at]);
  db.run(`INSERT INTO local_installation(id,installation_id,business_id,owner_id,device_id,public_key,key_reference,configured_at) VALUES (1,?,?,?,?,?,?,?)`, [randomUUIDv7(), source.install.businessId, source.install.ownerId, device, native.publicKey, native.material.keyReference, at]);
  db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,'OWNER')`, [source.install.businessId, source.install.ownerId, native.material.credentialReference]);
  db.run(`INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,?,?)`, [source.install.businessId, device, native.publicKey, authority ? 1 : 0, source.install.ownerId]);
  db.run(`INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,1,?)`, [source.install.businessId, source.install.deviceId, source.publicKey, source.install.ownerId]);
  db.run(`INSERT INTO exchange_destinations(id,business_id,receiver_device_id,kind,label) VALUES (?,?,?,'peer','Owner')`, [randomUUIDv7(), source.install.businessId, source.install.deviceId]); // As completed pairing leaves it.
  registerExchangeDestination(source.context, { deviceId: device, publicKey: native.publicKey, label, platform: "ANDROID", kind: "peer", authorityAllowed: authority });
  return { db, ...native, install: { ...source.install, deviceId: device, publicKey: native.publicKey }, context: await unlockWorkspace({ userId: source.install.ownerId, secret }, native.ports) };
}

/** A fresh, fully migrated PostgreSQL database per server; dropped after the run. */
export async function freshDatabase(): Promise<string> {
  const name = `kolo_sync_${randomUUIDv7().replaceAll("-", "")}`, admin = new Client({ connectionString: adminUrl });
  await admin.connect(); try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  databases.push(name);
  const url = new URL(adminUrl!); url.pathname = `/${name}`;
  return url.toString();
}

export async function started(options: { rateLimitMax?: number; key?: ServerKey; now?: () => Date; edition?: "selfhost" | "hosted"; graceDays?: number; webhookSecret?: string } = {}): Promise<Server> {
  const databaseUrl = await freshDatabase();
  const db = openDatabase(databaseUrl); await migrateToLatest(db);
  const key = options.key ?? generateServerKey().key;
  const app = await createApplication({ host: "127.0.0.1", port: 0, databaseUrl, edition: options.edition ?? "selfhost", graceDays: options.graceDays ?? 7,
    ...(options.webhookSecret === undefined ? {} : { billingWebhookSecret: options.webhookSecret }) }, { key, ...(options.rateLimitMax === undefined ? {} : { rateLimitMax: options.rateLimitMax }), ...(options.now === undefined ? {} : { now: options.now }) });
  app.addHook("onClose", async () => { await db.destroy(); });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const server: Server = { app, url, key, transport: createHttpSyncTransport(url), databaseUrl,
    async invite(label = "Fixture shop", days = 7, months = 0) { const issued = await issueCode(db, key, url, CLI_ACTOR, { label, days, now: options.now?.() ?? new Date(), includedMonths: months }); return { code: issued.code, token: parseConnectionCode(issued.code)!.token! }; } };
  servers.push(server);
  return server;
}

/** Owner's main till: a fresh single-use code. Any other till: the shared address only. */
export async function connect(device: Device, target: Server, token?: string): Promise<string> {
  const ownerDevice = device.db.get(`SELECT authority_allowed FROM trusted_exchange_devices WHERE device_id=?`, [device.install.deviceId])?.["authority_allowed"] === 1;
  const code = token ?? (ownerDevice ? (await target.invite()).token : undefined);
  device.destination = await connectServer(device.context, target.transport, { url: target.url, fingerprint: target.key.fingerprint, ...(code === undefined ? {} : { token: code }) }, crypto);
  return device.destination;
}
export const sync = (device: Device, target: Server) => synchronizeServer(device.context, device.destination!, target.transport, crypto);
export const count = (device: Device, table: string) => Number(device.db.get(`SELECT count(*) AS n FROM ${table}`)!["n"]);
const account = (device: Device) => String(device.db.get(`SELECT id FROM financial_accounts ORDER BY id LIMIT 1`)!["id"]);
export function product(device: Device, name = "Rice"): string {
  const id = randomUUIDv7();
  commands.saveProduct(device.context, { id, name, unit: "bag", divisible: false, active: true, sellingPriceMinor: 500, purchasePriceMinor: 300, currency: "XAF", taxRateBasisPoints: 0, minimumStock: 0, createdAt: at, updatedAt: at });
  return id;
}
export function sale(device: Device, productId: string, number = `V-${randomUUIDv7()}`): string {
  commands.completeSale(device.context, { id: randomUUIDv7(), number, eventId: randomUUIDv7(), occurredAt: at, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId, name: "Rice", unitPriceMinor: 500, unitCostMinor: 300, quantity: 1000 }], payments: [{ id: randomUUIDv7(), accountId: account(device), amountMinor: 500 }] });
  return number;
}
export async function query(target: { databaseUrl: string }, text: string, values: unknown[] = []) { const client = new Client({ connectionString: target.databaseUrl }); await client.connect(); try { return (await client.query(text, values)).rows; } finally { await client.end(); } }

/** Closes every server and SQLite database and drops the PostgreSQL databases this run created. */
export async function cleanup(): Promise<void> {
  for (const value of servers.splice(0)) await value.app.close();
  // Every till must still satisfy core's invariants after whatever the test sent through the server.
  closeConsistent(sqlite.splice(0));
  if (adminUrl !== undefined && databases.length > 0) { const admin = new Client({ connectionString: adminUrl }); await admin.connect(); try { for (const name of databases.splice(0)) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); } }
}

/** Real Node/OpenSSL credential primitives, as the desktop adapter has them, for tills created fresh in tests. */
export const credentialCrypto: CredentialCrypto = {
  randomHex: bytes => randomBytes(bytes).toString("hex"),
  derive: async (secretText, salt, iterations) => pbkdf2Sync(secretText, Buffer.from(salt, "hex"), iterations, 32, "sha256").toString("hex"),
  equalHex: (left, right) => left.length === right.length && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")),
  sign: async (privateKey, message) => sign(null, Buffer.from(message), privateKey).toString("hex"),
  deviceKey: () => new Promise((resolve, reject) => generateKeyPair("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }, (error, publicKey, privateKey) => error ? reject(error) : resolve({ publicKey, privateKey }))),
  encryptionKeyPair: () => new Promise((resolve, reject) => generateKeyPair("x25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }, (error, publicKey, privateKey) => error ? reject(error) : resolve({ publicKey, privateKey }))),
  agree: async (privateKey, peer) => diffieHellman({ privateKey: createPrivateKey(privateKey), publicKey: createPublicKey(peer) }).toString("hex"),
};
/** An in-memory protected vault; the credential port on top of it is the real one. */
export function memoryVault(): SecretStore {
  const values = new Map<string, string>();
  return { read: async key => values.get(key), write: async (key, value) => { values.set(key, value); }, forget: async key => { values.delete(key); } };
}
