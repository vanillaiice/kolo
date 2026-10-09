import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "../data/database/driver.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate, MIGRATIONS } from "../data/database/migrations.ts";
import { changeRevision, subscribeChanges } from "../data/database/changes.ts";
import { createWorkspace, unlockWorkspace, lockWorkspace } from "../identity/workspace.ts";
import type { WorkspacePorts } from "../identity/types.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";

const at = "2026-10-06T09:00:00.000Z", secret = "fixture-secret";
const databases: Database[] = [], paths: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function fixture(location?: string) {
  const db = openDatabase(location === undefined ? {} : { location }); databases.push(db); migrate(db);
  const material = { publicKey: generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, now: () => at, newId: randomUUIDv7, credentials: { provision: async () => material, inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "ANDROID", currency: "XAF", secret }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const account = queries.paymentAccounts(context).items[0]!;
  const product = (name = "Rice", options: { divisible?: boolean; barcode?: string; categoryId?: string } = {}) => {
    const id = randomUUIDv7(); commands.saveProduct(context, { id, name, unit: "unit", currency: "XAF", sellingPriceMinor: 500, purchasePriceMinor: 300, taxRateBasisPoints: 0, minimumStock: 0, divisible: options.divisible ?? false, barcode: options.barcode, categoryId: options.categoryId, active: true, createdAt: at, updatedAt: at }); return id;
  };
  const sale = (productId: string, ownerId = context.userId) => {
    assert.equal(ownerId, context.userId); const id = randomUUIDv7(); commands.completeSale(context, { id, number: id, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId, name: "Rice then", unitPriceMinor: 500, quantity: 1000 }], payments: [{ id: randomUUIDv7(), accountId: account.id, amountMinor: 500 }], occurredAt: at, eventId: randomUUIDv7() }); return id;
  };
  return { db, ports, installation, context, account, product, sale };
}

