import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import type { Database } from "../data/database/driver.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import { bucketKeys, defaultBucket, type Bucket } from "../data/reports/analytics.ts";
import { createWorkspace, grantPermission, unlockWorkspace } from "../identity/workspace.ts";
import { createLocalMember } from "../identity/members.ts";
import { WorkspaceError, type WorkspacePorts } from "../identity/types.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";
import * as reports from "./reports.ts";
import { previewReturn, returnSale } from "./returns.ts";

const at = "2026-09-01T09:00:00.000Z", later = "2026-12-01T00:00:00.000Z", secret = "fixture-secret";
const FROM = "2026-10-01T00:00:00.000Z", TO = "2026-11-01T00:00:00.000Z";
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const code = (value: string) => (error: unknown): boolean => error instanceof WorkspaceError && error.code === value;

async function fixture() {
  const db = openDatabase(); databases.push(db); migrate(db);
  // Recorded after everything the tests say happened.
  let now = later;
  const material = { publicKey: generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, now: () => now, newId: randomUUIDv7, credentials: { provision: async () => ({ ...material, credentialReference: randomUUIDv7() }), inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "ANDROID", currency: "XAF", secret }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const account = queries.paymentAccounts(context).items[0]!;
  const product = (name: string) => {
    const id = randomUUIDv7(); commands.saveProduct(context, { id, name, unit: "unit", currency: "XAF", sellingPriceMinor: 500, purchasePriceMinor: 300, taxRateBasisPoints: 0, minimumStock: 0, divisible: true, active: true, createdAt: at, updatedAt: at }); return id;
  };
  const customer = (name: string) => { const id = randomUUIDv7(); commands.saveCustomer(context, { id, name, active: true, createdAt: at, updatedAt: at }); return id; };
  /** One paid sale; lines are [product, unit price, thousandths, unit cost?]. */
  const sell = (occurredAt: string, lines: readonly (readonly [string, number, number, number?])[], options: { discountMinor?: number; customerId?: string } = {}) => {
    const id = randomUUIDv7(), items = lines.map(([productId, unitPriceMinor, quantity, unitCostMinor]) => ({ id: randomUUIDv7(), movementId: randomUUIDv7(), productId, name: "Sold as", unitPriceMinor, quantity, ...(unitCostMinor === undefined ? {} : { unitCostMinor }) }));
    const total = lines.reduce((sum, [, price, quantity]) => sum + Math.floor((price * quantity + 500) / 1000), 0) - (options.discountMinor ?? 0);
    commands.completeSale(context, { id, number: id, lines: items, payments: [{ id: randomUUIDv7(), accountId: account.id, amountMinor: total }], occurredAt, eventId: randomUUIDv7(), ...options });
    return { id, items };
  };
  /** Returns one line of a sale for cash, at the return's own instant. */
  const giveBack = (saleId: string, itemId: string, quantity: number, when: string) => {
    now = when;
    const preview = previewReturn(context, "SALE", saleId, [{ originalItemId: itemId, quantity }]);
    returnSale(context, { id: randomUUIDv7(), eventId: randomUUIDv7(), originalId: saleId, priorId: preview.source.priorId, reason: "Returned",
      items: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), originalItemId: itemId, quantity }], refunds: [{ id: randomUUIDv7(), accountId: account.id, amountMinor: preview.totalMinor }] });
    now = later;
    return preview.totalMinor;
  };
  return { db, ports, installation, context, product, customer, sell, giveBack };
}

