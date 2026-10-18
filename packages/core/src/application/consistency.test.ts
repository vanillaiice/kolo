import assert from "node:assert/strict";
import { closeConsistent } from "../data/database/integrity.ts";
import { afterEach, describe, it } from "node:test";
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import type { Database } from "../data/database/driver.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import { applyReturn } from "../data/returns/returns.ts";
import { ExchangeError } from "../exchange/types.ts";
import { createWorkspace, unlockWorkspace } from "../identity/workspace.ts";
import type { WorkspacePorts } from "../identity/types.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";
import * as reports from "./reports.ts";
import { previewReturn, returnPurchase, returnSale } from "./returns.ts";

/**
 * Every way of slicing a period's sales must add up to the period, and every
 * return must leave the books describing what physically happened. These run
 * against real SQLite with an oracle written independently of the code under test.
 */

const later = "2027-01-01T00:00:00.000Z", secret = "fixture-secret", at = "2026-09-01T09:00:00.000Z";
const databases: Database[] = [];
afterEach(() => { closeConsistent(databases.splice(0)); });

async function fixture() {
  const db = openDatabase(); databases.push(db); migrate(db);
  let now = later;
  const material = { publicKey: generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, now: () => now, newId: randomUUIDv7, credentials: { provision: async () => ({ ...material, credentialReference: randomUUIDv7() }), inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "ANDROID", currency: "XAF", secret }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const till = queries.paymentAccounts(context).items[0]!.id, wallet = randomUUIDv7();
  commands.saveAccount(context, { id: wallet, name: "Wallet", kind: "MOBILE_MONEY", currency: "XAF", active: true, createdAt: at, updatedAt: at });
  const product = (name: string, sellingPriceMinor: number, categoryId?: string) => {
    const id = randomUUIDv7();
    commands.saveProduct(context, { id, name, unit: "unit", currency: "XAF", sellingPriceMinor, purchasePriceMinor: 1, taxRateBasisPoints: 0, minimumStock: 0, divisible: true, active: true, createdAt: at, updatedAt: at, ...(categoryId === undefined ? {} : { categoryId }) });
    return id;
  };
  const category = (name: string) => { const id = randomUUIDv7(); commands.saveCategory(context, { id, name, active: true, createdAt: at, updatedAt: at }); return id; };
  const customer = (name: string) => { const id = randomUUIDv7(); commands.saveCustomer(context, { id, name, active: true, createdAt: at, updatedAt: at }); return id; };
  const supplier = (name: string) => { const id = randomUUIDv7(); commands.saveSupplier(context, { id, name, active: true, createdAt: at, updatedAt: at }); return id; };
  return { db, context, till, wallet, product, category, customer, supplier, setNow: (value: string) => { now = value; } };
}

/** Deterministic PRNG so a failure names a reproducible seed. */
function random(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return below => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
  };
}

/** Independent oracle arithmetic: BigInt, rounding half up on non-negative values. */
const round = (numerator: bigint, denominator: bigint): bigint => (2n * numerator + denominator) / (2n * denominator);
function allocate(lines: readonly { id: string; total: bigint }[], discount: bigint): Map<string, bigint> {
  const subtotal = lines.reduce((sum, line) => sum + line.total, 0n);
  if (discount === 0n || subtotal === 0n) return new Map(lines.map(line => [line.id, line.total]));
  const shares = lines.map(line => ({ id: line.id, total: line.total, share: line.total * discount / subtotal, remainder: line.total * discount % subtotal }));
  let left = discount - shares.reduce((sum, line) => sum + line.share, 0n);
  const order = [...shares].sort((a, b) => a.remainder !== b.remainder ? (b.remainder > a.remainder ? 1 : -1) : (a.id < b.id ? -1 : 1));
  for (const line of order) { if (left === 0n) break; line.share++; left--; }
  return new Map(shares.map(line => [line.id, line.total - line.share]));
}

