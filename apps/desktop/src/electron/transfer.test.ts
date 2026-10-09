import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, randomUUIDv7 } from "node:crypto";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import type { Database } from "@kolo/core/data/database/driver";
import type { TransferDocument } from "@kolo/core/backup/types";
import { DesktopApplication } from "./application.ts";
import { localCredentialsOnDesktop, desktopExchangeCrypto, desktopTransferCrypto, type NativeSafeStorage } from "./local-credentials.ts";
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
  const inbox: { next?: string; saved: TransferDocument[]; cancel: boolean } = { saved: [], cancel: false };
  const dialogs = { open: async () => inbox.cancel ? undefined : inbox.next, save: async (document: TransferDocument) => { inbox.saved.push(document); return true; } };
  const holder: { application?: DesktopApplication; database?: Database } = {};
  const serve = async (database: Database): Promise<DesktopApplication> => {
    opened.push(database);
    const application = new DesktopApplication({ database, credentials, newId: randomUUIDv7, now: clock }, desktopExchangeCrypto, { files: slots, dialogs, crypto: desktopTransferCrypto,
      onActivated: async next => { migrate(next); const previous = holder.application; holder.application = await serve(next); holder.database = next; void previous?.dispose(); } });
    await application.initialize(); return application;
  };
  const database = slots.openActive(); migrate(database); holder.database = database; holder.application = await serve(database);
  return { inbox, get app(): DesktopApplication { return holder.application!; }, get database(): Database { return holder.database!; },
    async dispose() { await holder.application?.dispose(); for (const item of opened) { try { item.close(); } catch { /* Already closed. */ } } slots.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function shop(f: Awaited<ReturnType<typeof installation>>, name: string): Promise<string> {
  const setup = value(await f.app.createShop({ businessName: name, ownerName: "Owner", deviceLabel: "PC", cashAccountName: "Cash", secret: "654321" }));
  return value(await f.app.unlock({ userId: setup.members[0]!.id, secret: "654321" })).sessionId!;
}
let tick = Date.parse("2026-10-06T12:00:00.000Z");
const clock = (): string => new Date(tick += 1000).toISOString();

it("an encrypted backup restores into an empty installation only after the shop name is confirmed", async () => {
  const a = await installation(clock), b = await installation(clock);
  try {
    const sessionId = await shop(a, "Boutique Awa"), cash = value(await a.app.listPaymentAccounts({ sessionId })).items[0]!.id;
    const item = value(await a.app.createProduct({ sessionId, requestId: randomUUID(), name: "Rice", unit: "bag", divisible: false, sellingPriceMinor: 500, openingThousandths: 4000 }));
    value(await a.app.checkout({ sessionId, requestId: randomUUID(), lines: [{ productId: item.id, quantity: 1000, unitPriceMinor: 500 }], payments: [{ accountId: cash, amountMinor: 500 }] }));
    failure(await a.app.saveBackup({ sessionId, password: "short" }), "invalid_password");
    assert.deepEqual(value(await a.app.saveBackup({ sessionId, password: "correct horse battery" })), { saved: true });
    const backup = a.inbox.saved.at(-1)!; assert.match(backup.filename, /\.kolo-backup\.json$/);
    b.inbox.cancel = true; failure(await b.app.openBackup({ password: "correct horse battery" }), "cancelled"); b.inbox.cancel = false;
    failure(await b.app.restoreBackup({ confirmedName: "Boutique Awa", deviceLabel: "PC 2", secret: "112233" }), "no_file");
    b.inbox.next = backup.text;
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

it("two desktops pair by compared fingerprint and code, then exchange sales and receipts by file", async () => {
  const a = await installation(clock), b = await installation(clock);
  try {
    const owner = await shop(a, "Boutique Awa");
    const item = value(await a.app.createProduct({ sessionId: owner, requestId: randomUUID(), name: "Rice", unit: "bag", divisible: false, sellingPriceMinor: 500, openingThousandths: 10000 }));
    const invite = value(await a.app.saveInvite({ sessionId: owner, authorityAllowed: false })); assert.equal(invite.saved, true);
    b.inbox.next = a.inbox.saved.at(-1)!.text;
    const checked = value(await b.app.openInvite()); assert.deepEqual([checked.businessName, checked.fingerprint], ["Boutique Awa", invite.fingerprint]);
    const accepted = value(await b.app.acceptInvite({ confirmedFingerprint: invite.fingerprint, deviceLabel: "Second till", secret: "223344" }));
    a.inbox.next = b.inbox.saved.at(-1)!.text;
    const request = value(await a.app.openPairingRequest({ sessionId: owner })); assert.deepEqual([request.deviceLabel, request.verificationCode], ["Second till", accepted.verificationCode]);
    failure(await a.app.approvePairingRequest({ sessionId: owner, confirmedCode: "000000", password: "pairing file password" }), "confirmation_required");
    a.inbox.next = b.inbox.saved.at(-1)!.text; value(await a.app.openPairingRequest({ sessionId: owner }));
    value(await a.app.approvePairingRequest({ sessionId: owner, confirmedCode: accepted.verificationCode, password: "pairing file password" }));
    b.inbox.next = a.inbox.saved.at(-1)!.text;
    assert.deepEqual(value(await b.app.completePairing({ password: "pairing file password", confirmedCode: accepted.verificationCode })), { activated: true });
    const paired = value(await b.app.getWorkspace()); assert.deepEqual([paired.state, paired.shopName], ["locked", "Boutique Awa"]);
    const second = value(await b.app.unlock({ userId: paired.members[0]!.id, secret: "223344" })).sessionId!;
    const cash = value(await b.app.listPaymentAccounts({ sessionId: second })).items[0]!.id;
    value(await b.app.checkout({ sessionId: second, requestId: randomUUID(), lines: [{ productId: item.id, quantity: 2000, unitPriceMinor: 500 }], payments: [{ accountId: cash, amountMinor: 1000 }] }));
    await b.app.seal();
    const toA = value(await b.app.exchangeState({ sessionId: second })).destinations[0]!; assert.ok(toA.pending > 0);
    const exported = value(await b.app.saveExchange({ sessionId: second, destinationId: toA.id, password: "exchange file password" })); assert.deepEqual(exported, { saved: true, empty: false });
    a.inbox.next = b.inbox.saved.at(-1)!.text;
    failure(await a.app.importExchange({ sessionId: owner }), "no_file");
    const bundle = value(await a.app.openExchange({ sessionId: owner, password: "exchange file password" })); assert.ok(bundle.ready > 0);
    assert.ok(value(await a.app.importExchange({ sessionId: owner })).processed > 0);
    assert.equal(value(await a.app.listProducts({ sessionId: owner })).items[0]!.onHandThousandths, 8000);
    const batch = value(await a.app.exchangeState({ sessionId: owner })).batches[0]!;
    value(await a.app.saveImportReceipt({ sessionId: owner, batchId: batch.batchId, password: "exchange file password" }));
    b.inbox.next = a.inbox.saved.at(-1)!.text;
    assert.ok(value(await b.app.openImportReceipt({ sessionId: second, destinationId: toA.id, password: "exchange file password" })).recorded > 0);
    assert.equal(value(await b.app.exchangeState({ sessionId: second })).destinations[0]!.pending, 0);
    assert.deepEqual(value(await b.app.saveExchange({ sessionId: second, destinationId: toA.id, password: "exchange file password" })), { saved: false, empty: true });
    failure(await a.app.restoreBackup({ confirmedName: "x", deviceLabel: "x", secret: "654321" }), "no_file");
  } finally { await a.dispose(); await b.dispose(); }
});
