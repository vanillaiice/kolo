import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import type { Database } from "./driver.ts";
import { openDatabase } from "./node-sqlite.ts";
import { migrate } from "./migrations.ts";
import { assertConsistent, checkIntegrity } from "./integrity.ts";
import { createWorkspace, unlockWorkspace } from "../../identity/workspace.ts";
import type { WorkspacePorts } from "../../identity/types.ts";
import * as commands from "../../application/operations.ts";
import * as queries from "../../application/queries.ts";
import { previewReturn, returnSale } from "../../application/returns.ts";

const at = "2026-10-06T09:00:00.000Z", secret = "fixture-secret";
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function shop() {
  const db = openDatabase(); databases.push(db); migrate(db);
  const material = { publicKey: generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, now: () => at, newId: randomUUIDv7, credentials: { provision: async () => material, inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "DESKTOP", currency: "XAF", secret }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const account = queries.paymentAccounts(context).items[0]!.id, product = randomUUIDv7(), customer = randomUUIDv7();
  commands.saveProduct(context, { id: product, name: "Rice", unit: "bag", currency: "XAF", sellingPriceMinor: 1000, purchasePriceMinor: 600, taxRateBasisPoints: 0, minimumStock: 0, divisible: true, active: true, createdAt: at, updatedAt: at });
  commands.saveCustomer(context, { id: customer, name: "Ama", active: true, createdAt: at, updatedAt: at });
  // A discounted credit sale with a fractional line, partly returned twice: every invariant has something to check.
  const sale = randomUUIDv7(), line = randomUUIDv7();
  commands.completeSale(context, { id: sale, number: sale, customerId: customer, discountMinor: 300, occurredAt: at, eventId: randomUUIDv7(), creditTransactionId: randomUUIDv7(),
    lines: [{ id: line, movementId: randomUUIDv7(), productId: product, name: "Rice", unitPriceMinor: 1000, quantity: 2500 }], payments: [{ id: randomUUIDv7(), accountId: account, amountMinor: 1000 }] });
  for (const quantity of [500, 1000]) {
    const preview = previewReturn(context, "SALE", sale, [{ originalItemId: line, quantity }]);
    returnSale(context, { id: randomUUIDv7(), eventId: randomUUIDv7(), originalId: sale, priorId: preview.source.priorId, reason: "Back", items: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), originalItemId: line, quantity }],
      refunds: [], debtTransactionId: randomUUIDv7() });
  }
  return { db, context, sale, line, product, customer, ports };
}
const codes = (db: Database): string[] => checkIntegrity(db).issues.map(issue => issue.code).sort();

it("a shop built only through operations is consistent, including discounted credit sales and partial returns", async () => {
  const { db } = await shop();
  const report = checkIntegrity(db);
  assert.deepEqual(report.issues, []); assert.equal(report.ok, true); assert.equal(report.consistent, true);
  assert.doesNotThrow(() => assertConsistent(db));
});

it("tampering behind the operations is reported as corruption with its own code", async () => {
  const { db, sale, product, customer } = await shop(), deviceUser = db.get(`SELECT user_id,device_id,business_id FROM sales WHERE id=?`, [sale])!;
  const values = [deviceUser["business_id"]!, deviceUser["user_id"]!, deviceUser["device_id"]!, at, at];
  // A second stock movement for the sale and an extra debt on the customer, both appended directly.
  db.run(`INSERT INTO inventory_movements(id,business_id,product_id,type,quantity,reference_kind,reference_id,user_id,device_id,occurred_at,recorded_at)
    VALUES (?,?,?,'SALE',-1000,'SALE',?,?,?,?,?)`, [randomUUIDv7(), values[0]!, product, sale, values[1]!, values[2]!, at, at]);
  db.run(`INSERT INTO customer_transactions(id,customer_id,business_id,type,amount_minor,currency,reference_kind,reference_id,user_id,device_id,occurred_at,recorded_at)
    VALUES (?,?,?,'CREDIT_SALE',5,'XAF','SALE',?,?,?,?,?)`, [randomUUIDv7(), customer, values[0]!, sale, values[1]!, values[2]!, at, at]);
  assert.deepEqual(codes(db), ["credit_sale_mismatch", "sale_stock_mismatch"]);
  assert.equal(checkIntegrity(db).consistent, false);
  assert.throws(() => assertConsistent(db, "till A"), /till A is inconsistent: .*credit_sale_mismatch×1/);
});

it("operational sync states are attention, not corruption; another schema version reports only that", async () => {
  const { db } = await shop();
  db.run(`UPDATE sync_outbox SET state='rejected' WHERE rowid=(SELECT min(rowid) FROM sync_outbox)`);
  const report = checkIntegrity(db);
  assert.deepEqual(report.issues, [{ code: "rejected_outbox", count: 1, severity: "attention" }]);
  assert.equal(report.ok, false); assert.equal(report.consistent, true);
  assert.doesNotThrow(() => assertConsistent(db));
  db.run(`DELETE FROM schema_migrations WHERE version=(SELECT max(version) FROM schema_migrations)`);
  assert.deepEqual(checkIntegrity(db).issues.map(issue => issue.code), ["unsupported_schema"]);
});
