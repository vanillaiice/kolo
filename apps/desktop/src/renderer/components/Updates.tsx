import { useEffect, useState } from "react";
import type { FoundUpdate, UpdateService, UpdateView } from "../../shared/service.ts";
import { parseNotes } from "../release-notes.ts";
import { call, ErrorText, useAction, useText } from "./ui.tsx";

/** The update state, kept current from the main process; undefined without an update service (tests, other hosts). */
export function useUpdates(updates: UpdateService | undefined): UpdateView | undefined {
  const [view, setView] = useState<UpdateView>();
  useEffect(() => {
    if (updates === undefined) return undefined;
    let active = true;
    const unsubscribe = updates.onUpdate(next => { if (active) setView(next); });
    void call(() => updates.updateState()).then(result => { if (active && result.ok) setView(current => current ?? result.value); });
    return () => { active = false; unsubscribe(); };
  }, [updates]);
  return view;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
}

/**
 * The notes of every release since this version, newest first, as plain text in the reader's language. Open by default
 * for a breaking update, which the person should read before choosing.
 */
function ReleaseNotes({ found }: { readonly found: FoundUpdate }): React.JSX.Element {
  const { t, language } = useText();
  return <details className="release-notes" open={found.breaking}><summary>{t("updateNotes")}</summary>
    {found.notes.length === 0 ? <p className="hint">{t("updateNoNotes")}</p> : found.notes.map(note => <section key={note.version}>
      {found.notes.length > 1 && <h3>{fill(t("updateNotesFor"), { version: note.version })}</h3>}
      {(() => { const blocks = parseNotes(note.html, language), items: React.JSX.Element[] = [];
        // Consecutive items form one list.
        for (let index = 0; index < blocks.length; index++) {
          const block = blocks[index]!;
          if (block.kind === "item") { const list: string[] = []; while (blocks[index]?.kind === "item") list.push(blocks[index++]!.text); index--; items.push(<ul key={index}>{list.map((item, at) => <li key={at}>{item}</li>)}</ul>); }
          else items.push(block.kind === "heading" ? <h4 key={index}>{block.text}</h4> : <p key={index}>{block.text}</p>);
        }
        return items.length === 0 ? <p className="hint">{t("updateNoNotes")}</p> : items; })()}
    </section>)}
  </details>;
}

/** One line describing the state, shared by the banner and the settings panel. */
function StatusText({ view }: { readonly view: UpdateView }): React.JSX.Element | null {
  const { t } = useText(), status = view.status;
  switch (status.state) {
    case "checking": return <p className="hint">{t("updateChecking")}</p>;
    case "current": return <p className="hint">{t("updateCurrent")}</p>;
    case "available": return <><p><strong>{fill(t("updateAvailable"), { version: status.version })}</strong></p><Found found={status}/></>;
    case "downloading": return <><p role="status">{fill(t("updateDownloading"), { version: status.version, percent: status.percent })}</p><Found found={status}/></>;
    case "ready": return <><p><strong>{fill(t("updateReady"), { version: status.version })}</strong>{view.automatic && view.installsOnClose && !status.breaking && <> {t("updateReadyOnQuit")}</>}</p><Found found={status}/></>;
    case "failed": return <p className="notice error">{t(`updateFailed.${status.step}`)}</p>;
    default: return null;
  }
}

function Found({ found }: { readonly found: FoundUpdate }): React.JSX.Element {
  const { t } = useText();
  return <>{found.breaking && <p className="notice error">{t("updateBreaking")}</p>}<ReleaseNotes found={found}/></>;
}

