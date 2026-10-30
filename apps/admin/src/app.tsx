import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { LocationProvider, Route, Router, useLocation } from "preact-iso/router";
import lazy from "preact-iso/lazy";
import { activity, api, ApiError, type Edition, type Me } from "./api.ts";
import type { Language } from "./text.ts";
import { Dialog, ShellContext, translate, useShell, type Shell, type T } from "./lib.tsx";
import { Overview } from "./routes/overview.tsx";
import { Shops } from "./routes/shops.tsx";

const ShopPage = lazy(() => import("./routes/shop.tsx").then(module => module.ShopPage));
const Codes = lazy(() => import("./routes/codes.tsx").then(module => module.Codes));
const BillingPage = lazy(() => import("./routes/billing.tsx").then(module => module.BillingPage));
const Audit = lazy(() => import("./routes/audit.tsx").then(module => module.Audit));
const HealthPage = lazy(() => import("./routes/health.tsx").then(module => module.HealthPage));
const Operators = lazy(() => import("./routes/operators.tsx").then(module => module.Operators));
const Account = lazy(() => import("./routes/account.tsx").then(module => module.Account));

type Theme = "system" | "light" | "dark";
type Signed = Me & { edition?: Edition; totp?: boolean };
const stored = <V extends string>(key: string, allowed: readonly V[], fallback: V): V => {
  try { const value = localStorage.getItem(key) as V | null; return value !== null && allowed.includes(value) ? value : fallback; } catch { return fallback; }
};
const remember = (key: string, value: string): void => { try { localStorage.setItem(key, value); } catch { /* per-viewer convenience only */ } };

/** The operator dashboard: sign-in, then the shell with its pages. */
export function App(): ComponentChildren {
  const [language, setLanguage] = useState<Language>(() => stored("kolo-admin-language", ["fr", "en"], "fr"));
  const [theme, setTheme] = useState<Theme>(() => stored("kolo-admin-theme", ["system", "light", "dark"], "system"));
  const [me, setMe] = useState<Signed | null | undefined>(undefined);
  const t = useMemo(() => translate(language), [language]);
  useEffect(() => { document.documentElement.lang = language; remember("kolo-admin-language", language); }, [language]);
  useEffect(() => { if (theme === "system") delete document.documentElement.dataset["theme"]; else document.documentElement.dataset["theme"] = theme; remember("kolo-admin-theme", theme); }, [theme]);
  useEffect(() => { api.me().then(setMe, () => setMe(null)); }, []);
  const preferences = { language, setLanguage, theme, setTheme, t };
  if (me === undefined) return <main class="center"><p class="muted">{t("loading")}</p></main>;
  if (me === null) return <SignIn {...preferences} onSignedIn={() => { api.me().then(setMe, () => setMe(null)); }} />;
  return <LocationProvider scope={/^\/admin(\/(?!api\/)|$)/}><Signed me={me} setMe={setMe} {...preferences} /></LocationProvider>;
}

interface Preferences { language: Language; setLanguage: (language: Language) => void; theme: Theme; setTheme: (theme: Theme) => void; t: T }

function Preferences({ language, setLanguage, theme, setTheme, t }: Preferences): ComponentChildren {
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  return <div class="preferences">
    <button type="button" class="quiet" lang={language === "fr" ? "en" : "fr"} onClick={() => setLanguage(language === "fr" ? "en" : "fr")}>{t("language")}</button>
    <button type="button" class="quiet" onClick={() => setTheme(next[theme])}>{t(`theme${theme[0]!.toUpperCase()}${theme.slice(1)}`)}</button>
  </div>;
}

