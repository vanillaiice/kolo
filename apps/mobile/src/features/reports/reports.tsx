import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { analyticsView, reportView, REPORT_KINDS, REPORT_PERMISSION, UNDATED_REPORT_KINDS, type AnalyticsBucket, type AnalyticsResult, type ReportLine, type ReportResult } from "@kolo/core/application/report-views";
import { localDayPeriod } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity, formatRate } from "@kolo/core/domain/money";
import { localeOf, useText, type Language, type TextKey } from "../../app/i18n.tsx";
import { useNav, useParams } from "../../app/navigation.tsx";
import { useDraft, usePermissions, useRevision, useSession } from "../../app/session.tsx";
import { spacing } from "../../components/theme.ts";
import { Button, EmptyState, Facts, Field, ListRow, Notice, RowGroup, Screen, Section, Segmented, Stat, useStyles } from "../../components/ui.tsx";
import { localDay, useDeferredRecord } from "../shared.tsx";
import { Bars, Heatmap, Shares, Trend, type Datum } from "./charts.tsx";

/** Rows a phone keeps from a report or analytics list; totals stay exact over all rows. */
const PHONE_ROWS = 100;
type Preset = "today" | "last7" | "last30" | "thisMonth" | "thisYear";
const PRESETS: readonly Preset[] = ["today", "last7", "last30", "thisMonth", "thisYear"];
/** Report kinds whose figures do not depend on a period (current balances and stock). */
function presetStart(preset: Preset): Date {
  const start = new Date();
  if (preset === "last7") start.setDate(start.getDate() - 6);
  if (preset === "last30") start.setDate(start.getDate() - 29);
  if (preset === "thisMonth") start.setDate(1);
  if (preset === "thisYear") start.setMonth(0, 1);
  return start;
}
interface PeriodState { readonly preset?: Preset | undefined; readonly from: string; readonly to: string }

/** Desktop period presets plus custom local days; the shared rule turns days into half-open instants. */
export function usePeriod(key: string, initial: Preset): { state: PeriodState; period: { from: string; until: string } | undefined; control: React.JSX.Element } {
  const { t } = useText(), today = localDay(new Date());
  const [state, setState] = useDraft<PeriodState>(key, () => ({ preset: initial, from: localDay(presetStart(initial)), to: today }));
  const [from, setFrom] = useState(state.from), [to, setTo] = useState(state.to);
  let period: { from: string; until: string } | undefined;
  try { period = localDayPeriod(state.from, state.to); } catch { period = undefined; }
  const choose = (preset: Preset): void => { const next = { preset, from: localDay(presetStart(preset)), to: today }; setState(next); setFrom(next.from); setTo(next.to); };
  const control = <Section>
    <Segmented label={t("period")} value={state.preset} onChange={choose} options={PRESETS.map(id => ({ id, label: t(`preset.${id}` as TextKey) }))} />
    <View style={{ flexDirection: "row", gap: spacing.sm }}>
      <View style={{ flex: 1 }}><Field label={t("from")} value={from} onChange={setFrom} kind="date" /></View>
      <View style={{ flex: 1 }}><Field label={t("to")} value={to} onChange={setTo} kind="date" /></View>
    </View>
    <Button label={t("applyPeriod")} variant="secondary" onPress={() => setState({ preset: undefined, from: from.trim(), to: to.trim() })} />
    {period === undefined && <Notice tone="error" text={t("invalidPeriod")} />}
  </Section>;
  return { state, period, control };
}

/** Every report kind this actor may read. */
export function ReportsScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), permissions = usePermissions();
  const kinds = REPORT_KINDS.filter(kind => permissions.includes(REPORT_PERMISSION[kind]));
  return <Screen title={t("reports")} onBack={nav.back}>
    {permissions.includes("reports.sales") && <RowGroup><ListRow title={t("analytics")} subtitle={t("analyticsHelp")} onPress={() => nav.push("analytics")} /></RowGroup>}
    {kinds.length === 0 ? <EmptyState title={t("noPermission")} /> : <RowGroup>{kinds.map(kind => <ListRow key={kind} title={t(`report.${kind}` as TextKey)} subtitle={t(`report.${kind}.help` as TextKey)} onPress={() => nav.push("report", { kind })} />)}</RowGroup>}
  </Screen>;
}

const money = (value: number): string => formatMoney(value);
function lines(rows: readonly ReportLine[], countKey: TextKey, t: (key: TextKey, values?: Record<string, string | number>) => string): React.JSX.Element {
  return <RowGroup>{rows.map(row => <ListRow key={`${row.key}-${row.label}`} title={row.label || t("uncategorized")} subtitle={t(countKey, { count: row.count })} trailing={money(row.totalMinor)} trailingTone={row.totalMinor < 0 ? "danger" : "normal"} />)}</RowGroup>;
}

