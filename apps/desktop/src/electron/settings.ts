import { setPaymentTerms, setProductTaxRule, setTaxSettings } from "@kolo/core/application/operations";
import { creditStatus as readCreditStatus, productTax as readProductTax, shopPaymentTerms, shopTaxSettings } from "@kolo/core/application/settings";
import { markNotificationsAnnounced, markNotificationsRead, notifications as readNotifications } from "@kolo/core/application/notifications";
import { WorkspaceError } from "@kolo/core/identity/types";
import type { CreditStatusView, NotificationsView, PaymentTermsView, ProductTaxView, TaxSettingsView } from "../shared/service.js";
import { boolean, object, optional, text, uuid, whole } from "./validation.ts";
import { CommandError, nextVersion, type Host } from "./host.ts";

/**
 * Tax settings, product tax rules, payment terms and notifications (ADR-033). Edits name the version they were made
 * from: an identical request returns the stored value, a newer stored version is never overwritten.
 */

function party(value: unknown): "CUSTOMER" | "SUPPLIER" {
  if (value !== "CUSTOMER" && value !== "SUPPLIER") throw new WorkspaceError("invalid_input");
  return value;
}
function termsDays(value: unknown): number { const days = whole(value); if (days > 3650) throw new WorkspaceError("invalid_input"); return days; }
function rate(value: unknown): number { const result = whole(value); if (result > 10000) throw new WorkspaceError("invalid_input"); return result; }
function version(data: Record<string, unknown>): string | undefined { return optional(data["version"], value => text(value, 64)); }
function checkVersion(stored: string | undefined, requested: string | undefined): void { if (stored !== requested) throw new CommandError("request_conflict"); }
function next(host: Host, stored: string | undefined): string { return stored === undefined ? host.ports.now() : nextVersion(host, stored); }

function taxView(value: ReturnType<typeof shopTaxSettings>): TaxSettingsView {
  return { enabled: value.enabled, label: value.label, standardRateBasisPoints: value.standardRateBasisPoints,
    ...(value.registration === undefined ? {} : { registration: value.registration }), ...(value.updatedAt === undefined ? {} : { version: value.updatedAt }) };
}

/** The shop's tax settings; any signed-in member may read them. */
export function taxSettings(host: Host, input: unknown): TaxSettingsView {
  return taxView(shopTaxSettings(host.actor(object(input, ["sessionId"]))));
}
/** Saves the shop's tax settings under business.settings from the displayed version. */
export function updateTaxSettings(host: Host, input: unknown): TaxSettingsView {
  const data = object(input, ["sessionId", "version", "enabled", "label", "standardRateBasisPoints", "registration"]), context = host.actor(data, ["business.settings"]);
  const wanted = { enabled: boolean(data["enabled"]), label: text(data["label"], 20), standardRateBasisPoints: rate(data["standardRateBasisPoints"]),
    registration: optional(data["registration"], value => text(value, 40)) };
  return host.ports.database.transaction(() => {
    const stored = shopTaxSettings(context);
    if (stored.enabled === wanted.enabled && stored.label === wanted.label && stored.standardRateBasisPoints === wanted.standardRateBasisPoints && stored.registration === wanted.registration && stored.updatedAt !== undefined) return taxView(stored);
    checkVersion(stored.updatedAt, version(data));
    if (!setTaxSettings(context, { ...wanted, updatedAt: next(host, stored.updatedAt) })) throw new CommandError("request_conflict");
    return taxView(shopTaxSettings(context));
  });
}

function productTaxView(value: ReturnType<typeof readProductTax>): ProductTaxView {
  return { rule: value.rule, ...(value.rule === "RATE" ? { rateBasisPoints: value.rateBasisPoints } : {}), effectiveRateBasisPoints: value.effectiveRateBasisPoints,
    ...(value.updatedAt === undefined ? {} : { version: value.updatedAt }) };
}
/** A product's tax rule and the rate it would sell at now, under products.view. */
export function productTax(host: Host, input: unknown): ProductTaxView {
  const data = object(input, ["sessionId", "productId"]);
  return productTaxView(readProductTax(host.actor(data, ["products.view"]), uuid(data["productId"])));
}
/** Sets a product's tax rule under products.edit from the displayed version. */
export function setProductTax(host: Host, input: unknown): ProductTaxView {
  const data = object(input, ["sessionId", "productId", "version", "rule", "rateBasisPoints"]), context = host.actor(data, ["products.edit"]), productId = uuid(data["productId"]);
  const rule = data["rule"];
  if (rule !== "STANDARD" && rule !== "EXEMPT" && rule !== "RATE") throw new WorkspaceError("invalid_input");
  const own = rule === "RATE" ? rate(data["rateBasisPoints"]) : undefined;
  if (rule !== "RATE" && data["rateBasisPoints"] !== undefined || own === 0) throw new WorkspaceError("invalid_input");
  return host.ports.database.transaction(() => {
    const stored = readProductTax(context, productId);
    if (stored.updatedAt !== undefined && stored.rule === rule && (stored.rule !== "RATE" || stored.rateBasisPoints === own)) return productTaxView(stored);
    checkVersion(stored.updatedAt, version(data));
    const at = next(host, stored.updatedAt);
    if (!setProductTaxRule(context, rule === "RATE" ? { productId, rule, rateBasisPoints: own!, updatedAt: at } : { productId, rule, updatedAt: at })) throw new CommandError("request_conflict");
    return productTaxView(readProductTax(context, productId));
  });
}

