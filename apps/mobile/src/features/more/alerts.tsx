import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { markNotificationsAnnounced, markNotificationsRead, notifications, type ShopNotification } from "@kolo/core/application/notifications";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import type { Permission } from "@kolo/core/identity/permissions";
import { useText, type Language, type TextKey } from "../../app/i18n.tsx";
import { translate } from "../../app/strings.ts";
import { useNav, type Navigation } from "../../app/navigation.tsx";
import { usePermissions, useRevision, useSession } from "../../app/session.tsx";
import { useAction } from "../../components/command.tsx";
import { Button, EmptyState, ListRow, Notice, RowGroup, Screen, Toggle } from "../../components/ui.tsx";
import { formatDate, useRecord } from "../shared.tsx";
import { notificationPermission, onNotificationOpened, setSystemNotificationsEnabled as setSystemNotificationsEnabledOnDevice, showNotification, systemNotificationsEnabled } from "../../data/output/notifications-on-device.ts";

/** Time-based alerts (debts falling due, a silent sync) appear without any change, so they are reread. */
const REREAD_MS = 5 * 60_000;

/**
 * While the shop is open, raises new unread alerts once as Android notifications (at most three, then a summary) when
 * this phone allows it, and marks them announced; a changed fact raises them again. A tap opens Alerts. Nothing runs
 * while KOLO is closed: there is no background task.
 */
export function useAlertAnnouncer(openAlerts: () => void): void {
  const { language } = useText(), { context } = useSession(), revision = useRevision(ALERT_DOMAINS), [tick, setTick] = useState(0), running = useRef(false);
  const open = useRef(openAlerts); open.current = openAlerts;
  useEffect(() => onNotificationOpened(() => open.current()), []);
  useEffect(() => {
    const timer = setInterval(() => setTick(value => value + 1), REREAD_MS);
    const state = AppState.addEventListener("change", next => { if (next === "active") setTick(value => value + 1); });
    return () => { clearInterval(timer); state.remove(); };
  }, []);
  useEffect(() => {
    if (running.current || !systemNotificationsEnabled()) return;
    running.current = true;
    void (async () => {
      try {
        if (await notificationPermission(false) !== "granted") return;
        const now = new Date().toISOString(), fresh = notifications(context, now).items.filter(item => !item.read && !item.announced);
        if (fresh.length === 0) return;
        for (const item of fresh.slice(0, 3)) { const { title, body } = describeAlert(item, language); await showNotification(item.key, title, body); }
        if (fresh.length > 3) await showNotification("alerts-summary", translate(language, "alerts"), translate(language, "alertsMore", { count: fresh.length - 3 }));
        markNotificationsAnnounced(context, now, fresh.map(item => item.key));
      } catch { /* A locked session or refused permission only means nothing is shown now. */ }
      finally { running.current = false; }
    })();
  }, [context, revision, tick, language]);
}

/** This phone's switch for Android notifications; turning it on asks Android once (Android 13 and later). */
export function SystemNotificationsToggle(): React.JSX.Element {
  const { t } = useText(), session = useSession(), [enabled, setEnabled] = useState(systemNotificationsEnabled), [status, setStatus] = useState<string>();
  useEffect(() => { void notificationPermission(false).then(setStatus, () => setStatus("denied")); }, []);
  const change = (value: boolean): void => {
    setEnabled(value); setSystemNotificationsEnabledOnDevice(value);
    if (value) void session.systemUi(() => notificationPermission(true)).then(setStatus, () => undefined);
  };
  return <>
    <Toggle label={t("systemNotifications")} value={enabled} onChange={change} hint={t("systemNotificationsHelp")} />
    {enabled && status === "denied" && <Notice tone="warning" text={t("systemNotificationsBlocked")} />}
  </>;
}

/** Domains whose changes can raise or clear an alert. */
export const ALERT_DOMAINS = ["inventory", "products", "customers", "suppliers", "sales", "purchases", "accounts", "settings", "notifications", "authority"] as const;

/** The signed-in member's unread alert count; zero when the alerts cannot be read. */
export function useUnreadAlerts(): number {
  const { context } = useSession(), revision = useRevision(ALERT_DOMAINS);
  return useRecord(() => notifications(context, new Date().toISOString()).unread, [context, revision]).value ?? 0;
}

