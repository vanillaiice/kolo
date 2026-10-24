import { useState } from "react";
import { Text } from "react-native";
import { setPaymentTerms, setProductTaxRule, setTaxSettings } from "@kolo/core/application/operations";
import { creditStatus, productTax, shopPaymentTerms, shopTaxSettings } from "@kolo/core/application/settings";
import { product as productRead } from "@kolo/core/application/records";
import { rateEntry, rateInput } from "@kolo/core/domain/entry";
import { formatMoney, formatRate } from "@kolo/core/domain/money";
import { useText } from "../../app/i18n.tsx";
import { useLeaveGuard, useNav, useParams } from "../../app/navigation.tsx";
import { usePermissions, useRevision, useSession } from "../../app/session.tsx";
import { FormProblem, useAction } from "../../components/command.tsx";
import { Button, Facts, Field, Notice, Screen, Section, Segmented, Toggle, useStyles } from "../../components/ui.tsx";
import { formatDate, nextVersion, useRecord } from "../shared.tsx";

/** Whole days from 0 to 3650; anything else is refused with the terms message. */
function daysEntry(value: string): number {
  const trimmed = value.trim();
  if (!/^\d{1,4}$/.test(trimmed) || Number(trimmed) > 3650) throw new FormProblem("termsInvalid");
  return Number(trimmed);
}
function rate(value: string): number { try { return rateEntry(value); } catch { throw new FormProblem("taxRateInvalid"); } }
/** The version a last-write-wins edit writes: after the stored one, never behind it. */
function version(stored: string | undefined): string { return stored === undefined ? new Date().toISOString() : nextVersion(stored); }

/** Shop tax settings (business.settings, ADR-033): prices include tax; a change applies to new sales only. */
export function ShopTaxScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context } = useSession(), action = useAction(), revision = useRevision(["settings"]);
  const loaded = useRecord(() => shopTaxSettings(context), [context, revision]).value;
  const [enabled, setEnabled] = useState(loaded?.enabled ?? false), [label, setLabel] = useState(loaded?.label ?? "TVA");
  const [standard, setStandard] = useState(loaded === undefined ? "19.25" : rateInput(loaded.standardRateBasisPoints)), [registration, setRegistration] = useState(loaded?.registration ?? "");
  useLeaveGuard(loaded !== undefined && (enabled !== loaded.enabled || label !== loaded.label || standard !== rateInput(loaded.standardRateBasisPoints) || registration !== (loaded.registration ?? "")));
  const save = (): void => action.run(() => {
    const trimmed = label.trim();
    if (trimmed === "" || trimmed.length > 20) throw new FormProblem("taxLabelInvalid");
    const stored = shopTaxSettings(context);
    if (stored.updatedAt !== loaded?.updatedAt) throw new FormProblem("changedMeanwhile");
    if (!setTaxSettings(context, { enabled, label: trimmed, standardRateBasisPoints: rate(standard), ...(registration.trim() === "" ? {} : { registration: registration.trim() }), updatedAt: version(stored.updatedAt) })) throw new FormProblem("newerEdit");
  }, () => nav.leave(), "saved");
  return <Screen title={t("taxTitle")} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={save} /></>}>
    <Notice text={t("taxHelp")} />
    <Section><Toggle label={t("taxEnabled")} value={enabled} onChange={setEnabled} hint={t("hint.taxEnabled")} />
      <Field label={t("taxLabel")} value={label} onChange={setLabel} hint={t("hint.taxLabel")} />
      <Field label={t("taxRate")} value={standard} onChange={setStandard} kind="quantity" hint={t("hint.taxRate")} />
      <Field label={t("taxRegistration")} value={registration} onChange={setRegistration} kind="code" hint={t("hint.taxRegistration")} /></Section>
  </Screen>;
}

/** Shop default payment terms for customers and suppliers (business.settings). */
export function ShopTermsScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context } = useSession(), action = useAction(), revision = useRevision(["settings"]);
  const loaded = useRecord(() => shopPaymentTerms(context), [context, revision]).value;
  const [customer, setCustomer] = useState(String(loaded?.customer.days ?? 30)), [supplier, setSupplier] = useState(String(loaded?.supplier.days ?? 30));
  useLeaveGuard(loaded !== undefined && (customer !== String(loaded.customer.days) || supplier !== String(loaded.supplier.days)));
  const save = (): void => action.run(() => {
    const stored = shopPaymentTerms(context), wanted = { CUSTOMER: daysEntry(customer), SUPPLIER: daysEntry(supplier) };
    for (const party of ["CUSTOMER", "SUPPLIER"] as const) {
      const current = party === "CUSTOMER" ? stored.customer : stored.supplier;
      if (current.stored && current.days === wanted[party]) continue;
      if (!setPaymentTerms(context, { party, days: wanted[party], updatedAt: version(current.version) })) throw new FormProblem("newerEdit");
    }
  }, () => nav.leave(), "saved");
  return <Screen title={t("termsTitle")} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={save} /></>}>
    <Notice text={t("termsHelp")} />
    <Section><Field label={t("termsCustomers")} value={customer} onChange={setCustomer} kind="code" hint={t("hint.termsDays")} />
      <Field label={t("termsSuppliers")} value={supplier} onChange={setSupplier} kind="code" hint={t("hint.termsDays")} />
      {loaded !== undefined && (!loaded.customer.stored || !loaded.supplier.stored) && <Notice text={t("termsDefaultNote")} />}</Section>
  </Screen>;
}