it("offline shop day persists split-credit sale, collection, payable payment, counts, transfer, expense reversal and receipt across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-f4-")); paths.push(directory); const location = join(directory, "shop.db");
  const f = await fixture(location), { context, account } = f, p = f.product(), customer = randomUUIDv7(), supplier = randomUUIDv7(), wallet = randomUUIDv7();
  commands.saveCustomer(context, { id: customer, name: "Buyer", active: true, createdAt: at, updatedAt: at });
  commands.saveSupplier(context, { id: supplier, name: "Supplier", active: true, createdAt: at, updatedAt: at });
  commands.saveAccount(context, { id: wallet, name: "Wallet", kind: "MOBILE_MONEY", currency: "XAF", active: true, createdAt: at, updatedAt: at });
  commands.recordPurchase(context, { id: randomUUIDv7(), supplierId: supplier, supplierTransactionId: randomUUIDv7(), lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, quantity: 3000, unitCostMinor: 300 }], payments: [], occurredAt: at, eventId: randomUUIDv7() });
  const saleId = randomUUIDv7(); commands.completeSale(context, { id: saleId, number: "R-1", customerId: customer, creditTransactionId: randomUUIDv7(), lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, name: "Rice then", unitPriceMinor: 500, quantity: 4000 }], payments: [{ id: randomUUIDv7(), accountId: account.id, amountMinor: 200 }, { id: randomUUIDv7(), accountId: wallet, amountMinor: 100 }], occurredAt: at, eventId: randomUUIDv7() });
  assert.equal(queries.productStock(context, p).onHandThousandths, -1000);
  assert.equal(queries.receipt(context, saleId).outstandingMinor, 1700);
  commands.receiveCustomerPayment(context, { id: randomUUIDv7(), customerId: customer, accountId: account.id, amountMinor: 1700, occurredAt: at, eventId: randomUUIDv7() });
  commands.paySupplier(context, { id: randomUUIDv7(), supplierId: supplier, accountId: account.id, amountMinor: 900, occurredAt: at, eventId: randomUUIDv7() });
  assert.equal(queries.personBalance(context, "customer", customer), 0); assert.equal(queries.personBalance(context, "supplier", supplier), 0);
  assert.equal(commands.countStock(context, { productId: p, countedThousandths: 2000, reason: "Shelf count" }), 3000);
  commands.moveCash(context, { eventId: randomUUIDv7(), movements: [
    { id: randomUUIDv7(), accountId: account.id, counterpartId: wallet, type: "TRANSFER_OUT", amountMinor: -200, occurredAt: at },
    { id: randomUUIDv7(), accountId: wallet, counterpartId: account.id, type: "TRANSFER_IN", amountMinor: 200, occurredAt: at },
  ] });
  const expenseId = randomUUIDv7(); commands.recordExpense(context, { id: expenseId, category: "TRANSPORT", accountId: account.id, amountMinor: 100, occurredAt: at, eventId: randomUUIDv7() });
  commands.recordExpense(context, { id: randomUUIDv7(), category: "TRANSPORT", accountId: account.id, amountMinor: -100, reversesId: expenseId, occurredAt: at, eventId: randomUUIDv7() });
  const comparison = commands.reconcileCash(context, account.id, 790); assert.equal(comparison.expectedMinor, 800); assert.equal(comparison.differenceMinor, -10);
  assert.equal(queries.accounts(context).items.find(item => item.id === account.id)?.onHandMinor, 800);
  commands.adjustCashToCount(context, { accountId: account.id, countedMinor: 790, reason: "Confirmed drawer difference" });
  lockWorkspace(f.db); f.db.close(); databases.splice(databases.indexOf(f.db), 1);
  const reopened = openDatabase({ location }); databases.push(reopened); const next = await unlockWorkspace({ userId: f.installation.ownerId, secret }, { ...f.ports, database: reopened });
  assert.equal(queries.accounts(next).items.find(item => item.id === account.id)?.onHandMinor, 790);
  assert.equal(queries.productStock(next, p).onHandThousandths, 2000); assert.equal(queries.receipt(next, saleId).totalMinor, 2000);
  assert.equal(queries.statement(next, "customer", customer).items.length, 2);
  assert.equal(queries.purchases(next).items[0]?.totalMinor, 900); assert.equal(queries.expenses(next).items.length, 2);
});

it("bounded keyset catalogue handles duplicate names, archived rows, literal wildcards and no cross-shop records", async () => {
  const f = await fixture(); for (let index = 0; index < 35; index++) f.product("Duplicate"); f.product("50% rice"); f.product("50X rice");
  const one = queries.products(f.context), two = queries.products(f.context, { after: one.next! });
  assert.equal(one.items.length, 30); assert.equal(two.items.length, 7); assert.equal(two.next, undefined);
  assert.equal(new Set([...one.items, ...two.items].map(item => item.id)).size, 37);
  assert.equal(queries.products(f.context, { term: "50%" }).items.length, 1);
  const item = one.items[0]!; commands.saveProduct(f.context, { ...item, active: false, updatedAt: "2026-10-06T09:00:01.000Z" });
  assert.equal(queries.products(f.context, { includeInactive: true, limit: 100 }).items.length, 37);
  assert.equal(queries.products(f.context, { limit: 100 }).items.length, 36);
  for (const limit of [0, -1, 101, Infinity, 1.5]) assert.throws(() => queries.products(f.context, { limit }));
  assert.ok(f.db.all(`EXPLAIN QUERY PLAN SELECT id,name FROM products WHERE business_id=? AND active=1 AND (name,id)>(?,?) ORDER BY name,id LIMIT 31`, [f.context.businessId, "A", "x"]).some(row => String(row["detail"]).includes("products_operational_page")));
  const foreign = await fixture(); const foreignProduct = foreign.product();
  assert.equal(queries.products(f.context, { term: "Rice" }).items.length, 0);
  assert.throws(() => queries.productStock(f.context, foreignProduct)); assert.throws(() => queries.receipt(f.context, foreign.sale(foreignProduct)));
});

