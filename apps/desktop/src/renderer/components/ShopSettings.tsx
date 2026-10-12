import { useEffect, useState } from "react";
import { rateEntry, rateInput } from "@kolo/core/domain/entry";
import { formatRate } from "@kolo/core/domain/money";
import type { PaymentTermsView, ShopService, TaxSettingsView } from "../../shared/service.ts";
import { setSystemNotificationsEnabled, systemNotificationsEnabled } from "./Notifications.tsx";
import { ErrorText, Field, useAction, useRead, useText } from "./ui.tsx";

/** Whole days from 0 to 3650, or undefined for anything else. */
export function daysEntry(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return undefined;
  const days = Number(trimmed); return days <= 3650 ? days : undefined;
}

/** Shop tax settings (business.settings): prices include tax; a change applies to new sales only. */
export function TaxPanel({ service, sessionId }: { readonly service: ShopService; readonly sessionId: string }): React.JSX.Element {
  const { t, language } = useText(), action = useAction(), read = useRead(() => service.taxSettings({ sessionId }), [service, sessionId]);
  const [shown, setShown] = useState<TaxSettingsView>(), [saved, setSaved] = useState(false);
  const [enabled, setEnabled] = useState(false), [label, setLabel] = useState(""), [rate, setRate] = useState(""), [registration, setRegistration] = useState("");
  const load = (value: TaxSettingsView): void => { setShown(value); setEnabled(value.enabled); setLabel(value.label); setRate(rateInput(value.standardRateBasisPoints)); setRegistration(value.registration ?? ""); };
  useEffect(() => { if (read.data !== undefined) load(read.data); }, [read.data]);
  const submit = (): void => {
    setSaved(false);
    let standardRateBasisPoints: number;
    try { standardRateBasisPoints = rateEntry(rate); } catch { action.setError({ code: "taxRateInput" }); return; }
    void action.run(() => service.updateTaxSettings({ sessionId, ...(shown?.version === undefined ? {} : { version: shown.version }), enabled, label: label.trim(), standardRateBasisPoints,
      ...(registration.trim() === "" ? {} : { registration: registration.trim() }) })).then(value => { if (value !== undefined) { load(value); setSaved(true); } });
  };
  return <div className="panel"><h2>{t("taxTitle")}</h2><p className="hint">{t("taxHelp")}</p>
    {shown === undefined ? <ErrorText message={read.error}/> : <form onSubmit={event => { event.preventDefault(); submit(); }}><fieldset disabled={action.busy}>
      <label className="check" htmlFor="tax-enabled"><input id="tax-enabled" type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/>{t("taxEnabled")}</label>
      <div className="two-fields"><Field id="tax-label" label={t("taxLabel")} value={label} onChange={setLabel} maxLength={20}/>
        <Field id="tax-rate" label={t("taxRate")} value={rate} onChange={setRate} numeric maxLength={8}/></div>
      <Field id="tax-registration" label={t("taxRegistration")} value={registration} onChange={setRegistration} required={false} maxLength={40}/>
      <p className="hint">{t("taxRegistrationHelp")} {t("taxNewSalesOnly")}</p>
      {shown.enabled && <p className="hint">{t("productTaxNow")} {formatRate(shown.standardRateBasisPoints, language)}</p>}
    </fieldset>
      <ErrorText message={action.error} conflictMessage="staleVersion"/>{saved && <p role="status" className="notice success">{t("taxSaved")}</p>}
      <div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy ? t("recording") : t("save")}</button>
        {action.error?.code === "request_conflict" && <button type="button" className="secondary" onClick={read.retry}>{t("reload")}</button>}</div>
    </form>}
  </div>;
}

/** Shop default payment terms (business.settings) for customers and suppliers. */
export function TermsPanel({ service, sessionId }: { readonly service: ShopService; readonly sessionId: string }): React.JSX.Element {
  const { t } = useText(), action = useAction(), read = useRead(() => service.paymentTerms({ sessionId }), [service, sessionId]);
  const [shown, setShown] = useState<PaymentTermsView>(), [customer, setCustomer] = useState(""), [supplier, setSupplier] = useState(""), [saved, setSaved] = useState(false);
  const load = (value: PaymentTermsView): void => { setShown(value); setCustomer(String(value.customer.days)); setSupplier(String(value.supplier.days)); };
  useEffect(() => { if (read.data !== undefined) load(read.data); }, [read.data]);
  const submit = async (): Promise<void> => {
    setSaved(false);
    const customerDays = daysEntry(customer), supplierDays = daysEntry(supplier);
    if (customerDays === undefined || supplierDays === undefined || shown === undefined) { action.setError({ code: "termsInput" }); return; }
    let current = shown;
    for (const [party, days, stored] of [["CUSTOMER", customerDays, shown.customer], ["SUPPLIER", supplierDays, shown.supplier]] as const) {
      if (stored.stored && stored.days === days) continue;
      const value = await action.run(() => service.setShopTerms({ sessionId, party, days, ...(stored.version === undefined ? {} : { version: stored.version }) }));
      if (value === undefined) return;
      current = value;
    }
    load(current); setSaved(true);
  };
  return <div className="panel"><h2>{t("termsTitle")}</h2><p className="hint">{t("termsHelp")}</p>
    {shown === undefined ? <ErrorText message={read.error}/> : <form onSubmit={event => { event.preventDefault(); void submit(); }}><fieldset disabled={action.busy}>
      <div className="two-fields"><Field id="terms-customers" label={t("termsCustomers")} value={customer} onChange={setCustomer} numeric maxLength={4}/>
        <Field id="terms-suppliers" label={t("termsSuppliers")} value={supplier} onChange={setSupplier} numeric maxLength={4}/></div>
      {(!shown.customer.stored || !shown.supplier.stored) && <p className="hint">{t("termsDefaultNote")}</p>}
    </fieldset>
      <ErrorText message={action.error} conflictMessage="staleVersion"/>{saved && <p role="status" className="notice success">{t("termsSaved")}</p>}
      <div className="actions"><button className="primary" type="submit" disabled={action.busy}>{action.busy ? t("recording") : t("save")}</button>
        {action.error?.code === "request_conflict" && <button type="button" className="secondary" onClick={read.retry}>{t("reload")}</button>}</div>
    </form>}
  </div>;
}

/** This computer's choice to raise alerts as system notifications; asks the system the first time it is switched on. */
export function SystemNotificationsPanel(): React.JSX.Element {
  const { t } = useText(), supported = typeof Notification !== "undefined";
  const [enabled, setEnabled] = useState(systemNotificationsEnabled), [permission, setPermission] = useState(() => supported ? Notification.permission : "denied");
  const change = (value: boolean): void => {
    setEnabled(value); setSystemNotificationsEnabled(value);
    if (value && supported && Notification.permission === "default") void Notification.requestPermission().then(setPermission);
  };
  return <div className="panel"><h2>{t("systemNotifications")}</h2>
    <label className="check" htmlFor="system-notifications"><input id="system-notifications" type="checkbox" checked={enabled && supported} disabled={!supported} onChange={event => change(event.target.checked)}/>{t("systemNotificationsLabel")}</label>
    <p className="hint">{t("systemNotificationsHelp")}</p>
    {enabled && permission === "denied" && <p className="notice error">{t("systemNotificationsBlocked")}</p>}
  </div>;
}