/** One report: its period (when it has one), headline figures and bounded rows. */
export function ReportScreen(): React.JSX.Element {
  const { t, language } = useText(), s = useStyles(), nav = useNav(), { kind } = useParams("report"), { context } = useSession();
  const revision = useRevision(["sales", "inventory", "customers", "suppliers", "purchases", "accounts", "expenses"]);
  const { period, control } = usePeriod("report-period", "today");
  const result = useDeferredRecord((): ReportResult | undefined => {
    const range = UNDATED_REPORT_KINDS.has(kind) ? { from: new Date(0).toISOString(), until: new Date().toISOString() } : period;
    return range === undefined ? undefined : reportView(context, kind, range.from, range.until, { rows: PHONE_ROWS, language });
  }, [context, kind, period?.from, period?.until, language, revision]);
  const value = result.value;
  return <Screen title={t(`report.${kind}` as TextKey)} onBack={nav.back}>
    {!UNDATED_REPORT_KINDS.has(kind) && control}
    {result.loading && <ActivityIndicator accessibilityLabel={t("loading")} />}
    {result.failed && <Notice tone="error" text={t("loadFailed")} />}
    {value !== undefined && <ReportBody value={value} />}
    {value !== undefined && "truncated" in value && value.truncated && <Text style={s.muted}>{t("rowsTruncated", { count: PHONE_ROWS })}</Text>}
  </Screen>;
}

function ReportBody({ value }: { readonly value: ReportResult }): React.JSX.Element {
  const { t, language } = useText(), s = useStyles();
  switch (value.kind) {
    case "dashboard": return <>
      <View style={[s.row, { alignItems: "stretch" }]}>
        <Stat label={t("revenue")} value={money(value.salesMinor)} note={t("transactionCount", { count: value.transactions })} />
        <Stat label={t("profit")} value={money(value.grossProfitMinor)} note={value.linesWithoutCost > 0 ? t("unknownCostCount", { count: value.linesWithoutCost }) : t("estimate")} />
        <Stat label={t("expenses")} value={money(value.expensesMinor)} /><Stat label={t("net")} value={money(value.netResultMinor)} tone={value.netResultMinor < 0 ? "danger" : undefined} />
        <Stat label={t("customerDebt")} value={money(value.customerDebtMinor)} /><Stat label={t("supplierDebt")} value={money(value.supplierDebtMinor)} />
        <Stat label={t("lowStock")} value={String(value.lowStock)} />
      </View></>;
    case "sales": return <View style={[s.row, { alignItems: "stretch" }]}>
      <Stat label={t("revenue")} value={money(value.totalMinor)} /><Stat label={t("transactions")} value={String(value.transactions)} /><Stat label={t("itemsSold")} value={formatQuantity(value.itemsSoldThousandths)} /></View>;
    case "salesByProduct": case "salesByCategory": case "salesByUser": return <><Notice text={t("netOfReturnsHelp")} />{lines(value.lines, value.kind === "salesByUser" ? "salesCount" : "lineCount", t)}</>;
    case "salesByAccount": return <><Notice text={t("accountTakingsHelp")} />{lines(value.lines, "paymentCount", t)}</>;
    case "customerDebt": case "supplierDebt": return value.lines.length === 0 ? <EmptyState title={t("noDebts")} /> : lines(value.lines, "entryCount", t);
    case "cashFlow": return <View>{value.accounts.map(account => <Section key={account.accountId} title={account.name}>
      <Facts items={[[t("moneyIn"), money(account.inMinor)], [t("moneyOut"), money(account.outMinor)], [t("netFlow"), money(account.netMinor), account.netMinor < 0 ? "danger" : undefined], [t("closingBalance"), money(account.closingMinor), "strong"]]} /></Section>)}</View>;
    case "valuation": return <><View style={[s.row, { alignItems: "stretch" }]}><Stat label={t("stockValue")} value={money(value.totalMinor)} note={value.uncosted > 0 ? t("uncostedCount", { count: value.uncosted }) : undefined} /></View>
      <RowGroup>{value.products.map(item => <ListRow key={item.productId} title={item.name} subtitle={`${formatQuantity(item.onHandThousandths)}${item.unitCostMinor === undefined ? ` · ${t("unknownCost")}` : ` × ${money(item.unitCostMinor)}`}`}
        trailing={item.valueMinor === undefined ? "—" : money(item.valueMinor)} trailingTone={(item.valueMinor ?? 0) < 0 ? "danger" : "normal"} />)}</RowGroup></>;
    case "fastMoving": return <Bars data={value.products.map(item => ({ key: item.productId, label: item.name, value: item.soldThousandths, display: `${formatQuantity(item.soldThousandths)} · ${money(item.revenueMinor)}` }))} />;
    case "stockAlerts": return value.products.length === 0 ? <EmptyState title={t("noStockAlerts")} /> : <RowGroup>{value.products.map(item => <ListRow key={item.productId} title={item.name}
      trailing={formatQuantity(item.onHandThousandths)} trailingTone={item.onHandThousandths < 0 ? "danger" : "normal"} subtitle={item.onHandThousandths < 0 ? t("negativeStock") : t("belowMinimum")} />)}</RowGroup>;
    case "tax": return <><View style={[s.row, { alignItems: "stretch" }]}><Stat label={t("taxGross")} value={money(value.grossMinor)} /><Stat label={`${t("taxAmount")} · ${value.label}`} value={money(value.taxMinor)} />
      <Stat label={t("taxNet")} value={money(value.netMinor)} /></View><Notice text={t("taxReportHelp")} />
      {value.groups.length === 0 ? <EmptyState title={t("noTaxSales")} /> : <View>{value.groups.map(group => <Section key={group.rateBasisPoints} title={formatRate(group.rateBasisPoints, language)}>
        <Facts items={[[t("taxGross"), money(group.grossMinor), group.grossMinor < 0 ? "danger" : undefined], [t("taxAmount"), money(group.taxMinor), "strong"], [t("taxNet"), money(group.netMinor)]]} /></Section>)}</View>}</>;
    case "purchases": return <><View style={[s.row, { alignItems: "stretch" }]}><Stat label={t("purchasesTotal")} value={money(value.totalMinor)} /><Stat label={t("deliveries")} value={String(value.deliveries)} /></View>
      {lines(value.bySupplier.map(line => ({ ...line, label: line.key === "" ? t("noSupplier") : line.label })), "deliveryCount", t)}</>;
  }
}