it("cashier can collect and view their receipts but cannot see another actor's receipt or balances; revocation and lock apply immediately", async () => {
  const f = await fixture(), p = f.product(), ownerSale = f.sale(p), cashierId = randomUUIDv7();
  f.db.run(`INSERT INTO users(id,business_id,name,role,created_at,updated_at) VALUES (?,?,'Cashier','CASHIER',?,?)`, [cashierId, f.context.businessId, at, at]);
  f.db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,'CASHIER')`, [f.context.businessId, cashierId, cashierId]);
  const context = await unlockWorkspace({ userId: cashierId, secret }, f.ports);
  assert.equal(queries.paymentAccounts(context).items.length, 1); assert.throws(() => queries.accounts(context));
  assert.equal(queries.receipts(context).items.length, 0); assert.throws(() => queries.receipt(context, ownerSale));
  const id = randomUUIDv7(); commands.completeSale(context, { id, number: id, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, name: "Rice", unitPriceMinor: 500, quantity: 1000 }], payments: [{ id: randomUUIDv7(), accountId: f.account.id, amountMinor: 500 }], occurredAt: at, eventId: randomUUIDv7() });
  assert.equal(queries.receipts(context).items[0]?.id, id); assert.equal(queries.receipt(context, id).paidMinor, 500);
  f.db.run(`UPDATE local_memberships SET revoked='["products.view"]' WHERE user_id=?`, [cashierId]); assert.throws(() => queries.products(context));
  assert.throws(() => commands.countStock(context, { productId: p, countedThousandths: 0, reason: "count" }));
  lockWorkspace(f.db); assert.throws(() => queries.receipts(context));
});

it("domain observers see one committed fan-out with correct balances; rollback and reader failures cannot create false sale failure", async () => {
  const f = await fixture(), p = f.product(); let calls = 0;
  const before = changeRevision(f.db, ["sales", "inventory", "accounts"]);
  const unsubscribe = subscribeChanges(f.db, ["sales", "inventory", "accounts"], () => { calls++; assert.equal(queries.receipts(f.context).items.length, 1); });
  const badObserver = subscribeChanges(f.db, ["sales"], () => { throw new Error("broken view"); });
  f.sale(p); assert.equal(calls, 1); assert.notEqual(changeRevision(f.db, ["sales", "inventory", "accounts"]), before);
  f.db.run(`CREATE TRIGGER fail_sale BEFORE INSERT ON sale_payments BEGIN SELECT RAISE(ABORT,'failpoint'); END`);
  const committed = changeRevision(f.db, ["sales", "inventory", "accounts"]); assert.throws(() => f.sale(p));
  assert.equal(calls, 1); assert.equal(changeRevision(f.db, ["sales", "inventory", "accounts"]), committed);
  assert.equal(queries.receipts(f.context).items.length, 1); unsubscribe(); badObserver();
});

it("stock count and cash correction validate whole units and roll back audit, events and effects on failure", async () => {
  const f = await fixture(), p = f.product();
  for (const countedThousandths of [-1000, 500, NaN, 1.1]) assert.throws(() => commands.countStock(f.context, { productId: p, countedThousandths, reason: "count" }));
  assert.throws(() => commands.countStock(f.context, { productId: p, countedThousandths: 1000, reason: " " }));
  const pending = f.db.get(`SELECT count(*) AS n FROM event_journal`)!["n"];
  assert.equal(commands.countStock(f.context, { productId: p, countedThousandths: 0, reason: "count" }), 0);
  assert.equal(f.db.get(`SELECT count(*) AS n FROM event_journal`)!["n"], pending);
  f.db.run(`CREATE TRIGGER fail_audit BEFORE INSERT ON local_audit WHEN NEW.action='CASH_RECONCILED' BEGIN SELECT RAISE(ABORT,'failpoint'); END`);
  assert.throws(() => commands.adjustCashToCount(f.context, { accountId: f.account.id, countedMinor: 100, reason: "initial count" }));
  assert.equal(queries.accounts(f.context).items[0]!.onHandMinor, 0); assert.equal(f.db.get(`SELECT count(*) AS n FROM event_journal`)!["n"], pending);
  assert.throws(() => commands.adjustStock(f.context, { id: randomUUIDv7(), productId: p, type: "ADJUSTMENT", quantity: 500, reason: "fraction", occurredAt: at }, randomUUIDv7()));
});

it("schema 18 upgrades forward preserving catalogue metadata, events and append-only history", async () => {
  const db = openDatabase(); databases.push(db); db.run(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT`);
  for (const migration of MIGRATIONS.filter(item => item.version <= 18)) db.transaction(tx => { for (const sql of migration.statements) tx.run(sql); tx.run(`INSERT INTO schema_migrations VALUES (?,?,?)`, [migration.version, migration.name, at]); });
  const shop = randomUUIDv7(), category = randomUUIDv7(); db.run(`INSERT INTO businesses(id,name,currency,created_at,updated_at) VALUES (?,'Legacy','XAF',?,?)`, [shop, at, at]);
  db.run(`INSERT INTO categories(id,business_id,name,created_at,updated_at) VALUES (?,?,'Legacy category',?,?)`, [category, shop, at, at]);
  assert.deepEqual(migrate(db).applied.map(item => item.version), [19, 20]); assert.equal(db.get(`SELECT name FROM categories`)!["name"], "Legacy category");
  assert.equal(db.get(`SELECT updated_by_device FROM categories`)!["updated_by_device"], null);
});