function SignIn(props: Preferences & { onSignedIn: () => void }): ComponentChildren {
  const { t } = props;
  const [username, setUsername] = useState(""), [password, setPassword] = useState(""), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [totp, setTotp] = useState(true);
  useEffect(() => { api.config().then(value => setTotp(value.totp), () => setTotp(true)); }, []);
  const submit = (event: Event): void => {
    event.preventDefault(); if (busy) return; setBusy(true); setError(undefined);
    api.signIn(username, password, totp ? code : "").then(props.onSignedIn, (failure: unknown) => { setError(failure instanceof ApiError ? failure.code : "internal"); setCode(""); }).finally(() => setBusy(false));
  };
  return <main class="center sign-in">
    <form class="card" onSubmit={submit}>
      <span class="wordmark">kolo</span>
      <h1>{t("signInTitle")}</h1><p class="muted">{t("signInHelp")}</p>
      <label class="field">{t("username")}<input autoComplete="username" value={username} onInput={event => setUsername(event.currentTarget.value)} required maxLength={64} autoFocus /></label>
      <label class="field">{t("password")}<input type="password" autoComplete="current-password" value={password} onInput={event => setPassword(event.currentTarget.value)} required maxLength={256} /></label>
      {totp && <label class="field">{t("code")}<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onInput={event => setCode(event.currentTarget.value.replace(/\D/g, ""))} required /></label>}
      {error !== undefined && <p role="alert" class="notice error">{t(error)}</p>}
      <button class="primary" type="submit" disabled={busy}>{t(busy ? "signingIn" : "signIn")}</button>
      <Preferences {...props} />
    </form>
  </main>;
}

const NAV = [["overview", "/admin/"], ["shops", "/admin/shops"], ["codes", "/admin/codes"], ["billing", "/admin/billing"], ["audit", "/admin/audit"], ["health", "/admin/health"], ["operators", "/admin/operators"]] as const;

function Signed({ me, setMe, ...preferences }: Preferences & { me: Signed; setMe: (me: Signed | null) => void }): ComponentChildren {
  const { t, language } = preferences;
  const location = useLocation();
  const [menu, setMenu] = useState(false), [notice, setNotice] = useState<{ text: string; id: number }>();
  const [asking, setAsking] = useState<{ retry: () => void; cancel: () => void }>();
  const hosted = me.edition === "hosted", canChange = me.role === "admin";
  useEffect(() => setMenu(false), [location.path]);
  // Any refusal for an ended session returns to sign-in; a cancelled step-up shows nothing.
  const guard = useCallback((error: unknown): string => {
    if (error instanceof ApiError && error.code === "signed_out") { setMe(null); return ""; }
    if (error instanceof ApiError && error.code === "step_up_cancelled") return "";
    return error instanceof ApiError ? error.code : "internal";
  }, [setMe]);
  const stepUp = useCallback(<V,>(run: () => Promise<V>): Promise<V> => run().catch((error: unknown) => {
    if (!(error instanceof ApiError) || error.code !== "step_up_required") throw error;
    return new Promise<V>((resolve, reject) => setAsking({ retry: () => { setAsking(undefined); run().then(resolve, reject); }, cancel: () => { setAsking(undefined); reject(new ApiError("step_up_cancelled", 0)); } }));
  }), []);
  const notify = useCallback((text: string) => setNotice({ text, id: Date.now() }), []);
  useEffect(() => { if (notice === undefined) return; const timer = setTimeout(() => setNotice(undefined), 5000); return () => clearTimeout(timer); }, [notice]);
  const shell: Shell = useMemo(() => ({ t, language, me, canChange, hosted, guard, stepUp, notify }), [t, language, me, canChange, hosted, guard, stepUp, notify]);
  const links = NAV.filter(([key]) => (key !== "billing" || hosted) && (key !== "operators" || canChange));
  const current = (href: string): boolean => href === "/admin/" ? location.path === "/admin/" || location.path === "/admin" : location.path.startsWith(href);
  // "/" focuses the page's search field, as in most consoles.
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]") !== null) return;
      const search = document.querySelector<HTMLInputElement>("input[type=search]");
      if (search !== null) { event.preventDefault(); search.focus(); }
    };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, []);
  return <ShellContext.Provider value={shell}>
    <a class="skip" href="#content">{t("overview")}</a>
    <div class="shell">
      <aside class={menu ? "rail open" : "rail"}>
        <div class="rail-head">
          <a class="wordmark" href="/admin/">kolo</a>
          <button type="button" class="menu-button" aria-expanded={menu} aria-controls="rail-nav" onClick={() => setMenu(!menu)}>{t("menu")}</button>
        </div>
        <div class="rail-body" id="rail-nav">
          <p class="rail-title">{t("title")}</p>
          <nav aria-label={t("title")}>
            {links.map(([key, href]) => <a key={key} href={href} class={current(href) ? "nav current" : "nav"} aria-current={current(href) ? "page" : undefined}>{t(key)}</a>)}
          </nav>
          <div class="rail-foot">
            <a href="/admin/account" class={current("/admin/account") ? "who current" : "who"}><strong>{me.username}</strong><span>{t(me.role)}</span></a>
            <Preferences {...preferences} />
            <button type="button" class="quiet" onClick={() => { void api.signOut().finally(() => setMe(null)); }}>{t("signOut")}</button>
          </div>
        </div>
      </aside>
      <main class="content" id="content" tabIndex={-1}>
        <Idle me={me} onSignedOut={() => setMe(null)} />
        <Router>
          <Route path="/admin/" component={Overview} />
          <Route path="/admin/shops" component={Shops} />
          <Route path="/admin/shops/:id" component={ShopPage} />
          <Route path="/admin/codes" component={Codes} />
          <Route path="/admin/billing" component={BillingPage} />
          <Route path="/admin/audit" component={Audit} />
          <Route path="/admin/health" component={HealthPage} />
          <Route path="/admin/operators" component={Operators} />
          <Route path="/admin/account" component={Account} />
          <Route default component={Overview} />
        </Router>
        <footer class="footer">kolo · hblabs</footer>
      </main>
    </div>
    {notice !== undefined && <p key={notice.id} class="toast" role="status">{notice.text}</p>}
    <StepUp asking={asking} />
  </ShellContext.Provider>;
}

