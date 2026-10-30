import type { ComponentChildren } from "preact";
import { api, query } from "../api.ts";
import { dateOnly, dateTime, Failure, money, number, Pager, Pill, useLoad, useQuery, useShell } from "../lib.tsx";

const LIMIT = 100;
type Preset = "thisMonth" | "last30" | "lastMonth" | "custom";

/** A period's bounds as local days: `from` inclusive, `to` exclusive. */
function period(preset: Preset, from: string | undefined, to: string | undefined): { from: Date; to: Date } {
  const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "thisMonth") return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(today.getTime() + 86_400_000) };
  if (preset === "lastMonth") return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1) };
  if (preset === "custom" && from !== undefined && to !== undefined) return { from: new Date(`${from}T00:00:00`), to: new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000) };
  return { from: new Date(today.getTime() - 29 * 86_400_000), to: new Date(today.getTime() + 86_400_000) };
}
const isoDay = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Hosted billing across shops: what was collected in a period, how, and whose subscription ends next. */
export function BillingPage(): ComponentChildren {
  const { t, language } = useShell();
  const [params, setParams] = useQuery();
  const preset = (["thisMonth", "last30", "lastMonth", "custom"] as const).find(value => value === params["period"]) ?? "last30";
  const range = period(preset, params["from"], params["to"]), offset = Number(params["offset"] ?? 0) || 0;
  const bounds = { from: range.from.toISOString(), to: range.to.toISOString() };
  const address = query({ ...bounds, offset, limit: LIMIT });
  const report = useLoad(() => api.billing(address), [address]);
  const data = report.data;
  const choose = (value: Preset): void => {
    if (value !== "custom") { setParams({ period: value === "last30" ? undefined : value, from: undefined, to: undefined, offset: undefined }); return; }
    setParams({ period: "custom", from: isoDay(range.from), to: isoDay(new Date(range.to.getTime() - 86_400_000)), offset: undefined });
  };
  return <section>
    <header class="page-head">
      <h1>{t("billing")}</h1>
      <a class="secondary button" href={`/admin/api/billing.csv${query(bounds)}`} download>{t("export")}</a>
    </header>
    <div class="filters">
      <div class="segmented" role="group" aria-label={t("period")}>
        {(["thisMonth", "last30", "lastMonth", "custom"] as const).map(value => <button key={value} type="button" aria-pressed={preset === value} onClick={() => choose(value)}>{t(value)}</button>)}
      </div>
      {preset === "custom" && <>
        <label class="inline">{t("from")}<input type="date" value={params["from"] ?? ""} onChange={event => setParams({ from: event.currentTarget.value, offset: undefined })} /></label>
        <label class="inline">{t("to")}<input type="date" value={params["to"] ?? ""} onChange={event => setParams({ to: event.currentTarget.value, offset: undefined })} /></label>
      </>}
    </div>
    <Failure code={report.error} retry={() => report.reload()} />
    {data === undefined ? <p class="muted">{t("loading")}</p> : <>
      <div class="split">
        <section class="panel">
          <h2>{t("totalCollected")}</h2>
          <p class="total"><strong>{money(language, data.total.amountMinor)}</strong> <span class="muted">{number(language, data.total.payments)} {t("paymentsCount")}</span></p>
          <h3>{t("byMethod")}</h3>
          <ul class="shares">{[...data.byMethod].sort((a, b) => b.amountMinor - a.amountMinor).map(row => <li key={row.key}>
            <span>{t(row.key)}</span><span class="share-bar" aria-hidden="true"><i style={{ width: `${data.total.amountMinor === 0 ? 0 : Math.max(2, (row.amountMinor / data.total.amountMinor) * 100)}%` }} /></span>
            <span class="numeric">{money(language, row.amountMinor)}</span></li>)}</ul>
        </section>
        <section class="panel">
          <h2>{t("ending")}</h2>
          {data.ending.length === 0 ? <p class="muted">{t("noEnding")}</p> : <ul class="plain">{data.ending.map(row => <li key={row.shopId}>
            <a href={`/admin/shops/${row.shopId}`}>{row.name}</a>
            <span><Pill tone={`service-${row.service}`}>{t(row.service)}</Pill> {row.paidUntil === null ? t("notPaid") : dateOnly(language, row.paidUntil)}</span></li>)}</ul>}
        </section>
      </div>
      <h2>{t("payments")}</h2>
      {data.payments.length === 0 ? <p class="empty">{t("noPayments")}</p> : <>
        <div class="table-wrap"><table>
          <thead><tr><th>{t("when")}</th><th>{t("shop")}</th><th class="numeric">{t("months")}</th><th class="numeric">{t("amount")}</th><th>{t("method")}</th><th>{t("paidUntil")}</th><th>{t("who")}</th></tr></thead>
          <tbody>{data.payments.map(payment => <tr key={payment.paymentId}>
            <td class="nowrap">{dateTime(language, payment.recordedAt)}</td><td><a href={`/admin/shops/${payment.shopId}`}>{payment.shopName}</a></td>
            <td class="numeric">{payment.months}{payment.days > 0 ? ` + ${payment.days} ${t("daysShort")}` : ""}</td><td class="numeric">{money(language, payment.amountMinor)}</td>
            <td>{t(payment.method)}{payment.reference !== null && <small>{payment.reference}</small>}</td><td>{dateOnly(language, payment.paidUntilAfter)}</td>
            <td>{payment.recordedBy}<small>{t(payment.source === "code" ? "viaCodeSource" : payment.source)}</small></td>
          </tr>)}</tbody>
        </table></div>
        <Pager offset={offset} limit={LIMIT} shown={data.payments.length} total={data.total.payments} onOffset={value => setParams({ offset: value === 0 ? undefined : value })} />
      </>}
    </>}
  </section>;
}
