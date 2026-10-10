import assert from "node:assert/strict";
import { it } from "node:test";
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import { protectedCredentials } from "./credentials.ts";
import { createWorkspace } from "./workspace.ts";
import { localSecretKeys } from "./device-reset.ts";

it("a reset finds every key the shop stored in the protected store, and nothing belonging to another device", async () => {
  const db = openDatabase(); migrate(db);
  const vault = new Map<string, string>();
  const store = { read: async (key: string) => vault.get(key), write: async (key: string, value: string) => { vault.set(key, value); }, forget: async (key: string) => { vault.delete(key); } };
  const crypto = { randomHex: (bytes: number) => Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256))).toString("hex"),
    derive: async (secret: string, salt: string) => Buffer.from(`${secret}:${salt}`).toString("hex").padEnd(64, "0").slice(0, 64), equalHex: (a: string, b: string) => a === b,
    sign: async () => "00", deviceKey: async () => { const pair = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }); return { publicKey: pair.publicKey, privateKey: pair.privateKey }; } };
  const ports = { database: db, now: () => "2026-10-10T10:00:00.000Z", newId: randomUUIDv7, credentials: protectedCredentials(store, crypto) };
  const installation = await createWorkspace({ businessName: "Shop", ownerName: "Owner", deviceLabel: "Phone", platform: "ANDROID", currency: "XAF", secret: "135790" }, ports);
  db.run(`INSERT INTO users(id,business_id,name,role,created_at,updated_at) VALUES (?,?,'Synced','CASHIER',?,?)`, [randomUUIDv7(), installation.businessId, "2026-10-10T10:00:00.000Z", "2026-10-10T10:00:00.000Z"]);
  db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) SELECT business_id,id,'remote.other.'||id,'CASHIER' FROM users WHERE name='Synced'`);
  const keys = localSecretKeys(db);
  assert.deepEqual(keys, [...vault.keys()].sort(), "exactly the keys the shop wrote");
  assert.ok(keys.every(key => !key.startsWith("remote.")));
  for (const key of keys) await store.forget(key);
  assert.equal(vault.size, 0);
  db.close();
});

it("an empty or unconfigured database has no keys", () => {
  const db = openDatabase(); assert.deepEqual(localSecretKeys(db), []); migrate(db); assert.deepEqual(localSecretKeys(db), []); db.close();
});
