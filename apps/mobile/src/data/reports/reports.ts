/**
 * What the shop did, worked out from what it recorded (§21, §22).
 *
 * Every figure here is a query over transactions. Nothing is a stored total,
 * which is what makes a report and the records behind it incapable of
 * disagreeing — §21 says so directly, and it is the same rule stock and
 * balances already follow.
 *
 * They run on the device, against the local database, because an owner asking
 * what today took must get an answer with no network (§23). The server can
 * answer the same questions from the same shapes, but it is not on this path.
 *
 * Periods are half-open — `from` inclusive, `to` exclusive — so a day, a week
 * and a month tile without double-counting the sale made at midnight. They are
 * sliced by when business *happened*, never by when a row was written: a till
 * that syncs on Friday still sold on Monday, and last week's takings must not
 * change because a device was slow (§26).
 */

import type { Queryable } from "../database/driver.ts";
import { QUANTITY_SCALE } from "../inventory/movements.ts";

/** What a period sold. */
export interface SalesSummary {
  /** What the sales came to, after their discounts. */
  readonly totalMinor: number;
  /** How many sales, which is what a till's Z-report calls transactions. */
  readonly transactions: number;
  /** How much was sold, in thousandths of a unit. */
  readonly itemsSoldThousandths: number;
}

/** What a period earned, and what it cost to earn (§8, §20). */
export interface ProfitSummary {
  readonly revenueMinor: number;
  /** What the goods sold cost the business, for the lines that know. */
  readonly costMinor: number;
  readonly grossProfitMinor: number;
  /**
   * How many lines had no cost recorded.
   *
   * An honest gap rather than a zero: stock inherited from before the system,
   * or a delivery whose invoice never arrived, has no cost, and counting it as
   * free would report a profit the shop did not make (§8).
   */
  readonly linesWithoutCost: number;
}

/** One line of a breakdown, largest first. */
export interface Line {
  readonly key: string;
  readonly label: string;
  readonly totalMinor: number;
  readonly count: number;
}

/** §22's dashboard: what an owner looks at first. */
export interface Dashboard {
  readonly sales: SalesSummary;
  readonly profit: ProfitSummary;
  readonly expensesMinor: number;
  /** Gross profit less expenses. Negative when the shop lost money. */
  readonly netResultMinor: number;
  /** What customers owe, across everyone who owes anything. */
  readonly customerDebtMinor: number;
  /** How many products are at or below their reorder point. */
  readonly lowStock: number;
}

/**
 * The line total, in SQL, matching the arithmetic everywhere else exactly.
 *
 * Integer throughout: `(price × quantity + 500) / 1000` with integer division is
 * round-half-up, and quantities on a sale line are positive by construction. A
 * float divide would be the one place money stopped being exact (ADR-010), and
 * a device that rounded differently from the server would disagree with the
 * receipt by a franc a line.
 */
const LINE_TOTAL = `((i.unit_price_minor * i.quantity + ${QUANTITY_SCALE / 2}) / ${QUANTITY_SCALE}
                     - i.discount_minor)`;

/** What a period sold (§21). */
export function salesBetween(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): SalesSummary {
  const totals = tx.get(
    `SELECT coalesce(sum(${LINE_TOTAL}), 0) AS lines,
            coalesce(sum(i.quantity), 0) AS sold
       FROM sale_items i
       JOIN sales s ON s.id = i.sale_id
      WHERE s.business_id = ? AND s.occurred_at >= ? AND s.occurred_at < ?`,
    [businessId, from, to],
  );
  // The sale's own discount comes off the whole bill, after the lines, so it is
  // summed separately rather than spread across them.
  const sales = tx.get(
    `SELECT coalesce(sum(discount_minor), 0) AS discounts, count(*) AS transactions
       FROM sales
      WHERE business_id = ? AND occurred_at >= ? AND occurred_at < ?`,
    [businessId, from, to],
  );

  return {
    totalMinor: Number(totals?.["lines"] ?? 0) - Number(sales?.["discounts"] ?? 0),
    transactions: Number(sales?.["transactions"] ?? 0),
    itemsSoldThousandths: Number(totals?.["sold"] ?? 0),
  };
}

/**
 * What a period earned against what the goods cost (§8, §20).
 *
 * Cost is counted only for the lines that recorded one. A line with no cost
 * contributes its revenue and no cost, and is counted in `linesWithoutCost` so
 * the figure can be read for what it is: profit over the part of the trade the
 * shop knows the cost of.
 */
export function profitBetween(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): ProfitSummary {
  const row = tx.get(
    `SELECT coalesce(sum(${LINE_TOTAL}), 0) AS revenue,
            coalesce(sum(CASE WHEN i.unit_cost_minor IS NULL THEN 0
                              ELSE (i.unit_cost_minor * i.quantity + ${QUANTITY_SCALE / 2})
                                   / ${QUANTITY_SCALE} END), 0) AS cost,
            coalesce(sum(CASE WHEN i.unit_cost_minor IS NULL THEN 1 ELSE 0 END), 0) AS blind
       FROM sale_items i
       JOIN sales s ON s.id = i.sale_id
      WHERE s.business_id = ? AND s.occurred_at >= ? AND s.occurred_at < ?`,
    [businessId, from, to],
  );

  const revenueMinor = Number(row?.["revenue"] ?? 0);
  const costMinor = Number(row?.["cost"] ?? 0);
  return {
    revenueMinor,
    costMinor,
    grossProfitMinor: revenueMinor - costMinor,
    linesWithoutCost: Number(row?.["blind"] ?? 0),
  };
}

