import { sqlInteger } from "../database/safe-values.ts";
import { multiplyRatio, sumAmounts } from "../../rules/amounts.ts";
import { lineTotal } from "../../rules/pricing.ts";
import { discountedLineTotals } from "../../rules/returns.ts";
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
import { categoryLabel } from "../../domain/category-names.ts";
import type { Language } from "../../domain/money.ts";

/** What a period sold. */
export interface SalesSummary {
  /** Net sales after discounts and returns occurring in this period. */
  readonly totalMinor: number;
  /** How many sales, which is what a till's Z-report calls transactions. */
  readonly transactions: number;
  /** Net sold quantity after returns, in thousandths; may be negative in a return-only period. */
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

/** What a period's deliveries brought in, and what they cost (§15, §21). */
export interface PurchaseSummary {
  /** What the deliveries came to. */
  readonly totalMinor: number;
  /** How many deliveries, which is what a wholesaler's statement calls them. */
  readonly deliveries: number;
  /** How much arrived, in thousandths of a unit. */
  readonly receivedThousandths: number;
}

/**
 * How stock is valued (§8).
 *
 * Named rather than inlined because §8 requires the architecture to allow FIFO
 * and weighted average later. Adding one is a case in {@link COST_OF}, not a
 * rewrite of the report, and callers name the method they mean, so a screen
 * that changes it changes a report's meaning visibly rather than by accident.
 */
export type CostingMethod = "LATEST_COST";

/** What one product's stock is worth. */
export interface ValuedProduct {
  readonly productId: string;
  readonly name: string;
  /** Signed thousandths, as stock always is. */
  readonly onHandThousandths: number;
  /**
   * What one unit cost, and undefined when nothing says.
   *
   * Undefined is an honest gap, not a zero: stock inherited from before the
   * system, or received before this device saw the delivery, has no cost, and
   * valuing it at nothing would report an asset the shop does not have (§8).
   */
  readonly unitCostMinor?: number | undefined;
  /** Undefined for exactly the products whose cost is. */
  readonly valueMinor?: number | undefined;
}

/** What the shelves are worth (§8, §21). */
export interface Valuation {
  readonly method: CostingMethod;
  /** The total of every product that could be valued. */
  readonly totalMinor: number;
  readonly products: readonly ValuedProduct[];
  /**
   * How many products hold stock that nothing says the cost of.
   *
   * Surfaced rather than folded into the total, because "worth 650,000" and
   * "worth 650,000 plus twelve sacks nobody priced" are different answers and
   * only one of them is true.
   */
  readonly uncosted: number;
}

/** How a product moved over a period (§21). */
export interface ProductMovement {
  readonly productId: string;
  readonly name: string;
  /** How much left the shop net of returns, in thousandths. Zero is the interesting case. */
  readonly soldThousandths: number;
  /** What those sales came to, after line and whole-bill discounts and less returns. */
  readonly revenueMinor: number;
  /** What is left on the shelf, the sum of the ledger as always. */
  readonly onHandThousandths: number;
}

/** Stock that is not selling, and what it has tied up (§21). */
export interface DeadStock {
  readonly productId: string;
  readonly name: string;
  readonly onHandThousandths: number;
  /** When it last sold, and undefined if it never has. */
  readonly lastSoldAt?: string | undefined;
  /**
   * What it is worth at its latest cost, and undefined when nothing
   * says what it cost. The gap is honest, as it is in a valuation.
   */
  readonly valueMinor?: number | undefined;
}

/** What moved through an account over a period (§18, §21). */
export interface CashFlow {
  readonly accountId: string;
  readonly name: string;
  /** Everything that came in, positive. */
  readonly inMinor: number;
  /** Everything that went out, reported positive. */
  readonly outMinor: number;
  /** In less out. Negative when the account paid out more than it took. */
  readonly netMinor: number;
  /** What it holds now, which is the whole history and not just this period. */
  readonly closingMinor: number;
}

/** One entry of a customer's statement (§13, §21). */
export interface StatementEntry {
  readonly id: string;
  /** CREDIT_SALE, PAYMENT, RETURN, ADJUSTMENT, OPENING_BALANCE, WRITE_OFF. */
  readonly type: string;
  /** Signed as stored: positive adds to what is owed, negative reduces it. */
  readonly amountMinor: number;
  /** What caused it — the sale a debt came from, and how it is traced (§40). */
  readonly reference?: string | undefined;
  readonly reason?: string | undefined;
  readonly occurredAt: string;
  /**
   * What was owed after this entry, running down the statement.
   *
   * Worked out here rather than stored, like every other balance. It is what
   * makes a statement something a customer can be shown and follow, rather than
   * a list of amounts they have to add up themselves.
   */
  readonly balanceMinor: number;
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
  /** What the shop owes its wholesalers, across everyone it owes (§16). */
  readonly supplierDebtMinor: number;
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
 * receipt by a franc a line. Shared with the analytics queries for the same reason.
 *
 * @internal
 */
export const LINE_TOTAL = `((i.unit_price_minor * i.quantity + ${QUANTITY_SCALE / 2}) / ${QUANTITY_SCALE}
                     - i.discount_minor)`;

/**
 * The same arithmetic for a delivery line, which has a cost and no discount.
 *
 * Deliberately the same rounding as a sale line's. The two are compared to each
 * other whenever anyone asks what a shop made, and rounding them differently is
 * how a margin comes to be a franc a line wrong in a direction nobody notices.
 */
const PURCHASE_LINE_TOTAL = `((i.unit_cost_minor * i.quantity + ${QUANTITY_SCALE / 2})
                              / ${QUANTITY_SCALE})`;

/**
 * One sale line or sale-return line as it counts toward a period, for breakdowns.
 *
 * A sale line counts at its *net* value: its line total less its share of the
 * sale's whole-bill discount, allocated by {@link discountedLineTotals} — the
 * same allocation a return refunds against. A return line counts negative, at
 * the value it refunded, in the period the return happened. So any grouping of
 * these facts sums to exactly {@link salesBetween}'s total, and a fully returned
 * line nets to zero rather than leaving its discount share behind.
 *
 * Grouping keys are those of the original sale: its cashier, its customer, and
 * the product's current category (a category is a way of grouping products, so
 * moving a product moves its history).
 *
 * @internal
 */
export interface NetSaleFact {
  readonly productId: string;
  /** The name the line was sold under. */
  readonly name: string;
  /** The product's current name, when the product still exists. */
  readonly productName: string | undefined;
  /** Empty when the product is in no category. */
  readonly categoryId: string;
  readonly categoryName: string | undefined;
  /** The category's French/English names (ADR-037), when any are set. */
  readonly categoryNames?: { readonly fr?: string; readonly en?: string } | undefined;
  readonly saleId: string;
  readonly userId: string;
  readonly userName: string | undefined;
  /** Thousandths; negative for a return. */
  readonly quantity: number;
  /** Net XAF; negative for a return. */
  readonly revenueMinor: number;
  /** XAF cost of the goods; negative for a return; zero when the line recorded none. */
  readonly costMinor: number;
  /** A sale line with no recorded cost. Returns are never counted here. */
  readonly uncosted: boolean;
  /** Whether this fact is a return. */
  readonly returned: boolean;
}

/** @internal Net sale and return lines for a period, optionally for one customer; see {@link NetSaleFact}. */
export function netSaleFacts(tx: Queryable, businessId: string, from: string, to: string, customerId?: string): NetSaleFact[] {
  const forCustomer = customerId === undefined ? "" : " AND s.customer_id = ?4";
  const parameters = customerId === undefined ? [businessId, from, to] : [businessId, from, to, customerId];
  const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
  const names = (row: Record<string, unknown>): NetSaleFact["categoryNames"] => {
    const fr = text(row["category_fr"]), en = text(row["category_en"]);
    return fr === undefined && en === undefined ? undefined : { ...(fr === undefined ? {} : { fr }), ...(en === undefined ? {} : { en }) };
  };
  const sold = tx.all(
    `SELECT i.id, i.sale_id, i.product_id, i.name, i.unit_price_minor, i.quantity, i.discount_minor, i.unit_cost_minor,
            s.discount_minor AS sale_discount, s.user_id, u.name AS user_name,
            p.name AS product_name, coalesce(p.category_id, '') AS category_id, c.name AS category_name, cn.name_fr AS category_fr, cn.name_en AS category_en
       FROM sale_items i
       JOIN sales s ON s.id = i.sale_id
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN products p ON p.id = i.product_id AND p.business_id = s.business_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN category_names cn ON cn.id = c.id
      WHERE s.business_id = ?1 AND s.occurred_at >= ?2 AND s.occurred_at < ?3${forCustomer}
      ORDER BY i.sale_id, i.id`,
    parameters,
  );
  const bySale = new Map<string, typeof sold>();
  for (const row of sold) {
    const sale = String(row["sale_id"]), lines = bySale.get(sale);
    if (lines === undefined) bySale.set(sale, [row]); else lines.push(row);
  }
  const facts: NetSaleFact[] = [];
  for (const lines of bySale.values()) {
    const priced = lines.map(row => ({ id: String(row["id"]), unitPriceMinor: sqlInteger(row["unit_price_minor"]), quantity: sqlInteger(row["quantity"]), discountMinor: sqlInteger(row["discount_minor"]) }));
    const discount = sqlInteger(lines[0]!["sale_discount"]);
    const net = discount === 0 ? undefined : discountedLineTotals(priced, discount);
    for (const [index, row] of lines.entries()) {
      const line = priced[index]!, cost = row["unit_cost_minor"];
      facts.push({ productId: String(row["product_id"]), name: String(row["name"]), productName: text(row["product_name"]),
        categoryId: String(row["category_id"]), categoryName: text(row["category_name"]), categoryNames: names(row), saleId: String(row["sale_id"]),
        userId: String(row["user_id"]), userName: text(row["user_name"]), quantity: line.quantity,
        revenueMinor: net?.get(line.id) ?? lineTotal(line), costMinor: cost === null || cost === undefined ? 0 : multiplyRatio(sqlInteger(cost), line.quantity, QUANTITY_SCALE),
        uncosted: cost === null || cost === undefined, returned: false });
    }
  }
  const returned = tx.all(
    `SELECT ri.product_id, ri.quantity, ri.amount_minor, ri.cost_minor, si.name, s.id AS sale_id, s.user_id, u.name AS user_name,
            p.name AS product_name, coalesce(p.category_id, '') AS category_id, c.name AS category_name, cn.name_fr AS category_fr, cn.name_en AS category_en
       FROM business_return_items ri
       JOIN business_returns r ON r.business_id = ri.business_id AND r.id = ri.return_id
       JOIN sales s ON s.business_id = r.business_id AND s.id = r.original_id
       JOIN sale_items si ON si.id = ri.original_item_id AND si.sale_id = s.id
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN products p ON p.id = ri.product_id AND p.business_id = r.business_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN category_names cn ON cn.id = c.id
      WHERE r.business_id = ?1 AND r.kind = 'SALE' AND r.occurred_at >= ?2 AND r.occurred_at < ?3${forCustomer}
      ORDER BY r.occurred_at, ri.id`,
    parameters,
  );
  for (const row of returned) {
    facts.push({ productId: String(row["product_id"]), name: String(row["name"]), productName: text(row["product_name"]),
      categoryId: String(row["category_id"]), categoryName: text(row["category_name"]), categoryNames: names(row), saleId: String(row["sale_id"]),
      userId: String(row["user_id"]), userName: text(row["user_name"]), quantity: -sqlInteger(row["quantity"]),
      revenueMinor: -sqlInteger(row["amount_minor"]), costMinor: -sqlInteger(row["cost_minor"]), uncosted: false, returned: true });
  }
  return facts;
}

/** Groups net facts into report lines, best first; `count` is sale lines, or distinct sales when `countSales`. */
function linesOf(facts: readonly NetSaleFact[], group: (fact: NetSaleFact) => readonly [key: string, label: string], countSales = false): Line[] {
  const groups = new Map<string, { key: string; label: string; total: number; count: number; sales: Set<string> }>();
  for (const fact of facts) {
    const [key, label] = group(fact), id = `${key}\u0000${label}`;
    const current = groups.get(id) ?? { key, label, total: 0, count: 0, sales: new Set<string>() };
    current.total = sumAmounts([current.total, fact.revenueMinor]);
    if (!fact.returned) { current.count++; current.sales.add(fact.saleId); }
    groups.set(id, current);
  }
  return [...groups.values()].map(({ key, label, total, count, sales }) => ({ key, label, totalMinor: total, count: countSales ? sales.size : count }))
    .sort((a, b) => b.totalMinor - a.totalMinor || binary(a.label, b.label));
}

/** SQLite's default BINARY collation, so JavaScript ordering matches the queries it replaced. */
function binary(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
    totalMinor: sumAmounts([sqlInteger(totals?.["lines"] ?? 0), -sqlInteger(sales?.["discounts"] ?? 0), -returnedInPeriod(tx,businessId,"SALE",from,to).totalMinor]),
    transactions: sqlInteger(sales?.["transactions"] ?? 0),
    itemsSoldThousandths: sumAmounts([sqlInteger(totals?.["sold"] ?? 0), -returnedInPeriod(tx,businessId,"SALE",from,to).quantity]),
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

  const returned = returnedInPeriod(tx,businessId,"SALE",from,to);
  const discounts = sqlInteger(tx.get(`SELECT coalesce(sum(discount_minor),0) AS total FROM sales WHERE business_id=? AND occurred_at>=? AND occurred_at<?`,[businessId,from,to])!["total"]!);
  const revenueMinor = sumAmounts([sqlInteger(row?.["revenue"] ?? 0),-discounts,-returned.totalMinor]);
  const costMinor = sumAmounts([sqlInteger(row?.["cost"] ?? 0),-returned.costMinor]);
  return {
    revenueMinor,
    costMinor,
    grossProfitMinor: sumAmounts([revenueMinor,-costMinor]),
    linesWithoutCost: sqlInteger(row?.["blind"] ?? 0),
  };
}

/**
 * What sold, by product, best first (§21).
 *
 * Net, like every sales breakdown here: after line and whole-bill discounts and
 * less returns made in the period (see {@link NetSaleFact}), so the lines sum to
 * {@link salesBetween}'s total. A product only returned in the period shows a
 * negative total and a count of zero.
 */
export function salesByProduct(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): Line[] {
  return linesOf(netSaleFacts(tx, businessId, from, to), fact => [fact.productId, fact.name]);
}

/**
 * What each category sold, best first (§21).
 *
 * Joined through the *product* rather than stored on the sale line, because a
 * category is a way of grouping products and moving one between categories has
 * to move its history with it. A category copied onto the line at the time of
 * sale would leave last month's report grouping by a shelf the shop no longer
 * has, the opposite of what a line's *name* and *price* are copied for, which
 * is that a receipt must show what was actually charged.
 *
 * Products in no category are grouped under an empty key rather than dropped: a
 * breakdown of takings that did not add up to the takings would be worse than
 * an "uncategorised" line. For the same reason the lines are net of discounts
 * and the period's returns, and sum to {@link salesBetween}'s total.
 *
 * Labels are in `language`: a category's French or English name when set (ADR-037), otherwise its main name.
 */
export function salesByCategory(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
  language: Language = "fr",
): Line[] {
  return linesOf(netSaleFacts(tx, businessId, from, to), fact => [fact.categoryId, fact.categoryName === undefined
    ? (language === "en" ? "No category" : "Sans catégorie") : categoryLabel({ name: fact.categoryName, names: fact.categoryNames }, language)]);
}

/**
 * What each account took, best first (§21).
 *
 * By account and never by "payment method": which provider took the money is
 * the account's name, which is what makes adding one a row rather than a
 * release (§10).
 *
 * Net of sale refunds paid out of each account in the period; `count` is the
 * number of sale payments. Credit left owing reaches no account, so these sum to
 * the period's sales only when nothing was sold on credit.
 */
export function salesByAccount(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): Line[] {
  const rows = tx.all(
    `WITH moved AS (
       SELECT p.account_id, p.amount_minor, 1 AS entry
         FROM sale_payments p
        WHERE p.business_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3
       UNION ALL
       SELECT f.account_id, -f.amount_minor, 0
         FROM business_return_refunds f
         JOIN business_returns r ON r.business_id = f.business_id AND r.id = f.return_id
        WHERE r.business_id = ?1 AND r.kind = 'SALE' AND r.occurred_at >= ?2 AND r.occurred_at < ?3)
     SELECT m.account_id AS key,
            coalesce(a.name, m.account_id) AS label,
            sum(m.amount_minor) AS total,
            sum(m.entry) AS entries
       FROM moved m
       LEFT JOIN financial_accounts a ON a.id = m.account_id
      GROUP BY m.account_id, label
      ORDER BY total DESC, label`,
    [businessId, from, to],
  );
  return rows.map(toLine);
}

/**
 * Who sold what, best first: §21's sales by employee.
 *
 * Net of discounts; a return counts against the cashier who made the original
 * sale, in the period it happened. `count` is distinct sales. Sums to
 * {@link salesBetween}'s total.
 */
export function salesByUser(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): Line[] {
  return linesOf(netSaleFacts(tx, businessId, from, to), fact => [fact.userId, fact.userName ?? fact.userId], true);
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
 * What the shop owes every wholesaler, most first (§16, §21).
 *
 * The mirror of {@link outstandingDebt}, and deliberately a separate query over
 * a separate table. One list with a sign would put a customer who owes 5,000 and
 * a wholesaler owed 5,000 on the same line of the same report, and they are
 * opposite obligations; netting them would tell an owner the shop was square
 * when it was owed money by one person and owed money to another.
 *
 * Wholesalers the shop has paid ahead are absent, for the reason customers in
 * credit are: they are not debts, and a list of debts that included them would
 * have to be read twice to be understood.
 */
export function supplierDebt(tx: Queryable, businessId: string): Line[] {
  const rows = tx.all(
    `SELECT t.supplier_id AS key,
            coalesce(s.name, t.supplier_id) AS label,
            sum(t.amount_minor) AS total,
            count(*) AS entries
       FROM supplier_transactions t
       LEFT JOIN suppliers s ON s.id = t.supplier_id
      WHERE t.business_id = ?
      GROUP BY t.supplier_id, label
     HAVING sum(t.amount_minor) > 0
      ORDER BY total DESC, label`,
    [businessId],
  );
  return rows.map(toLine);
}

/**
 * What a period bought, by wholesaler (§21's purchase history).
 *
 * Sliced by when the stock *arrived*, like every period here, so a delivery
 * recorded on a phone that synced on Friday still lands in Monday.
 *
 * A delivery that named nobody (a crate from the market) is grouped under an
 * empty key rather than dropped. What the shop spent on stock is the question,
 * and leaving those out would answer a different one.
 *
 * Less the value of purchase returns made in the period, against the original
 * delivery's wholesaler, so the lines sum to {@link purchasesBetween}'s total.
 * `count` is deliveries received in the period.
 */
export function purchasesBySupplier(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): Line[] {
  const rows = tx.all(
    `WITH facts AS (
       SELECT p.supplier_id AS supplier, ${PURCHASE_LINE_TOTAL} AS total, p.id AS delivery
         FROM purchases p
         JOIN purchase_items i ON i.purchase_id = p.id
        WHERE p.business_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3
       UNION ALL
       SELECT p.supplier_id, -r.total_minor, NULL
         FROM business_returns r
         JOIN purchases p ON p.business_id = r.business_id AND p.id = r.original_id
        WHERE r.business_id = ?1 AND r.kind = 'PURCHASE' AND r.occurred_at >= ?2 AND r.occurred_at < ?3)
     SELECT coalesce(f.supplier, '') AS key,
            coalesce(s.name, 'Sans fournisseur') AS label,
            coalesce(sum(f.total), 0) AS total,
            count(DISTINCT f.delivery) AS entries
       FROM facts f
       LEFT JOIN suppliers s ON s.id = f.supplier
      GROUP BY key, label
      ORDER BY total DESC, label`,
    [businessId, from, to],
  );
  return rows.map(toLine);
}

/** What a period's deliveries cost in total (§21). */
export function purchasesBetween(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): PurchaseSummary {
  const row = tx.get(
    `SELECT coalesce(sum(${PURCHASE_LINE_TOTAL}), 0) AS total,
            count(DISTINCT p.id) AS deliveries,
            coalesce(sum(i.quantity), 0) AS received
       FROM purchases p
       JOIN purchase_items i ON i.purchase_id = p.id
      WHERE p.business_id = ? AND p.occurred_at >= ? AND p.occurred_at < ?`,
    [businessId, from, to],
  );
  return {
    totalMinor: sumAmounts([sqlInteger(row?.["total"] ?? 0),-returnedInPeriod(tx,businessId,"PURCHASE",from,to).totalMinor]),
    deliveries: sqlInteger(row?.["deliveries"] ?? 0),
    receivedThousandths: sumAmounts([sqlInteger(row?.["received"] ?? 0),-returnedInPeriod(tx,businessId,"PURCHASE",from,to).quantity]),
  };
}

/**
 * What a period paid its wholesalers, by wholesaler (§21).
 *
 * Reported positive, though the ledger stores a payment negative: "paid 50,000"
 * is what an owner is asking, and a column of negative numbers under the
 * heading "supplier payments" reads as money coming back.
 *
 * Money handed over at the door is deliberately absent. That is an
 * `account_movements` row against the till, not a ledger entry, because a
 * delivery from the market has no wholesaler to have a ledger; it shows in the
 * period's purchases instead, which is where the goods it bought are.
 */
export function supplierPaymentsBetween(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): Line[] {
  const rows = tx.all(
    `SELECT t.supplier_id AS key,
            coalesce(s.name, t.supplier_id) AS label,
            -sum(t.amount_minor) AS total,
            count(*) AS entries
       FROM supplier_transactions t
       LEFT JOIN suppliers s ON s.id = t.supplier_id
      WHERE t.business_id = ? AND t.type = 'PAYMENT'
        AND t.occurred_at >= ? AND t.occurred_at < ?
      GROUP BY t.supplier_id, label
      ORDER BY total DESC, label`,
    [businessId, from, to],
  );
  return rows.map(toLine);
}

/**
 * What one unit cost, per costing method (§8).
 *
 * The latest cost is the unit cost on the most recent movement that brought
 * stock *in* with one, a delivery or opening stock, which reads as replacement
 * cost: what it would take to restock today. The ledger comes first because the
 * product's `purchase_price` is a field someone edits. When the ledger names no
 * cost, which is how opening stock entered on a product form arrives, that
 * purchase price stands in (owner decision, 2026-10-11): a new shop's stock is
 * then worth what its owner said it cost rather than nothing until the first
 * delivery. Only a product with neither stays an honest gap.
 *
 * A future FIFO or weighted average is another entry here. The report around it
 * does not change.
 */
const COST_OF: Record<CostingMethod, string> = {
  LATEST_COST: `coalesce((SELECT c.unit_cost_minor
                            FROM inventory_movements c
                           WHERE c.business_id = p.business_id
                             AND c.product_id = p.id
                             AND c.type IN ('PURCHASE', 'OPENING_BALANCE')
                             AND c.unit_cost_minor IS NOT NULL
                           ORDER BY c.occurred_at DESC, c.id DESC
                           LIMIT 1),
                         p.purchase_price_minor)`,
};

/**
 * What one unit of a product costs now under `method`, or undefined when nothing says.
 *
 * A sale freezes this on its lines at checkout, so the profit it reports and the
 * valuation of the stock left behind read the same cost (§8); returns and later
 * reports keep the frozen figure.
 */
export function currentUnitCost(
  tx: Queryable,
  businessId: string,
  productId: string,
  method: CostingMethod = "LATEST_COST",
): number | undefined {
  const cost = tx.get(
    `SELECT ${COST_OF[method]} AS unit_cost FROM products p WHERE p.business_id = ? AND p.id = ?`,
    [businessId, productId],
  )?.["unit_cost"];
  return cost === null || cost === undefined ? undefined : sqlInteger(cost);
}

/**
 * What the stock on the shelves is worth (§8, §21).
 *
 * Quantity is the sum of the ledger, as everywhere; the cost comes from
 * {@link COST_OF}. Nothing here is a stored total, which is what makes the
 * valuation and the deliveries behind it incapable of disagreeing.
 *
 * Products holding nothing are absent: a shop that has ever sold out of
 * something would otherwise carry it forever in a report about what it owns.
 * Products holding *less* than nothing are **present, at a negative value**:
 * two devices each selling the last unit offline is expected (§29), and the
 * honest total is below zero until someone counts the shelf. Hiding it would
 * make the one figure that reveals the problem the one figure that conceals it.
 */
export function inventoryValuation(
  tx: Queryable,
  businessId: string,
  method: CostingMethod = "LATEST_COST",
): Valuation {
  const rows = tx.all(
    `SELECT p.id AS product_id, p.name AS name,
            coalesce(sum(m.quantity), 0) AS on_hand,
            ${COST_OF[method]} AS unit_cost
       FROM products p
       LEFT JOIN inventory_movements m
              ON m.product_id = p.id AND m.business_id = p.business_id
      WHERE p.business_id = ?
      GROUP BY p.id, p.name
     HAVING coalesce(sum(m.quantity), 0) <> 0
      ORDER BY p.name`,
    [businessId],
  );

  let totalMinor = 0;
  let uncosted = 0;
  const products = rows.map((row) => {
    const onHandThousandths = sqlInteger(row["on_hand"] ?? 0);
    const rawCost = row["unit_cost"];
    if (rawCost === null || rawCost === undefined) {
      uncosted++;
      return { productId: String(row["product_id"]), name: String(row["name"]), onHandThousandths };
    }

    const unitCostMinor = sqlInteger(rawCost);
    // The same rounding as a sale line and a delivery line, half away from
    // zero, because a valuation is compared against both.
    const valueMinor = valueOf(unitCostMinor, onHandThousandths);
    totalMinor = sumAmounts([totalMinor, valueMinor]);
    return {
      productId: String(row["product_id"]),
      name: String(row["name"]),
      onHandThousandths,
      unitCostMinor,
      valueMinor,
    };
  });

  return { method, totalMinor, products, uncosted };
}

/**
 * Cost times quantity over the scale, rounded half away from zero.
 *
 * In TypeScript rather than SQL because stock can be negative and SQLite's
 * integer division truncates toward zero, which would round a negative holding
 * the wrong way — the one place a valuation and a sale line would disagree.
 */
function valueOf(unitCostMinor: number, thousandths: number): number {
  try { return multiplyRatio(unitCostMinor, thousandths, QUANTITY_SCALE); }
  catch (cause) { throw new RangeError("a stock value is too large to be exact", { cause }); }
}

/**
 * How every product moved over a period, best first (§21).
 *
 * A LEFT JOIN from products rather than a GROUP BY over sale lines, because the
 * products that sold **nothing** are the whole point of the slow end of this
 * list and a join the other way would leave them out. That is the difference
 * between "these sold least" and "these did not sell", and only the second is
 * worth a shopkeeper's attention.
 *
 * Ranked by quantity rather than by takings: a cheap thing that shifts every day
 * is fast-moving even though a single generator outsells a year of it. What it
 * earned is reported alongside, so a caller can see both without a second query.
 *
 * Both are net of the period's returns, and takings are net of whole-bill
 * discounts, so a sale that came back does not make a product look fast.
 */
export function productMovement(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): ProductMovement[] {
  const moved = new Map<string, { sold: number; revenue: number }>();
  for (const fact of netSaleFacts(tx, businessId, from, to)) {
    const current = moved.get(fact.productId) ?? { sold: 0, revenue: 0 };
    moved.set(fact.productId, { sold: sumAmounts([current.sold, fact.quantity]), revenue: sumAmounts([current.revenue, fact.revenueMinor]) });
  }
  const rows = tx.all(
    `SELECT p.id AS product_id, p.name AS name,
            coalesce((SELECT sum(m.quantity)
                        FROM inventory_movements m
                       WHERE m.product_id = p.id AND m.business_id = p.business_id), 0) AS on_hand
       FROM products p
      WHERE p.business_id = ? AND p.active = 1`,
    [businessId],
  );
  return rows.map((row) => {
    const productId = String(row["product_id"]), sold = moved.get(productId);
    return {
      productId,
      name: String(row["name"]),
      soldThousandths: sold?.sold ?? 0,
      revenueMinor: sold?.revenue ?? 0,
      onHandThousandths: sqlInteger(row["on_hand"] ?? 0),
    };
  }).sort((a, b) => b.soldThousandths - a.soldThousandths || b.revenueMinor - a.revenueMinor || binary(a.name, b.name));
}

/** What shifted most over a period (§21). */
export function fastMoving(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
  limit = 10,
): ProductMovement[] {
  return productMovement(tx, businessId, from, to).slice(0, Math.max(0, limit));
}

/**
 * What shifted least over a period, worst first (§21).
 *
 * The same ranking read from the other end, deliberately, so the two lists
 * cannot disagree about where a product sits.
 */
export function slowMoving(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
  limit = 10,
): ProductMovement[] {
  const ranked = productMovement(tx, businessId, from, to);
  return ranked.slice(Math.max(0, ranked.length - Math.max(0, limit))).reverse();
}

/**
 * Stock that has not sold since a date, and what it has tied up (§21).
 *
 * The actionable version of the slow end: a shopkeeper does not need to know
 * that something sold twice instead of thirty times, they need to know which
 * shelves are holding money that is not moving. So this is stock **on hand**
 * that sold **nothing** in the period; a product that sold out is not dead, it
 * is finished, and one nobody stocks is not dead either.
 *
 * The value is at latest cost, and absent when nothing says what it
 * cost: the same honest gap a valuation reports rather than a zero that would
 * make dead stock look free to keep.
 */
export function deadStock(
  tx: Queryable,
  businessId: string,
  since: string,
  method: CostingMethod = "LATEST_COST",
): DeadStock[] {
  const rows = tx.all(
    `SELECT p.id AS product_id, p.name AS name,
            coalesce((SELECT sum(m.quantity)
                        FROM inventory_movements m
                       WHERE m.product_id = p.id AND m.business_id = p.business_id), 0) AS on_hand,
            (SELECT max(s.occurred_at)
               FROM sale_items i
               JOIN sales s ON s.id = i.sale_id
              WHERE i.product_id = p.id AND s.business_id = p.business_id) AS last_sold,
            ${COST_OF[method]} AS unit_cost
       FROM products p
      WHERE p.business_id = ?1 AND p.active = 1
        AND coalesce((SELECT sum(m.quantity)
                        FROM inventory_movements m
                       WHERE m.product_id = p.id AND m.business_id = p.business_id), 0) > 0
        AND NOT EXISTS (SELECT 1
                          FROM sale_items i
                          JOIN sales s ON s.id = i.sale_id
                         WHERE i.product_id = p.id AND s.business_id = p.business_id
                           AND s.occurred_at >= ?2)
      ORDER BY p.name`,
    [businessId, since],
  );

  return rows.map((row) => {
    const onHandThousandths = sqlInteger(row["on_hand"] ?? 0);
    const rawCost = row["unit_cost"];
    const lastSold = row["last_sold"];
    return {
      productId: String(row["product_id"]),
      name: String(row["name"]),
      onHandThousandths,
      ...(lastSold === null || lastSold === undefined ? {} : { lastSoldAt: String(lastSold) }),
      ...(rawCost === null || rawCost === undefined
        ? {}
        : { valueMinor: valueOf(sqlInteger(rawCost), onHandThousandths) }),
    };
  });
}

/**
 * Every source of money that touches an account, as one query.
 *
 * The same five arms `balanceOfAccount` sums, and they must stay the same five:
 * a source added there and not here would give a cash-flow report that did not
 * reconcile with the balance it sits beside, and an owner would have no way to
 * tell which was wrong. The signs follow the same rule — a customer's payment is
 * negated into the account, a supplier's is taken as stored.
 */
const CASH_SOURCES = `
  SELECT account_id, amount_minor, occurred_at FROM sale_payments
   WHERE business_id = ?1
  UNION ALL
  SELECT account_id, -amount_minor, occurred_at FROM customer_transactions
   WHERE business_id = ?1 AND type = 'PAYMENT' AND account_id IS NOT NULL
  UNION ALL
  SELECT account_id, amount_minor, occurred_at FROM account_movements
   WHERE business_id = ?1
  UNION ALL
  SELECT account_id, -amount_minor, occurred_at FROM expenses
   WHERE business_id = ?1
  UNION ALL
  SELECT account_id, amount_minor, occurred_at FROM supplier_transactions
   WHERE business_id = ?1 AND type = 'PAYMENT' AND account_id IS NOT NULL`;

/**
 * What went in and out of each account over a period (§21).
 *
 * In and out are reported apart rather than netted, because "took 400,000 and
 * paid out 380,000" and "took 20,000" are different days and only the first is
 * the truth about a busy one.
 *
 * The closing figure is the whole history, not the period: an owner comparing a
 * report against the drawer is asking what is in it now, and a period-only
 * figure would disagree with §18's count for a reason nobody could see.
 *
 * Accounts nothing has ever moved through are absent. An account opened and
 * never used has no flow to report, and a row of zeroes would read as one that
 * had been emptied.
 */
export function cashFlow(
  tx: Queryable,
  businessId: string,
  from: string,
  to: string,
): CashFlow[] {
  const rows = tx.all(
    `WITH moved AS (${CASH_SOURCES})
     SELECT a.id AS account_id, a.name AS name,
            coalesce(sum(CASE WHEN m.occurred_at >= ?2 AND m.occurred_at < ?3
                               AND m.amount_minor > 0
                              THEN m.amount_minor END), 0) AS took,
            coalesce(sum(CASE WHEN m.occurred_at >= ?2 AND m.occurred_at < ?3
                               AND m.amount_minor < 0
                              THEN -m.amount_minor END), 0) AS paid,
            coalesce(sum(m.amount_minor), 0) AS closing,
            count(m.amount_minor) AS entries
       FROM financial_accounts a
       JOIN moved m ON m.account_id = a.id
      WHERE a.business_id = ?1
      GROUP BY a.id, a.name
     HAVING entries > 0
      ORDER BY a.name`,
    [businessId, from, to],
  );

  return rows.map((row) => {
    const inMinor = sqlInteger(row["took"] ?? 0);
    const outMinor = sqlInteger(row["paid"] ?? 0);
    return {
      accountId: String(row["account_id"]),
      name: String(row["name"]),
      inMinor,
      outMinor,
      netMinor: sumAmounts([inMinor,-outMinor]),
      closingMinor: sqlInteger(row["closing"] ?? 0),
    };
  });
}

/**
 * A customer's statement: every entry, oldest first, with a running balance
 * (§13, §21's payment history).
 *
 * Ordered by when things **happened**, not when they arrived, so an entry synced
 * days late lands where it belongs and the running balance reads as the customer
 * experienced it. That is why the balance is worked out in order here rather
 * than by a window function over arrival: a statement whose lines are right but
 * whose running total is in arrival order would be a document that adds up and
 * still cannot be read aloud.
 *
 * The whole ledger, not a period. A statement covering last month that opened at
 * zero would claim a debt began then, and the argument this is for is about what
 * is owed in total.
 */
export function customerStatement(
  tx: Queryable,
  businessId: string,
  customerId: string,
): StatementEntry[] {
  const rows = tx.all(
    `SELECT id, type, amount_minor, reference_kind, reference_id, reason, occurred_at
       FROM customer_transactions
      WHERE business_id = ? AND customer_id = ?
      ORDER BY occurred_at, id`,
    [businessId, customerId],
  );

  let balanceMinor = 0;
  return rows.map((row) => {
    const amountMinor = sqlInteger(row["amount_minor"] ?? 0);
    balanceMinor = sumAmounts([balanceMinor,amountMinor]);
    const kind = row["reference_kind"];
    const reference = row["reference_id"];
    return {
      id: String(row["id"]),
      type: String(row["type"]),
      amountMinor,
      ...(kind === null || kind === undefined || reference === null || reference === undefined
        ? {}
        : { reference: `${String(kind)}:${String(reference)}` }),
      ...(row["reason"] === null || row["reason"] === undefined
        ? {}
        : { reason: String(row["reason"]) }),
      occurredAt: String(row["occurred_at"]),
      balanceMinor,
    };
  });
}

/**
 * What a customer bought over a period, by product (§21's purchase history).
 *
 * Every sale to them, not only the ones on credit: "what does this person buy"
 * is a question about a regular, and answering it from the credit ledger alone
 * would describe only the days they happened to be short.
 *
 * Net of discounts and of the returns they made in the period.
 */
export function customerPurchases(
  tx: Queryable,
  businessId: string,
  customerId: string,
  from: string,
  to: string,
): Line[] {
  return linesOf(netSaleFacts(tx, businessId, from, to, customerId), fact => [fact.productId, fact.name]);
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
 * What is owed *to* the shop and what is owed *by* it are two figures, never one
 * netted number. An owner with 80,000 out on credit and 80,000 owed to a
 * wholesaler is not square: one of those arrives when customers choose to pay
 * and the other falls due when the van comes back.
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
  const expensesMinor = sqlInteger(spent?.["spent"] ?? 0);

  const owed = outstandingDebt(tx, businessId);
  const customerDebtMinor = sumAmounts(owed.map(line => line.totalMinor));
  const owing = supplierDebt(tx, businessId);
  const supplierDebtMinor = sumAmounts(owing.map(line => line.totalMinor));

  return {
    sales,
    profit,
    expensesMinor,
    netResultMinor: sumAmounts([profit.grossProfitMinor,-expensesMinor]),
    customerDebtMinor,
    supplierDebtMinor,
    lowStock: lowStock(tx, businessId).length,
  };
}

function toLine(row: Record<string, unknown>): Line {
  return {
    key: String(row["key"]),
    label: String(row["label"]),
    totalMinor: sqlInteger(row["total"] ?? 0),
    count: sqlInteger(row["entries"] ?? 0),
  };
}

function returnedInPeriod(tx: Queryable, shop: string, kind: "SALE" | "PURCHASE", from: string, to: string): { totalMinor: number; costMinor: number; quantity: number } {
  const totals=tx.get(`SELECT coalesce(sum(total_minor),0) AS total,coalesce(sum(cost_minor),0) AS cost FROM business_returns WHERE business_id=? AND kind=? AND occurred_at>=? AND occurred_at<?`,[shop,kind,from,to])!;
  const units=tx.get(`SELECT coalesce(sum(i.quantity),0) AS quantity FROM business_return_items i JOIN business_returns r ON r.business_id=i.business_id AND r.id=i.return_id WHERE r.business_id=? AND r.kind=? AND r.occurred_at>=? AND r.occurred_at<?`,[shop,kind,from,to])!;
  return { totalMinor: sqlInteger(totals["total"]!), costMinor: sqlInteger(totals["cost"]!), quantity: sqlInteger(units["quantity"]!) };
}
