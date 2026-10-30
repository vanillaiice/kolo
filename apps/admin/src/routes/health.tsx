import type { ComponentChildren } from "preact";
import { api } from "../api.ts";
import { bytes, dateTime, Failure, isId, number, Seal, usePoll, useLoad, useShell } from "../lib.tsx";

/** "3 d 4 h", "12 min": how long the process has been up. */
function duration(seconds: number): string {
  const days = Math.floor(seconds / 86_400), hours = Math.floor(seconds % 86_400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days > 0 ? `${days} d ${hours} h` : hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

/** The server process, its database, the consistency checks and the audit log's seal. */
export function HealthPage(): ComponentChildren {
  const { t, language } = useShell();
  const health = useLoad(poll => api.health(poll), []);
  const integrity = useLoad(() => api.integrity(), []);
  usePoll(health.reload);
  const data = health.data, checks = integrity.data;
  const row = (label: string, value: ComponentChildren, warn = false): ComponentChildren => <div class={warn ? "warn" : undefined}><dt>{label}</dt><dd>{value}</dd></div>;
  return <section>
    <header class="page-head"><h1>{t("health")}</h1></header>
    <Failure code={health.error ?? integrity.error} retry={() => { health.reload(); integrity.reload(); }} />
    {checks !== undefined && <section class="panel integrity" aria-labelledby="integrity-title">
      <h2 id="integrity-title">{t("integrity")} <span class={checks.ok ? "verdict ok" : "verdict broken"}>{t(checks.ok ? "integrityOk" : "integrityFail")}</span></h2>
      <ul class="checks">{checks.checks.map(check => <li key={check.name} class={check.ok ? "ok" : "broken"}>
        <span class="mark" aria-hidden="true">{check.ok ? "✓" : "✕"}</span>
        <span>{t(check.name)}<span class="visually-hidden">: {t(check.ok ? "ok" : "failing")}</span>
          {!check.ok && <span class="targets">{check.name === "audit_chain" ? `${t("brokenAt")} ${check.targets[0]}` : check.targets.map(target => isId(target) ? <a key={target} href={`/admin/shops/${target}`}><code>{target.slice(0, 8)}</code></a> : <code key={target}>{target}</code>)}</span>}
        </span>
      </li>)}</ul>
      {checks.audit.headHash !== null && <div class="seal-panel">
        <h3>{t("sealTitle")}</h3>
        <p><span class="seq">{t("entry")} {checks.audit.headSeq}</span> <Seal hash={checks.audit.headHash} size="large" /></p>
        <p class="hint">{t("sealHelp")} {t("audit_chain_help")}</p>
      </div>}
    </section>}
    {data === undefined ? <p class="muted">{t("loading")}</p> : <>
      <dl class="readings">
        {row(t("edition"), t(data.edition))}
        {row(t("version"), data.version)}
        {row(t("uptime"), duration(data.runtime.uptimeSeconds))}
        {row(t("shops"), `${number(language, data.shops.active)} ${t("active")}, ${number(language, data.shops.suspended)} ${t("suspended")}, ${number(language, data.shops.removed)} ${t("removed")}`)}
        {row(t("database"), bytes(data.databaseBytes))}
        {row(t("facts"), number(language, data.facts))}
        {row(t("factsLastDay"), number(language, data.factsLastDay))}
        {row(t("sessions"), number(language, data.activeSessions))}
        {row(t("requests"), number(language, data.requests))}
        {row(t("clientErrors"), number(language, data.clientErrors))}
        {row(t("serverErrors"), number(language, data.serverErrors), data.serverErrors > 0)}
        {row(t("rateLimited"), number(language, data.rateLimited))}
        {row(t("memory"), bytes(data.runtime.memoryBytes))}
        {row(t("runtime"), `Node ${data.runtime.node}, PostgreSQL ${data.runtime.postgres}`)}
      </dl>
      <p class="hint">{t("countersNote")} {t("since")} {dateTime(language, data.startedAt)}.</p>
      <h2>{t("migrations")}</h2>
      <ul class="plain">{data.migrations.map(item => <li key={item.name}><code>{item.name}</code><span class="muted">{dateTime(language, item.appliedAt)}</span></li>)}</ul>
    </>}
  </section>;
}
