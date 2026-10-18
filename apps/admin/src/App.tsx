import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type AuditEntry, type Code, type Health, type Issued, type Me, type Method, type Shop, type ShopDetail } from "./api.ts";
import { text, type Language } from "./text.ts";

type View = "shops" | "codes" | "health" | "audit";
type T = (key: string) => string;

function storedLanguage(): Language {
  try { return localStorage.getItem("kolo-admin-language") === "en" ? "en" : "fr"; } catch { return "fr"; }
}
const bytes = (value: number): string => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024 ** 3).toFixed(2)} GiB`;

/** The operator dashboard: sign-in, then shops, connection codes, server health and the audit log. */
export function App(): ReactNode {
  const [language, setLanguage] = useState<Language>(storedLanguage);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>("shops");
  const t: T = useCallback(key => text(language, key), [language]);
  useEffect(() => { document.documentElement.lang = language; try { localStorage.setItem("kolo-admin-language", language); } catch { /* per-viewer convenience only */ } }, [language]);
  useEffect(() => { api.me().then(setMe, () => setMe(null)); }, []);
  // Any refusal for an ended session returns to sign-in.
  const guard = useCallback((error: unknown): string => {
    if (error instanceof ApiError && error.code === "signed_out") { setMe(null); return ""; }
    return error instanceof ApiError ? error.code : "internal";
  }, []);
  const toggle = <button className="text-button" onClick={() => setLanguage(language === "fr" ? "en" : "fr")}>{t("language")}</button>;
  if (me === undefined) return <main className="center"><p className="muted">{t("loading")}</p></main>;
  if (me === null) return <SignIn t={t} toggle={toggle} onSignedIn={setMe} />;
  const tabs: View[] = ["shops", "codes", "health", "audit"];
  return <div className="shell">
    <header className="topbar">
      <div className="brand-line"><span className="brand">kolo</span><span className="muted">{t("title")}</span></div>
      <nav aria-label={t("title")}>{tabs.map(tab => <button key={tab} className={view === tab ? "tab selected" : "tab"} aria-current={view === tab ? "page" : undefined} onClick={() => setView(tab)}>{t(tab)}</button>)}</nav>
      <div className="account">{toggle}<span className="who">{me.username}<small>{t(me.role)}</small></span>
        <button className="secondary" onClick={() => { void api.signOut().finally(() => setMe(null)); }}>{t("signOut")}</button></div>
    </header>
    <main className="content">
      {view === "shops" && <Shops t={t} language={language} canChange={me.role === "admin"} guard={guard} />}
      {view === "codes" && <Codes t={t} language={language} canChange={me.role === "admin"} guard={guard} />}
      {view === "health" && <HealthView t={t} language={language} guard={guard} />}
      {view === "audit" && <Audit t={t} language={language} guard={guard} />}
    </main>
    <footer className="footer muted">kolo · hblabs</footer>
  </div>;
}

function SignIn({ t, toggle, onSignedIn }: { t: T; toggle: ReactNode; onSignedIn: (me: Me) => void }): ReactNode {
  const [username, setUsername] = useState(""), [password, setPassword] = useState(""), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [totp, setTotp] = useState(true);
  useEffect(() => { api.config().then(value => setTotp(value.totp), () => setTotp(true)); }, []);
  const submit = (event: FormEvent): void => {
    event.preventDefault(); setBusy(true); setError(undefined);
    api.signIn(username, password, code).then(onSignedIn, (failure: unknown) => { setError(failure instanceof ApiError ? failure.code : "internal"); setCode(""); }).finally(() => setBusy(false));
  };
  return <main className="center">
    <form className="card" onSubmit={submit}>
      <div className="card-head"><span className="brand">kolo</span>{toggle}</div>
      <h1>{t("signInTitle")}</h1><p className="muted">{t("signInHelp")}</p>
      <label className="field">{t("username")}<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required maxLength={64} /></label>
      <label className="field">{t("password")}<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={256} /></label>
      {totp && <label className="field">{t("code")}<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} required /></label>}
      {error !== undefined && <p role="alert" className="notice error">{t(error)}</p>}
      <button className="primary" type="submit" disabled={busy}>{t(busy ? "signingIn" : "signIn")}</button>
    </form>
  </main>;
}

/** Loads on mount and on demand; failures show their stable code with a retry. */
function useLoad<V>(load: () => Promise<V>, guard: (error: unknown) => string, dependencies: readonly unknown[]): { data: V | undefined; error: string | undefined; reload: () => void } {
  const [data, setData] = useState<V>(), [error, setError] = useState<string>(), [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true; setError(undefined);
    load().then(value => { if (live) setData(value); }, (failure: unknown) => { if (live) setError(guard(failure)); });
    return () => { live = false; };
  }, [...dependencies, tick]);
  return { data, error, reload: () => setTick(value => value + 1) };
}
function Failure({ t, code, retry }: { t: T; code: string | undefined; retry: () => void }): ReactNode {
  if (code === undefined || code === "") return null;
  return <p role="alert" className="notice error">{t(code)} <button className="text-button" onClick={retry}>{t("retry")}</button></p>;
}
const date = (language: Language, value: string | null, t: T): string => value === null ? t("never") : new Date(value).toLocaleString(language === "fr" ? "fr-FR" : "en-GB");

function Shops({ t, language, canChange, guard }: { t: T; language: Language; canChange: boolean; guard: (error: unknown) => string }): ReactNode {
  const [search, setSearch] = useState(""), [query, setQuery] = useState(""), [selected, setSelected] = useState<string>();
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timer); }, [search]);
  const list = useLoad(() => api.shops(query), guard, [query]);
  if (selected !== undefined) return <ShopPage t={t} language={language} canChange={canChange} guard={guard} shopId={selected} onBack={() => { setSelected(undefined); list.reload(); }} />;
  return <section>
    <div className="heading"><h1>{t("shops")}</h1><input className="search" type="search" placeholder={t("search")} aria-label={t("search")} value={search} onChange={event => setSearch(event.target.value)} /></div>
    <Failure t={t} code={list.error} retry={list.reload} />
    {list.data === undefined ? <p className="muted">{t("loading")}</p> : list.data.shops.length === 0 ? <p className="empty">{t("noShops")}</p> :
      <div className="table-wrap"><table><thead><tr><th>{t("name")}</th><th>{t("status")}</th><th className="numeric">{t("devices")}</th><th>{t("lastSeen")}</th>{list.data.edition === "hosted" && <th>{t("subscription")}</th>}<th className="numeric">{t("facts")}</th><th className="numeric">{t("storage")}</th></tr></thead>
        <tbody>{list.data.shops.map((shop: Shop) => <tr key={shop.shopId}>
          <td><button className="row-link" onClick={() => setSelected(shop.shopId)}>{shop.name}</button><small><code>{shop.shopId}</code></small></td>
          <td><span className={`pill ${shop.status}`}>{t(shop.status)}</span></td><td className="numeric">{shop.devices}</td><td>{date(language, shop.lastSeenAt, t)}</td>
          {list.data!.edition === "hosted" && <td><span className={`pill service-${shop.service}`}>{t(shop.service)}</span><small>{shop.paidUntil === null ? t("notPaid") : date(language, shop.paidUntil, t)}</small></td>}
          <td className="numeric">{shop.facts.toLocaleString(language)}</td><td className="numeric">{bytes(shop.bytes)}</td></tr>)}</tbody></table></div>}
  </section>;
}

function ShopPage({ t, language, canChange, guard, shopId, onBack }: { t: T; language: Language; canChange: boolean; guard: (error: unknown) => string; shopId: string; onBack: () => void }): ReactNode {
  const shop = useLoad(() => api.shop(shopId), guard, [shopId]);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [confirm, setConfirm] = useState("");
  const act = (action: "suspend" | "resume" | "remove" | "restore"): void => {
    setBusy(true); setError(undefined);
    api.shopAction(shopId, action).then(() => { setConfirm(""); shop.reload(); }, (failure: unknown) => { setError(guard(failure)); shop.reload(); }).finally(() => setBusy(false));
  };
  const data: ShopDetail | undefined = shop.data;
  return <section>
    <button className="text-button back" onClick={onBack}>← {t("back")}</button>
    <Failure t={t} code={shop.error} retry={shop.reload} />
    {data === undefined ? <p className="muted">{t("loading")}</p> : <>
      <div className="heading"><h1>{data.name} <span className={`pill ${data.status}`}>{t(data.status)}</span></h1></div>
      <dl className="facts">
        <dt>ID</dt><dd><code>{data.shopId}</code></dd><dt>{t("owner")}</dt><dd><code>{data.ownerId}</code></dd>
        <dt>{t("enrolled")}</dt><dd>{date(language, data.enrolledAt, t)}</dd><dt>{t("viaCode")}</dt><dd>{data.connectionCode ?? "—"}</dd>
        <dt>{t("keyEpoch")}</dt><dd>{data.keyEpoch ?? "—"}</dd><dt>{t("conflicts")}</dt><dd>{data.conflicts}</dd>
        <dt>{t("facts")}</dt><dd>{data.facts.toLocaleString(language)} · {bytes(data.bytes)}</dd>
        {data.removeAfter !== null && <><dt>{t("removeAfter")}</dt><dd>{date(language, data.removeAfter, t)}</dd></>}
      </dl>
      {data.edition === "hosted" && <Subscription t={t} language={language} shop={data} canChange={canChange} guard={guard} onPaid={shop.reload} />}
      <h2>{t("devices")}</h2>
      <div className="table-wrap"><table><thead><tr><th>{t("device")}</th><th>{t("platform")}</th><th>{t("status")}</th><th>{t("lastSeen")}</th><th className="numeric">{t("backlog")}</th></tr></thead>
        <tbody>{data.deviceList.map(device => <tr key={device.deviceId}><td>{device.label}{device.authority && <span className="tag">{t("authority")}</span>}<small><code>{device.deviceId}</code></small></td>
          <td>{device.platform}</td><td>{t(device.active ? "trusted" : "revoked")}</td><td>{date(language, device.lastSeenAt, t)}</td><td className="numeric">{device.backlog}</td></tr>)}</tbody></table></div>
      {canChange && data.status === "active" && <Recovery t={t} language={language} shopId={data.shopId} guard={guard} />}
      {canChange && <div className="actions-panel">
        {error !== undefined && error !== "" && <p role="alert" className="notice error">{t(error)}</p>}
        {data.status === "active" && <div><button className="secondary" disabled={busy} onClick={() => act("suspend")}>{t("suspend")}</button><p className="hint">{t("suspendHelp")}</p></div>}
        {data.status === "suspended" && <div><button className="primary" disabled={busy} onClick={() => act("resume")}>{t("resume")}</button></div>}
        {data.status === "removed" && <div><button className="primary" disabled={busy} onClick={() => act("restore")}>{t("restore")}</button></div>}
        {data.status !== "removed" && <form className="danger-zone" onSubmit={event => { event.preventDefault(); if (confirm.trim() === data.name) act("remove"); }}>
          <p className="hint">{t("removeHelp")}</p>
          <label className="field">{t("confirmName")}<input value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="off" /></label>
          <button className="danger" type="submit" disabled={busy || confirm.trim() !== data.name}>{t("remove")}</button>
        </form>}
      </div>}
    </>}
  </section>;
}

/** An owner-recovery code for this shop, shown once with its QR code (ADR-036). */
function Recovery({ t, language, shopId, guard }: { t: T; language: Language; shopId: string; guard: (error: unknown) => string }): ReactNode {
  const [issued, setIssued] = useState<Issued>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [copied, setCopied] = useState(false);
  const issue = (): void => { setBusy(true); setError(undefined); api.issueRecovery(shopId).then(setIssued, (failure: unknown) => setError(guard(failure))).finally(() => setBusy(false)); };
  return <section className="panel">
    <h2>{t("recoveryTitle")}</h2><p className="hint">{t("recoveryHelp")}</p>
    {issued === undefined ? <button className="secondary" disabled={busy} onClick={issue}>{t(busy ? "issuing" : "issueRecovery")}</button> : <div className="issued-body">
      <img className="qr" alt="QR" src={`data:image/svg+xml;base64,${btoa(issued.qr)}`} />
      <div><p className="hint">{t("issuedHelp")} {date(language, issued.expiresAt, t)}.</p><code className="code">{issued.code}</code>
        <div className="row"><button className="secondary" onClick={() => { navigator.clipboard.writeText(issued.code).then(() => setCopied(true), () => setCopied(false)); }}>{t(copied ? "copied" : "copy")}</button>
          <button className="primary" onClick={() => setIssued(undefined)}>{t("done")}</button></div></div></div>}
    {error !== undefined && error !== "" && <p role="alert" className="notice error">{t(error)}</p>}
  </section>;
}

function Subscription({ t, language, shop, canChange, guard, onPaid }: { t: T; language: Language; shop: ShopDetail; canChange: boolean; guard: (error: unknown) => string; onPaid: () => void }): ReactNode {
  const [months, setMonths] = useState(1), [amount, setAmount] = useState(""), [method, setMethod] = useState<Method>("mtn_momo"), [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const pay = (event: FormEvent): void => {
    event.preventDefault(); setBusy(true); setError(undefined);
    api.pay(shop.shopId, months, Number(amount), method, reference.trim()).then(() => { setAmount(""); setReference(""); onPaid(); }, (failure: unknown) => setError(guard(failure))).finally(() => setBusy(false));
  };
  const methods: Method[] = ["mtn_momo", "orange_money", "cash", "bank", "card", "other"];
  return <section>
    <h2>{t("subscription")} <span className={`pill service-${shop.service}`}>{t(shop.service)}</span></h2>
    <dl className="facts"><dt>{t("paidUntil")}</dt><dd>{shop.paidUntil === null ? t("notPaid") : date(language, shop.paidUntil, t)}</dd>
      {shop.graceUntil !== null && <><dt>{t("graceUntil")}</dt><dd>{date(language, shop.graceUntil, t)}</dd></>}</dl>
    {canChange && <form className="panel payment-form" onSubmit={pay}>
      <h2>{t("recordPayment")}</h2><p className="hint">{t("recordPaymentHelp")}</p>
      <div className="row">
        <label className="field">{t("months")}<select value={months} onChange={event => setMonths(Number(event.target.value))}>{[1, 3, 6, 12].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="field">{t("amount")}<input inputMode="numeric" value={amount} onChange={event => setAmount(event.target.value.replace(/\D/g, ""))} required maxLength={12} /></label>
        <label className="field">{t("method")}<select value={method} onChange={event => setMethod(event.target.value as Method)}>{methods.map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        <label className="field grow">{t("reference")}<input value={reference} onChange={event => setReference(event.target.value)} maxLength={120} /></label>
        <button className="primary" type="submit" disabled={busy || amount === ""}>{t(busy ? "recording" : "recordPayment")}</button>
      </div>
      {error !== undefined && error !== "" && <p role="alert" className="notice error">{t(error)}</p>}
    </form>}
    <h2>{t("payments")}</h2>
    {shop.payments.length === 0 ? <p className="empty">{t("noPayments")}</p> : <div className="table-wrap"><table><thead><tr><th>{t("when")}</th><th className="numeric">{t("months")}</th><th className="numeric">{t("amount")}</th><th>{t("method")}</th><th>{t("paidUntil")}</th><th>{t("who")}</th></tr></thead>
      <tbody>{shop.payments.map(payment => <tr key={payment.paymentId}><td>{date(language, payment.recordedAt, t)}</td><td className="numeric">{payment.months}</td>
        <td className="numeric">{payment.amountMinor.toLocaleString(language)}</td><td>{t(payment.method)}{payment.reference !== null && <small>{payment.reference}</small>}</td>
        <td>{date(language, payment.paidUntilAfter, t)}</td><td>{payment.recordedBy}<small>{t(payment.source === "code" ? "viaCodeSource" : payment.source)}</small></td></tr>)}</tbody></table></div>}
  </section>;
}

function Codes({ t, language, canChange, guard }: { t: T; language: Language; canChange: boolean; guard: (error: unknown) => string }): ReactNode {
  const list = useLoad(() => api.codes(), guard, []);
  const [label, setLabel] = useState(""), [days, setDays] = useState(7), [months, setMonths] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const hosted = useLoad(() => api.health(), guard, []).data?.edition === "hosted";
  const [issued, setIssued] = useState<Issued>(), [copied, setCopied] = useState(false);
  const issue = (event: FormEvent): void => {
    event.preventDefault(); setBusy(true); setError(undefined); setCopied(false);
    api.issue(label.trim(), days, hosted ? months : 0).then(value => { setIssued(value); setLabel(""); list.reload(); }, (failure: unknown) => setError(guard(failure))).finally(() => setBusy(false));
  };
  const cancel = (code: Code): void => { api.cancel(code.codeId).then(list.reload, (failure: unknown) => { setError(guard(failure)); list.reload(); }); };
  return <section>
    <div className="heading"><h1>{t("codes")}</h1></div>
    {canChange && <div className="panel">
      {issued !== undefined ? <div className="issued">
        <h2>{t("issuedTitle")}</h2><p className="hint">{t("issuedHelp")} {date(language, issued.expiresAt, t)}.</p>
        <div className="issued-body"><img className="qr" alt="QR" src={`data:image/svg+xml;base64,${btoa(issued.qr)}`} />
          <div><strong>{issued.label}</strong><code className="code">{issued.code}</code>
            <div className="row"><button className="secondary" onClick={() => { navigator.clipboard.writeText(issued.code).then(() => setCopied(true), () => setCopied(false)); }}>{t(copied ? "copied" : "copy")}</button>
              <button className="primary" onClick={() => setIssued(undefined)}>{t("done")}</button></div></div></div>
      </div> : list.data?.canIssue === false ? <p className="notice">{t("publicUrlMissing")}</p> : <form onSubmit={issue}>
        <h2>{t("issueTitle")}</h2><p className="hint">{t("issueHelp")}</p>
        <div className="row">
          <label className="field grow">{t("label")}<input value={label} onChange={event => setLabel(event.target.value)} required maxLength={120} /></label>
          {hosted && <label className="field">{t("includedMonths")}<select value={months} onChange={event => setMonths(Number(event.target.value))}>{[0, 1, 3, 6, 12].map(value => <option key={value} value={value}>{value === 0 ? t("none") : value}</option>)}</select></label>}
          <label className="field">{t("validity")}<select value={days} onChange={event => setDays(Number(event.target.value))}>{[1, 7, 30].map(value => <option key={value} value={value}>{value} {t(value === 1 ? "day" : "days")}</option>)}</select></label>
          <button className="primary" type="submit" disabled={busy || label.trim() === ""}>{t(busy ? "issuing" : "issue")}</button>
        </div>
      </form>}
      {error !== undefined && error !== "" && <p role="alert" className="notice error">{t(error)}</p>}
    </div>}
    <Failure t={t} code={list.error} retry={list.reload} />
    {list.data === undefined ? <p className="muted">{t("loading")}</p> : list.data.codes.length === 0 ? <p className="empty">{t("noCodes")}</p> :
      <div className="table-wrap"><table><thead><tr><th>{t("label")}</th><th>{t("status")}</th><th>{t("created")}</th><th>{t("expires")}</th><th>{t("usedBy")}</th><th /></tr></thead>
        <tbody>{list.data.codes.map(code => <tr key={code.codeId}><td>{code.label}<small>{t("by")} {code.createdBy}{code.includedMonths > 0 ? ` · ${code.includedMonths} ${t("months").toLowerCase()}` : ""}{code.recoveryShopId !== null ? ` · ${t("recovery")}` : ""}</small></td><td><span className={`pill code-${code.state}`}>{t(code.state)}</span></td>
          <td>{date(language, code.createdAt, t)}</td><td>{date(language, code.expiresAt, t)}</td><td>{code.shopName ?? "—"}{code.usedAt !== null && <small>{date(language, code.usedAt, t)}</small>}</td>
          <td className="row-actions">{canChange && code.state === "unused" && <button className="text-button" onClick={() => cancel(code)}>{t("cancel")}</button>}</td></tr>)}</tbody></table></div>}
  </section>;
}

function HealthView({ t, language, guard }: { t: T; language: Language; guard: (error: unknown) => string }): ReactNode {
  const health = useLoad(() => api.health(), guard, []);
  useEffect(() => { const timer = setInterval(health.reload, 30_000); return () => clearInterval(timer); }, [health.reload]);
  const data: Health | undefined = health.data;
  const tile = (label: string, value: string, tone = ""): ReactNode => <div className={`tile ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
  return <section>
    <div className="heading"><h1>{t("health")}</h1></div>
    <Failure t={t} code={health.error} retry={health.reload} />
    {data === undefined ? <p className="muted">{t("loading")}</p> : <>
      <div className="tiles">
        {tile(t("edition"), t(data.edition))}
        {tile(t("shopsByStatus"), `${data.shops.active} ${t("active")} · ${data.shops.suspended} ${t("suspended")} · ${data.shops.removed} ${t("removed")}`)}
        {tile(t("database"), bytes(data.databaseBytes))}{tile(t("facts"), data.facts.toLocaleString(language))}{tile(t("factsLastDay"), data.factsLastDay.toLocaleString(language))}
        {tile(t("sessions"), String(data.activeSessions))}{tile(t("requests"), data.requests.toLocaleString(language))}
        {tile(t("clientErrors"), data.clientErrors.toLocaleString(language))}{tile(t("serverErrors"), data.serverErrors.toLocaleString(language), data.serverErrors > 0 ? "warn" : "")}
        {tile(t("rateLimited"), data.rateLimited.toLocaleString(language))}
      </div>
      <p className="hint">{t("countersNote")} {t("version")} {data.version} · {t("since")} {date(language, data.startedAt, t)}</p>
      <h2>{t("migrations")}</h2><ul className="plain">{data.migrations.map(item => <li key={item.name}><code>{item.name}</code><span className="muted">{date(language, item.appliedAt, t)}</span></li>)}</ul>
    </>}
  </section>;
}

