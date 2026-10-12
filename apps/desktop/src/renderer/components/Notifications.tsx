import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import type { Permission } from "@kolo/core/identity/permissions";
import type { NotificationsView, ShopNotification, ShopService } from "../../shared/service.ts";
import { hasText, text, type Language } from "../text.ts";
import { call, ErrorText, useText, type Message } from "./ui.tsx";

/** The screen an alert opens. */
export type AlertTarget = "products" | "customers" | "purchases" | "finance" | "devices";
const systemKey = "kolo.systemNotifications";
/** Time-based alerts (debts falling due, a sync that stays silent) appear without any change, so the list is reread. */
const REREAD_MS = 5 * 60_000;

/** Whether this computer raises system notifications; on unless switched off here. */
export function systemNotificationsEnabled(): boolean { try { return localStorage.getItem(systemKey) !== "off"; } catch { return true; } }
/** Remembers the system-notification choice for this computer. */
export function setSystemNotificationsEnabled(value: boolean): void { try { localStorage.setItem(systemKey, value ? "on" : "off"); } catch { /* Kept for this session only. */ } }

/** Where an alert leads, and the permission that screen needs. */
export function alertTarget(item: ShopNotification): { readonly target: AlertTarget; readonly permission: Permission } {
  switch (item.kind) {
    case "stock_low": case "stock_negative": return { target: "products", permission: "products.view" };
    case "customer_overdue": return { target: "customers", permission: "customers.view" };
    case "supplier_overdue": case "supplier_due_soon": return { target: "purchases", permission: "suppliers.view" };
    case "cash_difference": return { target: "finance", permission: "cash.view" };
    default: return { target: "devices", permission: "business.settings" };
  }
}

