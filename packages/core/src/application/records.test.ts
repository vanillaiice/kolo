import assert from "node:assert/strict";
import { closeConsistent } from "../data/database/integrity.ts";
import { afterEach, it } from "node:test";
import { createHash, generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import type { Database } from "../data/database/driver.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import { subscribeChanges } from "../data/database/changes.ts";
import { createWorkspace, unlockWorkspace, lockWorkspace } from "../identity/workspace.ts";
import { WorkspaceError, type WorkspacePorts } from "../identity/types.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";
import * as records from "./records.ts";
import { productPhotoDigests, setProductPhoto } from "./photos.ts";
import { analyticsView, reportView, REPORT_KINDS, REPORT_PERMISSION, UNDATED_REPORT_KINDS } from "./report-views.ts";

const at = "2026-10-06T09:00:00.000Z", secret = "fixture-secret", day = { from: "2026-10-06T00:00:00.000Z", until: "2026-10-07T00:00:00.000Z" };
const databases: Database[] = [];
afterEach(() => { closeConsistent(databases.splice(0)); });
async function fixture() {
  const db = openDatabase(); databases.push(db); migrate(db);
  const material = { publicKey: generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, now: () => at, newId: randomUUIDv7, credentials: { provision: async () => material, inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "ANDROID", currency: "XAF", secret }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const account = queries.paymentAccounts(context).items[0]!;
  const product = (name: string, categoryId?: string): string => {
    const id = randomUUIDv7(); commands.saveProduct(context, { id, name, unit: "unit", currency: "XAF", sellingPriceMinor: 500, purchasePriceMinor: 300, taxRateBasisPoints: 0, minimumStock: 0, divisible: false, categoryId, active: true, createdAt: at, updatedAt: at }); return id;
  };
  const cashier = async () => {
    const id = randomUUIDv7();
    db.run(`INSERT INTO users(id,business_id,name,role,created_at,updated_at) VALUES (?,?,'Cashier','CASHIER',?,?)`, [id, context.businessId, at, at]);
    db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,'CASHIER')`, [context.businessId, id, id]);
    return { id, context: await unlockWorkspace({ userId: id, secret }, ports) };
  };
  return { db, ports, context, account, product, cashier };
}
const sell = (context: Parameters<typeof commands.completeSale>[0], productId: string, accountId: string, quantity = 1000): string => {
  const id = randomUUIDv7();
  commands.completeSale(context, { id, number: id, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId, name: "Line", unitPriceMinor: 500, quantity }], payments: [{ id: randomUUIDv7(), accountId, amountMinor: 500 * quantity / 1000 }], occurredAt: at, eventId: randomUUIDv7() });
  return id;
};

it("single-record reads stay inside the shop and their permission; absent IDs read as undefined", async () => {
  const f = await fixture(), p = f.product("Rice"), customer = randomUUIDv7(), supplier = randomUUIDv7();
  commands.saveCustomer(f.context, { id: customer, name: "Buyer", creditLimitMinor: 5000, active: true, createdAt: at, updatedAt: at });
  commands.saveSupplier(f.context, { id: supplier, name: "Wholesaler", active: true, createdAt: at, updatedAt: at });
  assert.equal(records.product(f.context, p)?.name, "Rice");
  assert.equal(records.product(f.context, randomUUIDv7()), undefined);
  assert.equal(records.customer(f.context, customer)?.creditLimitMinor, 5000);
  assert.equal(records.customer(f.context, customer)?.outstandingMinor, 0);
  assert.equal(records.supplier(f.context, supplier)?.outstandingMinor, 0);
  assert.equal(records.account(f.context, f.account.id)?.onHandMinor, 0);
  const other = await fixture();
  assert.equal(records.product(other.context, p), undefined, "another shop's product is invisible");
  assert.equal(records.customer(other.context, customer), undefined);
  const { id: cashierId, context: cashier } = await f.cashier();
  assert.equal(records.product(cashier, p)?.id, p);
  assert.equal(records.customer(cashier, customer)?.id, customer, "cashiers choose customers at the till");
  assert.throws(() => records.supplier(cashier, supplier), (error: unknown) => error instanceof WorkspaceError && error.code === "permission_denied");
  f.db.run(`UPDATE local_memberships SET granted='["cash.move"]', revoked='["finance.accounts.view","cash.view"]' WHERE user_id=?`, [cashierId]);
  const moved = records.account(cashier, f.account.id);
  assert.equal(moved?.id, f.account.id); assert.equal(moved?.onHandMinor, undefined, "cash.move alone reads the account without its balance");
  f.db.run(`UPDATE local_memberships SET granted='[]', revoked='["cash.move","finance.accounts.view","cash.view"]' WHERE user_id=?`, [cashierId]);
  assert.throws(() => records.account(cashier, f.account.id), (error: unknown) => error instanceof WorkspaceError && error.code === "permission_denied");
  lockWorkspace(f.db);
  assert.throws(() => records.product(f.context, p));
});

it("purchase detail derives door payment, payable and returned value; expense detail links reversals", async () => {
  const f = await fixture(), p = f.product("Oil"), supplier = randomUUIDv7(), purchaseId = randomUUIDv7();
  commands.saveSupplier(f.context, { id: supplier, name: "Wholesaler", active: true, createdAt: at, updatedAt: at });
  commands.recordPurchase(f.context, { id: purchaseId, supplierId: supplier, supplierTransactionId: randomUUIDv7(), reference: "BL-7",
    lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, quantity: 4000, unitCostMinor: 300 }],
    payments: [{ id: randomUUIDv7(), accountId: f.account.id, amountMinor: 500, reason: "door" }], occurredAt: at, eventId: randomUUIDv7() });
  const detail = records.purchase(f.context, purchaseId)!;
  assert.deepEqual([detail.totalMinor, detail.paidMinor, detail.outstandingMinor, detail.returnedMinor, detail.reference, detail.lines[0]?.name], [1200, 500, 700, 0, "BL-7", "Oil"]);
  assert.equal(records.purchase(f.context, randomUUIDv7()), undefined);
  const expenseId = randomUUIDv7(), reversalId = randomUUIDv7();
  commands.recordExpense(f.context, { id: expenseId, category: "TRANSPORT", accountId: f.account.id, amountMinor: 100, description: "Taxi", occurredAt: at, eventId: randomUUIDv7() });
  assert.equal(records.expense(f.context, expenseId)?.reversedBy, undefined);
  commands.recordExpense(f.context, { id: reversalId, category: "TRANSPORT", accountId: f.account.id, amountMinor: -100, reversesId: expenseId, occurredAt: at, eventId: randomUUIDv7() });
  assert.equal(records.expense(f.context, expenseId)?.reversedBy, reversalId);
  assert.equal(records.expense(f.context, reversalId)?.reversesId, expenseId);
  assert.equal(records.expense(f.context, expenseId)?.description, "Taxi");
  const { context: cashier } = await f.cashier();
  assert.throws(() => records.purchase(cashier, purchaseId)); assert.throws(() => records.expense(cashier, expenseId));
});

it("batched stock and photo reads match per-row reads, ignore foreign IDs and are bounded", async () => {
  const f = await fixture(), a = f.product("A"), b = f.product("B"), c = f.product("C");
  sell(f.context, a, f.account.id, 3000);
  commands.adjustStock(f.context, { id: randomUUIDv7(), productId: b, type: "ADJUSTMENT", quantity: 2000, reason: "found", occurredAt: at }, randomUUIDv7());
  const other = await fixture(), foreign = other.product("Foreign");
  const levels = queries.stockLevels(f.context, [a, b, c, foreign, randomUUIDv7()]);
  assert.deepEqual([...levels.entries()].sort(), [[a, -3000], [b, 2000], [c, 0]].sort());
  for (const id of [a, b, c]) assert.equal(levels.get(id), queries.productStock(f.context, id).onHandThousandths);
  assert.equal(queries.stockLevels(f.context, []).size, 0);
  assert.throws(() => queries.stockLevels(f.context, Array.from({ length: 101 }, () => a)), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_input");
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 16, 0, 16, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  const crypto = { sha256Bytes: async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex") };
  let notified = 0; const unsubscribe = subscribeChanges(f.db, ["products"], () => { notified++; });
  const { digest } = await setProductPhoto(f.context, { productId: b, bytes: jpeg }, crypto);
  unsubscribe();
  assert.ok(notified >= 1, "a photo write invalidates product views");
  assert.deepEqual([...productPhotoDigests(f.context, [a, b, foreign]).entries()], [[b, digest]]);
  assert.throws(() => productPhotoDigests(f.context, Array.from({ length: 101 }, () => a)));
});

it("catalogue pages filter by category without leaking other categories or shops", async () => {
  const f = await fixture(), drinks = randomUUIDv7(), food = randomUUIDv7();
  commands.saveCategory(f.context, { id: drinks, name: "Drinks", active: true, createdAt: at, updatedAt: at });
  commands.saveCategory(f.context, { id: food, name: "Food", active: true, createdAt: at, updatedAt: at });
  const water = f.product("Water", drinks), soda = f.product("Soda", drinks); f.product("Bread", food); f.product("Loose");
  assert.deepEqual(queries.products(f.context, { categoryId: drinks }).items.map(item => item.id).sort(), [water, soda].sort());
  assert.deepEqual(queries.products(f.context, { categoryId: drinks, term: "wa" }).items.map(item => item.id), [water]);
  const first = queries.products(f.context, { categoryId: drinks, limit: 1 });
  assert.equal(queries.products(f.context, { categoryId: drinks, limit: 1, after: first.next! }).items.length, 1);
  assert.equal(queries.products(f.context, { categoryId: randomUUIDv7() }).items.length, 0);
  assert.throws(() => queries.customers(f.context, { categoryId: drinks }), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_input");
});

it("report and analytics views bound rows, keep totals exact, refuse bad input and omit unauthorized sections", async () => {
  const f = await fixture(), products = Array.from({ length: 12 }, (_, index) => f.product(`P${String(index).padStart(2, "0")}`));
  for (const id of products) sell(f.context, id, f.account.id);
  const full = reportView(f.context, "salesByProduct", day.from, day.until), capped = reportView(f.context, "salesByProduct", day.from, day.until, { rows: 5 });
  assert.ok(full.kind === "salesByProduct" && capped.kind === "salesByProduct");
  if (full.kind === "salesByProduct" && capped.kind === "salesByProduct") {
    assert.equal(full.lines.length, 12); assert.equal(full.truncated, false);
    assert.equal(capped.lines.length, 5); assert.equal(capped.truncated, true);
    assert.deepEqual(capped.lines, full.lines.slice(0, 5));
  }
  const summary = reportView(f.context, "sales", day.from, day.until);
  assert.ok(summary.kind === "sales" && summary.totalMinor === 6000 && summary.transactions === 12);
  for (const kind of REPORT_KINDS) assert.equal(reportView(f.context, kind, day.from, day.until, { rows: 3 }).kind, kind);
  for (const bad of [{ from: day.until, until: day.from }, { from: day.from, until: day.from }, { from: "2000-01-01T00:00:00.000Z", until: day.until }, { from: "nonsense", until: day.until }])
    assert.throws(() => reportView(f.context, "sales", bad.from, bad.until), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_input");
  for (const rows of [0, 501, 1.5]) assert.throws(() => reportView(f.context, "sales", day.from, day.until, { rows }));
  // Present-state reports ignore the period: mobile asked for them from 1970, which a dated report refuses.
  for (const kind of REPORT_KINDS) {
    const since1970 = (): unknown => reportView(f.context, kind, new Date(0).toISOString(), day.until, { rows: 3 });
    if (UNDATED_REPORT_KINDS.has(kind)) assert.deepEqual(since1970(), reportView(f.context, kind, day.from, day.until, { rows: 3 }), kind);
    else assert.throws(since1970, (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_input", kind);
  }
  assert.throws(() => reportView(f.context, "unknown" as never, day.from, day.until));

  const owner = analyticsView(f.context, { from: day.from, until: day.until, offsetMinutes: 60 }, { rows: 4 });
  assert.equal(owner.products.length, 4); assert.equal(owner.productsTruncated, true);
  assert.equal(owner.sales.revenueMinor, 6000); assert.ok(owner.profit !== undefined); assert.ok(owner.customers !== undefined);
  assert.equal(owner.trend.reduce((sum, point) => sum + point.revenueMinor, 0), 6000);
  assert.throws(() => analyticsView(f.context, { from: day.from, until: day.until, offsetMinutes: 900 }));
  assert.throws(() => analyticsView(f.context, { from: day.from, until: day.until, offsetMinutes: 0, bucket: "minute" as never }));

  const { id: cashierId, context: cashier } = await f.cashier();
  assert.throws(() => analyticsView(cashier, { from: day.from, until: day.until, offsetMinutes: 0 }));
  f.db.run(`UPDATE local_memberships SET granted='["reports.sales"]' WHERE user_id=?`, [cashierId]);
  const sales = analyticsView(cashier, { from: day.from, until: day.until, offsetMinutes: 0 });
  assert.equal(sales.profit, undefined); assert.equal(sales.customers, undefined); assert.equal(sales.previous.grossProfitMinor, undefined);
  assert.ok(sales.trend.every(point => point.grossProfitMinor === undefined)); assert.ok(sales.products.every(item => item.grossProfitMinor === undefined));
  for (const kind of REPORT_KINDS) {
    if (REPORT_PERMISSION[kind] === "reports.sales") assert.doesNotThrow(() => reportView(cashier, kind, day.from, day.until));
    else assert.throws(() => reportView(cashier, kind, day.from, day.until), (error: unknown) => error instanceof WorkspaceError && error.code === "permission_denied", kind);
  }
});

it("word search finds any word, ignores accents and case, keeps operators inert and follows edits", async () => {
  const f = await fixture(), rice = f.product("Sac de riz parfumé 25kg"), oil = f.product("Huile Végétale"), supplier = randomUUIDv7(), customer = randomUUIDv7();
  commands.saveSupplier(f.context, { id: supplier, name: "Grossiste Mbarga", phone: "699001122", contact: "Aïcha Ngono", active: true, createdAt: at, updatedAt: at });
  commands.saveCustomer(f.context, { id: customer, name: "Boutique du Marché", phone: "677123456", active: true, createdAt: at, updatedAt: at });
  const names = (term: string): string[] => queries.products(f.context, { term }).items.map(item => item.id);
  assert.deepEqual(names("riz"), [rice], "a word in the middle of the name");
  assert.deepEqual(names("PARFUME"), [rice], "case and accents are ignored");
  assert.deepEqual(names("sac parf"), [rice], "every word must match, the last as a prefix");
  assert.deepEqual(names("vege"), [oil]);
  assert.deepEqual(names("Sac"), [rice], "the name prefix search still works");
  assert.deepEqual(names("riz huile"), [], "all words must match");
  for (const hostile of ['"', "riz OR huile", "text:riz", "*", "NEAR(riz huile)", "riz)", "-riz"]) assert.doesNotThrow(() => names(hostile), hostile);
  assert.deepEqual(names("riz OR huile"), [], "operators are words, not syntax");
  assert.deepEqual(queries.suppliers(f.context, { term: "aicha" }).items.map(item => item.id), [supplier], "supplier contact");
  assert.deepEqual(queries.customers(f.context, { term: "marche" }).items.map(item => item.id), [customer], "customer name word");
  const stored = records.product(f.context, rice)!;
  commands.saveProduct(f.context, { ...stored, name: "Sac de mil", updatedAt: "2026-10-06T10:00:00.000Z" });
  assert.deepEqual(names("riz"), [], "an edit removes the old words"); assert.deepEqual(names("mil"), [rice]);
  const other = await fixture(); other.product("Riz local");
  assert.equal(queries.products(f.context, { term: "local" }).items.length, 0, "another shop's products never match");
});

it("statements carry the exact running balance after each entry, oldest first, across pages", async () => {
  const f = await fixture(), p = f.product("Rice"), customer = randomUUIDv7();
  commands.saveCustomer(f.context, { id: customer, name: "Buyer", active: true, createdAt: at, updatedAt: at });
  const times = ["2026-10-06T08:00:00.000Z", "2026-10-06T08:30:00.000Z", "2026-10-06T08:45:00.000Z"];
  for (const time of times.slice(0, 2)) {
    const id = randomUUIDv7();
    commands.completeSale(f.context, { id, number: id, customerId: customer, creditTransactionId: randomUUIDv7(), occurredAt: time, eventId: randomUUIDv7(),
      lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, name: "Rice", unitPriceMinor: 500, quantity: 1000 }], payments: [] });
  }
  commands.receiveCustomerPayment(f.context, { id: randomUUIDv7(), customerId: customer, accountId: f.account.id, amountMinor: 700, occurredAt: times[2]!, eventId: randomUUIDv7() });
  const first = queries.statement(f.context, "customer", customer, { limit: 2 }), second = queries.statement(f.context, "customer", customer, { limit: 2, after: first.next! });
  assert.deepEqual([...first.items, ...second.items].map(row => [row["amount_minor"], row["balance_minor"]]), [[-700, 300], [500, 1000], [500, 500]]);
  assert.equal(first.items[0]!["balance_minor"], queries.personBalance(f.context, "customer", customer));
});
