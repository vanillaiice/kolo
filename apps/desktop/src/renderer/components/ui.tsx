import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Result } from "../../shared/service.ts";
import { text, type Language, type TextKey } from "../text.ts";

export const TextContext = createContext<Language>("fr");
/** Text and number locale selected by the shell, with no platform SDK dependency. */
export function useText(): { t: (key: TextKey) => string; language: Language } {
  const language = useContext(TextContext); return { language, t: key => text(language, key) };
}
export type Message = { readonly code: TextKey; readonly retryAt?: string };
/** Stable failures are localized at render time; raw native errors are never shown. */
export function ErrorText({ message, inputMessage }: { readonly message: Message | undefined; readonly inputMessage?: TextKey }): React.JSX.Element | null {
  const { t, language } = useText();
  return message === undefined ? null : <p role="alert" className="notice error">{t(message.code === "invalid_input" && inputMessage !== undefined ? inputMessage : message.code)}{message.retryAt === undefined ? "" : ` ${new Date(message.retryAt).toLocaleTimeString(language === "fr" ? "fr-FR" : "en-GB")}`}</p>;
}
/** Named operation calls may also fail at the transport boundary. */
export async function call<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
  try { return await work(); } catch { return { ok: false, error: { code: "unavailable" } }; }
}
/** Single-flight form work preserves inputs on failure and ignores completion after unmount. */
export function useAction(): { busy: boolean; error: Message | undefined; setError: (value: Message | undefined) => void; run: <T>(work: () => Promise<Result<T>>) => Promise<T | undefined> } {
  const [busy, setBusy] = useState(false), [error, setError] = useState<Message>();
  const running = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async <T,>(work: () => Promise<Result<T>>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true; setBusy(true); setError(undefined);
    try { const result = await call(work); if (!mounted.current) return undefined; if (!result.ok) { setError(result.error); return undefined; } return result.value; }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  return { busy, error, setError, run };
}
/** Async bounded reads drop obsolete responses when filter/page/session changes. */
export function useRead<T>(load: () => Promise<Result<T>>, dependencies: readonly unknown[]): {
  data: T | undefined; error: Message | undefined; loading: boolean; retry: () => void;
} {
  const [data, setData] = useState<T>(), [error, setError] = useState<Message>(), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false; setLoading(true); setData(undefined); setError(undefined);
    void call(load).then(result => { if (disposed) return; if (result.ok) setData(result.value); else setError(result.error); setLoading(false); });
    return () => { disposed = true; };
  }, [...dependencies, retry]);
  return { data, error, loading, retry: () => setRetry(value => value + 1) };
}
/** Labelled keyboard-friendly form input with browser-native focus and accessible error handling. */
export function Field({ label, value, onChange, secret = false, numeric = false, required = true, id, disabled = false, maxLength = 120 }: {
  readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly secret?: boolean;
  readonly numeric?: boolean; readonly required?: boolean; readonly id: string; readonly disabled?: boolean; readonly maxLength?: number;
}): React.JSX.Element {
  return <label className="field" htmlFor={id}><span>{label}</span><input id={id} name={id} value={value} onChange={event => onChange(event.target.value)}
    type={secret ? "password" : "text"} inputMode={numeric ? "decimal" : "text"} autoComplete="off"
    required={required} disabled={disabled} maxLength={maxLength} /></label>;
}
/** Paged views keep only the current bounded result. */
export function Pager({ hasFirst, hasNext, onFirst, onNext }: { readonly hasFirst: boolean; readonly hasNext: boolean; readonly onFirst: () => void; readonly onNext: () => void }): React.JSX.Element {
  const { t } = useText();
  return <div className="pager">{hasFirst && <button className="secondary" onClick={onFirst}>{t("first")}</button>}{hasNext && <button className="secondary" onClick={onNext}>{t("more")} <span aria-hidden="true">→</span></button>}</div>;
}
/** Clear loading, empty and error states on every async list. */
export function ReadState({ loading, error, empty, emptyText, retry, children }: {
  readonly loading: boolean; readonly error: Message | undefined; readonly empty: boolean; readonly emptyText: string;
  readonly retry: () => void; readonly children: ReactNode;
}): React.JSX.Element {
  const { t } = useText();
  return loading ? <p className="muted" role="status">{t("opening")}</p> : error !== undefined ? <><ErrorText message={error} /><button className="secondary" onClick={retry}>{t("retry")}</button></> : empty ? <div className="empty"><p>{emptyText}</p></div> : <>{children}</>;
}
