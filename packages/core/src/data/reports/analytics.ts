/**
 * Light analytics over a period: how takings moved, when the shop is busy,
 * what sells and who buys (§21, §22).
 *
 * Every figure is a query over the same immutable sales, sale lines and
 * returns the reports in `reports.ts` read, with the same line arithmetic, so
 * a trend summed over its buckets equals the period's figure in
 * `profitBetween` and the two screens cannot disagree.
 *
 * Buckets and hours are the shop's *local* time. Stored instants are UTC, so
 * callers pass the local offset in minutes east of UTC (Douala is +60). A
 * single offset per request is exact for zones without daylight saving — which
 * is every XAF zone — and off by an hour across a change elsewhere.
 */

import type { Queryable } from "../database/driver.ts";
import { sqlInteger } from "../database/safe-values.ts";
import { sumAmounts } from "../../rules/amounts.ts";
import { QUANTITY_SCALE } from "../inventory/movements.ts";
import { LINE_TOTAL, netSaleFacts } from "./reports.ts";

/** How a trend is sliced. Weeks start on Monday. */
export type Bucket = "hour" | "day" | "week" | "month";

/** One slice of a sales trend. */
export interface SalesPoint {
  /** Local `YYYY-MM-DDTHH`, `YYYY-MM-DD` (a day, or a week's Monday) or `YYYY-MM`. */
  readonly key: string;
  /** Net of bill discounts and of returns made in this slice. */
  readonly revenueMinor: number;
  readonly transactions: number;
}

/** One slice of a profit trend: a sales point with what the goods cost. */
export interface ProfitPoint extends SalesPoint {
  /** Cost of the lines that recorded one, less the cost of returned goods. */
  readonly costMinor: number;
  readonly grossProfitMinor: number;
}

/** Sales started in one local hour of one weekday, summed over the period. */
export interface ActivityCell {
  /** 0 is Sunday, as SQLite and `Date#getDay` count. */
  readonly weekday: number;
  /** 0–23, local. */
  readonly hour: number;
  readonly transactions: number;
  /** What those sales came to after their bill discounts; returns are not activity. */
  readonly revenueMinor: number;
}

/** What one product sold over a period, net of its returns. */
export interface ProductSales {
  readonly productId: string;
  readonly name: string;
  /** Net thousandths; negative when more came back than sold in the period. */
  readonly soldThousandths: number;
  /** Line totals after line discounts, before any bill-level discount. */
  readonly revenueMinor: number;
}

/** {@link ProductSales} with what the goods cost (§8). */
export interface ProductProfit extends ProductSales {
  readonly costMinor: number;
  readonly grossProfitMinor: number;
  /** Lines with no recorded cost; their revenue counts and their cost does not. */
  readonly linesWithoutCost: number;
}

/** One named customer's buying over a period. */
export interface CustomerRank {
  readonly customerId: string;
  readonly name: string;
  readonly transactions: number;
  /** Net of bill discounts and of returns made in the period against their sales. */
  readonly revenueMinor: number;
  readonly lastPurchaseAt: string;
}

const MAX_BUCKETS = 1_000;
const HOUR = 3_600_000, DAY = 24 * HOUR;

/** The SQLite modifier that turns a stored UTC instant into local time. */
function shift(offsetMinutes: number): string {
  if (!Number.isSafeInteger(offsetMinutes) || Math.abs(offsetMinutes) > 14 * 60) throw new RangeError("a UTC offset is at most fourteen hours");
  return `${offsetMinutes < 0 ? "-" : "+"}${Math.abs(offsetMinutes)} minutes`;
}

/** The bucket key of a column, in SQL; `?4` is the {@link shift} modifier. */
function keyOf(bucket: Bucket, column: string): string {
  switch (bucket) {
    case "hour": return `strftime('%Y-%m-%dT%H', ${column}, ?4)`;
    case "day": return `date(${column}, ?4)`;
    // Back six days, then forward to a Monday: the Monday on or before the day.
    case "week": return `date(${column}, ?4, '-6 days', 'weekday 1')`;
    case "month": return `strftime('%Y-%m', ${column}, ?4)`;
  }
}

/**
 * The finest bucket that keeps a period to a readable number of points: hours
 * for up to two days, days for up to about two months, weeks for up to about a
 * year, months beyond.
 */
export function defaultBucket(from: string, to: string): Bucket {
  const span = Date.parse(to) - Date.parse(from);
  return span <= 2 * DAY ? "hour" : span <= 62 * DAY ? "day" : span <= 371 * DAY ? "week" : "month";
}

/**
 * Every bucket key a period touches, in order, including the empty ones a
 * trend needs to show as zero rather than skip.
 */
