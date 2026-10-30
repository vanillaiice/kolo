import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, query, type AuditEntry } from "../api.ts";
import { dateTime, Failure, isId, number, Seal, useLoad, useQuery, useShell } from "../lib.tsx";

const PAGE = 100;
const ACTIONS = [["", "allActions"], ["admin.", "actionSignIn"], ["shop.", "actionShop"], ["code.", "actionCode"], ["payment.", "actionPayment"]] as const;

/** An entry's details as short key/value pairs instead of raw JSON. */
export function AuditDetail({ detail }: { detail: Record<string, unknown> }): ComponentChildren {
  return <dl class="detail">{Object.entries(detail).map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd>{value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>;
}

/** The append-only, hash-chained log of every operator action, filtered through the address bar. */
export function Audit(): ComponentChildren {
  const { t, language } = useShell();
  const [params, setParams] = useQuery();
  const [entries, setEntries] = useState<AuditEntry[]>([]), [more, setMore] = useState(false), [loadingMore, setLoadingMore] = useState(false);
  const [username, setUsername] = useState(params["username"] ?? ""), [target, setTarget] = useState(params["target"] ?? "");
  useEffect(() => { const timer = setTimeout(() => {
    if ((params["username"] ?? "") !== username.trim() || (params["target"] ?? "") !== target.trim()) setParams({ username: username.trim(), target: target.trim() });
  }, 300); return () => clearTimeout(timer); }, [username, target]);
  // Dates are entered as days in local time; the period ends at the end of the "to" day.
  const day = (value: string | undefined, end: boolean): string | undefined => value === undefined ? undefined : new Date(new Date(`${value}T00:00:00`).getTime() + (end ? 86_400_000 : 0)).toISOString();
  const filters = { action: params["action"], username: params["username"], target: params["target"], from: day(params["from"], false), to: day(params["to"], true) };
  const address = query(filters);
  const first = useLoad(() => api.audit(query({ ...filters, limit: PAGE })), [address]);
  const integrity = useLoad(() => api.integrity(), []);
  useEffect(() => { if (first.data !== undefined) { setEntries(first.data.entries); setMore(first.data.entries.length === PAGE); } }, [first.data]);
  const loadMore = (): void => {
    const last = entries[entries.length - 1]; if (last === undefined) return;
    setLoadingMore(true);
    api.audit(query({ ...filters, before: last.id, limit: PAGE })).then(page => { setEntries(current => [...current, ...page.entries]); setMore(page.entries.length === PAGE); }, () => first.reload()).finally(() => setLoadingMore(false));
  };
  const chain = integrity.data?.checks.find(check => check.name === "audit_chain");
  const filtered = Object.values(filters).some(value => value !== undefined && value !== "");
  return <section>
    <header class="page-head">
      <h1>{t("audit")}</h1>
      <a class="secondary button" href={`/admin/api/audit.csv${address}`} download>{t("export")}</a>
    </header>
    {chain !== undefined && integrity.data !== undefined && <p class={chain.ok ? "chain-status ok" : "chain-status broken"} role={chain.ok ? undefined : "alert"}>
      {chain.ok ? <>{t("chainVerified")}: {number(language, integrity.data.audit.entries)} {t("entries")}.{integrity.data.audit.headHash !== null && <> {t("entry")} {integrity.data.audit.headSeq} <Seal hash={integrity.data.audit.headHash} /></>}</>
        : <>{t("brokenAt")} {chain.targets[0]}. {t("audit_chain_help")}</>}
    </p>}
    <div class="filters">
      <select aria-label={t("action")} value={params["action"] ?? ""} onChange={event => setParams({ action: event.currentTarget.value })}>{ACTIONS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select>
      <input type="search" placeholder={t("anyOperator")} aria-label={t("anyOperator")} value={username} onInput={event => setUsername(event.currentTarget.value)} maxLength={64} />
      <input type="search" placeholder={t("target")} aria-label={t("target")} value={target} onInput={event => setTarget(event.currentTarget.value)} maxLength={200} />
      <label class="inline">{t("from")}<input type="date" value={params["from"] ?? ""} onChange={event => setParams({ from: event.currentTarget.value })} /></label>
      <label class="inline">{t("to")}<input type="date" value={params["to"] ?? ""} onChange={event => setParams({ to: event.currentTarget.value })} /></label>
      {filtered && <button type="button" class="link" onClick={() => { setUsername(""); setTarget(""); setParams({ action: undefined, username: undefined, target: undefined, from: undefined, to: undefined }); }}>{t("clearFilters")}</button>}
    </div>
    <Failure code={first.error} retry={() => first.reload()} />
    {first.data === undefined ? <p class="muted">{t("loading")}</p> : entries.length === 0 ? <p class="empty">{t("noEntries")}</p> : <>
      <div class="table-wrap"><table>
        <thead><tr><th>{t("entry")}</th><th>{t("when")}</th><th>{t("who")}</th><th>{t("action")}</th><th>{t("target")}</th><th>{t("from")}</th></tr></thead>
        <tbody>{entries.map(entry => <tr key={entry.id}>
          <td class="nowrap"><span class="seq">{entry.seq}</span><Seal hash={entry.hash} /></td>
          <td class="nowrap">{dateTime(language, entry.at)}</td><td>{entry.username}</td>
          <td><code>{entry.action}</code>{entry.detail !== null && <AuditDetail detail={entry.detail} />}</td>
          <td>{isId(entry.target) ? <a href={`/admin/shops/${entry.target}`}><code>{entry.target}</code></a> : <code>{entry.target ?? ""}</code>}</td>
          <td>{entry.address ?? ""}</td>
        </tr>)}</tbody>
      </table></div>
      {more && <button type="button" class="secondary" disabled={loadingMore} onClick={loadMore}>{t(loadingMore ? "loading" : "more")}</button>}
    </>}
  </section>;
}
