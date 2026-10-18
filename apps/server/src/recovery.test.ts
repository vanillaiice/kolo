import assert from "node:assert/strict";
import { after, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomUUIDv7, sign } from "node:crypto";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { closeConsistent } from "@kolo/core/data/database/integrity";
import type { Database } from "@kolo/core/data/database/driver";
import { unlockWorkspace } from "@kolo/core/identity/workspace";
import type { OperationContext, WorkspacePorts } from "@kolo/core/identity/types";
import { confirmBackupRecoveryKey, prepareBackupRecoveryKey } from "@kolo/core/application/backup-key";
import { createBackup, previewBackup, restoreWorkspace } from "@kolo/core/application/backup";
import { connectServer, synchronizeServer, SyncTransportError } from "@kolo/core/application/server-sync";
import { shopKeys } from "@kolo/core/application/sealed-sync";
import * as commands from "@kolo/core/application/operations";
import { parseConnectionCode } from "@kolo/contracts/sync";
import { CLI_ACTOR, issueCode, shopDetail } from "./admin/operations.js";
import { AdminError } from "./admin/accounts.js";
import { openDatabase } from "./database.js";
import { at, cleanup, connect, count, crypto, owner, product, query, sale, secret, started, sync, type Device, type Server } from "./sync.fixtures.js";

const directories: string[] = [], databases: Database[] = [], workspaces: ReturnType<typeof nodeWorkspaceFiles>[] = [];
after(async () => {
  try { await cleanup(); }
  finally { try { closeConsistent(databases); } finally { for (const files of workspaces) files.close(); for (const directory of directories) rmSync(directory, { recursive: true, force: true }); } }
});
function files(): ReturnType<typeof nodeWorkspaceFiles> { const directory = mkdtempSync(join(tmpdir(), "kolo-recovery-")); directories.push(directory); const slots = nodeWorkspaceFiles(directory); workspaces.push(slots); return slots; }
/** A brand-new device with its own Ed25519 identity and X25519 vault key, as a replacement computer would have. */
function freshDevice(): { slots: ReturnType<typeof nodeWorkspaceFiles>; ports: WorkspacePorts } {
  const slots = files(), database = slots.openActive(); databases.push(database); migrate(database);
  const signing = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const sealing = generateKeyPairSync("x25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const material = { publicKey: signing.publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  return { slots, ports: { database, newId: randomUUIDv7, now: () => at, credentials: { provision: async () => material, inspect: async () => material,
    verify: async (reference, pin) => reference === material.credentialReference && pin === secret, sign: async (_reference, message) => sign(null, Buffer.from(message), signing.privateKey).toString("hex"),
    encryptionKey: async () => sealing.publicKey, agree: async (_reference, peer) => diffieHellman({ privateKey: createPrivateKey(sealing.privateKey), publicKey: createPublicKey(peer) }).toString("hex") } } };
}
async function recoveryCode(target: Server, shopId: string): Promise<string> {
  const db = openDatabase(target.databaseUrl);
  try { return parseConnectionCode((await issueCode(db, target.key, target.url, CLI_ACTOR, { label: "", days: 1, now: new Date(), recoveryShopId: shopId })).code)!.token!; }
  finally { await db.destroy(); }
}
async function pinKey(device: Device): Promise<string> {
  const key = await prepareBackupRecoveryKey(device.context, secret, crypto), groups = key.text.split("-");
  await confirmBackupRecoveryKey(device.context, key, key.confirm.map(index => groups[index]!), crypto);
  return key.text;
}
/** Restores a backup onto a fresh device with only the file and the typed recovery key, then signs in. */
async function restoreOnFreshDevice(file: Uint8Array, typed: string, businessId: string, ownerId: string): Promise<{ database: Database; context: OperationContext }> {
  const fresh = freshDevice(), preview = await previewBackup(file, { recoveryKey: typed }, fresh.slots, crypto);
  const restored = await restoreWorkspace(preview, { confirmedBusinessId: businessId, deviceLabel: "Replacement PC", platform: "DESKTOP", secret }, fresh.ports);
  databases.push(restored.database);
  return { database: restored.database, context: await unlockWorkspace({ userId: ownerId, secret }, { ...fresh.ports, database: restored.database }) };
}
const conflict = (error: unknown) => error instanceof SyncTransportError && error.code === "enrollment_conflict";