/** What sold, by product, best first (§21). */
export function salesByProduct(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): Line[] {
  const rows = tx.all(
    `SELECT i.product_id AS key, i.name AS label,
            sum(${LINE_TOTAL}) AS total, count(*) AS entries
       FROM sale_items i
       JOIN sales s ON s.id = i.sale_id
      WHERE s.business_id = ? AND s.occurred_at >= ? AND s.occurred_at < ?
      GROUP BY i.product_id, i.name
      ORDER BY total DESC, i.name`,
    [businessId, from, to],
  );
  return rows.map(toLine);
}

/**
 * What each account took, best first (§21).
 *
 * By account and never by "payment method": which provider took the money is
 * the account's name, which is what makes adding one a row rather than a
 * release (§10).
 */
export function salesByAccount(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): Line[] {
  const rows = tx.all(
    `SELECT p.account_id AS key,
            coalesce(a.name, p.account_id) AS label,
            sum(p.amount_minor) AS total,
            count(*) AS entries
       FROM sale_payments p
       LEFT JOIN financial_accounts a ON a.id = p.account_id
      WHERE p.business_id = ? AND p.occurred_at >= ? AND p.occurred_at < ?
      GROUP BY p.account_id, label
      ORDER BY total DESC, label`,
    [businessId, from, to],
  );
  return rows.map(toLine);
}

/** Who sold what, best first — §21's sales by employee. */
export function salesByUser(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): Line[] {
  const rows = tx.all(
    `SELECT s.user_id AS key,
            coalesce(u.name, s.user_id) AS label,
            sum(${LINE_TOTAL}) AS total,
            count(DISTINCT s.id) AS entries
       FROM sale_items i
       JOIN sales s ON s.id = i.sale_id
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.business_id = ? AND s.occurred_at >= ? AND s.occurred_at < ?
      GROUP BY s.user_id, label
      ORDER BY total DESC, label`,
    [businessId, from, to],
  );
  return rows.map(toLine);
}

/**
 * What every customer owes, most first (§13, §21).
 *
 * Customers in credit are absent: they are not debts, and a list of debts that
 * included them would have to be read twice to be understood.
 */
export function outstandingDebt(tx: Queryable, businessId: string): Line[] {
  const rows = tx.all(
    `SELECT t.customer_id AS key,
            coalesce(c.name, t.customer_id) AS label,
            sum(t.amount_minor) AS total,
            count(*) AS entries
       FROM customer_transactions t
       LEFT JOIN customers c ON c.id = t.customer_id
      WHERE t.business_id = ?
      GROUP BY t.customer_id, label
     HAVING sum(t.amount_minor) > 0
      ORDER BY total DESC, label`,
    [businessId],
  );
  return rows.map(toLine);
}

/**
 * The products at or below their reorder point (§7, §21).
 *
 * Stock is the sum of the ledger, here as everywhere. Products with a reorder
 * point of zero are not tracked and are absent, rather than every product a
 * shop has ever sold out of appearing forever.
 */
export function lowStock(tx: Queryable, businessId: string): Line[] {
  const rows = tx.all(
    `SELECT p.id AS key, p.name AS label,
            coalesce(sum(m.quantity), 0) AS total,
            p.minimum_stock AS entries
       FROM products p
       LEFT JOIN inventory_movements m
              ON m.product_id = p.id AND m.business_id = p.business_id
      WHERE p.business_id = ? AND p.active = 1 AND p.minimum_stock > 0
      GROUP BY p.id, p.name, p.minimum_stock
     HAVING coalesce(sum(m.quantity), 0) <= p.minimum_stock
      ORDER BY total, p.name`,
    [businessId],
  );
  return rows.map(toLine);
}

/**
 * §22's dashboard, assembled from the reports above.
 *
 * Supplier debt is absent because suppliers are not built yet (§14–§16). An
 * empty line would read as "nothing owed", which is a different and much worse
 * answer than "not known".
 */
export function dashboard(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): Dashboard {
  const sales = salesBetween(tx, businessId, from, to);
  const profit = profitBetween(tx, businessId, from, to);

  const spent = tx.get(
    `SELECT coalesce(sum(amount_minor), 0) AS spent
       FROM expenses
      WHERE business_id = ? AND occurred_at >= ? AND occurred_at < ?`,
    [businessId, from, to],
  );
  const expensesMinor = Number(spent?.["spent"] ?? 0);

  const owed = outstandingDebt(tx, businessId);
  const customerDebtMinor = owed.reduce((total, line) => total + line.totalMinor, 0);

  return {
    sales,
    profit,
    expensesMinor,
    netResultMinor: profit.grossProfitMinor - expensesMinor,
    customerDebtMinor,
    lowStock: lowStock(tx, businessId).length,
  };
}

function toLine(row: Record<string, unknown>): Line {
  return {
    key: String(row["key"]),
    label: String(row["label"]),
    totalMinor: Number(row["total"] ?? 0),
    count: Number(row["entries"] ?? 0),
  };
}
