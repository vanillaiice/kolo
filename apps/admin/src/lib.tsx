import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";
import { useLocation } from "preact-iso/router";
import type { Edition, Me } from "./api.ts";
import { text, type Language } from "./text.ts";

export type T = (key: string) => string;
/** What every page needs from the shell: text, the operator, refusal handling, step-up and notices. */
export interface Shell {
  readonly t: T; readonly language: Language; readonly me: Me & { readonly edition?: Edition; readonly totp?: boolean };
  readonly canChange: boolean; readonly hosted: boolean;
  /** The stable code of a refusal to show, or "" when there is nothing to show (signed out, step-up cancelled). */
  readonly guard: (error: unknown) => string;
  /** Runs a change; if the server asks for a step-up, asks the operator to confirm and runs it once more. */
  readonly stepUp: <V>(run: () => Promise<V>) => Promise<V>;
  readonly notify: (message: string) => void;
}
export const ShellContext = createContext<Shell>(null as unknown as Shell);
export const useShell = (): Shell => useContext(ShellContext);
export const translate = (language: Language): T => key => text(language, key);

/** Loads on mount and when `dependencies` change; failures keep the last data and show their code with a retry. */
export function useLoad<V>(load: (poll: boolean) => Promise<V>, dependencies: readonly unknown[]): { data: V | undefined; error: string | undefined; reload: (poll?: boolean) => void; loadedAt: Date | undefined } {
  const { guard } = useShell();
  const [data, setData] = useState<V>(), [error, setError] = useState<string>(), [loadedAt, setLoadedAt] = useState<Date>();
  const generation = useRef(0), loader = useRef(load);
  loader.current = load;
  const reload = useCallback((poll = false) => {
    const mine = ++generation.current;
    loader.current(poll).then(value => { if (mine === generation.current) { setData(value); setError(undefined); setLoadedAt(new Date()); } },
      (failure: unknown) => { if (mine === generation.current) setError(guard(failure)); });
  }, [guard]);
  useEffect(() => { reload(); }, dependencies);
  return { data, error, reload, loadedAt };
}

/** Calls `refresh(true)` every `ms` while the page is visible, and once on returning to it. */
export function usePoll(refresh: (poll: boolean) => void, ms = 30_000): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = (): void => { stop(); if (document.visibilityState === "visible") timer = setInterval(() => refresh(true), ms); };
    const stop = (): void => { if (timer !== undefined) clearInterval(timer); timer = undefined; };
    const changed = (): void => { if (document.visibilityState === "visible") refresh(true); start(); };
    start(); document.addEventListener("visibilitychange", changed);
    return () => { stop(); document.removeEventListener("visibilitychange", changed); };
  }, [refresh, ms]);
}

/** The page's query string as state: links and the back button keep filters, sort and page. */
export function useQuery(): [Record<string, string>, (patch: Record<string, string | number | undefined>) => void] {
  const location = useLocation();
  const set = useCallback((patch: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams(location.query);
    for (const [key, value] of Object.entries(patch)) if (value === undefined || value === "") params.delete(key); else params.set(key, String(value));
    const search = params.toString();
    location.route(`${location.path}${search === "" ? "" : `?${search}`}`, true);
  }, [location.path, location.query]);
  return [location.query, set];
}

/** Runs one change at a time per form: `busy` blocks a double submit, `error` holds the refusal to show. */
export function useAction(): { busy: boolean; error: string | undefined; setError: (code: string | undefined) => void; run: <V>(action: () => Promise<V>, done?: (value: V) => void) => void } {
  const { guard, stepUp } = useShell();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), flight = useRef(false);
  const run = <V,>(action: () => Promise<V>, done?: (value: V) => void): void => {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(undefined);
    stepUp(action).then(value => done?.(value), (failure: unknown) => { const code = guard(failure); setError(code === "" ? undefined : code); })
      .finally(() => { flight.current = false; setBusy(false); });
  };
  return { busy, error, setError, run };
}

