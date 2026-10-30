import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { api, query, type Code, type CodeState, type Issued } from "../api.ts";
import { DAY, dateTime, Failure, LimitInput, number, OneTime, Pager, Pill, useAction, useLoad, useQuery, useShell, When } from "../lib.tsx";

const LIMIT = 50, STATES: readonly CodeState[] = ["unused", "used", "expired", "cancelled"];

/** Connection codes: issue one (shown once), and see what became of the others. */
export function Codes(): ComponentChildren {
  const { t, language, canChange, notify } = useShell();
  const [params, setParams] = useQuery();
  const offset = Number(params["offset"] ?? 0) || 0, state = STATES.includes(params["state"] as CodeState) ? params["state"] : undefined;
  const address = query({ state, offset, limit: LIMIT });
  const list = useLoad(() => api.codes(address), [address]);
  const cancel = useAction();
  const data = list.data;
  return <section>
    <header class="page-head"><h1>{t("codes")}</h1></header>
    {canChange && data !== undefined && <IssueForm canIssue={data.canIssue} hosted={data.edition === "hosted"} onIssued={() => list.reload()} />}
    <nav class="tabs" aria-label={t("status")}>
      {[undefined, ...STATES].map(value => <a key={value ?? "all"} href={`/admin/codes${query({ state: value })}`} class={state === value ? "tab current" : "tab"} aria-current={state === value ? "page" : undefined}>{t(value ?? "allCodes")}</a>)}
    </nav>
    <Failure code={list.error ?? cancel.error} retry={() => list.reload()} />
    {data === undefined ? <p class="muted">{t("loading")}</p> : data.codes.length === 0 ? <p class="empty">{t("noCodes")}</p> : <>
      <div class="table-wrap"><table>
        <thead><tr><th>{t("label")}</th><th>{t("status")}</th><th>{t("created")}</th><th>{t("expires")}</th><th>{t("usedBy")}</th><th><span class="visually-hidden">{t("action")}</span></th></tr></thead>
        <tbody>{data.codes.map((code: Code) => {
          const soon = code.state === "unused" && new Date(code.expiresAt).getTime() - Date.now() < DAY;
          return <tr key={code.codeId}>
            <td>{code.label}<small>{t("by")} {code.createdBy}, {terms(t, code)}</small></td>
            <td><Pill tone={`code-${code.state}`}>{t(code.state)}</Pill>{soon && <small class="warn-text">{t("expiresSoon")}</small>}</td>
            <td>{dateTime(language, code.createdAt)}</td>
            <td><When value={code.expiresAt} /></td>
            <td>{code.shopId === null ? "—" : <a href={`/admin/shops/${code.shopId}`}>{code.shopName ?? code.shopId}</a>}{code.usedAt !== null && <small><When value={code.usedAt} /></small>}</td>
            <td class="row-actions">{canChange && code.state === "unused" && <button type="button" class="link" disabled={cancel.busy} onClick={() => cancel.run(() => api.cancel(code.codeId), () => { notify(t("codeCancelled")); list.reload(); })}>{t("cancelCode")}</button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      <Pager offset={offset} limit={LIMIT} shown={data.codes.length} total={data.total} onOffset={value => setParams({ offset: value === 0 ? undefined : value })} />
      <p class="muted fine">{number(language, data.total)} {t("codes").toLowerCase()}</p>
    </>}
  </section>;
}

/** What a code gives the shop it creates, or that it is a recovery code. */
function terms(t: (key: string) => string, code: Code): string {
  if (code.recoveryShopId !== null) return t("recovery");
  return [code.includedMonths > 0 ? `${code.includedMonths} ${t(code.includedMonths === 1 ? "monthOne" : "months").toLowerCase()}` : "", code.includedDays > 0 ? `${code.includedDays} ${t("trialDaysShort")}` : "",
    code.maxTills === null ? t("unlimitedTills").toLowerCase() : `${code.maxTills} ${t("tillsShort")}`].filter(Boolean).join(", ");
}

function IssueForm({ canIssue, hosted, onIssued }: { canIssue: boolean; hosted: boolean; onIssued: () => void }): ComponentChildren {
  const { t, language } = useShell();
  const [label, setLabel] = useState(""), [days, setDays] = useState(7), [months, setMonths] = useState(0), [trial, setTrial] = useState(0);
  // A hosted code names its till limit or says unlimited; nothing is preselected there (ADR-039).
  const [limit, setLimit] = useState(""), [unlimited, setUnlimited] = useState<boolean>();
  const [issued, setIssued] = useState<Issued>();
  const action = useAction();
  const isUnlimited = unlimited ?? !hosted, maxTills = isUnlimited ? null : Number(limit), ready = isUnlimited || Number.isInteger(maxTills) && maxTills! >= 1;
  if (!canIssue) return <p class="notice">{t("publicUrlMissing")}</p>;
  if (issued !== undefined) return <section class="panel"><OneTime title={t("issuedTitle")} help={`${t("issuedHelp")} ${dateTime(language, issued.expiresAt)}.`} qr={issued.qr} value={issued.code}
    extra={<strong>{issued.label}</strong>} filename={`kolo-code-${issued.label.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40)}.svg`} onDone={() => setIssued(undefined)} /></section>;
  const issue = (event: Event): void => {
    event.preventDefault(); if (!ready) { action.setError("tillLimitChoose"); return; }
    action.run(() => api.issue({ label: label.trim(), days, maxTills, ...(hosted ? { includedMonths: months, includedDays: trial } : {}) }), value => {
      setIssued(value); setLabel(""); setLimit(""); setUnlimited(undefined); onIssued();
    });
  };
  return <form class="panel" onSubmit={issue}>
    <h2>{t("issueTitle")}</h2><p class="hint">{t("issueHelp")}</p>
    <div class="row">
      <label class="field grow">{t("label")}<input value={label} onInput={event => setLabel(event.currentTarget.value)} required maxLength={120} /></label>
      {hosted && <label class="field">{t("includedMonths")}<select value={months} onChange={event => setMonths(Number(event.currentTarget.value))}>{[0, 1, 3, 6, 12].map(value => <option key={value} value={value}>{value === 0 ? t("none") : value}</option>)}</select></label>}
      {hosted && <label class="field">{t("trialDays")}<select value={trial} onChange={event => setTrial(Number(event.currentTarget.value))}>{[0, 7, 14, 30].map(value => <option key={value} value={value}>{value === 0 ? t("none") : value}</option>)}</select></label>}
      <label class="field">{t("validity")}<select value={days} onChange={event => setDays(Number(event.currentTarget.value))}>{[1, 7, 30].map(value => <option key={value} value={value}>{value} {t(value === 1 ? "day" : "days")}</option>)}</select></label>
    </div>
    <LimitInput limit={limit} unlimited={isUnlimited} onLimit={setLimit} onUnlimited={setUnlimited} idPrefix="code" />
    <button class="primary" type="submit" disabled={action.busy || label.trim() === "" || !ready}>{t(action.busy ? "issuing" : "issue")}</button>
    {action.error !== undefined && <p role="alert" class="notice error">{t(action.error)}</p>}
  </form>;
}