/** Localized title and sentence for one alert, from its kind and facts only. */
export function describeAlert(item: ShopNotification, language: Language): { readonly title: string; readonly body: string } {
  const t = (key: Parameters<typeof text>[1]): string => text(language, key), facts = item.facts;
  const money = (minor = 0): string => formatMoney(minor, language), quantity = (thousandths = 0): string => formatQuantity(thousandths, language);
  const date = (value: string | undefined): string => value === undefined ? "—" : new Date(value).toLocaleDateString(language === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
  const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
  const title = t(`n.${item.kind}`);
  switch (item.kind) {
    case "stock_low": return { title, body: fill(t("nb.stock"), { name: item.name, stock: quantity(facts.onHandThousandths), min: quantity(facts.minimumThousandths) }) };
    case "stock_negative": return { title, body: fill(t("nb.stock_negative"), { name: item.name, stock: quantity(facts.onHandThousandths) }) };
    case "customer_overdue": case "supplier_overdue": return { title, body: fill(t("nb.overdue"), { name: item.name, amount: money(facts.overdueMinor), date: date(facts.oldestDueAt) }) };
    case "supplier_due_soon": return { title, body: fill(t("nb.due_soon"), { name: item.name, amount: money(facts.dueSoonMinor), date: date(facts.nextDueAt) }) };
    case "cash_difference": return { title, body: fill(t("nb.cash"), { name: item.name, counted: money(facts.countedMinor), expected: money(facts.expectedMinor) }) };
    case "sync_refused": return { title, body: facts.error !== undefined && hasText(facts.error) ? t(facts.error) : fill(t("nb.refused"), { name: item.name, error: facts.error ?? "" }) };
    case "sync_stalled": return { title, body: facts.lastSuccessAt === undefined ? t("nb.stalled_never") : fill(t("nb.stalled"), { date: date(facts.lastSuccessAt) }) };
    case "service_grace": return { title, body: fill(t("nb.grace"), { date: date(facts.graceUntil) }) };
    case "service_paused": return { title, body: t("serviceInactive") };
  }
}

/**
 * The signed-in member's alerts: reread on every change and every five minutes. New, unread alerts are raised once
 * as system notifications when this computer allows it, then marked announced; a changed fact raises them again.
 */
export function useNotifications(service: ShopService, sessionId: string, revision: number, open: (target: AlertTarget) => void): {
  readonly data: NotificationsView | undefined; readonly error: Message | undefined; readonly markAll: () => Promise<void>;
} {
  const { language } = useText(), [data, setData] = useState<NotificationsView>(), [error, setError] = useState<Message>(), [tick, setTick] = useState(0);
  const announcing = useRef(false), openRef = useRef(open), languageRef = useRef(language);
  openRef.current = open; languageRef.current = language;
  useEffect(() => { const timer = setInterval(() => setTick(value => value + 1), REREAD_MS); return () => clearInterval(timer); }, []);
  const announce = useCallback(async (view: NotificationsView): Promise<void> => {
    const fresh = view.items.filter(item => !item.read && !item.announced);
    if (fresh.length === 0 || announcing.current || !systemNotificationsEnabled() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    announcing.current = true;
    try {
      for (const item of fresh.slice(0, 3)) {
        const { title, body } = describeAlert(item, languageRef.current), shown = new Notification(title, { body, tag: item.key });
        shown.onclick = () => { window.focus(); openRef.current(alertTarget(item).target); };
      }
      if (fresh.length > 3) new Notification(text(languageRef.current, "notificationsTitle"), { body: `+${fresh.length - 3} ${text(languageRef.current, "moreAlerts")}` });
      const marked = await call(() => service.markNotifications({ sessionId, keys: fresh.map(item => item.key), announced: true }));
      if (marked.ok) setData(marked.value);
    } finally { announcing.current = false; }
  }, [service, sessionId]);
  useEffect(() => {
    let disposed = false;
    void call(() => service.notifications({ sessionId })).then(result => {
      if (disposed) return;
      if (!result.ok) { setError(result.error); return; }
      setError(undefined); setData(result.value); void announce(result.value);
    });
    return () => { disposed = true; };
  }, [service, sessionId, revision, tick, announce]);
  const markAll = useCallback(async (): Promise<void> => {
    const result = await call(() => service.markNotifications({ sessionId }));
    if (result.ok) { setData(result.value); setError(undefined); } else setError(result.error);
  }, [service, sessionId]);
  return { data, error, markAll };
}

/** Topbar button with the unread count; it opens the alert list. */
export function AlertsButton({ unread, expanded, onToggle }: { readonly unread: number; readonly expanded: boolean; readonly onToggle: () => void }): React.JSX.Element {
  const { t } = useText();
  return <button type="button" className={`secondary alerts-button ${unread > 0 ? "has-unread" : ""}`} aria-expanded={expanded} aria-controls="alerts-panel" onClick={onToggle}
    aria-label={unread > 0 ? `${t("notificationsTitle")} · ${unread} ${t("unreadAlerts")}` : t("notificationsTitle")}>
    <span aria-hidden="true">◔</span>{t("notificationsTitle")}{unread > 0 && <span className="alerts-count" aria-hidden="true">{unread}</span>}</button>;
}

/** The current alerts, most serious first, each opening the screen that resolves it when the member may see it. */
export function AlertsPanel({ view, error, permissions, onOpen, onMarkAll, onClose }: {
  readonly view: NotificationsView | undefined; readonly error: Message | undefined; readonly permissions: readonly Permission[];
  readonly onOpen: (target: AlertTarget) => void; readonly onMarkAll: () => void; readonly onClose: () => void;
}): React.JSX.Element {
  const { t, language } = useText();
  return <div id="alerts-panel" className="panel alerts-panel" role="region" aria-label={t("notificationsTitle")} onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
    <div className="detail-heading"><h2>{t("notificationsTitle")}</h2><div className="actions">
      {view !== undefined && view.unread > 0 && <button className="secondary" onClick={onMarkAll}>{t("markAllRead")}</button>}
      <button className="secondary" onClick={onClose}>{t("close")}</button></div></div>
    <ErrorText message={error}/>
    {view === undefined ? <p className="muted" role="status">{t("opening")}</p> : view.items.length === 0 ? <p className="muted">{t("noNotifications")}</p> :
      <ul className="alerts-list">{view.items.map(item => {
        const { title, body } = describeAlert(item, language), { target, permission } = alertTarget(item);
        return <li key={item.key} className={`alert-item ${item.severity} ${item.read ? "read" : "unread"}`}>
          <div><strong>{title}</strong><p>{body}</p></div>
          {permissions.includes(permission) && <button className="text-button" onClick={() => onOpen(target)}>{t("openAlert")} <span aria-hidden="true">→</span></button>}
        </li>;
      })}</ul>}
    {view?.truncated === true && <p className="hint">{t("truncatedRows")}</p>}
  </div>;
}