const locale = (language: Language): string => language === "fr" ? "fr-FR" : "en-GB";
export const bytes = (value: number): string => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024 ** 3).toFixed(2)} GiB`;
export const number = (language: Language, value: number): string => value.toLocaleString(locale(language));
export const money = (language: Language, value: number): string => `${value.toLocaleString(locale(language))} ${language === "fr" ? "FCFA" : "XAF"}`;
export const dateTime = (language: Language, value: string): string => new Date(value).toLocaleString(locale(language), { dateStyle: "medium", timeStyle: "short" });
export const dateOnly = (language: Language, value: string): string => new Date(value).toLocaleDateString(locale(language), { dateStyle: "medium" });
/** "3 min ago", "in 2 days": the nearest unit, for dates people scan rather than read. */
export function relative(language: Language, value: string, now = Date.now()): string {
  const seconds = (new Date(value).getTime() - now) / 1000, format = new Intl.RelativeTimeFormat(locale(language), { numeric: "auto" });
  for (const [unit, size] of [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3600], ["minute", 60]] as const)
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(Math.round(seconds), "second");
}
export const DAY = 86_400_000;
/** True for a dashed UUID, so audit targets that are shops can link to them. */
export const isId = (value: string | null): value is string => value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** A date shown relative, with the exact time on hover and for assistive technology. */
export function When({ value, empty }: { value: string | null; empty?: string }): ComponentChildren {
  const { language, t } = useShell();
  if (value === null) return <span class="muted">{empty ?? t("never")}</span>;
  return <time dateTime={value} title={dateTime(language, value)}>{relative(language, value)}</time>;
}

export function Failure({ code, retry }: { code: string | undefined; retry?: () => void }): ComponentChildren {
  const { t } = useShell();
  if (code === undefined || code === "") return null;
  return <p role="alert" class="notice error">{t(code)}{retry !== undefined && <> <button type="button" class="link" onClick={retry}>{t("retry")}</button></>}</p>;
}

export const Pill = ({ tone, children }: { tone: string; children: ComponentChildren }): ComponentChildren => <span class={`pill ${tone}`}>{children}</span>;

/** "51–100 of 312" with previous and next. */
export function Pager({ offset, limit, shown, total, onOffset }: { offset: number; limit: number; shown: number; total: number; onOffset: (offset: number) => void }): ComponentChildren {
  const { t, language } = useShell();
  if (total <= limit && offset === 0) return null;
  return <nav class="pager" aria-label={t("next")}>
    <span>{shown === 0 ? 0 : number(language, offset + 1)}–{number(language, offset + shown)} {t("of")} {number(language, total)}</span>
    <button type="button" class="secondary small" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - limit))}>{t("previous")}</button>
    <button type="button" class="secondary small" disabled={offset + shown >= total} onClick={() => onOffset(offset + limit)}>{t("next")}</button>
  </nav>;
}

/** A column header that sorts by `key`; a second press reverses the direction. */
export function SortHeader({ label, sortKey, sort, dir, onSort, numeric }: { label: string; sortKey: string; sort: string; dir: string; onSort: (key: string, dir: string) => void; numeric?: boolean }): ComponentChildren {
  const current = sort === sortKey;
  return <th class={numeric === true ? "numeric" : undefined} aria-sort={current ? (dir === "asc" ? "ascending" : "descending") : undefined}>
    <button type="button" class="sort" onClick={() => onSort(sortKey, current && dir === "desc" ? "asc" : "desc")}>{label}<span aria-hidden="true" class="arrow">{current ? (dir === "asc" ? "↑" : "↓") : ""}</span></button>
  </th>;
}

/** A modal on the native dialog element: focus is trapped and Escape closes it. */
export function Dialog({ open, onClose, labelledBy, children }: { open: boolean; onClose: () => void; labelledBy: string; children: ComponentChildren }): ComponentChildren {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (dialog === null) return; if (open && !dialog.open) dialog.showModal(); if (!open && dialog.open) dialog.close(); }, [open]);
  return <dialog ref={ref} class="dialog" aria-labelledby={labelledBy} onCancel={event => { event.preventDefault(); onClose(); }}>{open && children}</dialog>;
}

export function CopyButton({ value, label }: { value: string; label?: string }): ComponentChildren {
  const { t } = useShell();
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  // The clipboard API needs a secure context; over plain HTTP the text stays selectable instead.
  if (typeof navigator.clipboard === "undefined") return null;
  return <button type="button" class="secondary small" onClick={() => { navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false)); }}>{t(copied ? "copied" : "copy")}{label === undefined ? "" : ` ${label}`}</button>;
}

/**
 * The audit chain's seal: eight colour blocks and the first eight characters of an entry's hash. Two seals that
 * look the same are the same entry; an operator notes one and compares it later (ADR-045).
 */
export function Seal({ hash, size = "small" }: { hash: string; size?: "small" | "large" }): ComponentChildren {
  const blocks = Array.from({ length: 8 }, (_, index) => parseInt(hash.slice(index * 2, index * 2 + 2), 16));
  return <span class={`seal ${size}`} title={hash}>
    <span class="seal-blocks" aria-hidden="true">{blocks.map((value, index) => <i key={index} style={{ background: `hsl(${Math.round(value * 360 / 256)} ${55 + (value % 4) * 8}% ${38 + (value % 3) * 8}%)` }} />)}</span>
    <code>{hash.slice(0, 8)}</code>
  </span>;
}

/** One series of daily counts as bars, each with its value on hover and focus; a table carries the same numbers. */
export function DailyBars({ title, days }: { title: string; days: readonly { day: string; facts: number }[] }): ComponentChildren {
  const { language } = useShell();
  const [focus, setFocus] = useState<number>();
  const width = 560, height = 140, gap = 2, top = 18, max = Math.max(1, ...days.map(item => item.facts));
  const step = width / Math.max(1, days.length), bar = Math.max(2, step - gap);
  const label = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString(locale(language), { day: "numeric", month: "short", timeZone: "UTC" });
  const active = focus === undefined ? undefined : days[focus];
  return <figure class="chart">
    <figcaption>{title}</figcaption>
    <div class="chart-plot">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} preserveAspectRatio="none">
        <line x1="0" x2={width} y1={height} y2={height} class="axis" />
        {days.map((item, index) => {
          const h = item.facts === 0 ? 0 : Math.max(3, Math.round((item.facts / max) * (height - top))), x = index * step + gap / 2;
          return <g key={item.day} tabIndex={0} class={focus === index ? "bar focused" : "bar"} onMouseEnter={() => setFocus(index)} onMouseLeave={() => setFocus(undefined)} onFocus={() => setFocus(index)} onBlur={() => setFocus(undefined)}
            aria-label={`${label(item.day)}: ${number(language, item.facts)}`}>
            <rect x={index * step} y={0} width={step} height={height} class="hit" />
            {h > 0 && <path d={`M${x},${height} V${height - h + 4} q0,-4 4,-4 h${bar - 8} q4,0 4,4 V${height} Z`} class="mark" />}
          </g>;
        })}
      </svg>
      <div class="ticks" aria-hidden="true">{[days[0], days[Math.floor(days.length / 2)], days[days.length - 1]].map(item => item === undefined ? null : <span key={item.day}>{label(item.day)}</span>)}</div>
      {active !== undefined && <div class="tip" role="status" style={{ left: `${((focus! + 0.5) / days.length) * 100}%` }}><strong>{number(language, active.facts)}</strong> {label(active.day)}</div>}
    </div>
    <table class="visually-hidden"><caption>{title}</caption><tbody>{days.map(item => <tr key={item.day}><th scope="row">{item.day}</th><td>{item.facts}</td></tr>)}</tbody></table>
  </figure>;
}

/** A till count with an explicit "Unlimited" choice. */
export function LimitInput({ limit, unlimited, onLimit, onUnlimited, idPrefix }: { limit: string; unlimited: boolean; onLimit: (value: string) => void; onUnlimited: (value: boolean) => void; idPrefix: string }): ComponentChildren {
  const { t } = useShell();
  return <div class="row limit-row">
    <label class="field" htmlFor={`${idPrefix}-tills`}>{t("tillLimit")}<input id={`${idPrefix}-tills`} type="number" min={1} max={1000} step={1} inputMode="numeric" value={unlimited ? "" : limit} disabled={unlimited}
      onInput={event => onLimit(event.currentTarget.value)} /></label>
    <label class="check" htmlFor={`${idPrefix}-unlimited`}><input id={`${idPrefix}-unlimited`} type="checkbox" checked={unlimited} onChange={event => onUnlimited(event.currentTarget.checked)} />{t("unlimitedTills")}</label>
    <p class="hint">{t("tillLimitHelp")}</p>
  </div>;
}

/** A one-time secret handed to someone: QR code, the text, copy, and (for codes) a QR download. */
export function OneTime({ title, help, qr, value, extra, filename, onDone }: { title: string; help: string; qr: string; value: string; extra?: ComponentChildren; filename?: string; onDone: () => void }): ComponentChildren {
  const { t } = useShell();
  const [href, setHref] = useState<string>();
  useEffect(() => { const url = URL.createObjectURL(new Blob([qr], { type: "image/svg+xml" })); setHref(url); return () => URL.revokeObjectURL(url); }, [qr]);
  return <div class="one-time" role="region" aria-label={title}>
    <h2>{title}</h2><p class="hint">{help}</p>
    <div class="one-time-body">
      {href !== undefined && <img class="qr" alt="QR" src={`data:image/svg+xml;base64,${btoa(qr)}`} />}
      <div class="one-time-text">{extra}<code class="secret">{value}</code>
        <div class="row"><CopyButton value={value} />{filename !== undefined && href !== undefined && <a class="secondary small button" href={href} download={filename}>{t("downloadQr")}</a>}
          <button type="button" class="primary" onClick={onDone}>{t("done")}</button></div></div>
    </div>
  </div>;
}