/** The actions that fit the state: download, open the download page (portable), or restart and install. */
function UpdateActions({ updates, view, onLater }: { readonly updates: UpdateService; readonly view: UpdateView; readonly onLater?: () => void }): React.JSX.Element | null {
  const { t } = useText(), action = useAction(), status = view.status;
  const buttons: React.JSX.Element[] = [];
  if (status.state === "available" && view.mode === "install") buttons.push(<button key="download" className="primary" disabled={action.busy} onClick={() => { void action.run(() => updates.downloadUpdate()); }}>{t("updateDownload")}</button>);
  if (status.state === "available" && view.mode === "notify") buttons.push(<button key="open" className="primary" disabled={action.busy} onClick={() => { void action.run(() => updates.openDownloads()); }}>{t("updateOpenDownloads")}</button>);
  if (status.state === "failed" && (status.step === "download" || status.step === "backup")) buttons.push(<button key="retry" className="secondary" disabled={action.busy} onClick={() => { void action.run(() => updates.checkForUpdate()); }}>{t("retry")}</button>);
  if (status.state === "ready") buttons.push(<button key="install" className="primary" disabled={action.busy} onClick={() => { void action.run(() => updates.installUpdate()); }}>{t("updateInstall")}</button>);
  if (buttons.length === 0) return null;
  if (onLater !== undefined) buttons.push(<button key="later" className="secondary" onClick={onLater}>{t("updateLater")}</button>);
  return <>
    {status.state === "ready" && <p className="hint">{t("updateRestartHelp")} {t("updateCopyHelp")}</p>}
    {status.state === "available" && view.mode === "notify" && <p className="hint">{t("updatePortableHelp")}</p>}
    <div className="actions">{buttons}</div><ErrorText message={action.error}/>
  </>;
}

/**
 * Shown above every screen when a new version is found, downloading or ready, until "Later". A failed background check
 * stays in Settings: a till without internet is normal.
 */
export function UpdateBanner({ updates, view }: { readonly updates: UpdateService | undefined; readonly view: UpdateView | undefined }): React.JSX.Element | null {
  const { t } = useText(), [dismissed, setDismissed] = useState<string>();
  if (updates === undefined || view === undefined || view.mode === "none") return null;
  const status = view.status;
  if (status.state !== "available" && status.state !== "downloading" && status.state !== "ready" && !(status.state === "failed" && status.step !== "check")) return null;
  // "Later" hides one version in one state; the same version becoming ready shows again.
  const key = `${status.state}:${"version" in status ? status.version : status.step}`;
  if (dismissed === key) return null;
  return <div className="panel update-banner" role="region" aria-label={t("updates")}><StatusText view={view}/>
    <UpdateActions updates={updates} view={view} onLater={() => setDismissed(key)}/></div>;
}

/** Settings: version, state, "check now" and the automatic-update preference for this computer. */
export function UpdatesPanel({ updates, view }: { readonly updates: UpdateService | undefined; readonly view: UpdateView | undefined }): React.JSX.Element | null {
  const { t } = useText(), action = useAction();
  if (updates === undefined || view === undefined) return null;
  if (view.mode === "none") return <div className="panel"><h2>{t("updates")}</h2><p className="hint">{t("updateNone")}</p></div>;
  const busy = action.busy || view.status.state === "checking" || view.status.state === "downloading";
  return <div className="panel"><h2>{t("updates")}</h2><p className="hint">{t("updatesHelp")}</p>
    <StatusText view={view}/><UpdateActions updates={updates} view={view}/>
    {view.mode === "install" && <><label className="check" htmlFor="automatic-updates"><input id="automatic-updates" type="checkbox" checked={view.automatic} disabled={action.busy}
      onChange={event => { void action.run(() => updates.setAutomaticUpdates({ enabled: event.target.checked })); }}/>{t("updateAutomatic")}</label>
      <p className="hint">{t(view.installsOnClose ? "updateAutomaticHelp" : "updateAutomaticDebHelp")}</p></>}
    <div className="actions"><button className="secondary" disabled={busy || view.status.state === "ready"} onClick={() => { void action.run(() => updates.checkForUpdate()); }}>{t("updateCheck")}</button></div>
    <ErrorText message={action.error}/>
  </div>;
}
