/**
 * Saves the mobile performance fixture (docs/implementation/mobile-parity.md) as an encrypted
 * backup that a phone can restore, so the same dataset is measured on a device.
 *
 * Usage: npm run fixture:mobile -- [output directory]
 *
 * The shop, its owner and one sample product go through `DesktopApplication` so the identity,
 * signatures and backup are genuine. The bulk catalogue and opening stock are then inserted
 * directly, as `scripts/mobile-fixture.mjs` does, because 10 000 signed product events would
 * measure the generator rather than the phone. Credit sales go through checkout and leave a long
 * customer statement and a sealed event history.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, randomUUIDv7 } from "node:crypto";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import type { TransferDocument } from "@kolo/core/backup/types";
import { DesktopApplication } from "../src/electron/application.ts";
import { localCredentialsOnDesktop, desktopExchangeCrypto, desktopTransferCrypto, type NativeSafeStorage } from "../src/electron/local-credentials.ts";
import type { Result } from "../src/shared/service.ts";

const PRODUCTS = 10_000, MOVEMENTS = 100_000, STATEMENT_SALES = 2_000;
const OWNER_SECRET = "654321", BACKUP_PASSWORD = "kolo-fixture-2026";
const outputDirectory = resolve(process.argv[2] ?? "kolo-fixture");

function value<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${result.error.code}`);
  return result.value;
}

function memoryVault(): NativeSafeStorage {
  const key = randomBytes(32);
  return { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async message => { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, cipher.update(message, "utf8"), cipher.final(), cipher.getAuthTag()]); },
    decryptStringAsync: async bytes => { const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return { result: Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"), shouldReEncrypt: false }; } };
}

const workDirectory = mkdtempSync(join(tmpdir(), "kolo-fixture-"));
try {
  const slots = nodeWorkspaceFiles(join(workDirectory, "data")), database = slots.openActive(); migrate(database);
  const saved: TransferDocument[] = [];
  const app = new DesktopApplication({ database, credentials: localCredentialsOnDesktop(join(workDirectory, "vault"), memoryVault()), newId: randomUUIDv7, now: () => new Date().toISOString() },
    desktopExchangeCrypto, { files: slots, dialogs: { open: async () => undefined, save: async document => { saved.push(document); return true; } },
      crypto: desktopTransferCrypto, onActivated: async () => undefined });
  await app.initialize();
  const setup = value(await app.createShop({ businessName: "Mobile fixture", ownerName: "Owner", deviceLabel: "Fixture", cashAccountName: "Cash", secret: OWNER_SECRET }), "setup");
  const sessionId = value(await app.unlock({ userId: setup.members[0]!.id, secret: OWNER_SECRET }), "unlock").sessionId!;
  const account = value(await app.listAccounts({ sessionId }), "accounts").items[0]!;

  // One product through the application supplies the shop, user and device the bulk rows reuse.
  const sample = value(await app.createProduct({ sessionId, requestId: randomUUID(), name: "Sample product", unit: "unit", divisible: false, sellingPriceMinor: 500,
    purchasePriceMinor: 300, barcode: "BENCHSAMPLE", openingThousandths: 1000 }), "sample product");
  const opening = database.get("SELECT business_id, user_id, device_id FROM inventory_movements WHERE product_id = ?", [sample.id])!;
  const businessId = String(opening["business_id"]), userId = String(opening["user_id"]), deviceId = String(opening["device_id"]);
  const at = new Date().toISOString(), productIds: string[] = [];
  database.transaction(tx => {
    for (let i = 0; i < PRODUCTS; i++) {
      const id = randomUUIDv7(); productIds.push(id);
      tx.run("INSERT INTO products(id,business_id,name,barcode,unit,purchase_price_minor,selling_price_minor,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [id, businessId, `Product ${String(i).padStart(5, "0")}`, `BENCH${i}`, "unit", 300, 500, "XAF", at, at]);
    }
    for (let i = 0; i < MOVEMENTS; i++) tx.run("INSERT INTO inventory_movements(id,business_id,product_id,type,quantity,unit_cost_minor,unit_cost_currency,user_id,device_id,occurred_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [randomUUIDv7(), businessId, productIds[i % PRODUCTS]!, "OPENING_BALANCE", 1000, 300, "XAF", userId, deviceId, at, at]);
  });

  const customer = value(await app.createCustomer({ sessionId, requestId: randomUUID(), name: "Long statement", phone: "+237 600 00 00 00", creditLimitMinor: 1_000_000_000 }), "customer");
  for (let i = 0; i < STATEMENT_SALES; i++) {
    value(await app.checkout({ sessionId, requestId: randomUUID(), customerId: customer.id, payments: i % 4 === 0 ? [{ accountId: account.id, amountMinor: 200 }] : [],
      lines: [{ productId: productIds[i % PRODUCTS]!, quantity: 1000, unitPriceMinor: 500 }] }), "credit sale");
    if (i % 500 === 499) process.stdout.write(`${i + 1}/${STATEMENT_SALES} credit sales\n`);
  }
  await app.seal();
  value(await app.saveBackup({ sessionId, password: BACKUP_PASSWORD }), "backup");
  const document = saved[saved.length - 1]!;
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, document.filename), document.text);
  writeFileSync(join(outputDirectory, "README.txt"), [
    "kolo mobile performance fixture", "", `Backup file: ${document.filename}`, `Backup password: ${BACKUP_PASSWORD}`, "",
    `${PRODUCTS + 1} products, ${MOVEMENTS + 1} opening movements, ${STATEMENT_SALES} credit sales to "Long statement".`,
    "Restoring replaces the shop on the device; choose a new owner code while restoring.", "",
  ].join("\n"));
  process.stdout.write(`Wrote ${join(outputDirectory, document.filename)} (${(document.text.length / 1048576).toFixed(1)} MiB)\n`);
  await app.dispose(); database.close();
} finally { rmSync(workDirectory, { recursive: true, force: true }); }
