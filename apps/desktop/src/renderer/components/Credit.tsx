import { useEffect, useState } from "react";
import { formatMoney } from "@kolo/core/domain/money";
import type { CreditStatusView, ShopService } from "../../shared/service.ts";
import { daysEntry } from "./ShopSettings.tsx";
import { ErrorText, Field, ReadState, useAction, useRead, useText } from "./ui.tsx";

/**
 * A customer's or supplier's payment terms and what is overdue or due soon now (ADR-033). Payments settle the oldest
 * debt first. Members who manage the party can give it its own terms or return it to the shop default.
 */
export function CreditTermsPanel({ service, sessionId, revision, party, partyId, canManage }: {
  readonly service: ShopService; readonly sessionId: string; readonly revision: number; readonly party: "CUSTOMER" | "SUPPLIER"; readonly partyId: string; readonly canManage: boolean;
}): React.JSX.Element {
  const { t, language } = useText(), action = useAction();
  const read = useRead(() => service.creditStatus({ sessionId, party, partyId }), [service, sessionId, party, partyId, revision]);
  const [shown, setShown] = useState<CreditStatusView>(), [days, setDays] = useState(""), [editing, setEditing] = useState(false);
  useEffect(() => { if (read.data !== undefined) { setShown(read.data); if (!editing) setDays(String(read.data.days)); } }, [read.data, editing]);
  const date = (value: string): string => new Date(value).toLocaleDateString(language === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
  const save = (value: number | null): void => {
    void action.run(() => service.setPartyTerms({ sessionId, party, partyId, days: value, ...(shown?.version === undefined ? {} : { version: shown.version }) }))
      .then(result => { if (result !== undefined) { setShown(result); setDays(String(result.days)); setEditing(false); } });
  };
  return <div className="panel"><h2>{t("creditTitle")}</h2>
    {shown === undefined ? <ReadState loading={read.loading} error={read.error} empty={false} emptyText="" retry={read.retry}>{null}</ReadState> : <>
      <dl className="facts"><dt>{t("termsDays")}</dt><dd>{shown.days} {t("daysSuffix")} <small>{t(`termsSource.${shown.source}`)}</small></dd>
        {shown.balanceMinor <= 0 ? <><dt>{t("balance")}</dt><dd>{t("nothingOwed")}</dd></> : <>
          <dt>{t("overdueLabel")}</dt><dd className={shown.overdueMinor > 0 ? "money negative" : "money"}>{formatMoney(shown.overdueMinor, language)}</dd>
          {shown.dueSoonMinor > 0 && <><dt>{t("dueSoonLabel")}</dt><dd className="money">{formatMoney(shown.dueSoonMinor, language)}</dd></>}
          {shown.oldestDueAt !== undefined && <><dt>{t("oldestDue")}</dt><dd>{date(shown.oldestDueAt)}</dd></>}
          {shown.nextDueAt !== undefined && <><dt>{t("nextDue")}</dt><dd>{date(shown.nextDueAt)}</dd></>}</>}</dl>
      {canManage && (editing ? <form onSubmit={event => { event.preventDefault(); const value = daysEntry(days); if (value === undefined) action.setError({ code: "termsInput" }); else save(value); }}>
        <fieldset disabled={action.busy}><Field id={`${party.toLowerCase()}-terms`} label={t("ownTerms")} hint={t("hint.termsDays")} value={days} onChange={setDays} numeric maxLength={4}/></fieldset>
        <ErrorText message={action.error} conflictMessage="staleVersion"/>
        <div className="actions"><button className="primary" type="submit" disabled={action.busy}>{t("save")}</button>
          {shown.source === "party" && <button type="button" className="secondary" disabled={action.busy} onClick={() => save(null)}>{t("useShopTerms")}</button>}
          <button type="button" className="secondary" disabled={action.busy} onClick={() => { setEditing(false); action.setError(undefined); }}>{t("cancel")}</button></div>
      </form> : <div className="actions"><button className="secondary" onClick={() => { setDays(String(shown.days)); setEditing(true); }}>{t("edit")} · {t("termsDays")}</button></div>)}
    </>}
  </div>;
}
