import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import { closeConsistent } from "../data/database/integrity.ts";
import type { Database } from "../data/database/driver.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import { balanceOf } from "../data/customers/customers.ts";
import { balanceOfAccount } from "../data/finance/cash.ts";
import { createWorkspace, unlockWorkspace } from "../identity/workspace.ts";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "../identity/types.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";
import { previewReturn, returnSale } from "./returns.ts";

const at = "2026-10-18T09:00:00.000Z", secret = "fixture-secret";
const databases: Database[] = [];
afterEach(() => { closeConsistent(databases.splice(0)); });

async function fixture() {
  const db = openDatabase(); databases.push(db); migrate(db);
  let now = at;
  const material = { publicKey: generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, now: () => now, newId: randomUUIDv7, credentials: { provision: async () => material, inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "ANDROID", currency: "XAF", secret,
    accounts: [{ name: "Caisse", kind: "CASH" }, { name: "MoMo", kind: "MOBILE_MONEY" }] }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const accounts = queries.paymentAccounts(context).items, cash = accounts.find(item => item.kind === "CASH")!.id, momo = accounts.find(item => item.kind === "MOBILE_MONEY")!.id;
  const product = randomUUIDv7(), customer = randomUUIDv7();
  commands.saveProduct(context, { id: product, name: "Rice", unit: "bag", currency: "XAF", sellingPriceMinor: 700, purchasePriceMinor: 400, taxRateBasisPoints: 0, minimumStock: 0, divisible: false, active: true, createdAt: at, updatedAt: at });
  commands.saveCustomer(context, { id: customer, name: "Awa", active: true, createdAt: at, updatedAt: at });
  const cashier = async (revoked: readonly string[] = []) => {
    const id = randomUUIDv7();
    db.run(`INSERT INTO users(id,business_id,name,role,created_at,updated_at) VALUES (?,?,'Cashier','CASHIER',?,?)`, [id, context.businessId, at, at]);
    db.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role,revoked) VALUES (?,?,?,'CASHIER',?)`, [context.businessId, id, id, JSON.stringify(revoked)]);
    return unlockWorkspace({ userId: id, secret }, ports);
  };
  return { db, context, cash, momo, product, customer, cashier, setNow: (value: string) => { now = value; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** A 700 sale to `customerId`, paid `paid` into `accountId`, keeping `kept` change on account when given. */
function sell(f: Fixture, options: { context?: OperationContext; customerId?: string | undefined; paid?: number; accountId?: string; kept?: Partial<commands.KeptChange> | undefined; occurredAt?: string } = {}) {
  const id = randomUUIDv7(), accountId = options.accountId ?? f.cash, paid = options.paid ?? 700, occurredAt = options.occurredAt ?? at;
  const keptChange = options.kept === undefined ? undefined : { id: randomUUIDv7(), eventId: randomUUIDv7(), accountId, amountMinor: 300, ...options.kept };
  commands.completeSale(options.context ?? f.context, { id, number: `V-${id}`, eventId: randomUUIDv7(), occurredAt, ...("customerId" in options ? { customerId: options.customerId } : { customerId: f.customer }),
    lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: f.product, name: "Rice", unitPriceMinor: 700, quantity: 1000 }],
    payments: paid > 0 ? [{ id: randomUUIDv7(), accountId, amountMinor: paid }] : [], ...(paid < 700 ? { creditTransactionId: randomUUIDv7() } : {}) }, keptChange);
  return { id, keptChange };
}
const outstanding = (f: Fixture) => balanceOf(f.db, f.context.businessId, f.customer).outstandingMinor;
const drawer = (f: Fixture, account = f.cash) => balanceOfAccount(f.db, f.context.businessId, account).onHandMinor;
const refused = (code: string) => (error: unknown) => error instanceof WorkspaceError && error.code === code;

it("a customer paying 1000 for 700 keeps 300 on account: one sale, one payment, one transaction", async () => {
  const f = await fixture(), { id, keptChange } = sell(f, { kept: {} });
  assert.equal(outstanding(f), -300, "the change is an advance");
  assert.equal(drawer(f), 1000, "the drawer holds everything handed over");
  const receipt = queries.receipt(f.context, id);
  assert.deepEqual([receipt.totalMinor, receipt.paidMinor, receipt.outstandingMinor, receipt.changeKeptMinor], [700, 700, 0, 300]);
  const entry = f.db.get(`SELECT type,amount_minor,account_id,reason,occurred_at FROM customer_transactions WHERE id=?`, [keptChange!.id])!;
  assert.deepEqual({ ...entry }, { type: "PAYMENT", amount_minor: -300, account_id: f.cash, reason: receipt.number, occurred_at: at }, "an ordinary payment, noted with the sale number");
  const events = f.db.all(`SELECT event_type FROM event_journal WHERE provenance='local' AND event_type IN ('SALE_COMPLETED','CUSTOMER_PAYMENT') ORDER BY origin_sequence`).map(row => row["event_type"]);
  assert.deepEqual(events, ["SALE_COMPLETED", "CUSTOMER_PAYMENT"], "two ordinary facts every till already applies");
  // A sale without kept change says nothing about it, and a plain payment at another time is not mistaken for one.
  f.setNow("2026-10-18T09:10:00.000Z");
  const plain = sell(f, { occurredAt: "2026-10-18T09:05:00.000Z" });
  commands.receiveCustomerPayment(f.context, { id: randomUUIDv7(), customerId: f.customer, accountId: f.cash, amountMinor: 50, note: queries.receipt(f.context, plain.id).number, occurredAt: "2026-10-18T09:06:00.000Z", eventId: randomUUIDv7() });
  assert.equal(queries.receipt(f.context, plain.id).changeKeptMinor, undefined);
});

it("the kept change pays for the next purchase, and a return refunds only what the sale collected", async () => {
  const f = await fixture(), first = sell(f, { kept: {} });
  f.setNow("2026-10-18T10:00:00.000Z");
  const next = sell(f, { paid: 400, occurredAt: "2026-10-18T10:00:00.000Z" });
  const receipt = queries.receipt(f.context, next.id);
  assert.deepEqual([receipt.outstandingMinor, receipt.customerAccount?.creditAppliedMinor, receipt.customerAccount?.debtAddedMinor], [300, 300, 0]);
  assert.equal(outstanding(f), 0, "the advance covered the rest");
  f.setNow("2026-10-18T11:00:00.000Z");
  const sold = queries.receipt(f.context, first.id), preview = previewReturn(f.context, "SALE", first.id, [{ originalItemId: sold.lines[0]!.id, quantity: 1000 }]);
  assert.equal(preview.totalMinor, 700, "the change is the customer's advance, not the sale's");
  returnSale(f.context, { id: randomUUIDv7(), eventId: randomUUIDv7(), originalId: first.id, priorId: preview.source.priorId, reason: "Back",
    items: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), originalItemId: sold.lines[0]!.id, quantity: 1000 }], refunds: [{ id: randomUUIDv7(), accountId: f.cash, amountMinor: 700 }] });
  assert.equal(queries.receipt(f.context, first.id).changeKeptMinor, 300, "the receipt still shows what was kept");
  assert.equal(outstanding(f), 0);
});

it("refuses kept change that is not change, and writes nothing at all when refused", async () => {
  const f = await fixture();
  const cases: [string, Parameters<typeof sell>[1]][] = [
    ["no customer", { customerId: undefined, kept: {} }],
    ["a sale left partly on credit", { paid: 500, kept: {} }],
    ["an account the sale was not paid into", { kept: { accountId: f.momo } }],
    ["a cash drawer is the only place change can be", { accountId: f.momo, kept: {} }],
    ["zero", { kept: { amountMinor: 0 } }], ["negative", { kept: { amountMinor: -300 } }], ["fractional", { kept: { amountMinor: 1.5 } }],
  ];
  for (const [label, options] of cases) assert.throws(() => sell(f, options), refused("invalid_input"), label);
  const sameIds = randomUUIDv7();
  assert.throws(() => commands.completeSale(f.context, { id: sameIds, number: `V-${sameIds}`, eventId: randomUUIDv7(), occurredAt: at, customerId: f.customer,
    lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: f.product, name: "Rice", unitPriceMinor: 700, quantity: 1000 }], payments: [{ id: randomUUIDv7(), accountId: f.cash, amountMinor: 700 }] },
  { id: sameIds, eventId: randomUUIDv7(), accountId: f.cash, amountMinor: 300 }), refused("invalid_input"), "the payment reuses the sale's ID");
  assert.equal(f.db.get(`SELECT count(*) AS n FROM sales`)!["n"], 0, "no sale was written for any refusal");
  assert.equal(outstanding(f), 0);
  // A ledger ID already taken fails the payment after the sale was written: the whole transaction rolls back.
  const taken = sell(f, { kept: {} }).keptChange!.id;
  assert.throws(() => sell(f, { kept: { id: taken } }));
  assert.equal(f.db.get(`SELECT count(*) AS n FROM sales`)!["n"], 1, "the second sale rolled back with its payment");
  assert.equal(outstanding(f), -300); assert.equal(drawer(f), 1000);
});

it("a cashier keeps change by default; one without customers.pay cannot, and the sale is not recorded", async () => {
  const f = await fixture(), cashier = await f.cashier();
  sell(f, { context: cashier, kept: {} });
  assert.equal(outstanding(f), -300);
  const restricted = await f.cashier(["customers.pay"]);
  assert.throws(() => sell(f, { context: restricted, kept: {} }), refused("permission_denied"));
  sell(f, { context: restricted }); // The same sale without kept change is fine.
  assert.equal(f.db.get(`SELECT count(*) AS n FROM sales`)!["n"], 2); assert.equal(outstanding(f), -300);
});
