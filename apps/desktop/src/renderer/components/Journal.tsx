import { useState } from "react";
import type { Cursor } from "@kolo/core/application/queries";
import { AUDIT_CSV_COLUMNS, auditCsv, type AuditCsvText } from "@kolo/core/domain/audit-csv";
import { localDayPeriod } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity, formatRate } from "@kolo/core/domain/money";
import type { AuditEntry, AuditGroup, AuditSubject, HeldBackFact, ShopService } from "../../shared/service.ts";
import { hasText, type Language, type TextKey } from "../text.ts";
import { ErrorText, Pager, ReadState, Select, useAction, useRead, useText } from "./ui.tsx";

const GROUPS: readonly AuditGroup[] = ["sales", "purchases", "stock", "money", "catalogue", "people", "staff", "devices", "settings", "other"];
/** Local calendar day as YYYY-MM-DD, the input the shared period rule expects. */
function day(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
/** Either end may be left open; a filled end must be a real day, and the start must not follow the end. */
function period(from: string, to: string): { from?: string; until?: string } | undefined {
  try {
    const start = from === "" ? undefined : localDayPeriod(from, from).from, end = to === "" ? undefined : localDayPeriod(to, to).until;
    if (start !== undefined && end !== undefined && start >= end) return undefined;
    return { ...(start === undefined ? {} : { from: start }), ...(end === undefined ? {} : { until: end }) };
  } catch { return undefined; }
}
const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

/** The stored code in words: a role, permission, movement, expense category or tax rule; unknown codes as stored. */
function codeText(entry: AuditEntry, t: (key: TextKey) => string): string | undefined {
  const code = entry.facts.code;
  if (code === undefined) return undefined;
  const candidates = entry.type.startsWith("PERMISSION_") ? [`permission.${code}`] : ["MEMBER_CREATED", "MEMBER_ROLE_CHANGED", "ROLE_PERMISSIONS_SET", "CUSTOM_ROLE_SET"].includes(entry.type) ? [`role.${code}`]
    : entry.type === "PAYMENT_TERMS_SET" ? [code === "SUPPLIER" ? "suppliers" : "customers"] : [...(entry.type === "CASH_MOVED" ? [`jd.cash.${code}`] : []), `jd.${code}`, code];
  const key = candidates.find(hasText);
  return key === undefined ? code : t(key);
}

/** One line of what an entry recorded, from its facts only. */
export function journalDetails(entry: AuditEntry, t: (key: TextKey) => string, language: Language): string {
  const f = entry.facts, money = (minor: number): string => formatMoney(minor, language), parts: string[] = [];
  const stock = entry.type === "STOCK_COUNTED", change = (key: TextKey, now: number | undefined, before: number | undefined): void => {
    if (now !== undefined) parts.push(fill(t(key), { value: before === undefined ? money(now) : `${money(before)} → ${money(now)}` }));
  };
  const code = codeText(entry, t);
  if (code !== undefined) parts.push(code);
  if (entry.type === "PRODUCT_SAVED") { change("jd.price", f.amountMinor, f.previousAmountMinor); if (f.previousCostMinor !== undefined) change("jd.cost", f.costMinor, f.previousCostMinor); }
  else if (entry.type === "CASH_COUNTED") { if (f.amountMinor !== undefined && f.amountMinor !== 0) parts.push(fill(t("jd.difference"), { value: money(f.amountMinor) })); }
  else if (f.amountMinor !== undefined) parts.push(money(f.amountMinor));
  if (f.quantityThousandths !== undefined) parts.push(formatQuantity(f.quantityThousandths, language));
  if (f.lines !== undefined && f.lines > 1) parts.push(fill(t("jd.lines"), { count: String(f.lines) }));
  if (f.counted !== undefined && f.expected !== undefined) {
    const amount = (value: number): string => stock ? formatQuantity(value, language) : money(value);
    parts.push(fill(t("jd.counted"), { counted: amount(f.counted), expected: amount(f.expected) }));
  }
  if (f.days !== undefined) parts.push(f.days === null ? t("jd.defaultDays") : fill(t("jd.days"), { count: String(f.days) }));
  if (f.rateBasisPoints !== undefined) parts.push(formatRate(f.rateBasisPoints, language));
  if (f.enabled !== undefined) parts.push(t(f.enabled ? "jd.on" : "jd.off"));
  if (f.created === true) parts.push(t("jd.new"));
  if (f.active === false) parts.push(t("jd.archived"));
  if (f.reversal === true) parts.push(t("jd.reversal"));
  if (f.reference !== undefined && f.reference !== entry.subject?.name) parts.push(f.reference);
  if (f.reason !== undefined) parts.push(`«\u00a0${f.reason}\u00a0»`);
  const line = parts.join(" · ");
  return line.charAt(0).toLocaleUpperCase(language) + line.slice(1);
}

/** The operation's name in the current language, with its code when this version does not know it. */
function operationText(entry: AuditEntry, t: (key: TextKey) => string): string {
  return hasText(`j.${entry.type}`) ? t(`j.${entry.type}` as TextKey) : `${t("j.other")} (${entry.type})`;
}

/** Spreadsheet wording for an export in the current language. */
function csvText(t: (key: TextKey) => string, language: Language): AuditCsvText {
  return { headings: Object.fromEntries(AUDIT_CSV_COLUMNS.map(column => [column, t(`jc.${column}` as TextKey)])) as AuditCsvText["headings"],
    operation: entry => operationText(entry, t), details: entry => journalDetails(entry, t, language),
    source: entry => t(entry.source === "this_device" ? "journalThisDevice" : "journalShopWide"),
    status: entry => entry.status !== undefined && entry.status !== "applied" && hasText(`jst.${entry.status}`) ? t(`jst.${entry.status}` as TextKey) : "",
    unknown: t("journalUnknown") };
}

/**
 * Owner only: other tills' facts held back for a reason the owner may approve. Each approval names the exact fact
 * and its reason; the fact is then applied under every other check and can still be refused.
 */
function HeldBack({ service, sessionId, revision }: { readonly service: ShopService; readonly sessionId: string; readonly revision: number }): React.JSX.Element | null {
  const { t, language } = useText(), [done, setDone] = useState(0), [confirming, setConfirming] = useState<string>();
  const list = useRead(() => service.heldBack({ sessionId }), [service, sessionId, revision, done]), action = useAction();
  const approve = (fact: HeldBackFact): void => { void action.run(() => service.reviewHeldBack({ sessionId, eventId: fact.eventId, digest: fact.digest })).then(() => { setConfirming(undefined); setDone(value => value + 1); }); };
  if (list.data === undefined || list.data.length === 0) return null;
  return <div className="panel held-back" role="region" aria-labelledby="held-back-title">
    <h2 id="held-back-title">{t("heldBackTitle")}</h2><p className="muted">{t("heldBackHelp")}</p>
    <ul className="held-back-list">{list.data.map(fact => <li key={fact.eventId}>
      <div><strong>{hasText(`j.${fact.type}`) ? t(`j.${fact.type}` as TextKey) : fact.type}</strong>
        <span className="muted"> · {fact.actorName ?? t("journalUnknown")} · {fact.deviceLabel ?? t("journalUnknown")} · {new Date(fact.occurredAt).toLocaleString(language === "fr" ? "fr-FR" : "en-GB")}</span>
        <p className="field-hint">{t(`heldBack.${fact.reason}` as TextKey)}</p></div>
      {confirming === fact.eventId
        ? <div className="actions"><button className="primary" disabled={action.busy} onClick={() => approve(fact)}>{t("heldBackConfirm")}</button>
          <button className="secondary" disabled={action.busy} onClick={() => setConfirming(undefined)}>{t("cancel")}</button></div>
        : <div className="actions"><button className="secondary" disabled={action.busy} onClick={() => setConfirming(fact.eventId)}>{t("heldBackApprove")}</button></div>}
    </li>)}</ul>
    <ErrorText message={action.error}/>
  </div>;
}

/**
 * The operation journal under audit.view: newest first, narrowed by days, member, device, family or one record.
 * Choosing a record shows every operation that involved it (a product's price changes, sales and counts).
 */
export function Journal({ service, sessionId, revision, canExport, canReview = false }: { readonly service: ShopService; readonly sessionId: string; readonly revision: number; readonly canExport: boolean; readonly canReview?: boolean }): React.JSX.Element {
  const { t, language } = useText(), today = day(new Date());
  const [from, setFrom] = useState(() => { const start = new Date(); start.setDate(start.getDate() - 6); return day(start); }), [to, setTo] = useState(today);
  const [actorId, setActorId] = useState(""), [deviceId, setDeviceId] = useState(""), [group, setGroup] = useState<AuditGroup | "">(""), [subject, setSubject] = useState<AuditSubject>();
  const range = period(from, to), filters = `${range?.from}|${range?.until}|${actorId}|${deviceId}|${group}|${subject?.id}`;
  const [cursor, setCursor] = useState<{ after: Cursor; key: string }>();
  const after = cursor?.key === `${filters}|${revision}` ? cursor.after : undefined;
  const page = useRead(() => range === undefined ? Promise.resolve({ ok: true as const, value: undefined }) : service.journal({ sessionId, ...range,
    ...(actorId === "" ? {} : { actorId }), ...(deviceId === "" ? {} : { deviceId }), ...(group === "" ? {} : { group }), ...(subject === undefined ? {} : { subjectId: subject.id }),
    ...(after === undefined ? {} : { after }) }), [service, sessionId, filters, after, revision]);
  const preset = (days: number | undefined): void => {
    if (days === undefined) { setFrom(""); setTo(""); return; }
    const start = new Date(); start.setDate(start.getDate() - days); setFrom(day(start)); setTo(today);
  };
  const name = (value: AuditSubject): string => value.name ?? t("journalUnknown");
  const exporting = useAction(), [exported, setExported] = useState<{ count: number; truncated: boolean }>();
  // Every page matching the filters, then one file; the save dialog decides where it goes.
  const exportCsv = (): void => { if (range === undefined) return; setExported(undefined); void exporting.run(async () => {
    const query = { sessionId, ...range, ...(actorId === "" ? {} : { actorId }), ...(deviceId === "" ? {} : { deviceId }), ...(group === "" ? {} : { group }), ...(subject === undefined ? {} : { subjectId: subject.id }) };
    const read = await service.journalExport(query);
    if (!read.ok) return read;
    const { items: shown, truncated } = read.value;
    const saved = await service.saveCsv({ sessionId, filename: `kolo-journal-${from === "" ? "start" : from}_${to === "" ? today : to}.csv`,
      content: auditCsv(shown, csvText(t, language), language === "fr" ? ";" : ",") });
    if (saved.ok && saved.value) setExported({ count: shown.length, truncated });
    return saved;
  }); };
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("journal")}</p><h1>{t("journalTitle")}</h1><p className="muted">{t("journalHelp")}</p></div></div>
    {canReview && <HeldBack service={service} sessionId={sessionId} revision={revision}/>}
    <div className="report-controls panel">
      <div className="field"><label htmlFor="journal-from">{t("from")}</label><input id="journal-from" type="date" value={from} max={to === "" ? undefined : to} aria-describedby="journal-from-hint" onChange={event => setFrom(event.target.value)}/><small className="field-hint" id="journal-from-hint">{t("hint.periodFrom")}</small></div>
      <div className="field"><label htmlFor="journal-to">{t("to")}</label><input id="journal-to" type="date" value={to} min={from === "" ? undefined : from} aria-describedby="journal-to-hint" onChange={event => setTo(event.target.value)}/><small className="field-hint" id="journal-to-hint">{t("hint.periodTo")}</small></div>
      <Select id="journal-actor" label={t("journalWho")} hint={t("hint.journalWho")} value={actorId} onChange={setActorId}
        options={[{ value: "", label: t("journalAnyone") }, ...(page.data?.members ?? []).map(member => ({ value: member.id, label: member.name }))]}/>
      <Select id="journal-device" label={t("journalDevice")} hint={t("hint.journalDevice")} value={deviceId} onChange={setDeviceId}
        options={[{ value: "", label: t("journalAnyDevice") }, ...(page.data?.devices ?? []).map(device => ({ value: device.id, label: device.label }))]}/>
      <Select id="journal-group" label={t("journalFamily")} hint={t("hint.journalFamily")} value={group} onChange={value => setGroup(value as AuditGroup | "")}
        options={[{ value: "", label: t("journalAnyGroup") }, ...GROUPS.map(id => ({ value: id, label: t(`jg.${id}` as TextKey) }))]}/>
      <div className="actions presets"><button className="secondary" onClick={() => preset(0)}>{t("today")}</button>
        <button className="secondary" onClick={() => preset(6)}>{t("last7")}</button>
        <button className="secondary" onClick={() => preset(29)}>{t("last30")}</button>
        <button className="secondary" onClick={() => preset(undefined)}>{t("journalAll")}</button></div>
      {canExport && <div className="actions journal-export"><button className="secondary" disabled={exporting.busy || range === undefined || page.data?.items.length === 0} onClick={exportCsv}>{exporting.busy ? t("journalExporting") : t("journalExport")}</button></div>}
      <ErrorText message={exporting.error}/>
      {exported !== undefined && <p className={`notice ${exported.truncated ? "error" : "success"} journal-notice`} role="status">{fill(t(exported.truncated ? "journalExportTruncated" : exported.count === 1 ? "journalExportedOne" : "journalExported"), { count: exported.count.toLocaleString(language === "fr" ? "fr-FR" : "en-GB") })}</p>}
      {subject !== undefined && <p className="journal-subject" role="status">{t("journalOnlyRecord")} <strong>{name(subject)}</strong>
        <button className="text-button" onClick={() => setSubject(undefined)}>{t("journalClearRecord")}</button></p>}
    </div>
    {range === undefined ? <p className="notice error" role="alert">{t("invalidPeriod")}</p> : <div className="panel">
      <ReadState loading={page.loading} error={page.error} empty={page.data?.items.length === 0} emptyText={t("journalEmpty")} retry={page.retry}>
        <div className="table-wrap"><table className="journal-table"><thead><tr><th>{t("date")}</th><th>{t("journalWho")}</th><th>{t("journalDevice")}</th><th>{t("journalWhat")}</th><th>{t("journalRecord")}</th><th>{t("journalDetails")}</th></tr></thead><tbody>
          {page.data?.items.map(entry => <tr key={entry.id}>
            <td className="journal-when">{new Date(entry.occurredAt).toLocaleDateString(language === "fr" ? "fr-FR" : "en-GB")}<small>{new Date(entry.occurredAt).toLocaleTimeString(language === "fr" ? "fr-FR" : "en-GB")}</small></td>
            <td>{entry.actor.name ?? t("journalUnknown")}</td>
            <td>{entry.device.label ?? t("journalUnknown")}</td>
            <td>{operationText(entry, t)}
              {entry.source === "this_device" && <span className="tag neutral" title={t("journalThisDeviceHelp")}>{t("journalThisDevice")}</span>}
              {entry.status !== undefined && entry.status !== "applied" && hasText(`jst.${entry.status}`) && <span className="tag">{t(`jst.${entry.status}` as TextKey)}</span>}
</td>
            <td>{entry.subject !== undefined && (subject?.id === entry.subject.id ? name(entry.subject)
              : <button className="row-link" title={`${t("journalShowRecord")} ${name(entry.subject)}`} onClick={() => setSubject(entry.subject)}>{name(entry.subject)}</button>)}
              {entry.related?.name !== undefined && <span className="muted"> · {entry.related.name}</span>}</td>
            <td className="journal-details">{journalDetails(entry, t, language)}</td>
          </tr>)}
        </tbody></table></div>
      </ReadState>
      <Pager hasFirst={after !== undefined} hasNext={page.data?.next !== undefined} onFirst={() => setCursor(undefined)}
        onNext={() => { if (page.data?.next) setCursor({ after: page.data.next, key: `${filters}|${revision}` }); }}/>
    </div>}
  </section>;
}
