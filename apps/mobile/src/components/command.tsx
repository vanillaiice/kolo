import { useCallback, useEffect, useRef, useState } from "react";
import { useText, type TextKey } from "../app/i18n.tsx";
import type { TextValues } from "../app/strings.ts";
import { FormProblem, failureKey } from "../app/failures.ts";
import { Notice } from "./ui.tsx";

export { FormProblem, StaleRecord, failureKey } from "../app/failures.ts";

type Message = { readonly tone: "success" | "error" | "info" | "warning"; readonly key: TextKey; readonly values?: TextValues | undefined };
/**
 * Runs a synchronous command once at a time. A failure keeps the form and shows a keyed message;
 * `after` runs only after the command returned (that is, after its transaction committed).
 */
export function useAction(): {
  run: <T>(work: () => T, after?: (result: T) => void, success?: TextKey) => void;
  runAsync: <T>(work: () => Promise<T>, after?: (result: T) => void, success?: TextKey) => Promise<void>;
  busy: boolean; message: Message | undefined; show: (message: Message | undefined) => void; notice: React.JSX.Element | null;
} {
  const { t } = useText(), [message, show] = useState<Message>(), [busy, setBusy] = useState(false), running = useRef(false), mounted = useRef(true);
  const run = useCallback(<T,>(work: () => T, after?: (result: T) => void, success?: TextKey): void => {
    if (running.current) return;
    running.current = true;
    let result: T;
    try { result = work(); }
    catch (error) { show({ tone: "error", key: failureKey(error), ...(error instanceof FormProblem ? { values: error.values } : {}) }); return; }
    finally { running.current = false; }
    // The command committed; what follows is navigation/UI and never reported as a failed command.
    show(success === undefined ? undefined : { tone: "success", key: success });
    after?.(result);
  }, []);
  const runAsync = useCallback(async <T,>(work: () => Promise<T>, after?: (result: T) => void, success?: TextKey): Promise<void> => {
    if (running.current) return;
    running.current = true; setBusy(true); show(undefined);
    let result: T;
    try { result = await work(); }
    catch (error) { if (mounted.current) show({ tone: "error", key: failureKey(error), ...(error instanceof FormProblem ? { values: error.values } : {}) }); return; }
    finally { running.current = false; if (mounted.current) setBusy(false); }
    if (!mounted.current) return;
    show(success === undefined ? undefined : { tone: "success", key: success });
    after?.(result);
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return { run, runAsync, busy, message, show, notice: message === undefined ? null : <Notice tone={message.tone} text={t(message.key, message.values)} /> };
}
