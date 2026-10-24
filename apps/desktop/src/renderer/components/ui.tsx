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
export function ErrorText({ message, inputMessage, conflictMessage }: { readonly message: Message | undefined; readonly inputMessage?: TextKey; readonly conflictMessage?: TextKey }): React.JSX.Element | null {
  const { t, language } = useText();
  const key = message?.code === "invalid_input" ? inputMessage : message?.code === "request_conflict" ? conflictMessage : undefined;
  return message === undefined ? null : <p role="alert" className="notice error">{t(key ?? message.code)}{message.retryAt === undefined ? "" : ` ${new Date(message.retryAt).toLocaleTimeString(language === "fr" ? "fr-FR" : "en-GB")}`}</p>;
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
/**
 * A labelled text input. Like every form control it says what it is for: `hint` is required and shown under the
 * input (read with it by screen readers); `null` marks a field whose label and place already say everything.
 */
export function Field({ label, hint, value, onChange, secret = false, numeric = false, required = true, id, disabled = false, maxLength = 120 }: {
  readonly label: string; readonly hint: string | null; readonly value: string; readonly onChange: (value: string) => void; readonly secret?: boolean;
  readonly numeric?: boolean; readonly required?: boolean; readonly id: string; readonly disabled?: boolean; readonly maxLength?: number;
}): React.JSX.Element {
  const { t } = useText(), [visible, setVisible] = useState(false);
  const input = <input id={id} name={id} value={value} onChange={event => onChange(event.target.value)}
    type={secret && !visible ? "password" : "text"} inputMode={numeric ? "decimal" : "text"} autoComplete="off" spellCheck={false}
    required={required} disabled={disabled} maxLength={maxLength} {...described(id, hint)} />;
  if (!secret) return <div className="field"><label htmlFor={id}>{label}</label>{input}<FieldHint id={id} hint={hint}/></div>;
  // Secrets can be revealed to check typing; the toggle sits beside the input, outside its label.
  const toggle = t(visible ? "hideSecret" : "showSecret");
  return <div className="field"><label htmlFor={id}>{label}</label><div className="secret-input">{input}
    <button type="button" className="secret-toggle" aria-controls={id} aria-label={`${toggle} · ${label}`} disabled={disabled}
      onClick={() => setVisible(current => !current)}>{toggle}</button></div><FieldHint id={id} hint={hint}/></div>;
}
/** The description under a control, linked to it with `aria-describedby`. */
function FieldHint({ id, hint }: { readonly id: string; readonly hint: string | null }): React.JSX.Element | null {
  return hint === null ? null : <small className="field-hint" id={`${id}-hint`}>{hint}</small>;
}
function described(id: string, hint: string | null): { "aria-describedby"?: string } {
  return hint === null ? {} : { "aria-describedby": `${id}-hint` };
}
/** A settings checkbox with its description; list filters and permission grids use plain `label.check` rows. */
export function Check({ id, label, hint, checked, onChange, disabled = false }: {
  readonly id: string; readonly label: string; readonly hint: string | null; readonly checked: boolean; readonly onChange: (checked: boolean) => void; readonly disabled?: boolean;
}): React.JSX.Element {
  return <div className="check-field"><label className="check" htmlFor={id}><input id={id} type="checkbox" checked={checked} disabled={disabled}
    onChange={event => onChange(event.target.checked)} {...described(id, hint)}/>{label}</label><FieldHint id={id} hint={hint}/></div>;
}
/** Labelled native select with its description; options are supplied already localized. */
export function Select({ label, hint, value, onChange, id, options, disabled = false }: {
  readonly label: string; readonly hint: string | null; readonly value: string; readonly onChange: (value: string) => void; readonly id: string;
  readonly options: readonly { readonly value: string; readonly label: string; readonly disabled?: boolean }[]; readonly disabled?: boolean;
}): React.JSX.Element {
  return <div className="field"><label htmlFor={id}>{label}</label><select id={id} name={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} {...described(id, hint)}>
    {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select><FieldHint id={id} hint={hint}/></div>;
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

/** Width at which `.record-layout` stacks; keep in step with styles.css. */
const STACKED_RECORDS = "(max-width: 1100px)";

/**
 * List/detail screens: when the layout is stacked the detail replaces the list, so opening a
 * record brings the detail to the top of the window. Wide layouts already show both and do not move.
 */
export function useRevealDetail(selected: string | undefined): React.RefObject<HTMLDivElement | null> {
  const detail = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected !== undefined && window.matchMedia(STACKED_RECORDS).matches) detail.current?.scrollIntoView({ block: "start" }); }, [selected]);
  return detail;
}

/** Return from a record to its list; only shown while the record layout is stacked. */
export function BackToList({ label, onBack }: { readonly label: string; readonly onBack: () => void }): React.JSX.Element {
  const { t } = useText();
  return <button type="button" className="text-button back-to-list no-print" onClick={onBack}><span aria-hidden="true">←</span>{t("back")} · {label}</button>;
}
