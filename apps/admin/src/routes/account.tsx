import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { Failure, useAction, useLoad, useShell, When } from "../lib.tsx";

/** The signed-in operator's sessions and password. */
export function Account(): ComponentChildren {
  const { t, me, notify } = useShell();
  const sessions = useLoad(() => api.sessions(), []);
  const ending = useAction(), changing = useAction();
  const [password, setPassword] = useState(""), [repeat, setRepeat] = useState("");
  const others = (sessions.data?.sessions ?? []).filter(session => !session.current).length;
  const change = (event: Event): void => {
    event.preventDefault();
    if (password !== repeat) { changing.setError("passwordsDiffer"); return; }
    changing.run(() => api.changePassword(password), () => { setPassword(""); setRepeat(""); notify(t("passwordChanged")); sessions.reload(); });
  };
  return <section>
    <header class="page-head"><h1>{t("account")}</h1><p class="muted">{me.username}, {t(me.role)}</p></header>
    <h2>{t("mySessions")}</h2>
    <Failure code={sessions.error ?? ending.error} retry={() => sessions.reload()} />
    {sessions.data === undefined ? <p class="muted">{t("loading")}</p> : <>
      <div class="table-wrap"><table>
        <thead><tr><th>{t("started")}</th><th>{t("lastSeen")}</th><th>{t("address")}</th><th><span class="visually-hidden">{t("action")}</span></th></tr></thead>
        <tbody>{sessions.data.sessions.map(session => <tr key={session.id}>
          <td><When value={session.createdAt} />{session.current && <span class="tag">{t("thisSession")}</span>}</td>
          <td><When value={session.lastSeenAt} /></td><td><code>{session.address}</code></td>
          <td class="row-actions">{!session.current && <button type="button" class="link" disabled={ending.busy} onClick={() => ending.run(() => api.revokeSession(session.id), () => sessions.reload())}>{t("endSession")}</button>}</td>
        </tr>)}</tbody>
      </table></div>
      {others > 0 && <button type="button" class="secondary" disabled={ending.busy} onClick={() => ending.run(() => api.signOutOthers(), result => { notify(`${result.ended} ${t("othersEnded")}`); sessions.reload(); })}>{t("signOutOthers")}</button>}
    </>}
    <form class="panel narrow" onSubmit={change}>
      <h2>{t("changePassword")}</h2><p class="hint">{t("passwordHelp")}</p>
      <input type="text" autoComplete="username" value={me.username} hidden readOnly />
      <label class="field">{t("newPassword")}<input type="password" autoComplete="new-password" value={password} onInput={event => setPassword(event.currentTarget.value)} required minLength={12} maxLength={256} /></label>
      <label class="field">{t("repeatPassword")}<input type="password" autoComplete="new-password" value={repeat} onInput={event => setRepeat(event.currentTarget.value)} required minLength={12} maxLength={256} /></label>
      {changing.error !== undefined && <p role="alert" class="notice error">{t(changing.error)}</p>}
      <button type="submit" class="primary" disabled={changing.busy || password.length < 12}>{t("changePassword")}</button>
    </form>
  </section>;
}