it("partial discounted sale returns compensate stock, customer credit and cash exactly and never edit originals", async () => {
  const { previewReturn, returnSale } = await import("./returns.ts"); const { salesBetween, profitBetween } = await import("./reports.ts");
  const f = await fixture(), p = f.product(), customer = randomUUIDv7(), saleId = randomUUIDv7(), itemId = randomUUIDv7();
  commands.saveCustomer(f.context,{id:customer,name:"Buyer",active:true,createdAt:at,updatedAt:at});
  commands.completeSale(f.context,{ id:saleId,number:saleId,customerId:customer,creditTransactionId:randomUUIDv7(),discountMinor:1,
    lines:[{id:itemId,movementId:randomUUIDv7(),productId:p,name:"Rice",unitPriceMinor:500,unitCostMinor:300,quantity:3000}],payments:[{id:randomUUIDv7(),accountId:f.account.id,amountMinor:500}],occurredAt:at,eventId:randomUUIDv7() });
  const original = f.db.get(`SELECT * FROM sales WHERE id=?`,[saleId]);
  for (const [index,expected] of [500,499,500].entries()) {
    const preview=previewReturn(f.context,"SALE",saleId,[{originalItemId:itemId,quantity:1000}]); assert.equal(preview.totalMinor,expected);
    const input={ id:randomUUIDv7(),eventId:randomUUIDv7(),originalId:saleId,priorId:preview.source.priorId,reason:"Returned goods",
      items:[{id:randomUUIDv7(),movementId:randomUUIDv7(),originalItemId:itemId,quantity:1000}],refunds:index===2?[{id:randomUUIDv7(),accountId:f.account.id,amountMinor:500}]:[],debtTransactionId:index===2?undefined:randomUUIDv7() };
    returnSale(f.context,input); assert.throws(()=>returnSale(f.context,{...input,id:randomUUIDv7(),eventId:randomUUIDv7()}));
  }
  assert.deepEqual(f.db.get(`SELECT * FROM sales WHERE id=?`,[saleId]),original); assert.equal(queries.productStock(f.context,p).onHandThousandths,0);
  assert.equal(queries.personBalance(f.context,"customer",customer),0); assert.equal(queries.accounts(f.context).items[0]!.onHandMinor,0);
  assert.equal(salesBetween(f.context,at,"2026-10-07T00:00:00.000Z").totalMinor,0); assert.equal(profitBetween(f.context,at,"2026-10-07T00:00:00.000Z").grossProfitMinor,0);
  assert.throws(()=>previewReturn(f.context,"SALE",saleId,[{originalItemId:itemId,quantity:1000}]));
  assert.throws(()=>f.db.run(`DELETE FROM business_returns`)); assert.throws(()=>f.db.run(`UPDATE business_return_items SET quantity=1`));
});