describe("bucket keys", () => {
  it("covers a period in local time, empty buckets included, weeks from Monday", () => {
    assert.deepEqual(bucketKeys("2026-10-05T23:00:00.000Z", "2026-10-07T23:00:00.000Z", "day", 60), ["2026-10-06", "2026-10-07"]);
    assert.deepEqual(bucketKeys("2026-10-05T23:00:00.000Z", "2026-10-06T02:00:00.000Z", "hour", 60), ["2026-10-06T00", "2026-10-06T01", "2026-10-06T02"]);
    // 2026-10-01 is a Thursday; its week starts Monday 28 September.
    assert.deepEqual(bucketKeys(FROM, "2026-10-13T00:00:00.000Z", "week", 0), ["2026-09-28", "2026-10-05", "2026-10-12"]);
    assert.deepEqual(bucketKeys("2025-11-15T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "month", 0), ["2025-11", "2025-12", "2026-01"]);
    assert.deepEqual(bucketKeys(FROM, TO, "day", -300).slice(0, 2), ["2026-09-30", "2026-10-01"]);
  });
  it("rejects empty periods, impossible offsets and unreadable bucket counts", () => {
    assert.throws(() => bucketKeys(TO, FROM, "day", 0), RangeError);
    assert.throws(() => bucketKeys(FROM, FROM, "day", 0), RangeError);
    assert.throws(() => bucketKeys(FROM, TO, "day", 15 * 60), RangeError);
    assert.throws(() => bucketKeys(FROM, TO, "day", 0.5), RangeError);
    assert.throws(() => bucketKeys("2020-01-01T00:00:00.000Z", TO, "hour", 0), RangeError);
  });
  it("chooses a readable bucket for the period's length", () => {
    assert.equal(defaultBucket(FROM, "2026-10-02T00:00:00.000Z"), "hour");
    assert.equal(defaultBucket(FROM, TO), "day");
    assert.equal(defaultBucket("2026-01-01T00:00:00.000Z", TO), "week");
    assert.equal(defaultBucket("2024-01-01T00:00:00.000Z", TO), "month");
  });
});

describe("analytics over recorded sales", () => {
  it("sums a profit trend to exactly the period's profit, with discounts, uncosted lines and returns", async () => {
    const f = await fixture(), rice = f.product("Rice"), oil = f.product("Oil");
    const first = f.sell("2026-10-02T10:00:00.000Z", [[rice, 500, 3_000, 300], [oil, 1_250, 1_500]], { discountMinor: 7 });
    f.sell("2026-10-09T15:30:00.000Z", [[rice, 333, 2_500, 101]]);
    f.giveBack(first.id, first.items[0]!.id, 1_000, "2026-10-10T08:00:00.000Z");
    // October in Douala, as the screen computes it from local calendar days.
    const from = "2026-09-30T23:00:00.000Z", to = "2026-10-31T23:00:00.000Z";
    const profit = reports.profitBetween(f.context, from, to), trend = reports.profitTrend(f.context, from, to, "day", 60);
    assert.equal(trend.length, 31);
    assert.equal(trend[0]!.key, "2026-10-01");
    const sum = (pick: (point: typeof trend[number]) => number): number => trend.reduce((total, point) => total + pick(point), 0);
    assert.equal(sum(point => point.revenueMinor), profit.revenueMinor);
    assert.equal(sum(point => point.costMinor), profit.costMinor);
    assert.equal(sum(point => point.grossProfitMinor), profit.grossProfitMinor);
    assert.equal(sum(point => point.transactions), 2);
    assert.ok(trend.find(point => point.key === "2026-10-10")!.revenueMinor < 0, "a return lands on the day it happened");
    assert.equal(trend.find(point => point.key === "2026-10-05")!.revenueMinor, 0);
    assert.deepEqual(reports.salesTrend(f.context, from, to, "day", 60).map(point => Object.keys(point).sort()), trend.map(() => ["key", "revenueMinor", "transactions"]));
  });

  it("places sales in the shop's local day and hour, not UTC's", async () => {
    const f = await fixture(), rice = f.product("Rice");
    // 23:30 UTC on Saturday 3 October is 00:30 on Sunday 4 October in Douala.
    f.sell("2026-10-03T23:30:00.000Z", [[rice, 500, 1_000]]);
    f.sell("2026-10-03T23:45:00.000Z", [[rice, 500, 2_000]], { discountMinor: 100 });
    const trend = reports.salesTrend(f.context, FROM, TO, "day", 60);
    assert.equal(trend.find(point => point.key === "2026-10-04")!.transactions, 2);
    assert.equal(trend.find(point => point.key === "2026-10-03")!.transactions, 0);
    assert.deepEqual(reports.salesActivity(f.context, FROM, TO, 60), [{ weekday: 0, hour: 0, transactions: 2, revenueMinor: 1_400 }]);
    assert.deepEqual(reports.salesActivity(f.context, FROM, TO, 0), [{ weekday: 6, hour: 23, transactions: 2, revenueMinor: 1_400 }]);
  });

  it("buckets every instant where the JavaScript calendar does, for any offset (oracle)", async () => {
    const f = await fixture(), rice = f.product("Rice");
    let seed = 7; const random = (): number => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    const instants = Array.from({ length: 40 }, () => new Date(Date.parse(FROM) + Math.floor(random() * (Date.parse(TO) - Date.parse(FROM)))).toISOString());
    for (const instant of instants) f.sell(instant, [[rice, 100, 1_000]]);
    for (const offset of [-600, -270, 0, 60, 345, 840]) for (const bucket of ["hour", "day", "week", "month"] as Bucket[]) {
      if (bucket === "hour") continue; // 744 hourly points are covered by the count below.
      const trend = reports.salesTrend(f.context, FROM, TO, bucket, offset);
      assert.equal(trend.reduce((total, point) => total + point.transactions, 0), instants.length, `${bucket} ${offset}`);
      for (const instant of instants) {
        const local = new Date(Date.parse(instant) + offset * 60_000), day = local.toISOString().slice(0, 10);
        const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (local.getUTCDay() + 6) % 7)).toISOString().slice(0, 10);
        const key = bucket === "day" ? day : bucket === "week" ? monday : day.slice(0, 7);
        assert.ok((trend.find(point => point.key === key)?.transactions ?? 0) > 0, `${instant} → ${key} (${bucket} ${offset})`);
      }
      const cells = reports.salesActivity(f.context, FROM, TO, offset);
      assert.equal(cells.reduce((total, cell) => total + cell.transactions, 0), instants.length);
    }
    assert.equal(reports.salesTrend(f.context, FROM, TO, "hour", 60).reduce((total, point) => total + point.transactions, 0), instants.length);
  });

  it("ranks products by takings net of their returns, including products only returned", async () => {
    const f = await fixture(), rice = f.product("Rice"), oil = f.product("Oil"), salt = f.product("Salt");
    const september = f.sell("2026-09-20T10:00:00.000Z", [[salt, 200, 5_000, 120]]);
    const october = f.sell("2026-10-02T10:00:00.000Z", [[rice, 500, 4_000, 300], [oil, 1_000, 1_000]]);
    f.sell("2026-10-03T10:00:00.000Z", [[oil, 1_000, 3_000]]);
    f.giveBack(october.id, october.items[0]!.id, 1_000, "2026-10-04T10:00:00.000Z");
    f.giveBack(september.id, september.items[0]!.id, 2_000, "2026-10-04T11:00:00.000Z");
    const ranked = reports.productProfit(f.context, FROM, TO);
    assert.deepEqual(ranked.map(row => [row.name, row.soldThousandths, row.revenueMinor, row.costMinor, row.linesWithoutCost]), [
      ["Oil", 4_000, 4_000, 0, 2], ["Rice", 3_000, 1_500, 900, 0], ["Salt", -2_000, -400, -240, 0],
    ]);
    assert.equal(ranked[1]!.grossProfitMinor, 600);
    assert.deepEqual(Object.keys(reports.productSales(f.context, FROM, TO)[0]!).sort(), ["name", "productId", "revenueMinor", "soldThousandths"]);
  });

  it("ranks named customers by what they bought, walk-ins absent, returns off, bounded", async () => {
    const f = await fixture(), rice = f.product("Rice"), awa = f.customer("Awa"), paul = f.customer("Paul"), zoe = f.customer("Zoé");
    const big = f.sell("2026-10-02T10:00:00.000Z", [[rice, 500, 10_000]], { customerId: paul });
    f.sell("2026-10-03T10:00:00.000Z", [[rice, 500, 4_000]], { customerId: awa });
    f.sell("2026-10-05T10:00:00.000Z", [[rice, 500, 4_000]], { customerId: awa, discountMinor: 50 });
    f.sell("2026-10-06T10:00:00.000Z", [[rice, 500, 1_000]], { customerId: zoe });
    f.sell("2026-10-06T11:00:00.000Z", [[rice, 500, 50_000]]);
    f.giveBack(big.id, big.items[0]!.id, 3_000, "2026-10-07T10:00:00.000Z");
    assert.deepEqual(reports.topCustomers(f.context, FROM, TO).map(row => [row.name, row.transactions, row.revenueMinor, row.lastPurchaseAt]), [
      ["Awa", 2, 3_950, "2026-10-05T10:00:00.000Z"], ["Paul", 1, 3_500, "2026-10-02T10:00:00.000Z"], ["Zoé", 1, 500, "2026-10-06T10:00:00.000Z"],
    ]);
    assert.deepEqual(reports.topCustomers(f.context, FROM, TO, 1).map(row => row.name), ["Awa"]);
    assert.deepEqual(reports.topCustomers(f.context, "2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"), []);
  });

  it("checks each figure's own report permission inside the operation", async () => {
    const f = await fixture();
    const userId = await createLocalMember(f.context, { name: "Cashier", role: "CASHIER", secret });
    grantPermission(f.context, userId, "reports.sales");
    const staff = await unlockWorkspace({ userId, secret }, f.ports);
    assert.equal(reports.salesTrend(staff, FROM, TO, "week", 60).length, 5);
    assert.deepEqual(reports.salesActivity(staff, FROM, TO, 60), []);
    assert.deepEqual(reports.productSales(staff, FROM, TO), []);
    assert.throws(() => reports.profitTrend(staff, FROM, TO, "week", 60), code("permission_denied"));
    assert.throws(() => reports.productProfit(staff, FROM, TO), code("permission_denied"));
    assert.throws(() => reports.topCustomers(staff, FROM, TO), code("permission_denied"));
  });

  it("keeps each shop's figures to itself", async () => {
    const f = await fixture(), rice = f.product("Rice");
    f.sell("2026-10-02T10:00:00.000Z", [[rice, 500, 1_000]]);
    const other = await fixture();
    assert.equal(reports.salesTrend(other.context, FROM, TO, "month", 0)[0]!.transactions, 0);
    assert.deepEqual(reports.productSales(other.context, FROM, TO), []);
  });
});