/** Warns two minutes before the idle or absolute session end, and offers to stay. */
function Idle({ me, onSignedOut }: { me: Signed; onSignedOut: () => void }): ComponentChildren {
  const { t } = useShell();
  const [left, setLeft] = useState<{ minutes: number; absolute: boolean }>();
  const expires = me.expiresAt === undefined ? Infinity : new Date(me.expiresAt).getTime();
  useEffect(() => {
    const check = (): void => {
      const idle = activity.last + me.idleMinutes * 60_000 - Date.now(), absolute = expires - Date.now(), remaining = Math.min(idle, absolute);
      if (remaining <= 0) { onSignedOut(); return; }
      setLeft(remaining <= 120_000 ? { minutes: Math.max(1, Math.ceil(remaining / 60_000)), absolute: absolute <= idle } : undefined);
    };
    check(); const timer = setInterval(check, 10_000); return () => clearInterval(timer);
  }, [me.idleMinutes, expires, onSignedOut]);
  if (left === undefined) return null;
  return <div class="notice warning idle" role="alert">
    {t(left.absolute ? "sessionEnds" : "idleWarning")} {left.minutes} {t("minutes")}.
    {!left.absolute && <button type="button" class="secondary small" onClick={() => { void api.me().then(() => setLeft(undefined), () => onSignedOut()); }}>{t("stayIn")}</button>}
  </div>;
}

/** Asks for the password and a fresh code, then retries the change that needed it. */
function StepUp({ asking }: { asking: { retry: () => void; cancel: () => void } | undefined }): ComponentChildren {
  const shell = useShell();
  const t = shell.t;
  const [password, setPassword] = useState(""), [code, setCode] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { setPassword(""); setCode(""); setError(undefined); if (asking !== undefined) setTimeout(() => first.current?.focus(), 0); }, [asking]);
  const totp = shell.me.totp !== false;
  const submit = (event: Event): void => {
    event.preventDefault(); if (busy || asking === undefined) return; setBusy(true); setError(undefined);
    api.confirm(password, totp ? code : "").then(() => asking.retry(), (failure: unknown) => { setError(shell.guard(failure)); setCode(""); }).finally(() => setBusy(false));
  };
  return <Dialog open={asking !== undefined} onClose={() => asking?.cancel()} labelledBy="step-up-title">
    <form onSubmit={submit} class="dialog-body">
      <h2 id="step-up-title">{t("stepUpTitle")}</h2><p class="hint">{t("stepUpHelp")}</p>
      <label class="field">{t("password")}<input ref={first} type="password" autoComplete="current-password" value={password} onInput={event => setPassword(event.currentTarget.value)} required maxLength={256} /></label>
      {totp && <label class="field">{t("code")}<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onInput={event => setCode(event.currentTarget.value.replace(/\D/g, ""))} required /></label>}
      {error !== undefined && error !== "" && <p role="alert" class="notice error">{t(error)}</p>}
      <div class="row end"><button type="button" class="secondary" onClick={() => asking?.cancel()}>{t("cancel")}</button><button type="submit" class="primary" disabled={busy}>{t(busy ? "confirming" : "confirm")}</button></div>
    </form>
  </Dialog>;
}