export function bucketKeys(from: string, to: string, bucket: Bucket, offsetMinutes: number): string[] {
  shift(offsetMinutes);
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new RangeError("a period must end after it starts");
  // Local wall-clock time, read back through the UTC getters.
  const first = new Date(start + offsetMinutes * 60_000), last = new Date(end - 1 + offsetMinutes * 60_000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const dayKey = (date: Date): string => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const keys: string[] = [];
  const push = (key: string): void => { if (keys.length >= MAX_BUCKETS) throw new RangeError("too many buckets for one trend"); keys.push(key); };
  if (bucket === "month") {
    for (let year = first.getUTCFullYear(), month = first.getUTCMonth();
      year < last.getUTCFullYear() || year === last.getUTCFullYear() && month <= last.getUTCMonth();
      month === 11 ? (year++, month = 0) : month++) push(`${year}-${pad(month + 1)}`);
    return keys;
  }
  const floor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate(), bucket === "hour" ? first.getUTCHours() : 0));
  if (bucket === "week") floor.setUTCDate(floor.getUTCDate() - (floor.getUTCDay() + 6) % 7);
  const step = bucket === "hour" ? HOUR : bucket === "day" ? DAY : 7 * DAY;
  for (let at = floor.getTime(); at <= last.getTime(); at += step) {
    const date = new Date(at);
    push(bucket === "hour" ? `${dayKey(date)}T${pad(date.getUTCHours())}` : dayKey(date));
  }
  return keys;
}

/**
 * Takings, cost and sales count per bucket, empty buckets included (§21).
 *
 * Sale lines, bill discounts and returns are each placed in the bucket in which
 * they *happened*, which is how `profitBetween` slices a period; summed, the
 * points equal its revenue, cost and gross profit exactly.
 */
export function profitTrend(tx: Queryable, businessId: string, from: string, to: string, bucket: Bucket, offsetMinutes: number): ProfitPoint[] {
  const keys = bucketKeys(from, to, bucket, offsetMinutes);
  const rows = tx.all(
    `WITH facts AS (
       SELECT ${keyOf(bucket, "s.occurred_at")} AS k, ${LINE_TOTAL} AS revenue,
              CASE WHEN i.unit_cost_minor IS NULL THEN 0
                   ELSE (i.unit_cost_minor * i.quantity + ${QUANTITY_SCALE / 2}) / ${QUANTITY_SCALE} END AS cost,
              0 AS sales
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.business_id = ?1 AND s.occurred_at >= ?2 AND s.occurred_at < ?3
       UNION ALL
       SELECT ${keyOf(bucket, "occurred_at")}, -discount_minor, 0, 1
         FROM sales WHERE business_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3
       UNION ALL
       SELECT ${keyOf(bucket, "occurred_at")}, -total_minor, -cost_minor, 0
         FROM business_returns WHERE business_id = ?1 AND kind = 'SALE' AND occurred_at >= ?2 AND occurred_at < ?3)
     SELECT k, sum(revenue) AS revenue, sum(cost) AS cost, sum(sales) AS sales FROM facts GROUP BY k`,
    [businessId, from, to, shift(offsetMinutes)],
  );
  const found = new Map(rows.map(row => [String(row["k"]), row]));
  return keys.map(key => {
    const row = found.get(key);
    const revenueMinor = sqlInteger(row?.["revenue"] ?? 0), costMinor = sqlInteger(row?.["cost"] ?? 0);
    return { key, revenueMinor, costMinor, grossProfitMinor: sumAmounts([revenueMinor, -costMinor]), transactions: sqlInteger(row?.["sales"] ?? 0) };
  });
}

/** {@link profitTrend} without cost, for those who may see sales but not margins. */
export function salesTrend(tx: Queryable, businessId: string, from: string, to: string, bucket: Bucket, offsetMinutes: number): SalesPoint[] {
  return profitTrend(tx, businessId, from, to, bucket, offsetMinutes).map(({ key, revenueMinor, transactions }) => ({ key, revenueMinor, transactions }));
}

/**
 * When the shop is busy: sales by local weekday and hour (§22).
 *
 * Only cells with at least one sale are returned. A sale counts where it was
 * rung up; its later returns are not activity at the hour they reversed.
 */
