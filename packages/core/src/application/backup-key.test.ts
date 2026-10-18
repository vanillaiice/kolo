import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { argon2, createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, pbkdf2Sync, randomBytes, randomUUIDv7, sign, verify } from "node:crypto";
import type { JournalEnvelope, SignedJournalEvent } from "@kolo/contracts/events";
import { closeConsistent } from "../data/database/integrity.ts";
import { nodeWorkspaceFiles } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import type { Database } from "../data/database/driver.ts";
import { createWorkspace, unlockWorkspace } from "../identity/workspace.ts";
import type { Installation, OperationContext, WorkspacePorts } from "../identity/types.ts";
import { nativeTransferCrypto } from "../backup/native-crypto.ts";
import { X25519_PKCS8_PREFIX, X25519_SPKI_PREFIX } from "../backup/hpke.ts";
import { inspectContainer } from "../backup/encryption.ts";
import { deriveRecoveryKey, formatRecoveryKey, generateRecoverySecret, parseRecoveryKey } from "../backup/recovery-key.ts";
import { TransferError } from "../backup/types.ts";
import { backupRecoveryKeys, confirmBackupRecoveryKey, currentBackupRecipient, prepareBackupRecoveryKey, type PendingBackupKey } from "./backup-key.ts";
import { cancelBackupPreview, createBackup, previewBackup, restoreWorkspace } from "./backup.ts";
import { eventSigningMessage, registerExchangeDestination, sealPendingEvents, verifyEvent } from "./exchange.ts";
import { applyEvent } from "./event-application.ts";
import { createJournalBatch, importJournalBatch } from "./event-delivery.ts";
import { currentShopKey, ensureEncryptionKey, maintainShopKeys, openSealedEvent, sealEvent, shopKeys, type SealingCrypto } from "./sealed-sync.ts";
import * as operations from "./operations.ts";

