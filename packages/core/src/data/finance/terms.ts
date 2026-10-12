import type { Queryable } from "../database/driver.ts";
import { sqlInteger } from "../database/safe-values.ts";
import { ageOutstanding, checkTermsDays, DEFAULT_TERMS_DAYS, type DebtAging, type LedgerEntry } from "../../rules/terms.ts";

/**
 * Payment terms and the due dates they imply (ADR-033).
 *
 * Terms are state: last write wins by `(updated_at, updated_by_device)`, like customer details. Due dates are never
 * stored; they are derived from the append-only ledgers, so changing terms re-ages history without editing it.
 */

/** Whose debts the terms govern: what customers owe the shop, or what the shop owes suppliers. */
export type TermsParty = "CUSTOMER" | "SUPPLIER";

/** The stored row key: the party's own ID, or `<business>:<party>` for the shop default. */
export function paymentTermsKey(businessId: string, party: TermsParty, partyId?: string): string {
  return partyId ?? `${businessId}:${party}`;
}

/** One terms record as written by `PAYMENT_TERMS_SET`. `days` null on a party means "use the shop default". */
export interface PaymentTermsRecord {
  readonly businessId: string; readonly party: TermsParty; readonly partyId?: string | undefined;
  readonly days: number | null; readonly updatedAt: string;
}

/**
 * Writes terms under last-write-wins, inside the caller's transaction. Returns false when a newer record is already
 * stored, so a losing local or replayed write changes nothing.
 */
export function writePaymentTerms(tx: Queryable, record: PaymentTermsRecord, deviceId: string): boolean {
  if (record.days === null ? record.partyId === undefined : checkTermsDays(record.days) !== record.days) throw new RangeError("invalid payment terms");
  const id = paymentTermsKey(record.businessId, record.party, record.partyId);
  const old = tx.get(`SELECT business_id, updated_at, updated_by_device FROM payment_terms WHERE id = ?`, [id]);
  if (old !== undefined && old["business_id"] !== record.businessId) throw new RangeError("payment terms belong to another shop");
  if (old !== undefined && !(record.updatedAt > String(old["updated_at"]) || record.updatedAt === old["updated_at"] && deviceId > String(old["updated_by_device"]))) return false;
  tx.run(`INSERT INTO payment_terms(id, business_id, party, party_id, days, updated_at, updated_by_device) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET days = excluded.days, updated_at = excluded.updated_at, updated_by_device = excluded.updated_by_device`,
  [id, record.businessId, record.party, record.partyId ?? null, record.days, record.updatedAt, deviceId]);
  return true;
}

/** Terms in force for one party, and where they come from. */
export interface EffectiveTerms {
  readonly days: number;
  /** `party` when the party has its own terms, `shop` for the stored shop default, `default` when nothing is stored. */
  readonly source: "party" | "shop" | "default";
  /** The party's own stored days, when set (null only when explicitly reset to the default). */
  readonly partyDays?: number | undefined;
  /** Version of the party's own record, for last-write-wins edits. */
  readonly partyVersion?: string | undefined;
}

/** The shop default for a party kind, with the stored version when there is one. */
export function shopTerms(tx: Queryable, businessId: string, party: TermsParty): { readonly days: number; readonly stored: boolean; readonly version?: string } {
  const row = tx.get(`SELECT days, updated_at FROM payment_terms WHERE id = ? AND business_id = ?`, [paymentTermsKey(businessId, party), businessId]);
  return row === undefined || row["days"] === null ? { days: DEFAULT_TERMS_DAYS, stored: false } : { days: sqlInteger(row["days"]), stored: true, version: String(row["updated_at"]) };
}

/** Terms in force for one customer or supplier. */
export function termsFor(tx: Queryable, businessId: string, party: TermsParty, partyId: string): EffectiveTerms {
  const shop = shopTerms(tx, businessId, party);
  const own = tx.get(`SELECT days, updated_at FROM payment_terms WHERE id = ? AND business_id = ? AND party = ?`, [partyId, businessId, party]);
  const version = own === undefined ? {} : { partyVersion: String(own["updated_at"]) };
  if (own !== undefined && own["days"] !== null) return { days: sqlInteger(own["days"]), source: "party", partyDays: sqlInteger(own["days"]), ...version };
  return { days: shop.days, source: shop.stored ? "shop" : "default", ...version };
}

