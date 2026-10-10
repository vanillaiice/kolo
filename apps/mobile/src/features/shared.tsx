import { useEffect, useMemo, useRef, useState } from "react";
import { InteractionManager } from "react-native";
import { newIdOnDevice } from "../data/auth/local-credentials-on-device.ts";
import { localeOf, type Language } from "../app/i18n.tsx";

export { nextVersion, requireVersion } from "../app/failures.ts";

/** Local date and time for a stored instant. */
export function formatDate(iso: string, language: Language, withTime = true): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat(localeOf(language), withTime ? { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" }).format(date);
}
/** Local calendar day as YYYY-MM-DD, the input the shared period rule expects. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Reads one record from SQLite whenever its dependencies or revision change; failures become `failed`. */
export function useRecord<T>(read: () => T | undefined, deps: readonly unknown[]): { value: T | undefined; failed: boolean } {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => { try { return { value: read(), failed: false }; } catch { return { value: undefined, failed: true }; } }, deps);
}

/** A request ID that stays the same for retries of one form submission and renews after success. */
export function useRequestId(): { readonly current: string; renew: () => void } {
  const id = useRef<string>(undefined);
  id.current ??= newIdOnDevice();
  return { get current() { return id.current!; }, renew: () => { id.current = newIdOnDevice(); } };
}

/**
 * Runs an expensive synchronous read (reports, analytics) after the screen has painted and any
 * navigation animation finished, so opening the screen never blocks input. A result computed for
 * older dependencies is dropped.
 */
export function useDeferredRecord<T>(read: () => T | undefined, deps: readonly unknown[]): { value: T | undefined; failed: boolean; loading: boolean } {
  const [state, setState] = useState<{ value: T | undefined; failed: boolean; loading: boolean }>({ value: undefined, failed: false, loading: true });
  const latest = useRef(0);
  useEffect(() => {
    const token = ++latest.current;
    setState(current => ({ ...current, loading: true }));
    const task = InteractionManager.runAfterInteractions(() => {
      let next: { value: T | undefined; failed: boolean; loading: boolean };
      try { next = { value: read(), failed: false, loading: false }; } catch { next = { value: undefined, failed: true, loading: false }; }
      if (token === latest.current) setState(next);
    });
    return () => task.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