const at = "2026-10-17T09:00:00.000Z", pin = "482915", password = "a portable backup password";
const crypto: SealingCrypto = {
  ...nativeTransferCrypto({
    sha256: async message => createHash("sha256").update(message).digest("hex"),
    verify: async (key, message, signature) => verify(null, Buffer.from(message), key, Buffer.from(signature, "hex")),
    randomHex: bytes => randomBytes(bytes).toString("hex"), derive: async (secret, salt, iterations) => pbkdf2Sync(secret, Buffer.from(salt, "hex"), iterations, 32, "sha256").toString("hex"),
    sha256Bytes: async bytes => createHash("sha256").update(bytes).digest("hex"),
    encodeText: text => new Uint8Array(Buffer.from(text, "utf8")), decodeText: bytes => Buffer.from(bytes).toString("utf8"),
    encodeBase64: bytes => Buffer.from(bytes).toString("base64"), decodeBase64: text => new Uint8Array(Buffer.from(text, "base64")),
    fromHex: hex => new Uint8Array(Buffer.from(hex, "hex")), toHex: bytes => Buffer.from(bytes).toString("hex"),
    createSha256:()=>{const hash=createHash("sha256");return {update:(bytes:Uint8Array)=>{hash.update(bytes);},digest:()=>hash.digest("hex")};},
    hmacSha256: (key, data) => new Uint8Array(createHmac("sha256", key).update(data).digest()),
    x25519: (privateKey, publicKey) => new Uint8Array(diffieHellman({ privateKey: createPrivateKey({ key: Buffer.from([...X25519_PKCS8_PREFIX, ...privateKey]), format: "der", type: "pkcs8" }), publicKey: createPublicKey({ key: Buffer.from([...X25519_SPKI_PREFIX, ...publicKey]), format: "der", type: "spki" }) })),
    argon2id: (message, salt, params) => new Promise<Uint8Array>((resolve, reject) => argon2("argon2id", { message, nonce: salt, memory: params.memoryKiB, passes: params.passes, parallelism: params.parallelism, tagLength: params.length }, (error, key) => error === null ? resolve(new Uint8Array(key)) : reject(error))),
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
const directories: string[] = [], databases: Database[] = [], controls: ReturnType<typeof nodeWorkspaceFiles>[] = [];
afterEach(() => { closeConsistent(databases.splice(0)); for (const control of controls.splice(0)) control.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const code = (expected: TransferError["code"]) => (error: unknown) => error instanceof TransferError && error.code === expected;

interface Till { directory: string; files: ReturnType<typeof nodeWorkspaceFiles>; db: Database; ports: WorkspacePorts; context: OperationContext; install: Installation; publicKey: string; privateKey: string }
/** Disk-backed workspace slots with a real Ed25519 signing key and X25519 vault key; the PIN is `pin`. */
function slot() {
  const directory = mkdtempSync(join(tmpdir(), "kolo-backup-key-")); directories.push(directory);
  const files = nodeWorkspaceFiles(directory); controls.push(files); const db = files.openActive(); databases.push(db); migrate(db);
  const signing = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const sealing = generateKeyPairSync("x25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const material = { publicKey: signing.publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, newId: randomUUIDv7, now: () => at, credentials: { provision: async () => material, inspect: async () => material,
    verify: async (reference, secret) => reference === material.credentialReference && secret === pin, sign: async (_reference, message) => sign(null, Buffer.from(message), signing.privateKey).toString("hex"),
    encryptionKey: async () => sealing.publicKey, agree: async (_reference, peer) => diffieHellman({ privateKey: createPrivateKey(sealing.privateKey), publicKey: createPublicKey(peer) }).toString("hex") } };
  return { directory, files, db, ports, publicKey: signing.publicKey, privateKey: signing.privateKey };
}
async function owner(name = "Boutique Awa"): Promise<Till> {
  const s = slot(), install = await createWorkspace({ businessName: name, ownerName: "Awa", deviceLabel: "Till A", platform: "DESKTOP", currency: "XAF", secret: pin }, s.ports);
  return { ...s, install, context: await unlockWorkspace({ userId: install.ownerId, secret: pin }, s.ports) };
}
/** A second till of the owner's shop, paired the way F3 pairing leaves it (no owner authority unless asked). */
async function paired(source: Till, authority = false): Promise<Till> {
  const s = slot(), device = randomUUIDv7();
  for (const table of ["businesses", "users", "devices", "financial_accounts"]) for (const row of source.db.all(`SELECT * FROM ${table}`)) {
    const columns = Object.keys(row); s.db.run(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, Object.values(row));
  }
  s.db.run(`INSERT INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES (?,?,'Till B','ANDROID',?,?,?)`, [device, source.install.businessId, at, at, at]);
  const material = await s.ports.credentials.inspect("any");
  s.db.run(`INSERT INTO local_installation(id,installation_id,business_id,owner_id,device_id,public_key,key_reference,configured_at) VALUES (1,?,?,?,?,?,?,?)`, [randomUUIDv7(), source.install.businessId, source.install.ownerId, device, s.publicKey, material!.keyReference, at]);
  s.db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,'OWNER')`, [source.install.businessId, source.install.ownerId, material!.credentialReference]);
  s.db.run(`INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,?,?)`, [source.install.businessId, device, s.publicKey, authority ? 1 : 0, source.install.ownerId]);
  s.db.run(`INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,1,?)`, [source.install.businessId, source.install.deviceId, source.publicKey, source.install.ownerId]);
  s.db.run(`INSERT INTO exchange_destinations(id,business_id,receiver_device_id,kind,label) VALUES (?,?,?,'peer','Owner')`, [randomUUIDv7(), source.install.businessId, source.install.deviceId]);
  registerExchangeDestination(source.context, { deviceId: device, publicKey: s.publicKey, label: "Till B", platform: "ANDROID", kind: "peer", authorityAllowed: authority });
  return { ...s, install: { ...source.install, deviceId: device, publicKey: s.publicKey }, context: await unlockWorkspace({ userId: source.install.ownerId, secret: pin }, s.ports) };
}
async function send(from: Till, to: Till) {
  const destination = String(from.db.get(`SELECT id FROM exchange_destinations WHERE receiver_device_id=?`, [to.install.deviceId])!["id"]);
  const batch = await createJournalBatch(from.context, destination, crypto, 1000);
  return batch === undefined ? [] : importJournalBatch(to.context, batch, crypto);
}
/** A fact signed with a till's real key, whatever it claims: what a compromised or malicious till could send. */
async function signed(till: Till, type: string, payload: JournalEnvelope["payload"]): Promise<SignedJournalEvent> {
  const envelope: JournalEnvelope = { event_id: randomUUIDv7(), business_id: till.install.businessId, origin_device_id: till.install.deviceId, actor_id: till.install.ownerId,
    origin_sequence: 900 + Math.floor(Math.random() * 1000), event_type: type, event_version: 2, occurred_at: at, branch_id: null, authority_revision: 1, required_permissions: ["users.manage"], payload };
  const message = eventSigningMessage(envelope);
  return { envelope, digest: await crypto.sha256(message), signature: sign(null, Buffer.from(message), till.privateKey).toString("hex") };
}
/** Creates and pins a key the way the owner does: shown once, three groups typed back. Returns the text the owner wrote down. */
async function pinKey(till: Till): Promise<{ text: string; keyId: string }> {
  const key = await prepareBackupRecoveryKey(till.context, pin, crypto), groups = key.text.split("-");
  await confirmBackupRecoveryKey(till.context, key, key.confirm.map(index => groups[index]!), crypto);
  return { text: key.text, keyId: key.keyId };
}
const typedBack = (key: PendingBackupKey) => key.confirm.map(index => key.text.split("-")[index]!);
/** Every byte the till wrote: its databases, write-ahead logs and staging files. */
const disk = (till: Till) => Buffer.concat(readdirSync(till.directory).map(name => { try { return readFileSync(join(till.directory, name)); } catch { return Buffer.alloc(0); } }));
const product = (till: Till, name = "Rice") => { const id = randomUUIDv7(); operations.saveProduct(till.context, { id, name, unit: "bag", active: true, divisible: false, sellingPriceMinor: 500, currency: "XAF", taxRateBasisPoints: 0, minimumStock: 0, createdAt: at, updatedAt: at }); return id; };

it("the owner pins a recovery key only after a fresh PIN and three typed-back groups; nothing secret is stored", async () => {
  const a = await owner();
  await assert.rejects(prepareBackupRecoveryKey(a.context, "000000", crypto), code("authentication_failed"));
  const key = await prepareBackupRecoveryKey(a.context, pin, crypto);
  assert.match(key.text, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){13}$/);
  assert.equal(key.confirm.length, 3); assert.ok(key.confirm.every((index, i) => index >= 0 && index < 14 && (i === 0 || key.confirm[i - 1]! < index)));
  assert.deepEqual(backupRecoveryKeys(a.context), [], "nothing is pinned before confirmation");
  const groups = typedBack(key);
  for (const wrong of [[], groups.slice(0, 2), [...groups.slice(0, 2), "ZZZZ"], groups.map(() => "0000")])
    await assert.rejects(confirmBackupRecoveryKey(a.context, key, wrong, crypto), code("confirmation_required"), wrong.join(","));
  const forgiving = groups.map(group => ` ${group.toLowerCase().replace(/0/g, "o").replace(/1/g, "l")} `);
  const view = await confirmBackupRecoveryKey(a.context, key, forgiving, crypto);
  assert.deepEqual(view, { keyId: key.keyId, version: 1, createdAt: at, current: true });
  await assert.rejects(confirmBackupRecoveryKey(a.context, key, groups, crypto), code("confirmation_required"), "a prepared key pins once");
  assert.deepEqual(backupRecoveryKeys(a.context), [view]);
  const fact = a.db.get(`SELECT canonical FROM event_journal WHERE event_type='SHOP_BACKUP_KEY'`)!, pair = await deriveRecoveryKey(await parseRecoveryKey(key.text, crypto), crypto);
  assert.deepEqual(JSON.parse(String(fact["canonical"])).payload, { key_id: key.keyId, version: 1, public_key: Buffer.from(pair.publicKey).toString("hex"), created_at: at });
  // Neither the secret, its written form nor the private half is anywhere on disk.
  const raw = Buffer.from(await parseRecoveryKey(key.text, crypto)), written = disk(a);
  for (const needle of [raw, Buffer.from(raw.toString("hex")), Buffer.from(key.text), Buffer.from(key.text.replace(/-/g, "")), Buffer.from(pair.privateKey), Buffer.from(Buffer.from(pair.privateKey).toString("hex"))])
    assert.equal(written.includes(needle), false);
  // A rotation pins version 2 as current; the first key stays for the backups that need it.
  const second = await pinKey(a);
  assert.deepEqual(backupRecoveryKeys(a.context).map(item => [item.keyId, item.version, item.current]), [[second.keyId, 2, true], [key.keyId, 1, false]]);
});

it("only the owner on an authority till can create a key, and a prepared key belongs to the session that made it", async () => {
  const a = await owner(), b = await paired(a), key = await prepareBackupRecoveryKey(a.context, pin, crypto);
  await assert.rejects(prepareBackupRecoveryKey(b.context, pin, crypto), (error: unknown) => error instanceof Error && "code" in error && ["invalid_pairing", "permission_denied"].includes(String(error.code)), "a till without owner authority");
  const again = await unlockWorkspace({ userId: a.install.ownerId, secret: pin }, a.ports);
  await assert.rejects(confirmBackupRecoveryKey(again, key, typedBack(key), crypto), code("confirmation_required"));
  await assert.rejects(confirmBackupRecoveryKey(a.context, { ...key }, typedBack(key), crypto), code("confirmation_required"), "a copy is not the prepared key");
});

it("pinned keys travel to the shop's tills; forged, non-owner and conflicting facts are refused and never used for sealing", async () => {
  const a = await owner(), b = await paired(a), first = await pinKey(a);
  await sealPendingEvents(a.context, crypto, 1000); await send(a, b);
  assert.deepEqual(backupRecoveryKeys(b.context).map(item => item.keyId), [first.keyId]);
  assert.equal((await currentBackupRecipient(b.context, crypto))?.keyId, first.keyId, "B seals to the owner's key");
  // B (no owner authority) claims a key of its own.
  const attacker = await deriveRecoveryKey(generateRecoverySecret(crypto), crypto);
  const forged = await signed(b, "SHOP_BACKUP_KEY", { key_id: attacker.keyId, version: 9, public_key: Buffer.from(attacker.publicKey).toString("hex"), created_at: at });
  assert.equal(applyEvent(a.context, await verifyEvent(a.context, forged, crypto)), "quarantined", "only the owner's authority till pins keys");
  assert.equal((await currentBackupRecipient(a.context, crypto))?.keyId, first.keyId, "the owner's till still seals to the owner's key");
  assert.equal(a.db.get(`SELECT key_id FROM backup_recovery_keys WHERE key_id=?`, [attacker.keyId]), undefined);
  // The owner's own fact for an existing key ID with another public key is a conflict, never a silent replacement.
  const clash = await signed(a, "SHOP_BACKUP_KEY", { key_id: first.keyId, version: 1, public_key: Buffer.from(attacker.publicKey).toString("hex"), created_at: at });
  assert.notEqual(applyEvent(b.context, await verifyEvent(b.context, clash, crypto)), "applied");
  assert.equal((await currentBackupRecipient(b.context, crypto))?.keyId, first.keyId);
  assert.equal(b.db.get(`SELECT public_key FROM backup_recovery_keys WHERE key_id=?`, [first.keyId])!["public_key"], a.db.get(`SELECT public_key FROM backup_recovery_keys WHERE key_id=?`, [first.keyId])!["public_key"]);
  // Malformed payloads are refused whoever signs them.
  for (const payload of [{ key_id: "XYZ", version: 1, public_key: "00".repeat(32), created_at: at }, { key_id: first.keyId, version: 0, public_key: "00".repeat(32), created_at: at }, { key_id: first.keyId, version: 2, public_key: "00".repeat(31), created_at: at }])
    assert.notEqual(applyEvent(b.context, await verifyEvent(b.context, await signed(a, "SHOP_BACKUP_KEY", payload), crypto)), "applied", JSON.stringify(payload));
  // A row whose public key no longer matches its ID (a damaged database) can never redirect encryption.
  b.db.run(`UPDATE backup_recovery_keys SET public_key=? WHERE key_id=?`, [Buffer.from(attacker.publicKey).toString("hex"), first.keyId]);
  await assert.rejects(currentBackupRecipient(b.context, crypto), code("invalid_snapshot"));
  await assert.rejects(createBackup(b.context, password, b.files, crypto), code("invalid_snapshot"));
});

it("concurrent rotations converge on the highest version, then the greater key ID", async () => {
  const a = await owner(), keys = await Promise.all([1, 2, 3].map(() => deriveRecoveryKey(generateRecoverySecret(crypto), crypto)));
  const insert = (key: typeof keys[number], version: number) => a.db.run(`INSERT INTO backup_recovery_keys(business_id,key_id,version,public_key,created_at,device_id,event_id) VALUES (?,?,?,?,?,?,?)`,
    [a.install.businessId, key.keyId, version, Buffer.from(key.publicKey).toString("hex"), at, a.install.deviceId, randomUUIDv7()]);
  insert(keys[0]!, 1); insert(keys[1]!, 2); insert(keys[2]!, 2);
  const tie = [keys[1]!, keys[2]!].sort((x, y) => x.keyId < y.keyId ? 1 : -1)[0]!;
  assert.equal((await currentBackupRecipient(a.context, crypto))?.keyId, tie.keyId);
  assert.deepEqual(backupRecoveryKeys(a.context).map(item => item.current), [true, false, false]);
});

it("backups seal to the pinned key; a fresh device restores with only the file and the typed key", async () => {
  const lonely = await owner("No key yet");
  await assert.rejects(createBackup(lonely.context, null, lonely.files, crypto), code("recovery_key_required"));
  assert.deepEqual(inspectContainer((await createBackup(lonely.context, password, lonely.files, crypto)).bytes).recipients, [], "without a key: password only");
  const a = await owner(), key = await pinKey(a), rice = product(a);
  const manual = await createBackup(a.context, password, a.files, crypto), automatic = await createBackup(a.context, null, a.files, crypto);
  assert.deepEqual({ ...inspectContainer(manual.bytes) }, { purpose: "backup", fileId: inspectContainer(manual.bytes).fileId, password: true, recipients: [key.keyId], sealedFor: [key.keyId] });
  assert.equal(inspectContainer(automatic.bytes).password, false);
  for (const [file, secret] of [[manual.bytes, password], [manual.bytes, { recoveryKey: key.text.toLowerCase() }], [automatic.bytes, { recoveryKey: key.text }]] as const) {
    const c = slot(), preview = await previewBackup(file, secret, c.files, crypto);
    const restored = await restoreWorkspace(preview, { confirmedBusinessId: a.install.businessId, deviceLabel: "New PC", platform: "DESKTOP", secret: pin }, c.ports); databases.push(restored.database);
    assert.equal(restored.database.get(`SELECT name FROM products WHERE id=?`, [rice])!["name"], "Rice");
    assert.deepEqual(restored.database.all(`SELECT key_id FROM backup_recovery_keys`).map(row => row["key_id"]), [key.keyId], "the restored shop knows its key");
  }
  const c = slot(), other = await formatRecoveryKey(generateRecoverySecret(crypto), crypto);
  await assert.rejects(previewBackup(automatic.bytes, { recoveryKey: other }, c.files, crypto), code("authentication_failed"));
  await assert.rejects(previewBackup(automatic.bytes, { recoveryKey: key.text.replace(/^./, key.text[0] === "A" ? "B" : "A") }, c.files, crypto), code("invalid_recovery_key"));
  await assert.rejects(previewBackup(automatic.bytes, password, c.files, crypto), code("authentication_failed"), "a recovery-key-only backup has no password");
});

it("a restored shop resumes sync alone: carried keys are re-granted to the new device, a new epoch opens, and later facts open", async () => {
  const a = await owner(), key = await pinKey(a);
  await ensureEncryptionKey(a.context); await maintainShopKeys(a.context, crypto);
  const [held] = await shopKeys(a.context, crypto); assert.equal(held?.epoch, 1);
  const backup = await createBackup(a.context, null, a.files, crypto);
  // After the backup, Till A seals another fact with the shop key, as it would for the server, and is then lost.
  const later = await sealEvent(crypto, a.install.businessId, held!, await signed(a, "SERVER_ENDPOINT_CLEARED", { server_device_id: randomUUIDv7(), revision: 7 }));
  const c = slot(), preview = await previewBackup(backup.bytes, { recoveryKey: key.text }, c.files, crypto);
  const restored = await restoreWorkspace(preview, { confirmedBusinessId: a.install.businessId, deviceLabel: "Replacement", platform: "DESKTOP", secret: pin }, c.ports); databases.push(restored.database);
  const db = restored.database, device = restored.installation.deviceId;
  assert.deepEqual(db.all(`SELECT epoch FROM shop_key_grants WHERE device_id=? ORDER BY epoch`, [device]).map(row => row["epoch"]), [1, 2]);
  assert.equal(db.get(`SELECT device_id FROM device_encryption_keys WHERE device_id=?`, [device])?.["device_id"], device);
  assert.deepEqual(db.all(`SELECT event_type FROM event_journal WHERE origin_device_id=? ORDER BY origin_sequence`, [device]).map(row => row["event_type"]), ["DEVICE_ENCRYPTION_KEY", "SHOP_KEY_GRANTED", "SHOP_KEY_GRANTED"]);
  assert.equal(Buffer.concat(readdirSync(c.directory).map(name => readFileSync(join(c.directory, name)))).includes(Buffer.from(held!.key)), false, "the plain key never enters the database");
  const context = await unlockWorkspace({ userId: a.install.ownerId, secret: pin }, { ...c.ports, database: db }), keys = await shopKeys(context, crypto);
  assert.deepEqual(keys.map(item => item.epoch).sort(), [1, 2]); assert.equal(currentShopKey(keys)?.epoch, 2, "new facts seal with the new epoch");
  const opened = await openSealedEvent(crypto, a.install.businessId, keys, later);
  assert.equal(opened?.envelope.event_id, later.event_id, "a fact Till A sealed after the backup opens on the restored till");
  // The restored owner keeps maintaining keys as the authority till: Till A is still in the roster, so it is offered the new epoch once.
  assert.equal(await maintainShopKeys(context, crypto), 1); assert.equal(await maintainShopKeys(context, crypto), 0);
});

it("a till that knows the shop refuses a backup signed by a till it does not trust", async () => {
  const a = await owner(), b = await paired(a, true), key = await pinKey(a);
  await sealPendingEvents(a.context, crypto, 1000); await send(a, b);
  await sealPendingEvents(b.context, crypto, 1000);
  const fromB = await createBackup(b.context, password, b.files, crypto);
  assert.deepEqual(inspectContainer(fromB.bytes).recipients, [key.keyId]);
  // Till D was paired with A only and has never heard of B: in recovery mode it refuses B's backup.
  const d = await paired(a, true), preview = await previewBackup(fromB.bytes, password, d.files, crypto);
  await assert.rejects(restoreWorkspace(preview, { confirmedBusinessId: a.install.businessId, deviceLabel: "D again", platform: "DESKTOP", secret: pin, recoveryContext: d.context }, d.ports), code("untrusted_backup"));
  // A preview that is not restored is cancelled, or Windows cannot remove its staged file.
  await cancelBackupPreview(preview);
  // Till A trusts B, so its recovery mode accepts the same file.
  const accepted = await restoreWorkspace(await previewBackup(fromB.bytes, password, a.files, crypto), { confirmedBusinessId: a.install.businessId, deviceLabel: "A again", platform: "DESKTOP", secret: pin, recoveryContext: a.context }, a.ports);
  databases.push(accepted.database);
  // A fresh device has nothing to compare with and restores it (the shop name is confirmed instead).
  const c = slot(), restored = await restoreWorkspace(await previewBackup(fromB.bytes, password, c.files, crypto), { confirmedBusinessId: a.install.businessId, deviceLabel: "C", platform: "DESKTOP", secret: pin }, c.ports);
  databases.push(restored.database);
});

it("a backup that cannot open every granted shop key fails instead of silently carrying none", async () => {
  const a = await owner(), key = await pinKey(a);
  const plain: SealingCrypto = { ...crypto }; delete (plain as Partial<SealingCrypto>).hkdf;
  assert.ok((await createBackup(a.context, password, a.files, plain)).bytes.byteLength > 0, "a shop that never used encrypted sync has nothing to carry");
  await ensureEncryptionKey(a.context); await maintainShopKeys(a.context, crypto);
  assert.equal((await shopKeys(a.context, crypto)).length, 1);
  const agree = a.ports.credentials.agree!;
  (a.ports.credentials as { agree?: typeof agree }).agree = async () => { throw new Error("vault unavailable"); };
  await assert.rejects(createBackup(a.context, password, a.files, crypto), code("sync_keys_unavailable"));
  await assert.rejects(createBackup(a.context, null, a.files, crypto), code("sync_keys_unavailable"), "automatic backups too");
  (a.ports.credentials as { agree?: typeof agree }).agree = agree;
  await assert.rejects(createBackup(a.context, password, a.files, plain), code("sync_keys_unavailable"), "a platform that cannot open grants cannot carry them");
  const backup = await createBackup(a.context, null, a.files, crypto), c = slot();
  const preview = await previewBackup(backup.bytes, { recoveryKey: key.text }, c.files, crypto);
  const restored = await restoreWorkspace(preview, { confirmedBusinessId: a.install.businessId, deviceLabel: "Replacement", platform: "DESKTOP", secret: pin }, c.ports); databases.push(restored.database);
  assert.ok(restored.database.all(`SELECT epoch FROM shop_key_grants WHERE device_id=?`, [restored.installation.deviceId]).some(row => row["epoch"] === 1), "the recovered backup carried the key");
});

it("a backup whose records disagree is refused at preview, before anything is activated", async () => {
  const a = await owner(), p = product(a), account = String(a.db.get(`SELECT id FROM financial_accounts LIMIT 1`)!["id"]), sale = randomUUIDv7();
  operations.completeSale(a.context, { id: sale, number: `V-${sale}`, eventId: randomUUIDv7(), occurredAt: at, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, name: "Rice", unitPriceMinor: 500, quantity: 1000 }], payments: [{ id: randomUUIDv7(), accountId: account, amountMinor: 500 }] });
  const sound = await createBackup(a.context, password, a.files, crypto), c = slot();
  const ok = await previewBackup(sound.bytes, password, c.files, crypto); assert.equal(ok.businessId, a.install.businessId); await cancelBackupPreview(ok);
  // A second stock movement for the same sale line: structurally valid SQLite, wrong books.
  const movement = a.db.get(`SELECT * FROM inventory_movements WHERE reference_id=?`, [sale])!, columns = Object.keys(movement);
  a.db.run(`INSERT INTO inventory_movements(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, columns.map(column => column === "id" ? randomUUIDv7() : movement[column]!));
  databases.splice(databases.indexOf(a.db), 1);
  try {
    const corrupt = await createBackup(a.context, password, a.files, crypto), d = slot();
    await assert.rejects(previewBackup(corrupt.bytes, password, d.files, crypto), code("inconsistent_records"));
    assert.equal(d.db.get(`SELECT count(*) AS n FROM businesses`)!["n"], 0, "the receiving slot is untouched");
  } finally { a.db.close(); }
});