/** A bucket key read back as a calendar date in UTC, so no zone shifts it again. */
function keyDate(key: string): Date {
  const [date = "", hour = "0"] = key.split("T"), [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, Number(hour)));
}
function keyLabel(key: string, bucket: AnalyticsBucket, language: Language): string {
  const format = (options: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat(localeOf(language), { timeZone: "UTC", ...options }).format(keyDate(key));
  return bucket === "hour" ? format({ hour: "2-digit", minute: "2-digit" }) : bucket === "month" ? format({ month: "short", year: "2-digit" }) : format({ day: "numeric", month: "short" });
}
function delta(current: number, previous: number, language: Language): string | undefined {
  if (previous === 0) return undefined;
  const change = (current - previous) / Math.abs(previous);
  return new Intl.NumberFormat(localeOf(language), { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(change);
}

/**
 * Analytics: KPI tiles with previous-period deltas first, then sections opened on demand (trend, busy
 * hours, product rankings, category and payment shares, top customers). Sections the actor may not read
 * are absent from the result, not just hidden.
 */
export function AnalyticsScreen(): React.JSX.Element {
  const { t, language } = useText(), s = useStyles(), nav = useNav(), { context } = useSession();
  const revision = useRevision(["sales", "inventory", "customers", "accounts", "expenses"]), { period, control } = usePeriod("analytics-period", "last30");
  const [bucket, setBucket] = useState<AnalyticsBucket | "auto">("auto"), [open, setOpen] = useDraft<string>("analytics-section", () => "trend"), [rank, setRank] = useState<"revenue" | "quantity" | "profit">("revenue");
  const result = useDeferredRecord((): AnalyticsResult | undefined => period === undefined ? undefined
    : analyticsView(context, { from: period.from, until: period.until, offsetMinutes: -new Date(period.from).getTimezoneOffset(), bucket: bucket === "auto" ? undefined : bucket }, { rows: 50, language }),
  [context, period?.from, period?.until, bucket, language, revision]);
  const value = result.value;
  const sections = value === undefined ? [] : [["trend", t("trend")], ["activity", t("busyHours")], ["products", t("productRanking")], ["categories", t("categoryShares")],
    ["accounts", t("paymentShares")], ...(value.customers === undefined ? [] : [["customers", t("topCustomers")]])] as const;
  const weekdays = [1, 2, 3, 4, 5, 6, 0].map(day => ({ day, label: new Intl.DateTimeFormat(localeOf(language), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(1970, 0, 4 + day))) }));
  const ranked = value === undefined ? [] : [...value.products].sort((a, b) => rank === "quantity" ? b.soldThousandths - a.soldThousandths : rank === "profit" ? (b.grossProfitMinor ?? 0) - (a.grossProfitMinor ?? 0) : b.revenueMinor - a.revenueMinor).slice(0, 10);
  return <Screen title={t("analytics")} onBack={nav.back}>
    {control}
    <Segmented label={t("groupBy")} value={bucket} onChange={setBucket} options={(["auto", "hour", "day", "week", "month"] as const).map(id => ({ id, label: t(`bucket.${id}` as TextKey) }))} />
    {result.loading && <ActivityIndicator accessibilityLabel={t("loading")} />}
    {result.failed && <Notice tone="error" text={t("loadFailed")} />}
    {value !== undefined && <>
      <View style={[s.row, { alignItems: "stretch" }]}>
        <Stat label={t("revenue")} value={money(value.sales.revenueMinor)} note={delta(value.sales.revenueMinor, value.previous.revenueMinor, language)} />
        <Stat label={t("transactions")} value={String(value.sales.transactions)} note={delta(value.sales.transactions, value.previous.transactions, language)} />
        <Stat label={t("averageBasket")} value={money(value.sales.averageBasketMinor)} />
        {value.profit !== undefined && <Stat label={t("profit")} value={money(value.profit.grossProfitMinor)} note={value.previous.grossProfitMinor === undefined ? t("estimate") : delta(value.profit.grossProfitMinor, value.previous.grossProfitMinor, language)} />}
        {value.profit !== undefined && <Stat label={t("net")} value={money(value.profit.netResultMinor)} tone={value.profit.netResultMinor < 0 ? "danger" : undefined} />}
      </View>
      {value.profit !== undefined && value.profit.linesWithoutCost > 0 && <Notice tone="warning" text={t("unknownCostCount", { count: value.profit.linesWithoutCost })} />}
      <Text style={s.muted}>{t("comparedToPrevious")}</Text>
      {sections.map(([id, label]) => <Section key={id}>
        <ListRow title={label} trailing={open === id ? "−" : "+"} onPress={() => setOpen(open === id ? "" : id)} />
        {open === id && id === "trend" && (value.trend.every(point => point.revenueMinor === 0) ? <EmptyState title={t("noSalesInPeriod")} /> :
          <Trend data={value.trend.map(point => ({ key: point.key, label: keyLabel(point.key, value.bucket, language), value: point.revenueMinor, display: money(point.revenueMinor) }))}
            secondary={value.profit === undefined ? undefined : value.trend.map(point => ({ key: point.key, label: t("profit"), value: point.grossProfitMinor ?? 0, display: money(point.grossProfitMinor ?? 0) }))} />)}
        {open === id && id === "activity" && <Heatmap cells={value.activity} weekdays={weekdays} display={cell => `${t("transactionCount", { count: cell.transactions })} · ${money(cell.revenueMinor)}`} />}
        {open === id && id === "products" && <>
          <Segmented value={rank} onChange={setRank} options={[{ id: "revenue", label: t("byRevenue") }, { id: "quantity", label: t("byQuantity") }, ...(value.profit === undefined ? [] : [{ id: "profit" as const, label: t("byProfit") }])]} />
          <Bars data={ranked.map(item => ({ key: item.productId, label: item.name, value: rank === "quantity" ? item.soldThousandths : rank === "profit" ? item.grossProfitMinor ?? 0 : item.revenueMinor,
            display: rank === "quantity" ? formatQuantity(item.soldThousandths) : money(rank === "profit" ? item.grossProfitMinor ?? 0 : item.revenueMinor) }))} />
          {value.productsTruncated && <Text style={s.muted}>{t("rowsTruncated", { count: 50 })}</Text>}</>}
        {open === id && id === "categories" && <Shares data={value.categories.map(line => ({ key: line.key, label: line.label || t("uncategorized"), value: line.totalMinor, display: money(line.totalMinor) }))} />}
        {open === id && id === "accounts" && <Shares data={value.accounts.map(line => ({ key: line.key, label: line.label, value: line.totalMinor, display: money(line.totalMinor) }))} />}
        {open === id && id === "customers" && value.customers !== undefined && (value.customers.length === 0 ? <EmptyState title={t("noNamedCustomers")} /> :
          <Bars data={value.customers.map((item): Datum => ({ key: item.customerId, label: item.name, value: item.revenueMinor, display: `${money(item.revenueMinor)} · ${t("transactionCount", { count: item.transactions })}` }))} />)}
      </Section>)}
    </>}
  </Screen>;
}