it("purchase returns receive cash and reduce payable debt; malformed or failed fan-out rolls back completely",async()=>{
  const { previewReturn,returnPurchase,returnSale }=await import("./returns.ts");const f=await fixture(),p=f.product(),supplier=randomUUIDv7(),purchaseId=randomUUIDv7(),itemId=randomUUIDv7();
  commands.saveSupplier(f.context,{id:supplier,name:"Supplier",active:true,createdAt:at,updatedAt:at});
  commands.recordPurchase(f.context,{id:purchaseId,supplierId:supplier,supplierTransactionId:randomUUIDv7(),lines:[{id:itemId,movementId:randomUUIDv7(),productId:p,unitCostMinor:300,quantity:2000}],payments:[{id:randomUUIDv7(),accountId:f.account.id,amountMinor:100,reason:"Delivery"}],occurredAt:at,eventId:randomUUIDv7()});
  const preview=previewReturn(f.context,"PURCHASE",purchaseId,[{originalItemId:itemId,quantity:2000}]);assert.equal(preview.totalMinor,600);
  const input={id:randomUUIDv7(),eventId:randomUUIDv7(),originalId:purchaseId,reason:"Cancelled delivery",items:[{id:randomUUIDv7(),movementId:randomUUIDv7(),originalItemId:itemId,quantity:2000}],refunds:[{id:randomUUIDv7(),accountId:f.account.id,amountMinor:100}],debtTransactionId:randomUUIDv7()};
  f.db.run(`CREATE TRIGGER fail_return BEFORE INSERT ON supplier_transactions WHEN NEW.type='RETURN' BEGIN SELECT RAISE(ABORT,'failpoint'); END`);
  assert.throws(()=>returnPurchase(f.context,input));assert.equal(f.db.get(`SELECT count(*) AS n FROM business_returns`)!["n"],0);assert.equal(queries.productStock(f.context,p).onHandThousandths,2000);
  f.db.run(`DROP TRIGGER fail_return`);returnPurchase(f.context,input);assert.equal(queries.personBalance(f.context,"supplier",supplier),0);assert.equal(queries.accounts(f.context).items[0]!.onHandMinor,0);assert.equal(queries.productStock(f.context,p).onHandThousandths,0);
  assert.throws(()=>returnSale(f.context,{...input,id:randomUUIDv7(),eventId:randomUUIDv7()}));
});


it("report-only capabilities read bounded debts and negative-stock alerts, including archived counterparties",async()=>{
  const f=await fixture(),p=f.product(),customer=randomUUIDv7();commands.saveCustomer(f.context,{id:customer,name:"Buyer",active:true,createdAt:at,updatedAt:at});
  commands.completeSale(f.context,{id:randomUUIDv7(),number:randomUUIDv7(),customerId:customer,creditTransactionId:randomUUIDv7(),lines:[{id:randomUUIDv7(),movementId:randomUUIDv7(),productId:p,name:"Rice",unitPriceMinor:500,quantity:1000}],payments:[],occurredAt:at,eventId:randomUUIDv7()});
  commands.saveCustomer(f.context,{id:customer,name:"Buyer",active:false,createdAt:at,updatedAt:"2026-10-06T09:01:00.000Z"});
  f.db.run(`UPDATE local_memberships SET revoked='["customers.view"]' WHERE user_id=?`,[f.context.userId]);
  assert.throws(()=>queries.customers(f.context));assert.equal(queries.debtPage(f.context,"customer",{limit:1}).items[0]?.amountMinor,500);
  assert.equal(queries.stockAlertPage(f.context,{limit:1}).items[0]?.quantity,-1000);
});