const iso = (ms: number): string => new Date(ms).toISOString();
const OCT = Date.parse("2026-10-01T00:00:00.000Z"), NOV = Date.parse("2026-11-01T00:00:00.000Z"), DEC = Date.parse("2026-12-01T00:00:00.000Z"), JAN = Date.parse("2027-01-01T00:00:00.000Z");
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

describe("every breakdown adds up to its period", () => {
  for (const seed of [1, 7, 42, 2026]) {
    it(`random discounted, split, credit and returned sales (seed ${seed})`, async () => {
      const f = await fixture(), next = random(seed);
      const food = f.category("Food"), drink = f.category("Drink");
      const products = [f.product("Rice", 650, food), f.product("Oil", 1_250, food), f.product("Soda", 400, drink), f.product("Soap", 275)];
      const customers = [f.customer("Ada"), f.customer("Bea")];
      /** Oracle facts, keyed by when they count. */
      const facts: { at: number; productId: string; customerId?: string; revenue: bigint; quantity: number }[] = [];
      const money: { at: number; accountId: string; amount: number }[] = [];
      const sales: { id: string; at: number; customerId?: string; lines: { id: string; productId: string; quantity: number; net: bigint; returned: number; returnedValue: bigint }[] }[] = [];

      for (let index = 0; index < 24; index++) {
        const occurred = OCT + next(DEC - OCT), customerId = next(3) === 0 ? undefined : customers[next(2)]!;
        const lines = Array.from({ length: 1 + next(3) }, () => {
          const productId = products[next(products.length)]!, unitPriceMinor = 1 + next(5_000), quantity = 1 + next(4_000);
          const gross = round(BigInt(unitPriceMinor) * BigInt(quantity), 1000n), discountMinor = next(3) === 0 ? next(Number(gross) + 1) : 0;
          return { id: randomUUIDv7(), movementId: randomUUIDv7(), productId, name: "Sold as", unitPriceMinor, quantity, discountMinor, ...(next(4) === 0 ? {} : { unitCostMinor: next(3_000) }), total: gross - BigInt(discountMinor) };
        });
        const subtotal = lines.reduce((total, line) => total + line.total, 0n), discountMinor = next(2) === 0 ? next(Number(subtotal) + 1) : 0;
        const net = allocate(lines, BigInt(discountMinor)), total = Number(subtotal) - discountMinor;
        const paid = customerId === undefined ? total : next(total + 1), cash = next(paid + 1);
        const payments = [[f.till, cash], [f.wallet, paid - cash]].filter(([, amount]) => (amount as number) > 0).map(([accountId, amountMinor]) => ({ id: randomUUIDv7(), accountId: accountId as string, amountMinor: amountMinor as number }));
        const id = randomUUIDv7();
        commands.completeSale(f.context, { id, number: id, occurredAt: iso(occurred), eventId: randomUUIDv7(), discountMinor, payments,
          lines: lines.map(({ total: _total, ...line }) => line), ...(customerId === undefined ? {} : { customerId }), ...(paid < total ? { creditTransactionId: randomUUIDv7() } : {}) });
        for (const payment of payments) money.push({ at: occurred, accountId: payment.accountId, amount: payment.amountMinor });
        for (const line of lines) facts.push({ at: occurred, productId: line.productId, ...(customerId === undefined ? {} : { customerId }), revenue: net.get(line.id)!, quantity: line.quantity });
        sales.push({ id, at: occurred, ...(customerId === undefined ? {} : { customerId }), lines: lines.map(line => ({ id: line.id, productId: line.productId, quantity: line.quantity, net: net.get(line.id)!, returned: 0, returnedValue: 0n })) });
      }

      // Returns, in time order per sale, some crossing into the next month; some lines go back whole.
      for (const sale of sales.filter(() => next(2) === 0)) {
        let when = sale.at;
        for (let attempt = 0; attempt < 2; attempt++) {
          const open = sale.lines.filter(line => line.returned < line.quantity);
          if (open.length === 0) break;
          const chosen = open.filter(() => next(2) === 0).slice(0, 2);
          if (chosen.length === 0) chosen.push(open[0]!);
          const items = chosen.map(line => ({ line, quantity: next(2) === 0 ? line.quantity - line.returned : 1 + next(line.quantity - line.returned) }));
          when += 1 + next(20 * 86_400_000); if (when >= JAN) break;
          f.setNow(iso(when));
          const preview = previewReturn(f.context, "SALE", sale.id, items.map(item => ({ originalItemId: item.line.id, quantity: item.quantity })));
          const refund = sale.customerId === undefined ? preview.totalMinor : next(Math.min(preview.totalMinor, preview.source.refundableMinor) + 1);
          assert.equal(refund <= preview.source.refundableMinor, true);
          returnSale(f.context, { id: randomUUIDv7(), eventId: randomUUIDv7(), originalId: sale.id, priorId: preview.source.priorId, reason: "Back",
            items: items.map(item => ({ id: randomUUIDv7(), movementId: randomUUIDv7(), originalItemId: item.line.id, quantity: item.quantity })),
            refunds: refund > 0 ? [{ id: randomUUIDv7(), accountId: f.till, amountMinor: refund }] : [], ...(preview.totalMinor > refund ? { debtTransactionId: randomUUIDv7() } : {}) });
          if (refund > 0) money.push({ at: when, accountId: f.till, amount: -refund });
          for (const { line, quantity } of items) {
            // Cumulative entitlement: what has gone back in total is round(net × returned / sold).
            const before = line.returnedValue; line.returned += quantity;
            line.returnedValue = round(line.net * BigInt(line.returned), BigInt(line.quantity));
            facts.push({ at: when, productId: line.productId, ...(sale.customerId === undefined ? {} : { customerId: sale.customerId }), revenue: before - line.returnedValue, quantity: -quantity });
          }
        }
      }
      f.setNow(later);

      for (const [from, to] of [[OCT, NOV], [NOV, DEC], [DEC, JAN], [OCT, JAN]] as const) {
        const a = iso(from), b = iso(to), inside = facts.filter(fact => fact.at >= from && fact.at < to);
        const total = Number(inside.reduce((value, fact) => value + fact.revenue, 0n)), sold = sum(inside.map(fact => fact.quantity));
        const period = reports.salesBetween(f.context, a, b), profit = reports.profitBetween(f.context, a, b);
        assert.deepEqual([period.totalMinor, period.itemsSoldThousandths, profit.revenueMinor], [total, sold, total], `${a} period`);
        for (const [name, lines] of [["product", reports.salesByProduct(f.context, a, b)], ["category", reports.salesByCategory(f.context, a, b)], ["cashier", reports.salesByUser(f.context, a, b)]] as const)
          assert.equal(sum(lines.map(line => line.totalMinor)), total, `${a} by ${name}`);
        const movement = reports.productMovement(f.context, a, b), productProfit = reports.productProfit(f.context, a, b);
        assert.deepEqual([sum(movement.map(item => item.revenueMinor)), sum(movement.map(item => item.soldThousandths))], [total, sold], `${a} movement`);
        assert.deepEqual([sum(productProfit.map(item => item.revenueMinor)), sum(productProfit.map(item => item.costMinor))], [total, profit.costMinor], `${a} product profit`);
        for (const productId of products) {
          const own = inside.filter(fact => fact.productId === productId), expected = Number(own.reduce((value, fact) => value + fact.revenue, 0n));
          assert.equal(movement.find(item => item.productId === productId)?.revenueMinor ?? 0, expected, `${a} product ${productId}`);
          assert.equal(productProfit.find(item => item.productId === productId)?.revenueMinor ?? 0, expected, `${a} product profit ${productId}`);
        }
        const top = reports.topCustomers(f.context, a, b, 100);
        for (const customerId of customers) {
          const expected = Number(inside.filter(fact => fact.customerId === customerId).reduce((value, fact) => value + fact.revenue, 0n));
          assert.equal(sum(reports.customerPurchases(f.context, customerId, a, b).map(line => line.totalMinor)), expected, `${a} customer ${customerId}`);
          const ranked = top.find(item => item.customerId === customerId);
          if (ranked !== undefined) assert.equal(ranked.revenueMinor, expected);
        }
        const accounts = reports.salesByAccount(f.context, a, b);
        for (const accountId of [f.till, f.wallet])
          assert.equal(accounts.find(line => line.key === accountId)?.totalMinor ?? 0, sum(money.filter(item => item.at >= from && item.at < to && item.accountId === accountId).map(item => item.amount)), `${a} account`);
      }
      // A line that went back whole leaves nothing behind, however the bill's discount fell on it.
      for (const sale of sales) for (const line of sale.lines) if (line.returned === line.quantity) assert.equal(line.returnedValue, line.net);
    });
  }

  it("a fully returned line on a discounted bill nets to zero for its product", async () => {
    const f = await fixture(), a = f.product("A", 1_000), b = f.product("B", 1_000), sale = randomUUIDv7(), lineA = randomUUIDv7();
    commands.completeSale(f.context, { id: sale, number: sale, occurredAt: "2026-10-05T10:00:00.000Z", eventId: randomUUIDv7(), discountMinor: 200,
      lines: [{ id: lineA, movementId: randomUUIDv7(), productId: a, name: "A", unitPriceMinor: 1_000, quantity: 1_000 },
        { id: randomUUIDv7(), movementId: randomUUIDv7(), productId: b, name: "B", unitPriceMinor: 1_000, quantity: 1_000 }],
      payments: [{ id: randomUUIDv7(), accountId: f.till, amountMinor: 1_800 }] });
    f.setNow("2026-10-06T10:00:00.000Z");
    const preview = previewReturn(f.context, "SALE", sale, [{ originalItemId: lineA, quantity: 1_000 }]);
    returnSale(f.context, { id: randomUUIDv7(), eventId: randomUUIDv7(), originalId: sale, reason: "Back", items: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), originalItemId: lineA, quantity: 1_000 }],
      refunds: [{ id: randomUUIDv7(), accountId: f.till, amountMinor: preview.totalMinor }] });
    f.setNow(later);
    const from = "2026-10-01T00:00:00.000Z", to = "2026-11-01T00:00:00.000Z";
    assert.deepEqual(reports.productProfit(f.context, from, to).map(item => [item.name, item.soldThousandths, item.revenueMinor, item.costMinor]), [["B", 1_000, 900, 1], ["A", 0, 0, 0]]);
    assert.deepEqual(reports.salesByProduct(f.context, from, to).map(line => [line.label, line.totalMinor]), [["B", 900], ["A", 0]]);
    assert.deepEqual(reports.salesByAccount(f.context, from, to).map(line => [line.totalMinor, line.count]), [[900, 1]]);
  });

  it("purchases by wholesaler add up to the period's purchases, net of returns", async () => {
    const f = await fixture(), p = f.product("Rice", 650), supplier = f.supplier("Grossiste"), purchase = randomUUIDv7(), line = randomUUIDv7();
    commands.recordPurchase(f.context, { id: purchase, supplierId: supplier, supplierTransactionId: randomUUIDv7(), occurredAt: "2026-10-03T08:00:00.000Z", eventId: randomUUIDv7(),
      lines: [{ id: line, movementId: randomUUIDv7(), productId: p, unitCostMinor: 333, quantity: 3_000 }], payments: [] });
    commands.recordPurchase(f.context, { id: randomUUIDv7(), occurredAt: "2026-10-04T08:00:00.000Z", eventId: randomUUIDv7(),
      lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, unitCostMinor: 100, quantity: 1_500 }], payments: [{ id: randomUUIDv7(), accountId: f.till, amountMinor: 150, reason: "Market" }] });
    f.setNow("2026-10-09T08:00:00.000Z");
    returnPurchase(f.context, { id: randomUUIDv7(), eventId: randomUUIDv7(), originalId: purchase, reason: "Damaged", debtTransactionId: randomUUIDv7(),
      items: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), originalItemId: line, quantity: 1_000 }], refunds: [] });
    f.setNow(later);
    const from = "2026-10-01T00:00:00.000Z", to = "2026-11-01T00:00:00.000Z", lines = reports.purchasesBySupplier(f.context, from, to);
    assert.equal(sum(lines.map(item => item.totalMinor)), reports.purchasesBetween(f.context, from, to).totalMinor);
    assert.deepEqual(lines.map(item => [item.key, item.totalMinor, item.count]), [[supplier, 666, 1], ["", 150, 1]]);
  });
});