/** Localized title and sentence for one alert, from its kind and facts only. */
export function describeAlert(item: ShopNotification, language: Language): { readonly title: string; readonly body: string } {
  const t = (key: TextKey, values?: Record<string, string>): string => translate(language, key, values), facts = item.facts;
  const money = (minor = 0): string => formatMoney(minor, language), quantity = (thousandths = 0): string => formatQuantity(thousandths, language);
  const date = (value: string | undefined): string => value === undefined ? "—" : formatDate(value, language, false);
  const title = t(`alert.${item.kind}`);
  switch (item.kind) {
    case "stock_low": return { title, body: t("alertBody.stock", { name: item.name, stock: quantity(facts.onHandThousandths), min: quantity(facts.minimumThousandths) }) };
    case "stock_negative": return { title, body: t("alertBody.stock_negative", { name: item.name, stock: quantity(facts.onHandThousandths) }) };
    case "customer_overdue": case "supplier_overdue": return { title, body: t("alertBody.overdue", { name: item.name, amount: money(facts.overdueMinor), date: date(facts.oldestDueAt) }) };
    case "supplier_due_soon": return { title, body: t("alertBody.due_soon", { name: item.name, amount: money(facts.dueSoonMinor), date: date(facts.nextDueAt) }) };
    case "cash_difference": return { title, body: t("alertBody.cash", { name: item.name, counted: money(facts.countedMinor), expected: money(facts.expectedMinor) }) };
    case "sync_refused": return { title, body: t("alertBody.refused", { name: item.name, error: facts.error ?? "" }) };
    case "sync_stalled": return { title, body: facts.lastSuccessAt === undefined ? t("alertBody.stalled_never") : t("alertBody.stalled", { date: date(facts.lastSuccessAt) }) };
    case "service_grace": return { title, body: t("alertBody.grace", { date: date(facts.graceUntil) }) };
    case "service_paused": return { title, body: t("alertBody.paused") };
  }
}

/** Opens the screen that resolves an alert, when the member may see it. */
function opener(item: ShopNotification, nav: Navigation, has: (permission: Permission) => boolean): (() => void) | undefined {
  switch (item.kind) {
    case "stock_low": case "stock_negative": return has("products.view") ? () => nav.push("product", { productId: item.subjectId }) : undefined;
    case "customer_overdue": return has("customers.view") ? () => nav.push("person", { kind: "customer", id: item.subjectId }) : undefined;
    case "supplier_overdue": case "supplier_due_soon": return has("suppliers.view") ? () => nav.push("person", { kind: "supplier", id: item.subjectId }) : undefined;
    case "cash_difference": return has("finance.accounts.view") && has("cash.view") ? () => nav.push("account", { accountId: item.subjectId }) : undefined;
    default: return has("business.settings") ? () => nav.push("serverSync") : undefined;
  }
}

/** Current alerts, most serious first; each opens the record it is about. Opening the list does not mark them read. */
export function AlertsScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), { context } = useSession(), permissions = usePermissions(), action = useAction();
  const revision = useRevision(ALERT_DOMAINS), [attempt, setAttempt] = useState(0);
  const { value, failed } = useRecord(() => notifications(context, new Date().toISOString()), [context, revision, attempt]);
  const has = (permission: Permission): boolean => permissions.includes(permission);
  return <Screen title={t("alerts")} onBack={nav.back} footer={value !== undefined && value.unread > 0 ? <>{action.notice}
    <Button label={t("markAllRead")} variant="secondary" onPress={() => action.run(() => markNotificationsRead(context, new Date().toISOString()), () => setAttempt(n => n + 1))} /></> : undefined}>
    <Notice text={t("alertsHelp")} />
    <SystemNotificationsToggle />
    {failed ? <Notice tone="error" text={t("loadFailed")} action={<Button label={t("retry")} variant="secondary" onPress={() => setAttempt(n => n + 1)} />} />
      : value === undefined || value.items.length === 0 ? <EmptyState title={t("noAlerts")} />
      : <RowGroup>{value.items.map(item => { const { title, body } = describeAlert(item, language);
          return <ListRow key={item.key} title={title} subtitle={body} tag={item.read ? undefined : t("new")} trailingTone={item.severity === "critical" ? "danger" : "normal"}
            trailing={item.severity === "critical" ? "!" : undefined} onPress={opener(item, nav, has)} />; })}</RowGroup>}
    {value?.truncated === true && <Notice text={t("rowsTruncated", { count: value.items.length })} />}
  </Screen>;
}
