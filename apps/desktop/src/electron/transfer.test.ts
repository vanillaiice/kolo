import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, randomUUIDv7 } from "node:crypto";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import type { Database } from "@kolo/core/data/database/driver";
import { TransferError, type TransferDocument } from "@kolo/core/backup/types";
import { decryptTransfer, encryptTransfer } from "@kolo/core/backup/encryption";
import { canonicalJson } from "@kolo/contracts/canonical";
import { deflateRawSync } from "node:zlib";
import { DesktopApplication } from "./application.ts";
import { pickedBytes } from "./transfer.ts";
import { localCredentialsOnDesktop, desktopExchangeCrypto, desktopSealingCrypto, desktopTransferCrypto, type NativeSafeStorage } from "./local-credentials.ts";
import type { Result } from "../shared/service.ts";

function value<T>(result: Result<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error("unexpected failure"); return result.value; }
function failure(result: Result<unknown>, code: string): void { assert.deepEqual(result, { ok: false, error: { code } }); }
function native(): NativeSafeStorage {
  const key = randomBytes(32);
  return { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async message => { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, cipher.update(message, "utf8"), cipher.final(), cipher.getAuthTag()]); },
    decryptStringAsync: async bytes => { const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return { result: Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"), shouldReEncrypt: false }; } };
}
/** A desktop installation on real workspace slots; activation swaps the served application like main does. */
async function installation(clock: () => string) {
  const directory = mkdtempSync(join(tmpdir(), "kolo-desktop-transfer-")), slots = nodeWorkspaceFiles(join(directory, "data"));
  const credentials = localCredentialsOnDesktop(join(directory, "vault"), native()), opened: Database[] = [];
  const inbox: { next?: Uint8Array; saved: TransferDocument[]; cancel: boolean } = { saved: [], cancel: false };
  // Picked files are read in pieces like real ones; backups arrive through the streamed save.
  const dialogs = { open: async () => inbox.cancel || inbox.next === undefined ? undefined : pickedBytes(inbox.next), save: async (document: TransferDocument) => { inbox.saved.push(document); return true; },
    saveStream: async (write: (sink: { write(bytes: Uint8Array): Promise<void> }) => Promise<string>) => { const parts: Uint8Array[] = []; const filename = await write({ write: async bytes => { parts.push(bytes); } }); inbox.saved.push({ filename, bytes: new Uint8Array(Buffer.concat(parts)) }); return true; } };
  const holder: { application?: DesktopApplication; database?: Database } = {};
  const faults = { activation: false, restore: false };
  const files = { ...slots, open: async (bytes: Uint8Array) => {
    // A restore failure after the safety switch: the staged backup refuses to activate.
    const candidate = await slots.open(bytes);
    return { ...candidate, activate: async (target: Database) => { if (faults.restore) throw new TransferError("activation_failed"); return candidate.activate(target); } };
  }, receive: async () => {
    // Restores stream into a staging file; the same failure applies to what it opens.
    const writer = await slots.receive();
    return { ...writer, open: async () => { const candidate = await writer.open(); return { ...candidate, activate: async (target: Database) => { if (faults.restore) throw new TransferError("activation_failed"); return candidate.activate(target); } }; } };
  }, empty: async () => {
    const candidate = await slots.empty();
    return { ...candidate, activate: async (target: Database) => {
      if (faults.activation) throw new TransferError("activation_failed");
      return candidate.activate(target);
    } };
  } };
  const serve = async (database: Database): Promise<DesktopApplication> => {
    opened.push(database);
    const application = new DesktopApplication({ database, credentials, newId: randomUUIDv7, now: clock }, desktopExchangeCrypto, { files, dialogs, crypto: desktopSealingCrypto,
      onActivated: async next => { migrate(next); const previous = holder.application; holder.application = await serve(next); holder.database = next; void previous?.dispose(); } });
    await application.initialize(); return application;
  };
  const database = slots.openActive(); migrate(database); holder.database = database; holder.application = await serve(database);
  return { inbox, faults, get app(): DesktopApplication { return holder.application!; }, get database(): Database { return holder.database!; },
    async reopen() { await holder.application?.dispose(); holder.database?.close(); const next = slots.openActive(); holder.database = next; holder.application = await serve(next); },
    async dispose() { await holder.application?.dispose(); for (const item of opened) { try { item.close(); } catch { /* Already closed. */ } } slots.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function shop(f: Awaited<ReturnType<typeof installation>>, name: string): Promise<string> {
  const setup = value(await f.app.createShop({ businessName: name, ownerName: "Owner", deviceLabel: "PC", cashAccountName: "Cash", secret: "654321" }));
  return value(await f.app.unlock({ userId: setup.members[0]!.id, secret: "654321" })).sessionId!;
}
let tick = Date.parse("2026-10-06T12:00:00.000Z");
const clock = (): string => new Date(tick += 1000).toISOString();

it("a locked shop can start fresh without its old code, retaining old facts and persisting the new slot", async () => {
  const f = await installation(clock);
  try {
    const sessionId = await shop(f, "Old shop"), original = f.database;
    value(await f.app.createProduct({ sessionId, requestId: randomUUID(), name: "Old rice", unit: "bag", divisible: false, sellingPriceMinor: 500, openingThousandths: 4000 }));
    failure(await f.app.startNewShop({ confirmedName: "Old shop" }), "permission_denied");
    value(await f.app.lock());
    failure(await f.app.startNewShop({ confirmedName: "Wrong shop" }), "confirmation_required");
    failure(await f.app.startNewShop({ confirmedName: "Old shop", path: "/forged" }), "invalid_input");
    assert.deepEqual(value(await f.app.startNewShop({ confirmedName: "Old shop" })), { activated: true });
    assert.equal(value(await f.app.getWorkspace()).state, "empty");
    assert.equal(f.database.get("SELECT id FROM products LIMIT 1"), undefined);
    assert.equal(original.get("SELECT name FROM products LIMIT 1")!["name"], "Old rice");
    await f.reopen(); assert.equal(value(await f.app.getWorkspace()).state, "empty");
    const setup = value(await f.app.createShop({ businessName: "New shop", ownerName: "New owner", deviceLabel: "PC", cashAccountName: "Cash", secret: "112233" }));
    const next = value(await f.app.unlock({ userId: setup.members[0]!.id, secret: "112233" }));
    assert.equal(value(await f.app.listProducts({ sessionId: next.sessionId! })).items.length, 0);
    failure(await f.app.listProducts({ sessionId }), "locked");
    await f.reopen(); assert.deepEqual([value(await f.app.getWorkspace()).state, value(await f.app.getWorkspace()).shopName], ["locked", "New shop"]);
  } finally { await f.dispose(); }
});

it("saved shops reopen with their original credentials and facts across restart", async () => {
  const f = await installation(clock);
  try {
    const sessionId = await shop(f, "Original");
    value(await f.app.createProduct({ sessionId, requestId: randomUUID(), name: "Retained rice", unit: "bag", divisible: false, sellingPriceMinor: 500, openingThousandths: 4000 }));
    failure(await f.app.savedShops(), "permission_denied");
    value(await f.app.lock()); value(await f.app.startNewShop({confirmedName:"Original"}));
    const saved = value(await f.app.savedShops()); assert.deepEqual(saved, [{id:"kolo.db",name:"Original"}]);
    failure(await f.app.openSavedShop({id:"../kolo.db"}), "activation_failed");
    failure(await f.app.openSavedShop({id:saved[0]!.id,path:"/forged"}), "invalid_input");
    assert.equal(value(await f.app.getWorkspace()).state,"empty");
    value(await f.app.openSavedShop({id:saved[0]!.id}));
    await f.reopen(); const view=value(await f.app.getWorkspace());
    assert.equal(view.state,"locked"); assert.equal(view.shopName,"Original");
    failure(await f.app.unlock({userId:view.members[0]!.id,secret:"112233"}),"invalid_credential");
    const unlocked=value(await f.app.unlock({userId:view.members[0]!.id,secret:"654321"}));
    assert.equal(value(await f.app.listProducts({sessionId:unlocked.sessionId!})).items[0]!.name,"Retained rice");
    failure(await f.app.openSavedShop({id:"kolo.db"}),"permission_denied");
  } finally { await f.dispose(); }
});

it("failed fresh-shop activation leaves the original shop selected and unlockable", async () => {
  const f = await installation(clock);
  try {
    await shop(f, "Original"); value(await f.app.lock()); f.faults.activation = true;
    failure(await f.app.startNewShop({ confirmedName: "Original" }), "activation_failed");
    await f.reopen();
    const view = value(await f.app.getWorkspace()); assert.equal(view.shopName, "Original");
    assert.equal(value(await f.app.unlock({ userId: view.members[0]!.id, secret: "654321" })).state, "unlocked");
  } finally { await f.dispose(); }
});

it("an encrypted backup restores into an empty installation only after the shop name is confirmed", async () => {
  const a = await installation(clock), b = await installation(clock);
  try {
    const sessionId = await shop(a, "Boutique Awa"), cash = value(await a.app.listPaymentAccounts({ sessionId })).items[0]!.id;
    const item = value(await a.app.createProduct({ sessionId, requestId: randomUUID(), name: "Rice", unit: "bag", divisible: false, sellingPriceMinor: 500, openingThousandths: 4000 }));
    value(await a.app.checkout({ sessionId, requestId: randomUUID(), lines: [{ productId: item.id, quantity: 1000, unitPriceMinor: 500 }], payments: [{ accountId: cash, amountMinor: 500 }] }));
    failure(await a.app.saveBackup({ sessionId, password: "short" }), "invalid_password");
    assert.deepEqual(value(await a.app.saveBackup({ sessionId, password: "correct horse battery" })), { saved: true });
    const backup = a.inbox.saved.at(-1)!; assert.match(backup.filename, /^[0-9a-f-]+\.kolo-backup$/);
    b.inbox.cancel = true; failure(await b.app.openBackup({ password: "correct horse battery" }), "cancelled"); b.inbox.cancel = false;
    failure(await b.app.restoreBackup({ confirmedName: "Boutique Awa", deviceLabel: "PC 2", secret: "112233" }), "no_file");
    b.inbox.next = backup.bytes;
    failure(await b.app.openBackup({ password: "wrong horse battery" }), "authentication_failed");
    const preview = value(await b.app.openBackup({ password: "correct horse battery" }));
    assert.deepEqual([preview.businessName, preview.ownerName], ["Boutique Awa", "Owner"]);
    failure(await b.app.restoreBackup({ confirmedName: "Boutique", deviceLabel: "PC 2", secret: "112233" }), "confirmation_required");
    assert.equal(value(await b.app.getWorkspace()).state, "empty");
    assert.deepEqual(value(await b.app.restoreBackup({ confirmedName: "Boutique Awa", deviceLabel: "PC 2", secret: "112233" })), { activated: true });
    const restored = value(await b.app.getWorkspace()); assert.deepEqual([restored.state, restored.shopName], ["locked", "Boutique Awa"]);
    const session = value(await b.app.unlock({ userId: restored.members[0]!.id, secret: "112233" })).sessionId!;
    assert.equal(value(await b.app.listProducts({ sessionId: session })).items[0]!.onHandThousandths, 3000);
    assert.equal(value(await b.app.listReceipts({ sessionId: session })).items.length, 1);
    const context = value(await a.app.getWorkspace()); assert.equal(context.state, "unlocked");
  } finally { await a.dispose(); await b.dispose(); }
});

it("the owner creates a backup recovery key once, and a second computer restores a backup with only that key", async () => {
  const a = await installation(clock), b = await installation(clock);
  try {
    const sessionId = await shop(a, "Boutique Awa");
    const item = value(await a.app.createProduct({ sessionId, requestId: randomUUID(), name: "Mil", unit: "bag", divisible: false, sellingPriceMinor: 700, openingThousandths: 2000 }));
    assert.deepEqual(value(await a.app.backupKeys({ sessionId })), []);
    failure(await a.app.prepareBackupKey({ sessionId, secret: "000000" }), "authentication_failed");
    failure(await a.app.confirmBackupKey({ sessionId, groups: ["0000", "0000", "0000"] }), "confirmation_required");
    const key = value(await a.app.prepareBackupKey({ sessionId, secret: "654321" })), groups = key.text.split("-");
    assert.equal(groups.length, 14); assert.equal(key.confirm.length, 3);
    failure(await a.app.confirmBackupKey({ sessionId, groups: ["0000", "0000", "0000"] }), "confirmation_required");
    failure(await a.app.confirmBackupKey({ sessionId, groups: ["0000"] }), "invalid_input");
    failure(await a.app.confirmBackupKey({ sessionId: randomUUID(), groups: key.confirm.map(index => groups[index]!) }), "locked");
    const pinned = value(await a.app.confirmBackupKey({ sessionId, groups: key.confirm.map(index => groups[index]!.toLowerCase()) }));
    assert.deepEqual({ ...pinned, createdAt: undefined }, { keyId: key.keyId, version: 1, current: true, createdAt: undefined });
    failure(await a.app.confirmBackupKey({ sessionId, groups: key.confirm.map(index => groups[index]!) }), "confirmation_required", "the shown key pins once and is forgotten");
    assert.deepEqual(value(await a.app.backupKeys({ sessionId })).map(view => view.keyId), [key.keyId]);
    // Locking forgets a key that was shown but not confirmed.
    const unconfirmed = value(await a.app.prepareBackupKey({ sessionId, secret: "654321" }));
    value(await a.app.lock());
    const again = value(await a.app.unlock({ userId: value(await a.app.getWorkspace()).members[0]!.id, secret: "654321" })).sessionId!;
    failure(await a.app.confirmBackupKey({ sessionId: again, groups: unconfirmed.confirm.map(index => unconfirmed.text.split("-")[index]!) }), "confirmation_required");
    value(await a.app.saveBackup({ sessionId: again, password: "correct horse battery" }));
    const backup = a.inbox.saved.at(-1)!;
    b.inbox.next = backup.bytes;
    failure(await b.app.openBackup({ password: "correct horse battery", recoveryKey: key.text }), "invalid_input");
    failure(await b.app.openBackup({}), "invalid_input");
    failure(await b.app.openBackup({ recoveryKey: "not a key" }), "invalid_recovery_key");
    assert.equal(value(await b.app.openBackup({ recoveryKey: key.text.replace(/-/g, " ") })).businessName, "Boutique Awa");
    assert.deepEqual(value(await b.app.restoreBackup({ confirmedName: "Boutique Awa", deviceLabel: "PC 2", secret: "112233" })), { activated: true });
    const restored = value(await b.app.getWorkspace()), session = value(await b.app.unlock({ userId: restored.members[0]!.id, secret: "112233" })).sessionId!;
    assert.equal(value(await b.app.listProducts({ sessionId: session })).items.find(product => product.id === item.id)?.name, "Mil");
    assert.deepEqual(value(await b.app.backupKeys({ sessionId: session })).map(view => view.keyId), [key.keyId], "the restored shop keeps its pinned key");
  } finally { await a.dispose(); await b.dispose(); }
});

it("the import screen recognizes backups and invites with one dialog, and refuses other files", async () => {
  const a = await installation(clock), b = await installation(clock);
  try {
    const sessionId = await shop(a, "Boutique Awa");
    value(await a.app.saveBackup({ sessionId, password: "correct horse battery" })); const backup = a.inbox.saved.at(-1)!.bytes;
    value(await a.app.saveInvite({ sessionId, authorityAllowed: false })); const invite = a.inbox.saved.at(-1)!.bytes;
    for (const text of ["not json", "[]", "{}", JSON.stringify({ header: { format: "kolo.encrypted", purpose: "exchange" } })]) { b.inbox.next = desktopTransferCrypto.encodeText(text); failure(await b.app.chooseImportFile(), "invalid_file"); }
    // Binary noise, a truncated container and an encrypted file of another purpose are refused before any password work.
    const exchange = await encryptTransfer(desktopTransferCrypto.encodeText("{}"), "exchange", randomUUIDv7(), "correct horse battery", desktopTransferCrypto);
    for (const file of [new Uint8Array(randomBytes(64)), backup.subarray(0, 10), new Uint8Array([0x89, 0x4b, 0x4f, 0x4c, 0x4f, 0x0d, 0x0a, 0x1a]), exchange]) { b.inbox.next = file; failure(await b.app.chooseImportFile(), "invalid_file"); }
    b.inbox.cancel = true; failure(await b.app.chooseImportFile(), "cancelled"); b.inbox.cancel = false;
    b.inbox.next = invite; assert.deepEqual(value(await b.app.chooseImportFile()), { kind: "invite" });
    b.inbox.next = undefined; assert.equal(value(await b.app.openInvite()).businessName, "Boutique Awa");
    b.inbox.next = backup; assert.deepEqual(value(await b.app.chooseImportFile()), { kind: "backup" });
    // The chosen file is used without opening the dialog again.
    b.inbox.next = undefined; assert.equal(value(await b.app.openBackup({ password: "correct horse battery" })).businessName, "Boutique Awa");
    // A JSON backup as releases before ADR-035 saved it is no longer recognized.
    b.inbox.next = await legacyBackup(backup, "correct horse battery"); failure(await b.app.chooseImportFile(), "invalid_file");
  } finally { await a.dispose(); await b.dispose(); }
});

/** Re-wraps a current backup as releases before ADR-035 wrote it: one JSON document with base64 ciphertext. */
async function legacyBackup(file: Uint8Array, password: string): Promise<Uint8Array> {
  const crypto = desktopTransferCrypto, plain = await decryptTransfer(file, "backup", password, crypto), compressed = new Uint8Array(deflateRawSync(plain));
  const header = { format: "kolo.encrypted", format_version: 2, purpose: "backup", file_id: randomUUIDv7(), cipher: "AES-256-GCM", kdf: "PBKDF2-SHA256", iterations: 600000,
    salt: crypto.randomHex(32), nonce: crypto.randomHex(12), compression: "deflate", plaintext_bytes: compressed.byteLength, content_bytes: plain.byteLength };
  const sealed = await crypto.encrypt(await crypto.derive(password, header.salt, 600000), header.nonce, compressed, canonicalJson(header));
  return crypto.encodeText(canonicalJson({ header, ...sealed }, 64 * 1024 * 1024));
}

it("signed out, a backup replaces this computer's shop only when asked, keeping the old shop as a safety copy", async () => {
  const a = await installation(clock), b = await installation(clock);
  try {
    const sessionId = await shop(a, "Boutique Awa");
    value(await a.app.createProduct({ sessionId, requestId: randomUUID(), name: "Rice", unit: "bag", divisible: false, sellingPriceMinor: 500, openingThousandths: 4000 }));
    value(await a.app.saveBackup({ sessionId, password: "correct horse battery" })); b.inbox.next = a.inbox.saved.at(-1)!.bytes;
    await shop(b, "Old till shop"); value(await b.app.lock());
    value(await b.app.chooseImportFile()); value(await b.app.openBackup({ password: "correct horse battery" }));
    const request = { confirmedName: "Boutique Awa", deviceLabel: "PC 2", secret: "112233" };
    failure(await b.app.restoreBackup(request), "not_empty");
    failure(await b.app.restoreBackup({ ...request, replace: "yes" }), "invalid_input");
    failure(await b.app.restoreBackup({ ...request, secret: "12", replace: true }), "invalid_input");
    assert.equal(value(await b.app.getWorkspace()).shopName, "Old till shop", "nothing switched before a valid request");
    assert.deepEqual(value(await b.app.restoreBackup({ ...request, replace: true })), { activated: true });
    const restored = value(await b.app.getWorkspace()); assert.deepEqual([restored.state, restored.shopName], ["locked", "Boutique Awa"]);
    const next = value(await b.app.unlock({ userId: restored.members[0]!.id, secret: "112233" })).sessionId!;
    assert.equal(value(await b.app.listProducts({ sessionId: next })).items[0]!.name, "Rice");
    value(await b.app.lock()); assert.deepEqual(value(await b.app.savedShops()).map(item => item.name), ["Old till shop"]);
    await b.reopen(); assert.equal(value(await b.app.getWorkspace()).shopName, "Boutique Awa", "the replacement persists across restart");
  } finally { await a.dispose(); await b.dispose(); }
});

it("a replacement that fails after the safety switch leaves the previous shop active and unlockable", async () => {
  const a = await installation(clock), b = await installation(clock);
  try {
    const sessionId = await shop(a, "Boutique Awa");
    value(await a.app.saveBackup({ sessionId, password: "correct horse battery" })); b.inbox.next = a.inbox.saved.at(-1)!.bytes;
    await shop(b, "Old till shop"); value(await b.app.lock());
    value(await b.app.chooseImportFile()); value(await b.app.openBackup({ password: "correct horse battery" }));
    b.faults.restore = true;
    failure(await b.app.restoreBackup({ confirmedName: "Boutique Awa", deviceLabel: "PC 2", secret: "112233", replace: true }), "activation_failed");
    const view = value(await b.app.getWorkspace()); assert.equal(view.shopName, "Old till shop");
    await b.reopen();
    const reopened = value(await b.app.getWorkspace()); assert.equal(reopened.shopName, "Old till shop", "active slot points back at the old shop");
    assert.equal(value(await b.app.unlock({ userId: reopened.members[0]!.id, secret: "654321" })).state, "unlocked");
  } finally { await a.dispose(); await b.dispose(); }
});

it("two desktops pair by compared fingerprint and code, then exchange sales and receipts by file", async () => {
  const a = await installation(clock), b = await installation(clock);
  try {
    const owner = await shop(a, "Boutique Awa");
    const item = value(await a.app.createProduct({ sessionId: owner, requestId: randomUUID(), name: "Rice", unit: "bag", divisible: false, sellingPriceMinor: 500, openingThousandths: 10000 }));
    const invite = value(await a.app.saveInvite({ sessionId: owner, authorityAllowed: false })); assert.equal(invite.saved, true);
    b.inbox.next = a.inbox.saved.at(-1)!.bytes;
    const checked = value(await b.app.openInvite()); assert.deepEqual([checked.businessName, checked.fingerprint], ["Boutique Awa", invite.fingerprint]);
    const accepted = value(await b.app.acceptInvite({ confirmedFingerprint: invite.fingerprint, deviceLabel: "Second till", secret: "223344" }));
    a.inbox.next = b.inbox.saved.at(-1)!.bytes;
    const request = value(await a.app.openPairingRequest({ sessionId: owner })); assert.deepEqual([request.deviceLabel, request.verificationCode], ["Second till", accepted.verificationCode]);
    failure(await a.app.approvePairingRequest({ sessionId: owner, confirmedCode: "000000", password: "pairing file password" }), "confirmation_required");
    a.inbox.next = b.inbox.saved.at(-1)!.bytes; value(await a.app.openPairingRequest({ sessionId: owner }));
    value(await a.app.approvePairingRequest({ sessionId: owner, confirmedCode: accepted.verificationCode, password: "pairing file password" }));
    b.inbox.next = a.inbox.saved.at(-1)!.bytes;
    assert.deepEqual(value(await b.app.completePairing({ password: "pairing file password", confirmedCode: accepted.verificationCode })), { activated: true });
    const paired = value(await b.app.getWorkspace()); assert.deepEqual([paired.state, paired.shopName], ["locked", "Boutique Awa"]);
    const second = value(await b.app.unlock({ userId: paired.members[0]!.id, secret: "223344" })).sessionId!;
    const cash = value(await b.app.listPaymentAccounts({ sessionId: second })).items[0]!.id;
    value(await b.app.checkout({ sessionId: second, requestId: randomUUID(), lines: [{ productId: item.id, quantity: 2000, unitPriceMinor: 500 }], payments: [{ accountId: cash, amountMinor: 1000 }] }));
    await b.app.seal();
    const toA = value(await b.app.exchangeState({ sessionId: second })).destinations[0]!; assert.ok(toA.pending > 0);
    const exported = value(await b.app.saveExchange({ sessionId: second, destinationId: toA.id, password: "exchange file password" })); assert.deepEqual(exported, { saved: true, empty: false });
    a.inbox.next = b.inbox.saved.at(-1)!.bytes;
    failure(await a.app.importExchange({ sessionId: owner }), "no_file");
    const bundle = value(await a.app.openExchange({ sessionId: owner, password: "exchange file password" })); assert.ok(bundle.ready > 0);
    assert.ok(value(await a.app.importExchange({ sessionId: owner })).processed > 0);
    assert.equal(value(await a.app.listProducts({ sessionId: owner })).items[0]!.onHandThousandths, 8000);
    const batch = value(await a.app.exchangeState({ sessionId: owner })).batches[0]!;
    value(await a.app.saveImportReceipt({ sessionId: owner, batchId: batch.batchId, password: "exchange file password" }));
    b.inbox.next = a.inbox.saved.at(-1)!.bytes;
    assert.ok(value(await b.app.openImportReceipt({ sessionId: second, destinationId: toA.id, password: "exchange file password" })).recorded > 0);
    assert.equal(value(await b.app.exchangeState({ sessionId: second })).destinations[0]!.pending, 0);
    assert.deepEqual(value(await b.app.saveExchange({ sessionId: second, destinationId: toA.id, password: "exchange file password" })), { saved: false, empty: true });
    failure(await a.app.restoreBackup({ confirmedName: "x", deviceLabel: "x", secret: "654321" }), "no_file");
  } finally { await a.dispose(); await b.dispose(); }
});

