import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import type { Database } from "../data/database/driver.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import { createWorkspace, unlockWorkspace } from "../identity/workspace.ts";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "../identity/types.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";
import { registerExchangeDestination } from "./exchange.ts";
import { markNotificationsAnnounced, markNotificationsRead, notifications } from "./notifications.ts";

const at = "2026-10-06T09:00:00.000Z", secret = "fixture-secret";
const days = (n: number): string => new Date(Date.parse(at) - n * 86_400_000).toISOString();
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const pem = (): string => generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey;

async function fixture() {
  const db = openDatabase(); databases.push(db); migrate(db);
  const material = { publicKey: pem(), keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, now: () => at, newId: randomUUIDv7, credentials: { provision: async () => material, inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "DESKTOP", currency: "XAF", secret }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const account = queries.paymentAccounts(context).items[0]!.id;
  const product = (name: string, minimumStock: number, opening: number): string => {
    const id = randomUUIDv7();
    commands.saveProduct(context, { id, name, unit: "unit", currency: "XAF", sellingPriceMinor: 1000, purchasePriceMinor: 600, taxRateBasisPoints: 0, minimumStock, divisible: false, active: true, createdAt: at, updatedAt: at });
    if (opening > 0) commands.adjustStock(context, { id: randomUUIDv7(), productId: id, type: "OPENING_BALANCE", quantity: opening, reason: "Opening", occurredAt: days(60) }, randomUUIDv7());
    return id;
  };
  const sell = (productId: string, options: { quantity?: number; customerId?: string; paid?: number; occurredAt?: string } = {}): void => {
    const quantity = options.quantity ?? 1000, total = quantity, paid = options.paid ?? total;
    commands.completeSale(context, { id: randomUUIDv7(), number: randomUUIDv7(), occurredAt: options.occurredAt ?? at, eventId: randomUUIDv7(), customerId: options.customerId,
      lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId, name: "Line", unitPriceMinor: 1000, quantity }],
      payments: paid > 0 ? [{ id: randomUUIDv7(), accountId: account, amountMinor: paid }] : [], ...(paid < total ? { creditTransactionId: randomUUIDv7() } : {}) });
  };
  const member = async (role: "CASHIER" | "MANAGER"): Promise<OperationContext> => {
    const id = randomUUIDv7();
    db.run(`INSERT INTO users(id,business_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)`, [id, context.businessId, role, role, at, at]);
    db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,?)`, [context.businessId, id, id, role]);
    return unlockWorkspace({ userId: id, secret }, ports);
  };
  const owner = (): Promise<OperationContext> => unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  return { db, context, account, product, sell, member, owner };
}
const kinds = (context: OperationContext, now = at): string[] => notifications(context, now).items.map(item => `${item.kind}:${item.name}`);

it("stock alerts appear at the reorder level, re-raise only when stock goes negative, and clear when restocked", async () => {
  const f = await fixture(), rice = f.product("Rice", 2000, 3000);
  f.product("Oil", 0, 1000); f.product("Salt", 1000, 5000);
  assert.deepEqual(kinds(f.context), []);
  f.sell(rice);
  let list = notifications(f.context, at);
  assert.deepEqual(list.items.map(item => [item.kind, item.name, item.facts.onHandThousandths, item.facts.minimumThousandths, item.read]), [["stock_low", "Rice", 2000, 2000, false]]);
  assert.equal(list.unread, 1);
  assert.equal(markNotificationsRead(f.context, at), 1);
  f.sell(rice);
  list = notifications(f.context, at);
  assert.equal(list.unread, 0, "selling more of a low product does not re-raise it");
  f.sell(rice, { quantity: 3000 });
  list = notifications(f.context, at);
  assert.deepEqual(list.items.map(item => [item.kind, item.severity, item.read, item.facts.onHandThousandths]), [["stock_negative", "critical", false, -2000]]);
  commands.adjustStock(f.context, { id: randomUUIDv7(), productId: rice, type: "ADJUSTMENT", quantity: 10_000, reason: "Delivery", occurredAt: at }, randomUUIDv7());
  assert.deepEqual(kinds(f.context), [], "restocking clears it");
  commands.saveProduct(f.context, { id: rice, name: "Rice", unit: "unit", currency: "XAF", sellingPriceMinor: 1000, taxRateBasisPoints: 0, minimumStock: 0, divisible: false, active: false, createdAt: at, updatedAt: days(-1) });
  f.sell(f.product("Beans", 0, 0));
  assert.deepEqual(kinds(f.context), ["stock_negative:Beans"], "archived products are left out; any negative stock is raised");
});

it("customer and supplier debts notify when overdue or due soon; payments do not re-raise, a newly overdue debt does", async () => {
  const f = await fixture(), p = f.product("Rice", 0, 100_000), ama = randomUUIDv7(), bello = randomUUIDv7(), supplier = randomUUIDv7();
  for (const [id, name] of [[ama, "Ama"], [bello, "Bello"]] as const) commands.saveCustomer(f.context, { id, name, active: true, createdAt: at, updatedAt: at });
  commands.saveSupplier(f.context, { id: supplier, name: "Wholesaler", active: true, createdAt: at, updatedAt: at });
  f.sell(p, { customerId: ama, paid: 0, occurredAt: days(40) });
  f.sell(p, { customerId: ama, paid: 0, occurredAt: days(25) });
  f.sell(p, { customerId: bello, paid: 0, occurredAt: days(2) });
  commands.recordPurchase(f.context, { id: randomUUIDv7(), supplierId: supplier, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, unitCostMinor: 500, quantity: 4000 }], payments: [], occurredAt: days(28), eventId: randomUUIDv7(), supplierTransactionId: randomUUIDv7() });
  let list = notifications(f.context, at);
  assert.deepEqual(list.items.map(item => [item.kind, item.name, item.facts.overdueMinor, item.facts.dueSoonMinor]), [["customer_overdue", "Ama", 1000, 0], ["supplier_due_soon", "Wholesaler", 0, 2000]]);
  markNotificationsRead(f.context, at);
  commands.receiveCustomerPayment(f.context, { id: randomUUIDv7(), customerId: ama, accountId: f.account, amountMinor: 400, occurredAt: at, eventId: randomUUIDv7() });
  list = notifications(f.context, at);
  assert.equal(list.unread, 0, "a partial payment does not re-raise");
  assert.equal(list.items[0]!.facts.overdueMinor, 600);
  // Six days later Ama's second sale and the supplier's delivery have fallen due too.
  const later = days(-6);
  list = notifications(f.context, later);
  assert.deepEqual(list.items.map(item => [item.kind, item.name, item.read]), [["supplier_overdue", "Wholesaler", false], ["customer_overdue", "Ama", false]]);
  commands.receiveCustomerPayment(f.context, { id: randomUUIDv7(), customerId: ama, accountId: f.account, amountMinor: 1600, occurredAt: at, eventId: randomUUIDv7() });
  assert.deepEqual(kinds(f.context, later), ["supplier_overdue:Wholesaler"], "a settled customer clears");
  commands.setPaymentTerms(f.context, { party: "SUPPLIER", partyId: supplier, days: 60, updatedAt: at });
  assert.deepEqual(kinds(f.context, later), [], "longer terms move the due date out");
});

it("a cash count that differs notifies until corrected or recounted; only for members who see cash", async () => {
  const f = await fixture(), p = f.product("Rice", 0, 10_000);
  f.sell(p, { quantity: 5000 });
  commands.reconcileCash(f.context, f.account, 5000);
  assert.deepEqual(kinds(f.context), [], "a matching count is quiet");
  const short = commands.reconcileCash(f.context, f.account, 4500);
  const [item] = notifications(f.context, at).items;
  assert.deepEqual({ kind: item?.kind, ...item?.facts }, { kind: "cash_difference", differenceMinor: short.differenceMinor, expectedMinor: 5000, countedMinor: 4500, countedAt: at });
  commands.reconcileCash(f.context, f.account, 5000);
  assert.deepEqual(kinds(f.context), [], "a later matching count resolves it");
  commands.reconcileCash(f.context, f.account, 4800);
  assert.equal(notifications(f.context, at).items.length, 1);
  commands.adjustCashToCount(f.context, { accountId: f.account, countedMinor: 4800, reason: "Short" });
  assert.deepEqual(kinds(f.context), [], "a correction resolves it");
  commands.reconcileCash(f.context, f.account, 1);
  const cashier = await f.member("CASHIER");
  assert.deepEqual(kinds(cashier), [], "cashiers do not see cash differences");
  const manager = await f.member("MANAGER");
  assert.deepEqual(kinds(manager), ["cash_difference:Cash"].map(value => value.replace("Cash", String(f.db.get(`SELECT name FROM financial_accounts`)!["name"]))));
});

it("sync notifies about refusals, hosted grace and pauses, and a long silence with facts waiting — never about being offline", async () => {
  const f = await fixture(), p = f.product("Rice", 0, 10_000);
  const destination = registerExchangeDestination(f.context, { deviceId: randomUUIDv7(), publicKey: pem(), label: "Server", platform: "SERVER", kind: "server" });
  f.db.run(`INSERT INTO server_endpoints(destination_id,business_id,url,connected_at,last_success_at,last_error) VALUES (?,?,'https://sync.example',?,?,'network_unavailable')`, [destination, f.context.businessId, days(10), days(0.5)]);
  f.sell(p);
  assert.deepEqual(kinds(f.context), [], "offline for hours is normal");
  assert.deepEqual(kinds(f.context, days(-1)).map(value => value.split(":")[0]), ["sync_stalled"], "a day without a pass while facts wait");
  f.db.run(`UPDATE server_endpoints SET last_error='shop_suspended'`);
  assert.deepEqual(notifications(f.context, at).items.map(item => [item.kind, item.facts.error]), [["sync_refused", "shop_suspended"]]);
  f.db.run(`UPDATE server_endpoints SET last_error=NULL,last_success_at=?,service_status='grace',paid_until=?,grace_until=?`, [at, days(2), days(-5)]);
  assert.deepEqual(notifications(f.context, at).items.map(item => [item.kind, item.facts.graceUntil]), [["service_grace", days(-5)]]);
  f.db.run(`UPDATE server_endpoints SET service_status='inactive'`);
  assert.deepEqual(kinds(f.context).map(value => value.split(":")[0]), ["service_paused"]);
  f.db.run(`UPDATE server_endpoints SET service_status='active',last_success_at=?`, [days(3)]);
  f.db.run(`INSERT INTO event_deliveries(event_id,destination_id,business_id,state) SELECT event_id,?,business_id,'applied' FROM event_journal`, [destination]);
  assert.deepEqual(kinds(f.context), [], "nothing waiting: a quiet till is fine");
  const manager = await f.member("MANAGER");
  f.db.run(`UPDATE server_endpoints SET last_error='shop_suspended'`);
  assert.equal(notifications(manager, at).items.some(item => item.kind === "sync_refused"), false, "sync needs business.settings");
});

it("read and announced marks are per user, follow fingerprints, drop when conditions clear, and validate input", async () => {
  const f = await fixture(), rice = f.product("Rice", 5000, 1000), oil = f.product("Oil", 5000, 1000);
  let list = notifications(f.context, at);
  assert.deepEqual(list.items.map(item => [item.name, item.read, item.announced]), [["Oil", false, false], ["Rice", false, false]]);
  assert.equal(markNotificationsAnnounced(f.context, at, [`stock:${rice}`]), 1);
  assert.equal(markNotificationsAnnounced(f.context, at, [`stock:${rice}`]), 0, "announcing twice changes nothing");
  list = notifications(f.context, at);
  assert.deepEqual(list.items.map(item => [item.name, item.read, item.announced]), [["Oil", false, false], ["Rice", false, true]]);
  assert.equal(markNotificationsRead(f.context, at, [`stock:${oil}`, "stock:unknown"]), 1);
  assert.equal(notifications(f.context, at).unread, 1);
  assert.equal(notifications(f.context, at, 1).truncated, true);
  const manager = await f.member("MANAGER");
  assert.equal(notifications(manager, at).unread, 2, "marks belong to the user who made them");
  const owner = await f.owner();
  commands.adjustStock(owner, { id: randomUUIDv7(), productId: oil, type: "ADJUSTMENT", quantity: 10_000, reason: "Delivery", occurredAt: at }, randomUUIDv7());
  markNotificationsRead(owner, at);
  assert.equal(f.db.get(`SELECT count(*) AS n FROM notification_state WHERE key=?`, [`stock:${oil}`])!["n"], 0, "a cleared condition's mark is dropped");
  for (const attempt of [() => notifications(owner, "now"), () => notifications(owner, at, 0), () => notifications(owner, at, 501),
    () => markNotificationsRead(owner, at, ["x".repeat(201)]), () => markNotificationsRead(owner, at, [""]), () => markNotificationsAnnounced(owner, "2026-10-06", [])])
    assert.throws(attempt, (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_input");
});