export function salesActivity(tx: Queryable, businessId: string, from: string, to: string, offsetMinutes: number): ActivityCell[] {
  const rows = tx.all(
    `SELECT CAST(strftime('%w', s.occurred_at, ?4) AS INTEGER) AS weekday,
            CAST(strftime('%H', s.occurred_at, ?4) AS INTEGER) AS hour,
            count(*) AS sales,
            sum(coalesce((SELECT sum(${LINE_TOTAL}) FROM sale_items i WHERE i.sale_id = s.id), 0) - s.discount_minor) AS revenue
       FROM sales s
      WHERE s.business_id = ?1 AND s.occurred_at >= ?2 AND s.occurred_at < ?3
      GROUP BY weekday, hour
      ORDER BY weekday, hour`,
    [businessId, from, to, shift(offsetMinutes)],
  );
  return rows.map(row => ({ weekday: sqlInteger(row["weekday"]), hour: sqlInteger(row["hour"]), transactions: sqlInteger(row["sales"]), revenueMinor: sqlInteger(row["revenue"] ?? 0) }));
}

/**
 * What every product that moved in a period sold and earned, best takings first.
 *
 * Net of the returns made in the period, product by product, so a product
 * returned but not sold in the period appears with negative figures rather than
 * vanishing. Named by the product's current name, so a renamed product is one
 * row. Revenue is net of each sale's whole-bill discount, allocated across its
 * lines exactly as a return refunds it, so a fully returned line nets to zero and
 * the products sum to {@link profitTrend}'s period revenue.
 */
export function productProfit(tx: Queryable, businessId: string, from: string, to: string): ProductProfit[] {
  const products = new Map<string, { name: string; quantity: number; revenue: number; cost: number; blind: number }>();
  for (const fact of netSaleFacts(tx, businessId, from, to)) {
    const current = products.get(fact.productId) ?? { name: fact.productName ?? (fact.returned ? fact.productId : fact.name), quantity: 0, revenue: 0, cost: 0, blind: 0 };
    products.set(fact.productId, { name: current.name, quantity: sumAmounts([current.quantity, fact.quantity]), revenue: sumAmounts([current.revenue, fact.revenueMinor]),
      cost: sumAmounts([current.cost, fact.costMinor]), blind: current.blind + (fact.uncosted ? 1 : 0) });
  }
  return [...products].map(([productId, value]) => ({
    productId, name: value.name, soldThousandths: value.quantity, revenueMinor: value.revenue, costMinor: value.cost,
    grossProfitMinor: sumAmounts([value.revenue, -value.cost]), linesWithoutCost: value.blind,
  })).sort((a, b) => b.revenueMinor - a.revenueMinor || b.soldThousandths - a.soldThousandths || a.name.localeCompare(b.name));
}

/** {@link productProfit} without cost, for those who may see sales but not margins. */
export function productSales(tx: Queryable, businessId: string, from: string, to: string): ProductSales[] {
  return productProfit(tx, businessId, from, to).map(({ productId, name, soldThousandths, revenueMinor }) => ({ productId, name, soldThousandths, revenueMinor }));
}

/**
 * The named customers who bought most over a period, most first (§12, §21).
 *
 * Every sale naming them counts, paid or on credit. Walk-in sales name nobody
 * and are absent. Returns made in the period against their sales come off;
 * a customer who only returned goods in the period bought nothing in it and is
 * not ranked.
 */
export function topCustomers(tx: Queryable, businessId: string, from: string, to: string, limit = 10): CustomerRank[] {
  const bought = tx.all(
    `SELECT s.customer_id AS customer_id, coalesce(c.name, s.customer_id) AS name, count(*) AS sales, max(s.occurred_at) AS last,
            sum(coalesce((SELECT sum(${LINE_TOTAL}) FROM sale_items i WHERE i.sale_id = s.id), 0) - s.discount_minor) AS revenue
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id AND c.business_id = s.business_id
      WHERE s.business_id = ?1 AND s.customer_id IS NOT NULL AND s.occurred_at >= ?2 AND s.occurred_at < ?3
      GROUP BY s.customer_id`,
    [businessId, from, to],
  );
  const returned = new Map(tx.all(
    `SELECT s.customer_id AS customer_id, sum(r.total_minor) AS total
       FROM business_returns r
       JOIN sales s ON s.business_id = r.business_id AND s.id = r.original_id
      WHERE r.business_id = ?1 AND r.kind = 'SALE' AND s.customer_id IS NOT NULL AND r.occurred_at >= ?2 AND r.occurred_at < ?3
      GROUP BY s.customer_id`,
    [businessId, from, to],
  ).map(row => [String(row["customer_id"]), sqlInteger(row["total"])]));
  return bought.map(row => {
    const customerId = String(row["customer_id"]);
    return { customerId, name: String(row["name"]), transactions: sqlInteger(row["sales"]), lastPurchaseAt: String(row["last"]),
      revenueMinor: sumAmounts([sqlInteger(row["revenue"] ?? 0), -(returned.get(customerId) ?? 0)]) };
  }).sort((a, b) => b.revenueMinor - a.revenueMinor || b.transactions - a.transactions || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}