function termsView(value: ReturnType<typeof shopPaymentTerms>): PaymentTermsView {
  const one = (item: ReturnType<typeof shopPaymentTerms>["customer"]) => ({ days: item.days, stored: item.stored, ...(item.version === undefined ? {} : { version: item.version }) });
  return { customer: one(value.customer), supplier: one(value.supplier) };
}
/** The shop's default payment terms for customers and suppliers. */
export function paymentTerms(host: Host, input: unknown): PaymentTermsView {
  return termsView(shopPaymentTerms(host.actor(object(input, ["sessionId"]))));
}
/** Sets the shop's default terms for one party kind under business.settings. */
export function setShopTerms(host: Host, input: unknown): PaymentTermsView {
  const data = object(input, ["sessionId", "party", "days", "version"]), context = host.actor(data, ["business.settings"]), kind = party(data["party"]), days = termsDays(data["days"]);
  return host.ports.database.transaction(() => {
    const stored = shopPaymentTerms(context)[kind === "CUSTOMER" ? "customer" : "supplier"];
    if (stored.stored && stored.days === days) return termsView(shopPaymentTerms(context));
    checkVersion(stored.version, version(data));
    if (!setPaymentTerms(context, { party: kind, days, updatedAt: next(host, stored.version) })) throw new CommandError("request_conflict");
    return termsView(shopPaymentTerms(context));
  });
}

function creditView(value: ReturnType<typeof readCreditStatus>): CreditStatusView {
  return { days: value.days, source: value.source, ...(value.partyDays === undefined ? {} : { partyDays: value.partyDays }), ...(value.partyVersion === undefined ? {} : { version: value.partyVersion }),
    balanceMinor: value.balanceMinor, overdueMinor: value.overdueMinor, dueSoonMinor: value.dueSoonMinor,
    ...(value.oldestDueAt === undefined ? {} : { oldestDueAt: value.oldestDueAt }), ...(value.nextDueAt === undefined ? {} : { nextDueAt: value.nextDueAt }) };
}
/** One customer's or supplier's terms and what is overdue or due soon now. */
export function creditStatus(host: Host, input: unknown): CreditStatusView {
  const data = object(input, ["sessionId", "party", "partyId"]);
  return creditView(readCreditStatus(host.actor(data), party(data["party"]), uuid(data["partyId"]), host.ports.now()));
}
/** Sets (or, with `days: null`, clears) one party's own terms under customers.manage or suppliers.manage. */
export function setPartyTerms(host: Host, input: unknown): CreditStatusView {
  const data = object(input, ["sessionId", "party", "partyId", "days", "version"]), kind = party(data["party"]), partyId = uuid(data["partyId"]);
  const context = host.actor(data, [kind === "CUSTOMER" ? "customers.manage" : "suppliers.manage"]), days = data["days"] === null ? null : termsDays(data["days"]);
  return host.ports.database.transaction(() => {
    const stored = readCreditStatus(context, kind, partyId, host.ports.now());
    if (stored.partyVersion !== undefined && (stored.partyDays ?? null) === days) return creditView(stored);
    if (stored.partyVersion === undefined && days === null) return creditView(stored);
    checkVersion(stored.partyVersion, version(data));
    if (!setPaymentTerms(context, { party: kind, partyId, days, updatedAt: next(host, stored.partyVersion) })) throw new CommandError("request_conflict");
    return creditView(readCreditStatus(context, kind, partyId, host.ports.now()));
  });
}

/** Current notifications for the signed-in member, most serious first. */
export function notifications(host: Host, input: unknown): NotificationsView {
  return readNotifications(host.actor(object(input, ["sessionId"])), host.ports.now());
}
/**
 * Marks notifications read (all when `keys` is absent), or with `announced: true` only as shown by the system so
 * they are not raised again. Returns the refreshed list.
 */
export function markNotifications(host: Host, input: unknown): NotificationsView {
  const data = object(input, ["sessionId", "keys", "announced"]), context = host.actor(data), now = host.ports.now();
  const keys = optional(data["keys"], value => { if (!Array.isArray(value) || value.length > 500) throw new WorkspaceError("invalid_input"); return value.map(key => text(key, 200, false)); });
  if (optional(data["announced"], boolean) === true) { if (keys === undefined) throw new WorkspaceError("invalid_input"); markNotificationsAnnounced(context, now, keys); }
  else markNotificationsRead(context, now, keys);
  return readNotifications(context, now);
}
