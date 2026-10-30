import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { api, type Enrolment, type Operator, type Role } from "../api.ts";
import { Failure, OneTime, Pill, useAction, useLoad, useShell, When } from "../lib.tsx";

/** Operator accounts: admins create them and change others; every change needs a step-up (ADR-045). */
export function Operators(): ComponentChildren {
  const { t, me, notify } = useShell();
  const list = useLoad(() => api.operators(), []);
  const action = useAction();
  const [enrolment, setEnrolment] = useState<{ value: Enrolment; reset: boolean }>();
  const [username, setUsername] = useState(""), [role, setRole] = useState<Role>("viewer");
  const change = (run: () => Promise<unknown>): void => action.run(run, () => { notify(t("operatorChanged")); list.reload(); });
  const create = (event: Event): void => {
    event.preventDefault();
    action.run(() => api.createOperator(username.trim(), role), value => { setEnrolment({ value, reset: false }); setUsername(""); list.reload(); });
  };
  return <section>
    <header class="page-head"><h1>{t("operators")}</h1></header>
    {list.data?.totp === false && <p class="notice warning">{t("totpOff")}</p>}
    {enrolment !== undefined ? <section class="panel">
      <OneTime title={t("enrolTitle")} help={enrolment.reset ? t("resetHelp") : t("enrolHelp")} qr={enrolment.value.qr} value={enrolment.value.password ?? enrolment.value.uri}
        extra={<p><strong>{enrolment.value.username}</strong>{enrolment.value.password !== undefined && <> ({t("password").toLowerCase()})</>}</p>} onDone={() => setEnrolment(undefined)} />
    </section> : <form class="panel" onSubmit={create}>
      <h2>{t("newOperator")}</h2><p class="hint">{t("newOperatorHelp")}</p>
      <div class="row">
        <label class="field grow">{t("username")}<input value={username} onInput={event => setUsername(event.currentTarget.value)} required minLength={3} maxLength={64} pattern="[A-Za-z0-9._\-]{3,64}" autoComplete="off" /></label>
        <label class="field">{t("role")}<select value={role} onChange={event => setRole(event.currentTarget.value as Role)}><option value="viewer">{t("viewer")}</option><option value="admin">{t("admin")}</option></select></label>
        <button class="primary" type="submit" disabled={action.busy || username.trim().length < 3}>{t("createOperator")}</button>
      </div>
    </form>}
    <Failure code={list.error ?? action.error} retry={() => list.reload()} />
    {list.data === undefined ? <p class="muted">{t("loading")}</p> : <div class="table-wrap"><table>
      <thead><tr><th>{t("username")}</th><th>{t("role")}</th><th>{t("status")}</th><th>{t("lastSignIn")}</th><th class="numeric">{t("sessionsShort")}</th><th><span class="visually-hidden">{t("action")}</span></th></tr></thead>
      <tbody>{list.data.operators.map((operator: Operator) => {
        const self = operator.username === me.username;
        return <tr key={operator.adminId}>
          <td><strong>{operator.username}</strong>{self && <span class="tag">{t("you")}</span>}</td>
          <td>{t(operator.role)}</td>
          <td>{!operator.active ? <Pill tone="removed">{t("deactivated")}</Pill> : operator.locked ? <Pill tone="warning">{t("locked")}</Pill> : <Pill tone="active">{t("active")}</Pill>}</td>
          <td><When value={operator.lastLoginAt} /></td>
          <td class="numeric">{operator.sessions}</td>
          <td class="row-actions">{!self && <div class="row-buttons">
            {operator.active && <button type="button" class="link" disabled={action.busy} onClick={() => change(() => api.setRole(operator.adminId, operator.role === "admin" ? "viewer" : "admin"))}>{t(operator.role === "admin" ? "makeViewer" : "makeAdmin")}</button>}
            {operator.locked && operator.active && <button type="button" class="link" disabled={action.busy} onClick={() => change(() => api.changeOperator(operator.adminId, "unlock"))}>{t("unlock")}</button>}
            {operator.active && <button type="button" class="link" disabled={action.busy} onClick={() => action.run(() => api.resetOperator(operator.adminId), value => { setEnrolment({ value, reset: true }); list.reload(); })}>{t("resetTotp")}</button>}
            <button type="button" class={operator.active ? "link danger-text" : "link"} disabled={action.busy} onClick={() => change(() => api.changeOperator(operator.adminId, operator.active ? "deactivate" : "activate"))}>{t(operator.active ? "deactivate" : "activate")}</button>
          </div>}</td>
        </tr>;
      })}</tbody>
    </table></div>}
  </section>;
}
