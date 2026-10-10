// Builds the large mobile performance fixture in real SQLite and times the core reads and
// commands the mobile screens use. This is a host baseline only: it runs Node SQLite on this
// computer and says nothing about Android startup, rendering, memory or the native driver.
// Usage: npm run build:packages && node scripts/mobile-fixture.mjs [--keep <file.db>]
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { openDatabase } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { createWorkspace, unlockWorkspace } from "@kolo/core/identity/workspace";
import { completeSale, saveCustomer } from "@kolo/core/application/operations";
import { customers, paymentAccounts, products, scannedProduct, statement, stockLevels } from "@kolo/core/application/queries";
import { productPhotoDigests } from "@kolo/core/application/photos";
import { analyticsView, reportView } from "@kolo/core/application/report-views";

const keep = process.argv.indexOf("--keep"), location = keep > 0 ? process.argv[keep + 1] : undefined;
const PRODUCTS = 10_000, MOVEMENTS = 100_000, STATEMENT_SALES = 2_000, secret = "654321", at = new Date().toISOString();
const database = openDatabase(location === undefined ? {} : { location }); migrate(database);
const material = { publicKey: generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
const ports = { database, now: () => new Date().toISOString(), newId: randomUUIDv7, credentials: { provision: async () => material, inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
const installation = await createWorkspace({ businessName: "Mobile fixture", ownerName: "Owner", deviceLabel: "Phone", platform: "ANDROID", currency: "XAF", secret }, ports);
const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
const business = context.businessId, account = paymentAccounts(context).items[0];
const user = installation.ownerId, device = installation.deviceId, productIds = [];
const built = performance.now();
database.transaction(tx => {
  for (let i = 0; i < PRODUCTS; i++) {
    const id = randomUUIDv7(); productIds.push(id);
    tx.run("INSERT INTO products(id,business_id,name,barcode,unit,purchase_price_minor,selling_price_minor,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [id, business, `Product ${String(i).padStart(5, "0")}`, `BENCH${i}`, "unit", 300, 500, "XAF", at, at]);
  }
  for (let i = 0; i < MOVEMENTS; i++) tx.run("INSERT INTO inventory_movements(id,business_id,product_id,type,quantity,unit_cost_minor,unit_cost_currency,user_id,device_id,occurred_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    [randomUUIDv7(), business, productIds[i % PRODUCTS], "OPENING_BALANCE", 1000, 300, "XAF", user, device, at, at]);
});
const customer = randomUUIDv7();
saveCustomer(context, { id: customer, name: "Long statement", active: true, createdAt: at, updatedAt: at });
const sale = (productId, onCredit) => {
  const id = randomUUIDv7();
  completeSale(context, { id, number: id, customerId: onCredit ? customer : undefined, creditTransactionId: onCredit ? randomUUIDv7() : undefined, occurredAt: new Date().toISOString(), eventId: randomUUIDv7(),
    lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId, name: "Line", unitPriceMinor: 500, quantity: 1000 }],
    payments: onCredit ? [] : [{ id: randomUUIDv7(), accountId: account.id, amountMinor: 500 }] });
};
// Credit sales leave a long statement and an unsealed event backlog, as a till that has not exchanged for weeks.
for (let i = 0; i < STATEMENT_SALES; i++) sale(productIds[i % PRODUCTS], true);
const fixtureMs = performance.now() - built;

function measure(work, runs = 20) {
  const times = [];
  for (let i = 0; i < runs; i++) { const start = performance.now(); work(i); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  return { medianMs: Number(times[Math.floor(runs / 2)].toFixed(2)), p95Ms: Number(times[Math.ceil(runs * 0.95) - 1].toFixed(2)) };
}
const page = products(context, { term: "Product 099" }).items.map(item => item.id);
const day = 86_400_000, until = new Date(Date.now() + day).toISOString(), month = new Date(Date.now() - 30 * day).toISOString();
const results = {
  nameSearch: measure(i => products(context, { term: `Product ${String(i * 37 % PRODUCTS).padStart(5, "0").slice(0, 4)}` })),
  scannerLookup: measure(i => scannedProduct(context, `BENCH${(i * 997) % PRODUCTS}`)),
  pageStockAndPhotos: measure(() => { stockLevels(context, page); productPhotoDigests(context, page); }),
  customerSearch: measure(() => customers(context, { term: "Long" })),
  statementPage: measure(() => statement(context, "customer", customer, {})),
  cashCheckout: measure(i => sale(productIds[(i * 131) % PRODUCTS], false), 10),
  dashboardReport: measure(() => reportView(context, "dashboard", month, until), 5),
  valuationReport: measure(() => reportView(context, "valuation", month, until, { rows: 100 }), 5),
  analytics30Days: measure(() => analyticsView(context, { from: month, until, offsetMinutes: 60 }, { rows: 50 }), 5),
};
const pendingEvents = Number(database.get("SELECT count(*) AS n FROM event_journal e LEFT JOIN event_signatures s ON s.event_id=e.event_id WHERE s.event_id IS NULL")?.["n"] ?? NaN);
process.stdout.write(`${JSON.stringify({ scope: "host Node SQLite baseline, not an Android measurement", platform: process.platform, cpu: cpus()[0]?.model, ramMiB: Math.round(totalmem() / 1048576),
  dataset: { products: PRODUCTS, movements: MOVEMENTS, statementEntries: STATEMENT_SALES, unsealedEvents: Number.isNaN(pendingEvents) ? "unknown" : pendingEvents }, fixtureMs: Math.round(fixtureMs),
  rssMiB: Math.round(process.memoryUsage().rss / 1048576), results }, null, 2)}\n`);
database.close();
