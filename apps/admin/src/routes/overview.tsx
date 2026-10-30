import type { ComponentChildren } from "preact";
import { api, type Attention, type AttentionKind } from "../api.ts";
import { DailyBars, Failure, dateOnly, money, number, usePoll, useLoad, useShell, When } from "../lib.tsx";

/** Most serious first: what stops sync or breaks a guarantee, then what will soon, then what is merely quiet. */
const SEVERITY: Readonly<Record<AttentionKind, "critical" | "warning" | "info">> = {
  integrity: "critical", server_errors: "critical", service_inactive: "critical", conflicts: "warning", service_grace: "warning", held_tills: "warning",
  purge_soon: "warning", code_expiring: "info", service_expiring: "info", stale_shop: "info",
};
const ORDER = ["critical", "warning", "info"] as const;

/** The first page: what needs the operator, then the server at a glance. */
export function Overview(): ComponentChildren {
  const { t, language, hosted } = useShell();
  const view = useLoad(poll => api.overview(poll), []);
  usePoll(view.reload);
  const data = view.data;
  const items = data === undefined ? [] : [...data.attention].sort((a, b) => ORDER.indexOf(SEVERITY[a.kind]) - ORDER.indexOf(SEVERITY[b.kind]));
  return <section>
    <header class="page-head">
      <h1>{t("overview")}</h1>
      {view.loadedAt !== undefined && <p class="muted fine">{t("updated")} <When value={view.loadedAt.toISOString()} /> <button type="button" class="link" onClick={() => view.reload()}>{t("refresh")}</button></p>}
    </header>
    <Failure code={view.error} retry={() => view.reload()} />
    {data === undefined ? <p class="muted">{t("loading")}</p> : <>
      <section class="attention" aria-labelledby="attention-title">
        <h2 id="attention-title">{t("needsAttention")}{items.length > 0 && <span class="count">{number(language, items.length)}</span>}</h2>
        {items.length === 0 ? <p class="all-clear">{t("allClear")}</p> :
          <ul class="attention-list">{items.map((item, index) => <AttentionRow key={`${item.kind}-${item.target ?? index}`} item={item} />)}</ul>}
      </section>
      <dl class="figures">
        <Figure label={t("shopsLabel")} value={number(language, data.shops.active)}
          note={[data.shops.suspended > 0 ? `${number(language, data.shops.suspended)} ${t("suspendedShort")}` : "", data.shops.removed > 0 ? `${number(language, data.shops.removed)} ${t("removedShort")}` : ""].filter(Boolean).join(", ")} href="/admin/shops" />
        <Figure label={t("tillsLabel")} value={number(language, data.tills.used)} note={data.tills.held > 0 ? `${number(language, data.tills.held)} ${t("heldShort")}` : ""} />
        <Figure label={t("factsLastDay")} value={number(language, data.factsLastDay)} />
        <Figure label={t("codesLabel")} value={number(language, data.unusedCodes)} href="/admin/codes?state=unused" />
        {hosted && data.revenue !== null && <Figure label={t("revenueLabel")} value={money(language, data.revenue.amountMinor)} note={`${number(language, data.revenue.payments)} ${t("paymentsCount")}`} href="/admin/billing" />}
        {hosted && data.services !== null && <Figure label={t("subscriptionsLabel")} value={number(language, data.services.active)}
          note={[data.services.grace > 0 ? `${data.services.grace} ${t("grace")}` : "", data.services.inactive > 0 ? `${data.services.inactive} ${t("inactive")}` : ""].filter(Boolean).join(", ")} href="/admin/shops?service=inactive" />}
      </dl>
      <DailyBars title={t("factsChart")} days={data.activity} />
    </>}
  </section>;
}

function Figure({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }): ComponentChildren {
  const body = <><dt>{label}</dt><dd class="value">{value}</dd>{note !== undefined && note !== "" && <dd class="note">{note}</dd>}</>;
  return href === undefined ? <div class="figure">{body}</div> : <a class="figure" href={href}>{body}</a>;
}

/** One thing to look at: whose it is, what is wrong in a sentence, and where to act. */
function AttentionRow({ item }: { item: Attention }): ComponentChildren {
  const { t, language } = useShell();
  const severity = SEVERITY[item.kind];
  const href = item.kind === "code_expiring" ? "/admin/codes?state=unused" : item.kind === "integrity" ? "/admin/health" : item.kind === "server_errors" ? "/admin/health" : item.target === null ? undefined : `/admin/shops/${item.target}`;
  const at = item.at === null ? "" : dateOnly(language, item.at);
  const what: ComponentChildren = {
    service_inactive: t("service_inactive"), service_grace: `${t("service_grace")} ${at}`, service_expiring: `${t("service_expiring")} ${at}`,
    held_tills: `${number(language, item.count ?? 0)} ${t("held_tills")}`, conflicts: `${number(language, item.count ?? 0)} ${t("conflicts_attention")}`,
    stale_shop: item.at === null ? t("stale_never") : <>{t("stale_shop")} <When value={item.at} /></>, code_expiring: `${t("code_expiring")} ${item.at === null ? "" : new Date(item.at).toLocaleString(language === "fr" ? "fr-FR" : "en-GB", { dateStyle: "medium", timeStyle: "short" })}`,
    purge_soon: `${t("purge_soon")} ${at}`, server_errors: `${number(language, item.count ?? 0)} ${t("server_errors_attention")}`, integrity: `${t("integrity_attention")} ${t(item.label)}`,
  }[item.kind];
  const title = item.kind === "integrity" ? t("integrity") : item.kind === "server_errors" ? t("serverErrors") : item.label;
  const body = <><span class="attention-title">{title}</span><span class="attention-what">{what}</span></>;
  return <li class={`attention-item ${severity}`}>{href === undefined ? <div>{body}</div> : <a href={href}>{body}</a>}</li>;
}