/** Due-date facts for a customer or supplier detail screen. */
export function CreditFacts({ kind, id }: { readonly kind: "customer" | "supplier"; readonly id: string }): React.JSX.Element | null {
  const { t, language } = useText(), { context } = useSession(), revision = useRevision(kind === "customer" ? ["customers", "sales", "settings"] : ["suppliers", "purchases", "settings"]);
  const status = useRecord(() => creditStatus(context, kind === "customer" ? "CUSTOMER" : "SUPPLIER", id, new Date().toISOString()), [context, kind, id, revision]).value;
  if (status === undefined) return null;
  const date = (value: string | undefined): string | undefined => value === undefined ? undefined : formatDate(value, language, false);
  return <Facts items={[[t("termsTitle"), `${t("termsDaysValue", { days: status.days })} · ${t(`termsSource.${status.source}`)}`],
    ...(status.balanceMinor > 0 ? [[t("overdue"), formatMoney(status.overdueMinor), status.overdueMinor > 0 ? "danger" : undefined] as const,
      [t("dueSoon"), status.dueSoonMinor > 0 ? formatMoney(status.dueSoonMinor) : undefined] as const,
      [t("oldestDue"), date(status.oldestDueAt)] as const, [t("nextDue"), date(status.nextDueAt)] as const] : [])]} />;
}

/** One customer's or supplier's own payment terms, or back to the shop default. */
export function PartyTermsScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { kind, id } = useParams("partyTerms"), { context } = useSession(), action = useAction();
  const party = kind === "customer" ? "CUSTOMER" : "SUPPLIER", revision = useRevision(["settings"]);
  const loaded = useRecord(() => creditStatus(context, party, id, new Date().toISOString()), [context, party, id, revision]).value;
  const [days, setDays] = useState(String(loaded?.days ?? 30));
  useLeaveGuard(loaded !== undefined && days !== String(loaded.days));
  const write = (value: number | null): void => action.run(() => {
    const stored = creditStatus(context, party, id, new Date().toISOString());
    if (!setPaymentTerms(context, { party, partyId: id, days: value, updatedAt: version(stored.partyVersion) })) throw new FormProblem("newerEdit");
  }, () => nav.leave(), "saved");
  return <Screen title={t("termsTitle")} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={() => { try { write(daysEntry(days)); } catch (error) { if (error instanceof FormProblem) action.show({ tone: "error", key: error.key }); } }} />
    {loaded?.source === "party" && <Button label={t("useShopTerms")} variant="secondary" onPress={() => write(null)} />}</>}>
    <Notice text={t("termsHelp")} />
    <Section><Field label={t("ownTerms")} value={days} onChange={setDays} kind="code" hint={t("hint.termsDays")} /></Section>
  </Screen>;
}

/** A product's tax rule (products.edit); past sales keep the rate they were sold at. */
export function ProductTaxScreen(): React.JSX.Element {
  const { t, language } = useText(), s = useStyles(), nav = useNav(), { productId } = useParams("productTax"), { context } = useSession(), action = useAction(), permissions = usePermissions();
  const revision = useRevision(["products", "settings"]);
  const loaded = useRecord(() => productTax(context, productId), [context, productId, revision]).value;
  const settings = useRecord(() => shopTaxSettings(context), [context, revision]).value, item = useRecord(() => productRead(context, productId), [context, productId, revision]).value;
  const [rule, setRule] = useState<"STANDARD" | "EXEMPT" | "RATE">(loaded?.rule ?? "STANDARD"), [own, setOwn] = useState(loaded?.rule === "RATE" ? rateInput(loaded.rateBasisPoints) : "");
  const canEdit = permissions.includes("products.edit") && item?.active === true;
  const save = (): void => action.run(() => {
    const stored = productTax(context, productId), at = version(stored.updatedAt);
    let ok: boolean;
    if (rule === "RATE") { const value = rate(own); if (value === 0) throw new FormProblem("taxRateInvalid"); ok = setProductTaxRule(context, { productId, rule, rateBasisPoints: value, updatedAt: at }); }
    else ok = setProductTaxRule(context, { productId, rule, updatedAt: at });
    if (!ok) throw new FormProblem("newerEdit");
  }, () => nav.leave(), "saved");
  return <Screen title={t("productTax")} eyebrow={item?.name} onBack={nav.back} footer={canEdit ? <>{action.notice}<Button label={t("save")} onPress={save} /></> : undefined}>
    {settings?.enabled === false ? <Notice text={t("productTaxOff")} /> : loaded !== undefined && <Text style={s.body}>{t("productTaxNow", { rate: formatRate(loaded.effectiveRateBasisPoints, language) })}</Text>}
    {canEdit ? <Section><Segmented label={t("productTax")} hint={t("hint.productTaxRule")} value={rule} onChange={setRule}
        options={(["STANDARD", "EXEMPT", "RATE"] as const).map(value => ({ id: value, label: `${t(`taxRule.${value}`)}${value === "STANDARD" && settings !== undefined ? ` (${formatRate(settings.standardRateBasisPoints, language)})` : ""}` }))} />
      {rule === "RATE" && <Field label={t("productOwnRate")} value={own} onChange={setOwn} kind="quantity" hint={t("hint.productOwnRate")} />}</Section>
      : loaded !== undefined && <Section><Text style={s.body}>{t(`taxRule.${loaded.rule}`)}{loaded.rule === "RATE" ? ` · ${formatRate(loaded.rateBasisPoints, language)}` : ""}</Text></Section>}
  </Screen>;
}