function ledger(party: TermsParty): { table: string; column: string } {
  return party === "CUSTOMER" ? { table: "customer_transactions", column: "customer_id" } : { table: "supplier_transactions", column: "supplier_id" };
}

/** The aging of one party's ledger under its current terms. */
export function agingOf(tx: Queryable, businessId: string, party: TermsParty, partyId: string, now: string): DebtAging & { readonly termsDays: number } {
  const { table, column } = ledger(party), terms = termsFor(tx, businessId, party, partyId);
  const balance = sqlInteger(tx.get(`SELECT coalesce(sum(amount_minor), 0) AS n FROM ${table} WHERE business_id = ? AND ${column} = ?`, [businessId, partyId])!["n"]!);
  const debts = balance <= 0 ? [] : coveringDebts(tx, table, column, businessId, partyId).get(partyId)?.entries ?? [];
  return { ...ageOutstanding(debts, balance, terms.days, now), termsDays: terms.days };
}

/** Every party of a kind that owes (or is owed) a positive balance, aged under its terms, highest overdue first. */
export function agedParties(tx: Queryable, businessId: string, party: TermsParty, now: string): readonly (DebtAging & { readonly partyId: string; readonly name: string; readonly termsDays: number })[] {
  const { table, column } = ledger(party);
  const shop = shopTerms(tx, businessId, party).days;
  const own = new Map(tx.all(`SELECT party_id, days FROM payment_terms WHERE business_id = ? AND party = ? AND party_id IS NOT NULL AND days IS NOT NULL`, [businessId, party])
    .map(row => [String(row["party_id"]), sqlInteger(row["days"])]));
  const result = [...coveringDebts(tx, table, column, businessId).entries()].map(([partyId, { balance, name, entries }]) => {
    const termsDays = own.get(partyId) ?? shop;
    return { partyId, name, termsDays, ...ageOutstanding(entries, balance, termsDays, now) };
  });
  return result.sort((a, b) => b.overdueMinor - a.overdueMinor || b.dueSoonMinor - a.dueSoonMinor || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.partyId < b.partyId ? -1 : 1));
}

/**
 * The newest positive entries that cover each positive balance: the debts still unpaid when the oldest is settled
 * first. Bounded by what is owed rather than by ledger length.
 */
function coveringDebts(tx: Queryable, table: string, column: string, businessId: string, partyId?: string): Map<string, { balance: number; name: string; entries: LedgerEntry[] }> {
  const names = table === "customer_transactions" ? "customers" : "suppliers";
  const rows = tx.all(`WITH balances AS (
      SELECT ${column} AS party_id, sum(amount_minor) AS balance FROM ${table}
       WHERE business_id = ?${partyId === undefined ? "" : ` AND ${column} = ?`} GROUP BY ${column} HAVING sum(amount_minor) > 0),
    debts AS (
      SELECT t.${column} AS party_id, t.id, t.amount_minor, t.occurred_at, b.balance,
             sum(t.amount_minor) OVER (PARTITION BY t.${column} ORDER BY t.occurred_at DESC, t.id DESC) AS covered
        FROM ${table} t JOIN balances b ON b.party_id = t.${column}
       WHERE t.business_id = ? AND t.amount_minor > 0)
    SELECT d.*, coalesce(p.name, d.party_id) AS name FROM debts d LEFT JOIN ${names} p ON p.id = d.party_id
     WHERE d.covered - d.amount_minor < d.balance ORDER BY d.party_id, d.occurred_at DESC, d.id DESC`,
  partyId === undefined ? [businessId, businessId] : [businessId, partyId, businessId]);
  const result = new Map<string, { balance: number; name: string; entries: LedgerEntry[] }>();
  for (const row of rows) {
    const id = String(row["party_id"]);
    let party = result.get(id);
    if (party === undefined) { party = { balance: sqlInteger(row["balance"]!), name: String(row["name"]), entries: [] }; result.set(id, party); }
    party.entries.push({ id: String(row["id"]), amountMinor: sqlInteger(row["amount_minor"]!), occurredAt: String(row["occurred_at"]) });
  }
  return result;
}