describe("a refund never pays out money the original did not settle", () => {
  const sold = "2026-10-05T10:00:00.000Z", back = "2026-10-06T10:00:00.000Z";
  async function creditSale(paidMinor: number) {
    const f = await fixture(), p = f.product("Rice", 1_000), customer = f.customer("Ada"), sale = randomUUIDv7(), line = randomUUIDv7();
    commands.completeSale(f.context, { id: sale, number: sale, occurredAt: sold, eventId: randomUUIDv7(), customerId: customer, creditTransactionId: randomUUIDv7(),
      lines: [{ id: line, movementId: randomUUIDv7(), productId: p, name: "Rice", unitPriceMinor: 1_000, quantity: 2_000 }],
      payments: paidMinor === 0 ? [] : [{ id: randomUUIDv7(), accountId: f.till, amountMinor: paidMinor }] });
    f.setNow(back);
    const give = (quantity: number, refund: number) => {
      const preview = previewReturn(f.context, "SALE", sale, [{ originalItemId: line, quantity }]);
      returnSale(f.context, { id: randomUUIDv7(), eventId: randomUUIDv7(), originalId: sale, priorId: preview.source.priorId, reason: "Back",
        items: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), originalItemId: line, quantity }],
        refunds: refund === 0 ? [] : [{ id: randomUUIDv7(), accountId: f.till, amountMinor: refund }], ...(preview.totalMinor > refund ? { debtTransactionId: randomUUIDv7() } : {}) });
    };
    return { f, customer, sale, give, cash: () => queries.accounts(f.context).items.find(item => item.id === f.till)!.onHandMinor, owed: () => queries.personBalance(f.context, "customer", customer) };
  }

  it("refuses cash back on a sale taken wholly on credit; the return clears the debt instead", async () => {
    const s = await creditSale(0);
    assert.equal(previewReturn(s.f.context, "SALE", s.sale, [{ originalItemId: s.f.db.get(`SELECT id FROM sale_items`)!["id"] as string, quantity: 1 }]).source.refundableMinor, 0);
    assert.throws(() => s.give(2_000, 1));
    assert.deepEqual([s.cash(), s.owed()], [0, 2_000]);
    s.give(2_000, 0);
    assert.deepEqual([s.cash(), s.owed()], [0, 0]);
  });

  it("caps refunds at what was paid, across successive returns", async () => {
    const s = await creditSale(700);
    assert.throws(() => s.give(1_000, 701));
    s.give(1_000, 500);
    assert.throws(() => s.give(1_000, 201));
    s.give(1_000, 200);
    // 700 paid, 700 refunded; the 1,300 on credit was cleared by the 1,300 of goods that came back on account.
    assert.deepEqual([s.cash(), s.owed()], [0, 0]);
  });

  it("caps a purchase refund at what was paid at the door", async () => {
    const f = await fixture(), p = f.product("Rice", 650), supplier = f.supplier("Grossiste"), purchase = randomUUIDv7(), line = randomUUIDv7();
    commands.recordPurchase(f.context, { id: purchase, supplierId: supplier, supplierTransactionId: randomUUIDv7(), occurredAt: sold, eventId: randomUUIDv7(),
      lines: [{ id: line, movementId: randomUUIDv7(), productId: p, unitCostMinor: 300, quantity: 2_000 }], payments: [{ id: randomUUIDv7(), accountId: f.till, amountMinor: 100, reason: "Deposit" }] });
    f.setNow(back);
    const preview = previewReturn(f.context, "PURCHASE", purchase, [{ originalItemId: line, quantity: 2_000 }]);
    assert.deepEqual([preview.totalMinor, preview.source.refundableMinor], [600, 100]);
    const input = (refund: number) => ({ id: randomUUIDv7(), eventId: randomUUIDv7(), originalId: purchase, reason: "Back", debtTransactionId: randomUUIDv7(),
      items: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), originalItemId: line, quantity: 2_000 }], refunds: [{ id: randomUUIDv7(), accountId: f.till, amountMinor: refund }] });
    assert.throws(() => returnPurchase(f.context, input(101)));
    returnPurchase(f.context, input(100));
    assert.deepEqual([queries.personBalance(f.context, "supplier", supplier), queries.accounts(f.context).items.find(item => item.id === f.till)!.onHandMinor], [0, 0]);
  });

  it("refuses an over-refund arriving from another device, committing nothing", async () => {
    const s = await creditSale(300), line = String(s.f.db.get(`SELECT id FROM sale_items`)!["id"]);
    const event = (refund: number) => ({ event_type: "SALE_RETURNED" as const, business_id: s.f.context.businessId, actor_id: s.f.context.userId, origin_device_id: s.f.context.deviceId,
      branch_id: (s.f.db.get(`SELECT branch_id FROM sales`)!["branch_id"] as string | null), occurred_at: back,
      payload: { returned: { id: randomUUIDv7(), original_id: s.sale, reason: "Back", items: [{ id: randomUUIDv7(), original_item_id: line, quantity: 2_000, movement_id: randomUUIDv7() }],
        refunds: [{ id: randomUUIDv7(), account_id: s.f.till, amount_minor: refund }], debt_transaction_id: randomUUIDv7() } } });
    assert.throws(() => s.f.db.transaction(tx => applyReturn(tx, event(301), back)), (error: unknown) => error instanceof ExchangeError && error.code === "invalid_payload");
    assert.equal(s.f.db.get(`SELECT count(*) AS n FROM business_returns`)!["n"], 0);
    s.f.db.transaction(tx => applyReturn(tx, event(300), back));
    assert.deepEqual([s.cash(), s.owed()], [0, 0]);
  });
});

describe("a stock count in a shop with several branches", () => {
  it("is compared with the counted branch's shelves, not the whole shop's", async () => {
    const f = await fixture(), p = f.product("Rice", 650), [first, second] = [randomUUIDv7(), randomUUIDv7()];
    for (const branch of [first, second]) f.db.run(`INSERT INTO branches(id,business_id,name,created_at,updated_at) VALUES (?,?,?,?,?)`, [branch, f.context.businessId, `Branch ${branch.slice(-4)}`, at, at]);
    for (const [branchId, quantity] of [[first, 5_000], [second, 3_000]] as const)
      commands.recordPurchase(f.context, { id: randomUUIDv7(), branchId, occurredAt: "2026-10-03T08:00:00.000Z", eventId: randomUUIDv7(),
        lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, unitCostMinor: 100, quantity }], payments: [{ id: randomUUIDv7(), accountId: f.till, amountMinor: quantity / 10, reason: "Paid" }] });
    assert.equal(commands.countStock(f.context, { productId: p, branchId: first, countedThousandths: 4_000, reason: "Shelf count" }), -1_000);
    assert.equal(queries.productStock(f.context, p).onHandThousandths, 7_000);
  });
});
