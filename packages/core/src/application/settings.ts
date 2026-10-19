import type { Queryable } from "../data/database/driver.ts";
import { agedParties, agingOf, shopTerms, termsFor, type EffectiveTerms, type TermsParty } from "../data/finance/terms.ts";
import { effectiveTaxRate, productTaxRule, taxSettings, type ProductTaxRule, type TaxSettings } from "../data/products/tax.ts";
import { activeMember, authorizedOperation, memberPermissions } from "../identity/internal-authority.ts";
import { WorkspaceError, type OperationContext } from "../identity/types.ts";
import type { Permission } from "../identity/permissions.ts";
import type { DebtAging } from "../rules/terms.ts";

/**
 * Reads for tax settings and payment terms (ADR-033). Writes are `setTaxSettings`, `setProductTaxRule` and
 * `setPaymentTerms` in `operations`. Business IDs come from the unlock context.
 */

function requireAny(tx: Queryable, context: OperationContext, permissions: readonly Permission[]): readonly Permission[] {
  const held = memberPermissions(tx, activeMember(tx, context, context.userId));
  if (!permissions.some(permission => held.includes(permission))) throw new WorkspaceError("permission_denied");
  return held;
}
function viewPermission(party: TermsParty): Permission {
  if (party !== "CUSTOMER" && party !== "SUPPLIER") throw new WorkspaceError("invalid_input");
  return party === "CUSTOMER" ? "customers.view" : "suppliers.view";
}

/** The shop's tax settings, readable by any unlocked member: tills need the label and rate to show receipts. */
export function shopTaxSettings(context: OperationContext): TaxSettings {
  return authorizedOperation(context, [], (_db, tx) => taxSettings(tx, context.businessId));
}

/** A product's tax rule and the rate a sale would carry now, under products.view. */
export function productTax(context: OperationContext, productId: string): ProductTaxRule & { readonly effectiveRateBasisPoints: number } {
  return authorizedOperation(context, ["products.view"], (_db, tx) => {
    const product = tx.get(`SELECT business_id FROM products WHERE id = ?`, [productId]);
    if (product?.["business_id"] !== context.businessId) throw new WorkspaceError("scope_mismatch");
    return { ...productTaxRule(tx, context.businessId, productId), effectiveRateBasisPoints: effectiveTaxRate(tx, context.businessId, productId) };
  });
}

/** Shop default terms for customers and suppliers; readable with customers.view, suppliers.view or business.settings. */
export function shopPaymentTerms(context: OperationContext): { readonly customer: ReturnType<typeof shopTerms>; readonly supplier: ReturnType<typeof shopTerms> } {
  return authorizedOperation(context, [], (_db, tx) => {
    requireAny(tx, context, ["customers.view", "suppliers.view", "business.settings"]);
    return { customer: shopTerms(tx, context.businessId, "CUSTOMER"), supplier: shopTerms(tx, context.businessId, "SUPPLIER") };
  });
}

/** One customer's or supplier's terms and aged balance at `now`, under customers.view or suppliers.view. */
export function creditStatus(context: OperationContext, party: TermsParty, partyId: string, now: string): EffectiveTerms & DebtAging {
  return authorizedOperation(context, [viewPermission(party)], (_db, tx) => {
    const row = tx.get(`SELECT business_id FROM ${party === "CUSTOMER" ? "customers" : "suppliers"} WHERE id = ?`, [partyId]);
    if (row?.["business_id"] !== context.businessId) throw new WorkspaceError("scope_mismatch");
    const { termsDays: _days, ...aging } = agingOf(tx, context.businessId, party, partyId, now);
    return { ...termsFor(tx, context.businessId, party, partyId), ...aging };
  });
}

/**
 * Customers (or suppliers) with a positive balance, aged under their terms: most overdue first, then most due soon.
 * Bounded to `limit` (1–500, default 100) with a `truncated` flag.
 */
export function agedBalances(context: OperationContext, party: TermsParty, now: string, limit = 100): { readonly items: readonly (DebtAging & { readonly partyId: string; readonly name: string; readonly termsDays: number })[]; readonly truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new WorkspaceError("invalid_input");
  return authorizedOperation(context, [viewPermission(party)], (_db, tx) => {
    const all = agedParties(tx, context.businessId, party, now);
    return { items: all.slice(0, limit), truncated: all.length > limit };
  });
}