it("losing every till: one backup and the printed recovery key restore the shop, reconnect with an owner-recovery code and read later sales", async () => {
  const target = await started(), a = await owner("Boutique du Drill"), rice = product(a, "Riz");
  sale(a, rice, "V-1"); await connect(a, target); await sync(a, target);
  const typed = await pinKey(a), backup = await createBackup(a.context, null, files(), crypto);
  // After the backup Till A keeps selling and syncing, then it is lost with every other till.
  sale(a, rice, "V-2"); await sync(a, target);
  assert.equal(count(a, "sales"), 2);
  const restored = await restoreOnFreshDevice(backup.bytes, typed, a.install.businessId, a.install.ownerId), r = restored.context;
  assert.equal(Number(restored.database.get(`SELECT count(*) AS n FROM sales`)!["n"]), 1, "the backup holds the first sale");
  // The server knows the shop but not this device: without an owner-recovery code it is a conflict.
  const address = { url: target.url, fingerprint: target.key.fingerprint };
  await assert.rejects(connectServer(r, target.transport, address, crypto), conflict);
  await assert.rejects(connectServer(r, target.transport, { ...address, token: (await target.invite()).token }, crypto), conflict, "an ordinary code cannot attach a device to an existing shop");
  const destination = await connectServer(r, target.transport, { ...address, token: await recoveryCode(target, a.install.businessId) }, crypto);
  for (let round = 0; round < 2; round++) await synchronizeServer(r, destination, target.transport, crypto);
  assert.deepEqual(restored.database.all(`SELECT number FROM sales ORDER BY number`).map(row => row["number"]), ["V-1", "V-2"], "the sale synced after the backup arrived");
  assert.deepEqual((await shopKeys(r, crypto)).map(key => key.epoch).sort(), [1, 2]);
  // The restored till trades and syncs under the new key epoch.
  commands.completeSale(r, { id: randomUUIDv7(), number: "V-3", eventId: randomUUIDv7(), occurredAt: at, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: rice, name: "Riz", unitPriceMinor: 500, unitCostMinor: 300, quantity: 1000 }],
    payments: [{ id: randomUUIDv7(), accountId: String(restored.database.get(`SELECT id FROM financial_accounts ORDER BY id LIMIT 1`)!["id"]), amountMinor: 500 }] });
  await synchronizeServer(r, destination, target.transport, crypto);
  const db = openDatabase(target.databaseUrl);
  try { assert.equal((await shopDetail(db, a.install.businessId)).keyEpoch, 2, "new facts reach the server sealed with the new epoch"); }
  finally { await db.destroy(); }
  const stored = await query(target, `SELECT count(*)::int AS n FROM journal WHERE business_id=$1`, [a.install.businessId]);
  assert.ok(Number(stored[0].n) > 0);
});

it("owner-recovery codes attach only a new device of the named owner to their own shop, once, and never create a shop", async () => {
  const target = await started(), a = await owner("Boutique Une"), b = await owner("Boutique Deux");
  await connect(a, target); await connect(b, target); await sync(a, target); await sync(b, target);
  const typed = await pinKey(a), backup = await createBackup(a.context, null, files(), crypto), address = { url: target.url, fingerprint: target.key.fingerprint };
  const forB = await recoveryCode(target, b.install.businessId);
  const restored = await restoreOnFreshDevice(backup.bytes, typed, a.install.businessId, a.install.ownerId);
  await assert.rejects(connectServer(restored.context, target.transport, { ...address, token: forB }, crypto), conflict, "a code for another shop");
  const forA = await recoveryCode(target, a.install.businessId);
  await connectServer(restored.context, target.transport, { ...address, token: forA }, crypto);
  const again = await restoreOnFreshDevice(backup.bytes, typed, a.install.businessId, a.install.ownerId);
  await assert.rejects(connectServer(again.context, target.transport, { ...address, token: forA }, crypto),
    (error: unknown) => error instanceof SyncTransportError && ["connection_code_used", "enrollment_conflict"].includes(error.code), "a recovery code works once");
  // A recovery code never creates a shop.
  const stranger = await owner("Boutique Nouvelle");
  await assert.rejects(connectServer(stranger.context, target.transport, { ...address, token: await recoveryCode(target, a.install.businessId) }, crypto),
    (error: unknown) => error instanceof SyncTransportError && error.code === "invalid_connection_code");
  // Recovery codes are issued only for existing shops, without paid months.
  const db = openDatabase(target.databaseUrl);
  try {
    for (const input of [{ recoveryShopId: randomUUIDv7() }, { recoveryShopId: "not-a-uuid" }, { recoveryShopId: a.install.businessId, includedMonths: 3 }])
      await assert.rejects(issueCode(db, target.key, target.url, CLI_ACTOR, { label: "", days: 1, now: new Date(), ...input }), (error: unknown) => error instanceof AdminError, JSON.stringify(input));
  } finally { await db.destroy(); }
});