function Audit({ t, language, guard }: { t: T; language: Language; guard: (error: unknown) => string }): ReactNode {
  const [entries, setEntries] = useState<AuditEntry[]>([]), [error, setError] = useState<string>(), [more, setMore] = useState(true), [tick, setTick] = useState(0);
  const load = useCallback((before?: string) => {
    api.audit(before).then(page => { setEntries(current => before === undefined ? page.entries : [...current, ...page.entries]); setMore(page.entries.length === 100); setError(undefined); }, (failure: unknown) => setError(guard(failure)));
  }, [guard]);
  useEffect(() => { load(); }, [load, tick]);
  return <section>
    <div className="heading"><h1>{t("audit")}</h1><a className="secondary link-button" href="/admin/api/audit.csv" download>{t("export")}</a></div>
    <Failure t={t} code={error} retry={() => setTick(value => value + 1)} />
    <div className="table-wrap"><table><thead><tr><th>{t("when")}</th><th>{t("who")}</th><th>{t("action")}</th><th>{t("target")}</th><th>{t("from")}</th></tr></thead>
      <tbody>{entries.map(entry => <tr key={entry.id}><td>{date(language, entry.at, t)}</td><td>{entry.username}</td><td><code>{entry.action}</code>{entry.detail !== null && <small>{JSON.stringify(entry.detail)}</small>}</td>
        <td><code>{entry.target ?? ""}</code></td><td>{entry.address ?? ""}</td></tr>)}</tbody></table></div>
    {more && entries.length > 0 && <button className="secondary" onClick={() => load(entries[entries.length - 1]!.id)}>{t("more")}</button>}
  </section>;
}
