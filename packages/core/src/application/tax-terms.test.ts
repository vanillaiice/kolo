import assert from "node:assert/strict";
import { closeConsistent } from "../data/database/integrity.ts";
import { afterEach, it } from "node:test";
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import type { Database } from "../data/database/driver.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate, MIGRATIONS } from "../data/database/migrations.ts";
import { sanitizeSnapshot } from "../backup/snapshot.ts";
import { createWorkspace, unlockWorkspace } from "../identity/workspace.ts";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "../identity/types.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";
import * as settings from "./settings.ts";
import * as reports from "./reports.ts";
import { reportView } from "./report-views.ts";
import { previewReturn, returnSale } from "./returns.ts";

const at = "2026-10-06T09:00:00.000Z", secret = "fixture-secret", period = { from: "2026-01-01T00:00:00.000Z", until: "2026-12-31T00:00:00.000Z" };
const days = (n: number): string => new Date(Date.parse(at) - n * 86_400_000).toISOString();
const databases: Database[] = [];
afterEach(() => { closeConsistent(databases.splice(0)); });
const denied = (code: string) => (error: unknown): boolean => error instanceof WorkspaceError && error.code === code;

async function fixture() {
  const db = openDatabase(); databases.push(db); migrate(db);
  const material = { publicKey: generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, now: () => at, newId: randomUUIDv7, credentials: { provision: async () => material, inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "ANDROID", currency: "XAF", secret }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const account = queries.paymentAccounts(context).items[0]!.id;
  const product = (name: string, price = 11925): string => {
    const id = randomUUIDv7(); commands.saveProduct(context, { id, name, unit: "unit", currency: "XAF", sellingPriceMinor: price, purchasePriceMinor: 100, taxRateBasisPoints: 0, minimumStock: 0, divisible: false, active: true, createdAt: at, updatedAt: at }); return id;
  };
  const cashier = async (): Promise<OperationContext> => {
    const id = randomUUIDv7();
    db.run(`INSERT INTO users(id,business_id,name,role,created_at,updated_at) VALUES (?,?,'Cashier','CASHIER',?,?)`, [id, context.businessId, at, at]);
    db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,'CASHIER')`, [context.businessId, id, id]);
    return unlockWorkspace({ userId: id, secret }, ports);
  };
  const events = (type: string): number => Number(db.get(`SELECT count(*) AS n FROM event_journal WHERE event_type=?`, [type])!["n"]);
  /** One session at a time: unlocking someone else locks the previous context. */
  const owner = (): Promise<OperationContext> => unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  return { db, context, account, product, cashier, events, owner };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function sell(f: Fixture, lines: readonly { productId: string; price?: number; quantity?: number; rate?: number }[], options: { discountMinor?: number; customerId?: string; paid?: number; occurredAt?: string } = {}): { saleId: string; lineIds: string[] } {
  const saleId = randomUUIDv7(), lineIds = lines.map(() => randomUUIDv7());
  const cart = lines.map((line, index) => ({ id: lineIds[index]!, movementId: randomUUIDv7(), productId: line.productId, name: "Line", unitPriceMinor: line.price ?? 11925, quantity: line.quantity ?? 1000, taxRateBasisPoints: line.rate }));
  const total = cart.reduce((sum, line) => sum + Math.round(line.unitPriceMinor * line.quantity / 1000), 0) - (options.discountMinor ?? 0), paid = options.paid ?? total;
  commands.completeSale(f.context, { id: saleId, number: saleId, lines: cart, discountMinor: options.discountMinor, customerId: options.customerId, occurredAt: options.occurredAt ?? at, eventId: randomUUIDv7(),
    payments: paid > 0 ? [{ id: randomUUIDv7(), accountId: f.account, amountMinor: paid }] : [], ...(paid < total ? { creditTransactionId: randomUUIDv7() } : {}) });
  return { saleId, lineIds };
}
const rates = (f: Fixture, saleId: string): number[] => f.db.all(`SELECT tax_rate_basis_points AS r FROM sale_items WHERE sale_id=? ORDER BY id`, [saleId]).map(row => Number(row["r"]));

it("tax is off until enabled; then each line carries its product's rule, frozen at the time of sale", async () => {
  const f = await fixture(), standard = f.product("Soap"), exempt = f.product("Rice"), own = f.product("Medicine");
  assert.deepEqual(settings.shopTaxSettings(f.context), { enabled: false, label: "TVA", standardRateBasisPoints: 1925 });
  const before = sell(f, [{ productId: standard, rate: 1925 }]);
  assert.deepEqual(rates(f, before.saleId), [0], "a caller's rate is ignored while tax is off");
  assert.equal(queries.receipt(f.context, before.saleId).tax, undefined);

  assert.equal(commands.setTaxSettings(f.context, { enabled: true, label: "TVA", standardRateBasisPoints: 1925, registration: "M012345678901A", updatedAt: days(-1) }), true);
  assert.equal(commands.setProductTaxRule(f.context, { productId: exempt, rule: "EXEMPT", updatedAt: at }), true);
  assert.equal(commands.setProductTaxRule(f.context, { productId: own, rule: "RATE", rateBasisPoints: 550, updatedAt: at }), true);
  assert.deepEqual(settings.productTax(f.context, own), { rule: "RATE", rateBasisPoints: 550, updatedAt: at, effectiveRateBasisPoints: 550 });
  assert.deepEqual(settings.productTax(f.context, standard), { rule: "STANDARD", effectiveRateBasisPoints: 1925 });
  assert.equal(f.events("TAX_SETTINGS_SET"), 1); assert.equal(f.events("PRODUCT_TAX_SET"), 2);

  const after = sell(f, [{ productId: standard, rate: 9999 }, { productId: exempt }, { productId: own, price: 1055 }]);
  assert.deepEqual(rates(f, after.saleId).sort(), [0, 1925, 550].sort());
  const journal = JSON.parse(String(f.db.get(`SELECT canonical FROM event_journal WHERE event_type='SALE_COMPLETED' ORDER BY origin_sequence DESC LIMIT 1`)!["canonical"]));
  assert.deepEqual(journal.payload.sale.items.map((item: { tax_rate_basis_points?: number }) => item.tax_rate_basis_points ?? 0).sort(), [0, 1925, 550].sort(), "the frozen rate travels with the sale");
  const receipt = queries.receipt(f.context, after.saleId);
  assert.deepEqual(receipt.tax, { label: "TVA", registration: "M012345678901A", groups: [
    { rateBasisPoints: 1925, grossMinor: 11925, taxMinor: 1925, netMinor: 10000 },
    { rateBasisPoints: 550, grossMinor: 1055, taxMinor: 55, netMinor: 1000 },
  ] });

  // A new standard rate applies to new sales only.
  assert.equal(commands.setTaxSettings(f.context, { enabled: true, label: "VAT", standardRateBasisPoints: 1000, updatedAt: days(-2) }), true);
  assert.deepEqual(rates(f, after.saleId).sort(), [0, 1925, 550].sort());
  assert.deepEqual(rates(f, sell(f, [{ productId: standard }]).saleId), [1000]);
  assert.equal(queries.receipt(f.context, after.saleId).tax?.label, "VAT", "receipts print the current label");
  assert.equal(queries.receipt(f.context, after.saleId).tax?.registration, undefined);
  assert.equal(commands.setProductTaxRule(f.context, { productId: exempt, rule: "STANDARD", updatedAt: days(-3) }), true);
  assert.deepEqual(rates(f, sell(f, [{ productId: exempt }]).saleId), [1000]);
  commands.setTaxSettings(f.context, { enabled: false, label: "VAT", standardRateBasisPoints: 1000, updatedAt: days(-4) });
  assert.deepEqual(rates(f, sell(f, [{ productId: own }]).saleId), [0], "switching tax off zeroes even products with their own rate");
});

it("tax settings and rules are last-write-wins, validated and permission-checked, and refusals write nothing", async () => {
  const f = await fixture(), p = f.product("Soap");
  assert.equal(commands.setTaxSettings(f.context, { enabled: true, label: "TVA", standardRateBasisPoints: 1925, updatedAt: at }), true);
  assert.equal(commands.setTaxSettings(f.context, { enabled: false, label: "TVA", standardRateBasisPoints: 0, updatedAt: days(1) }), false, "an older edit loses");
  assert.equal(settings.shopTaxSettings(f.context).enabled, true);
  assert.equal(f.events("TAX_SETTINGS_SET"), 1, "a losing edit emits no event");
  const invalid = [
    () => commands.setTaxSettings(f.context, { enabled: true, label: "", standardRateBasisPoints: 1925, updatedAt: days(-1) }),
    () => commands.setTaxSettings(f.context, { enabled: true, label: "A label far too long here", standardRateBasisPoints: 1925, updatedAt: days(-1) }),
    () => commands.setTaxSettings(f.context, { enabled: true, label: " TVA", standardRateBasisPoints: 1925, updatedAt: days(-1) }),
    () => commands.setTaxSettings(f.context, { enabled: true, label: "TVA", standardRateBasisPoints: 10001, updatedAt: days(-1) }),
    () => commands.setTaxSettings(f.context, { enabled: true, label: "TVA", standardRateBasisPoints: 1925, registration: "", updatedAt: days(-1) }),
    () => commands.setTaxSettings(f.context, { enabled: true, label: "TVA", standardRateBasisPoints: 1925, updatedAt: "yesterday" }),
    () => commands.setProductTaxRule(f.context, { productId: p, rule: "RATE", rateBasisPoints: 0, updatedAt: days(-1) }),
    () => commands.setProductTaxRule(f.context, { productId: p, rule: "RATE", rateBasisPoints: 10001, updatedAt: days(-1) }),
    () => commands.setProductTaxRule(f.context, { productId: p, rule: "BOTH" as "EXEMPT", updatedAt: days(-1) }),
  ];
  for (const attempt of invalid) assert.throws(attempt, denied("invalid_input"));
  assert.throws(() => commands.setProductTaxRule(f.context, { productId: randomUUIDv7(), rule: "EXEMPT", updatedAt: at }), denied("scope_mismatch"));
  const cashier = await f.cashier();
  assert.throws(() => commands.setTaxSettings(cashier, { enabled: false, label: "TVA", standardRateBasisPoints: 0, updatedAt: days(-5) }), denied("permission_denied"));
  assert.throws(() => commands.setProductTaxRule(cashier, { productId: p, rule: "EXEMPT", updatedAt: days(-5) }), denied("permission_denied"));
  assert.equal(settings.shopTaxSettings(cashier).enabled, true, "any member reads the settings tills need");
  assert.throws(() => reportView(cashier, "tax", period.from, period.until), denied("permission_denied"));
  assert.equal(f.db.get(`SELECT count(*) AS n FROM product_tax_rules`)!["n"], 0);
  assert.equal(f.events("PRODUCT_TAX_SET"), 0);
  // A rule written at the same instant from a lower device ID loses; the database keeps the constraint too.
  assert.throws(() => f.db.run(`INSERT INTO product_tax_rules(id,business_id,rule,rate_basis_points,updated_at,updated_by_device) VALUES (?,?,'RATE',NULL,?,?)`, [p, f.context.businessId, at, "x"]));
  assert.throws(() => f.db.run(`INSERT INTO shop_tax_settings(id,business_id,enabled,label,standard_rate_basis_points,updated_at,updated_by_device) VALUES ('other',?,1,'TVA',1,?,?)`, [f.context.businessId, at, "x"]));
});

it("the tax report groups a period's sales by rate net of bill discounts and returns, and adds up to net sales", async () => {
  const f = await fixture(), standard = f.product("Soap"), exempt = f.product("Rice", 5000), own = f.product("Medicine", 2110);
  commands.setTaxSettings(f.context, { enabled: true, label: "TVA", standardRateBasisPoints: 1925, updatedAt: at });
  commands.setProductTaxRule(f.context, { productId: exempt, rule: "EXEMPT", updatedAt: at });
  commands.setProductTaxRule(f.context, { productId: own, rule: "RATE", rateBasisPoints: 550, updatedAt: at });
  sell(f, [{ productId: standard }, { productId: exempt, price: 5000 }]);
  const discounted = sell(f, [{ productId: standard, quantity: 2000 }, { productId: own, price: 2110 }, { productId: exempt, price: 5000, quantity: 3000 }], { discountMinor: 1237 });
  const preview = previewReturn(f.context, "SALE", discounted.saleId, [{ originalItemId: discounted.lineIds[0]!, quantity: 1000 }]);
  returnSale(f.context, { id: randomUUIDv7(), eventId: randomUUIDv7(), originalId: discounted.saleId, reason: "Damaged", items: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), originalItemId: discounted.lineIds[0]!, quantity: 1000 }],
    refunds: [{ id: randomUUIDv7(), accountId: f.account, amountMinor: preview.totalMinor }] });
  const report = reportView(f.context, "tax", period.from, period.until);
  assert.equal(report.kind, "tax");
  if (report.kind !== "tax") return;
  assert.equal(report.grossMinor, reports.salesBetween(f.context, period.from, period.until).totalMinor, "gross equals net sales");
  assert.equal(report.grossMinor, report.netMinor + report.taxMinor);
  assert.deepEqual(report.groups.map(group => group.rateBasisPoints), [1925, 550, 0]);
  for (const group of report.groups) assert.equal(group.taxMinor, Number((BigInt(group.grossMinor) * BigInt(group.rateBasisPoints) * 2n + 10000n + BigInt(group.rateBasisPoints)) / (2n * (10000n + BigInt(group.rateBasisPoints)))));
  assert.equal(report.groups[2]!.taxMinor, 0);
  // Receipts of the discounted sale add up to its total, and an empty period reports nothing.
  const receipt = queries.receipt(f.context, discounted.saleId);
  const exemptShare = receipt.totalMinor - receipt.tax!.groups.reduce((sum, group) => sum + group.grossMinor, 0);
  assert.ok(exemptShare > 0 && exemptShare < 15000);
  const empty = reportView(f.context, "tax", "2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z");
  assert.deepEqual(empty, { kind: "tax", label: "TVA", grossMinor: 0, taxMinor: 0, netMinor: 0, groups: [] });
});

it("payment terms fall back party → shop → 30 days and age credit oldest-first under the current terms", async () => {
  const f = await fixture(), p = f.product("Rice", 1000), buyer = randomUUIDv7(), regular = randomUUIDv7(), supplier = randomUUIDv7();
  for (const [id, name] of [[buyer, "Ama"], [regular, "Bello"]] as const) commands.saveCustomer(f.context, { id, name, active: true, createdAt: at, updatedAt: at });
  commands.saveSupplier(f.context, { id: supplier, name: "Wholesaler", active: true, createdAt: at, updatedAt: at });
  sell(f, [{ productId: p, price: 1000 }], { customerId: buyer, paid: 0, occurredAt: days(40) });
  sell(f, [{ productId: p, price: 1000, quantity: 2000 }], { customerId: buyer, paid: 500, occurredAt: days(20) });
  sell(f, [{ productId: p, price: 1000 }], { customerId: regular, paid: 0, occurredAt: days(5) });
  commands.recordPurchase(f.context, { id: randomUUIDv7(), supplierId: supplier, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, unitCostMinor: 700, quantity: 10_000 }], payments: [], occurredAt: days(28), eventId: randomUUIDv7(), supplierTransactionId: randomUUIDv7() });

  let status = settings.creditStatus(f.context, "CUSTOMER", buyer, at);
  assert.deepEqual({ days: status.days, source: status.source, balance: status.balanceMinor, overdue: status.overdueMinor, oldest: status.oldestDueAt }, { days: 30, source: "default", balance: 2500, overdue: 1000, oldest: days(10) });
  assert.deepEqual(settings.shopPaymentTerms(f.context), { customer: { days: 30, stored: false }, supplier: { days: 30, stored: false } });

  assert.equal(commands.setPaymentTerms(f.context, { party: "CUSTOMER", days: 15, updatedAt: at }), true);
  status = settings.creditStatus(f.context, "CUSTOMER", buyer, at);
  assert.deepEqual({ source: status.source, overdue: status.overdueMinor }, { source: "shop", overdue: 2500 }, "shorter shop terms re-age history without editing it");
  assert.equal(commands.setPaymentTerms(f.context, { party: "CUSTOMER", partyId: buyer, days: 60, updatedAt: at }), true);
  status = settings.creditStatus(f.context, "CUSTOMER", buyer, at);
  assert.deepEqual({ source: status.source, days: status.days, partyDays: status.partyDays, overdue: status.overdueMinor, next: status.nextDueAt }, { source: "party", days: 60, partyDays: 60, overdue: 0, next: days(-20) });
  assert.equal(commands.setPaymentTerms(f.context, { party: "CUSTOMER", partyId: buyer, days: null, updatedAt: days(-1) }), true);
  assert.equal(settings.creditStatus(f.context, "CUSTOMER", buyer, at).source, "shop", "null returns a party to the shop default");
  assert.equal(commands.setPaymentTerms(f.context, { party: "CUSTOMER", partyId: buyer, days: 90, updatedAt: days(1) }), false, "older terms lose");

  // A payment settles the oldest debt first.
  commands.receiveCustomerPayment(f.context, { id: randomUUIDv7(), customerId: buyer, accountId: f.account, amountMinor: 1200, occurredAt: at, eventId: randomUUIDv7() });
  status = settings.creditStatus(f.context, "CUSTOMER", buyer, at);
  assert.deepEqual({ balance: status.balanceMinor, overdue: status.overdueMinor, oldest: status.oldestDueAt }, { balance: 1300, overdue: 1300, oldest: days(5) });

  const aged = settings.agedBalances(f.context, "CUSTOMER", at);
  assert.deepEqual(aged.items.map(item => [item.name, item.overdueMinor, item.dueSoonMinor, item.termsDays]), [["Ama", 1300, 0, 15], ["Bello", 0, 0, 15]]);
  assert.equal(settings.agedBalances(f.context, "CUSTOMER", at, 1).truncated, true);
  const suppliers = settings.agedBalances(f.context, "SUPPLIER", at);
  assert.deepEqual(suppliers.items.map(item => [item.name, item.balanceMinor, item.overdueMinor, item.dueSoonMinor]), [["Wholesaler", 7000, 0, 7000]], "due in 2 days is due soon");
  assert.equal(commands.setPaymentTerms(f.context, { party: "SUPPLIER", partyId: supplier, days: 14, updatedAt: at }), true);
  assert.equal(settings.agedBalances(f.context, "SUPPLIER", at).items[0]!.overdueMinor, 7000);

  // Permissions and validation.
  const cashier = await f.cashier();
  assert.throws(() => commands.setPaymentTerms(cashier, { party: "CUSTOMER", days: 7, updatedAt: days(-9) }), denied("permission_denied"));
  assert.throws(() => commands.setPaymentTerms(cashier, { party: "SUPPLIER", partyId: supplier, days: 7, updatedAt: days(-9) }), denied("permission_denied"));
  assert.throws(() => settings.creditStatus(cashier, "SUPPLIER", supplier, at), denied("permission_denied"));
  assert.equal(settings.creditStatus(cashier, "CUSTOMER", buyer, at).balanceMinor, 1300, "cashiers see a customer's standing at the till");
  const owner = await f.owner();
  for (const attempt of [
    () => commands.setPaymentTerms(owner, { party: "CUSTOMER", days: null, updatedAt: days(-9) }),
    () => commands.setPaymentTerms(owner, { party: "CUSTOMER", days: 3651, updatedAt: days(-9) }),
    () => commands.setPaymentTerms(owner, { party: "CUSTOMER", days: -1, updatedAt: days(-9) }),
    () => commands.setPaymentTerms(owner, { party: "OWNER" as "CUSTOMER", days: 1, updatedAt: days(-9) }),
  ]) assert.throws(attempt, denied("invalid_input"));
  assert.throws(() => commands.setPaymentTerms(owner, { party: "SUPPLIER", partyId: buyer, days: 1, updatedAt: days(-9) }), denied("scope_mismatch"), "a customer ID is not a supplier");
  assert.throws(() => settings.creditStatus(owner, "CUSTOMER", supplier, at), denied("scope_mismatch"));
  assert.throws(() => settings.agedBalances(owner, "CUSTOMER", at, 501), denied("invalid_input"));
  assert.equal(f.events("PAYMENT_TERMS_SET"), 4, "the losing edit emitted nothing");
});

it("migration 28 upgrades a populated schema 27 shop, and snapshots drop this device's notification marks", async () => {
  const db = openDatabase(); databases.push(db);
  db.run(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT`);
  for (const migration of MIGRATIONS.filter(item => item.version <= 27)) db.transaction(tx => { for (const statement of migration.statements) tx.run(statement); tx.run(`INSERT INTO schema_migrations VALUES (?,?,?)`, [migration.version, migration.name, at]); });
  db.run(`INSERT INTO businesses(id,name,currency,created_at,updated_at) VALUES ('b','Shop','XAF',?,?)`, [at, at]);
  assert.deepEqual(migrate(db).applied.map(item => item.version), MIGRATIONS.filter(m => m.version > 27).map(m => m.version));
  assert.equal(db.get(`SELECT name FROM businesses`)!["name"], "Shop");
  for (const table of ["shop_tax_settings", "product_tax_rules", "payment_terms", "notification_state"]) assert.equal(db.get(`SELECT count(*) AS n FROM ${table}`)!["n"], 0);
  assert.throws(() => db.run(`INSERT INTO payment_terms(id,business_id,party,party_id,days,updated_at,updated_by_device) VALUES ('wrong','b','CUSTOMER',NULL,5,?,'d')`, [at]), "a default is keyed by business and party");
  assert.throws(() => db.run(`INSERT INTO payment_terms(id,business_id,party,party_id,days,updated_at,updated_by_device) VALUES ('b:CUSTOMER','b','CUSTOMER',NULL,NULL,?,'d')`, [at]), "a default always has days");
  db.run(`INSERT INTO payment_terms(id,business_id,party,party_id,days,updated_at,updated_by_device) VALUES ('b:CUSTOMER','b','CUSTOMER',NULL,10,?,'d')`, [at]);

  const f = await fixture();
  f.db.run(`INSERT INTO notification_state(business_id,user_id,key,fingerprint,read_at) VALUES (?,?,'stock:x','low',?)`, [f.context.businessId, randomUUIDv7(), at]);
  sanitizeSnapshot(f.db, randomUUIDv7());
  assert.equal(f.db.get(`SELECT count(*) AS n FROM notification_state`)!["n"], 0);
});
