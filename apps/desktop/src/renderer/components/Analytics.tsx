import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { localDayPeriod } from "@kolo/core/domain/entry";
import { formatAmount, formatMoney, formatQuantity } from "@kolo/core/domain/money";
import type { Permission } from "@kolo/core/identity/permissions";
import type { AnalyticsBucket, AnalyticsCell, AnalyticsProduct, AnalyticsResult, ReportLine, ShopService } from "../../shared/service.ts";
import type { Language } from "../text.ts";
import { ReadState, useRead, useText } from "./ui.tsx";

type Props = { readonly service: ShopService; readonly sessionId: string; readonly revision: number; readonly permissions: readonly Permission[] };
type Preset = "today" | "last7" | "last30" | "thisMonth" | "thisYear";
type Rank = "revenue" | "quantity" | "profit";

/** Categorical slots in fixed order, validated for both themes; colour follows the entity's position, never re-cycled. */
const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"] as const;
/** Pie slices past this fold into "Others": part-to-whole stays readable at a glance. */
const SLICES = 5;
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

/** Local calendar day as YYYY-MM-DD, the input the shared period rule expects. */
function day(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function presetStart(preset: Preset): Date {
  const start = new Date();
  if (preset === "last7") start.setDate(start.getDate() - 6);
  if (preset === "last30") start.setDate(start.getDate() - 29);
  if (preset === "thisMonth") start.setDate(1);
  if (preset === "thisYear") start.setMonth(0, 1);
  return start;
}
const locale = (language: Language): string => language === "fr" ? "fr-FR" : "en-GB";
/** Short axis amounts: 12 500 → "12,5 k". Full amounts stay in tooltips and tables. */
function compact(minor: number, language: Language): string {
  return new Intl.NumberFormat(locale(language), { notation: "compact", maximumFractionDigits: 1 }).format(minor);
}
/** A bucket key read back as a calendar date in UTC, so no zone shifts it again. */
function keyDate(key: string): Date {
  const [date = "", hour = "0"] = key.split("T"), [year = 1970, month = 1, dayOfMonth = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, dayOfMonth, Number(hour)));
}
function keyLabel(key: string, bucket: AnalyticsBucket, language: Language, long = false): string {
  const date = keyDate(key), format = (options: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat(locale(language), { timeZone: "UTC", ...options }).format(date);
  switch (bucket) {
    case "hour": return long ? format({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : format({ hour: "2-digit", minute: "2-digit" });
    case "day": return format(long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
    case "week": return format({ day: "numeric", month: "short" });
    case "month": return format(long ? { month: "long", year: "numeric" } : { month: "short", year: "2-digit" });
  }
}
function weekdayName(weekday: number, language: Language, style: "short" | "long"): string {
  // 4 January 1970 was a Sunday.
  return new Intl.DateTimeFormat(locale(language), { weekday: style, timeZone: "UTC" }).format(new Date(Date.UTC(1970, 0, 4 + weekday)));
}
function percent(basisPoints: number, language: Language): string {
  return new Intl.NumberFormat(locale(language), { style: "percent", maximumFractionDigits: 1 }).format(basisPoints / 10_000);
}

/** Light analytics: one period selector above KPI tiles, a trend, busy hours, best sellers, shares and top customers. */
export function Analytics({ service, sessionId, revision, permissions }: Props): React.JSX.Element {
  const { t } = useText();
  const today = day(new Date());
  const [preset, setPreset] = useState<Preset | undefined>("last30");
  const [from, setFrom] = useState(() => day(presetStart("last30"))), [to, setTo] = useState(today);
  const [bucket, setBucket] = useState<AnalyticsBucket | "auto">("auto");
  let period: { from: string; until: string } | undefined;
  try { period = localDayPeriod(from, to); } catch { period = undefined; }
  const choose = (next: Preset): void => { setPreset(next); setFrom(day(presetStart(next))); setTo(today); };
  if (!permissions.includes("reports.sales")) return <section className="workspace-content"><p className="notice error">{t("noAccess")}</p></section>;
  return <section className="workspace-content analytics">
    <div className="section-heading"><div><p className="eyebrow">{t("analytics")}</p><h1>{t("analyticsHelp")}</h1></div></div>
    <div className="report-controls panel">
      <div className="segmented" role="group" aria-label={t("period")}>
        {(["today", "last7", "last30", "thisMonth", "thisYear"] as const).map(id => <button key={id} type="button" aria-pressed={preset === id} onClick={() => choose(id)}>{t(id)}</button>)}
      </div>
      <div className="field"><label htmlFor="analytics-from">{t("from")}</label><input id="analytics-from" type="date" value={from} max={to} aria-describedby="analytics-from-hint" onChange={event => { setPreset(undefined); setFrom(event.target.value); }}/><small className="field-hint" id="analytics-from-hint">{t("hint.periodFrom")}</small></div>
      <div className="field"><label htmlFor="analytics-to">{t("to")}</label><input id="analytics-to" type="date" value={to} min={from} aria-describedby="analytics-to-hint" onChange={event => { setPreset(undefined); setTo(event.target.value); }}/><small className="field-hint" id="analytics-to-hint">{t("hint.periodTo")}</small></div>
      <div className="field"><label htmlFor="analytics-bucket">{t("groupBy")}</label><select id="analytics-bucket" value={bucket} aria-describedby="analytics-bucket-hint" onChange={event => setBucket(event.target.value as AnalyticsBucket | "auto")}>
        {(["auto", "hour", "day", "week", "month"] as const).map(id => <option key={id} value={id}>{t(`bucket_${id}`)}</option>)}</select><small className="field-hint" id="analytics-bucket-hint">{t("hint.groupBy")}</small></div>
    </div>
    {period === undefined ? <p className="notice error" role="alert">{t("invalidPeriod")}</p>
      : <AnalyticsView key={`${period.from}:${period.until}:${bucket}`} service={service} sessionId={sessionId} revision={revision} period={period} bucket={bucket}/>}
  </section>;
}

function AnalyticsView({ service, sessionId, revision, period, bucket }: { service: ShopService; sessionId: string; revision: number; period: { from: string; until: string }; bucket: AnalyticsBucket | "auto" }): React.JSX.Element {
  // The offset at the period's start; XAF zones keep one offset all year.
  const offsetMinutes = -new Date(period.from).getTimezoneOffset();
  const read = useRead(() => service.analytics({ sessionId, from: period.from, until: period.until, offsetMinutes, ...(bucket === "auto" ? {} : { bucket }) }),
    [service, sessionId, period.from, period.until, offsetMinutes, bucket, revision]);
  return <ReadState loading={read.loading} error={read.error} empty={false} emptyText="" retry={read.retry}>{read.data !== undefined && <Dashboard value={read.data}/>}</ReadState>;
}

function Dashboard({ value }: { value: AnalyticsResult }): React.JSX.Element {
  const { t } = useText();
  if (value.sales.transactions === 0 && value.products.length === 0) return <><Kpis value={value}/><div className="panel empty"><p>{t("noReportData")}</p></div></>;
  return <>
    <Kpis value={value}/>
    <div className="analytics-grid">
      <Card title={t("salesOverTime")} wide><Trend value={value}/></Card>
      <Card title={t("busyTimes")} hint={t("busyTimesHelp")} wide><Heatmap cells={value.activity}/></Card>
      <Card title={t("rep_fastMoving")} hint={t("netOfDiscountsAndReturns")} wide><BestSellers products={value.products} truncated={value.productsTruncated}/></Card>
      <Card title={t("rep_salesByCategory")}><Share lines={value.categories} id="categories"/></Card>
      <Card title={t("paymentMethods")}><Share lines={value.accounts} id="accounts"/></Card>
      {value.customers !== undefined && <Card title={t("topCustomers")} hint={t("namedCustomersOnly")} wide><Customers rows={value.customers} total={value.sales.revenueMinor}/></Card>}
    </div>
  </>;
}

function Card({ title, hint, wide = false, children }: { title: string; hint?: string; wide?: boolean; children: React.ReactNode }): React.JSX.Element {
  return <section className={`panel chart-card ${wide ? "wide" : ""}`}><header><h2>{title}</h2>{hint !== undefined && <p className="hint">{hint}</p>}</header>{children}</section>;
}

/** Change against the previous equal-length period, with an arrow so the sign never rests on colour alone. */
function Delta({ current, previous }: { current: number; previous: number | undefined }): React.JSX.Element | null {
  const { t, language } = useText();
  if (previous === undefined || previous <= 0) return null;
  const ratio = (current - previous) / previous, flat = Math.abs(ratio) < 0.0005;
  const shown = new Intl.NumberFormat(locale(language), { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(ratio);
  return <small className={`delta ${flat ? "" : ratio > 0 ? "up" : "down"}`}><span aria-hidden="true">{flat ? "→" : ratio > 0 ? "▲" : "▼"}</span> {shown} <span className="muted">{t("vsPrevious")}</span></small>;
}

function Kpis({ value }: { value: AnalyticsResult }): React.JSX.Element {
  const { t, language } = useText(), money = (minor: number): string => formatMoney(minor, language);
  const tile = (label: string, shown: string, delta?: React.ReactNode, negative = false): React.JSX.Element =>
    <div className="stat-tile"><span>{label}</span><strong className={negative ? "negative" : undefined}>{shown}</strong>{delta}</div>;
  return <>
    <div className="stat-grid">
      {tile(t("revenue"), money(value.sales.revenueMinor), <Delta current={value.sales.revenueMinor} previous={value.previous.revenueMinor}/>, value.sales.revenueMinor < 0)}
      {tile(t("transactions"), String(value.sales.transactions), <Delta current={value.sales.transactions} previous={value.previous.transactions}/>)}
      {tile(t("avgBasket"), money(value.sales.averageBasketMinor))}
      {value.profit !== undefined && <>
        {tile(t("grossProfit"), money(value.profit.grossProfitMinor), <Delta current={value.profit.grossProfitMinor} previous={value.previous.grossProfitMinor}/>, value.profit.grossProfitMinor < 0)}
        {tile(t("marginRate"), value.profit.marginBasisPoints === undefined ? "—" : percent(value.profit.marginBasisPoints, language), undefined, (value.profit.marginBasisPoints ?? 0) < 0)}
        {tile(t("expenses"), money(value.profit.expensesMinor))}
        {tile(t("netResult"), money(value.profit.netResultMinor), undefined, value.profit.netResultMinor < 0)}
      </>}
    </div>
    {value.profit !== undefined && value.profit.linesWithoutCost > 0 && <p className="notice">{value.profit.linesWithoutCost} {t("uncostedLines")}</p>}
  </>;
}

function ChartTooltip({ active, payload, label, format }: { active?: boolean; payload?: readonly { name?: string; value?: number; color?: string }[]; label?: string; format: (value: number) => string }): React.JSX.Element | null {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  return <div className="chart-tooltip">{label !== undefined && <strong>{label}</strong>}
    {payload.map(entry => <span key={entry.name}><i aria-hidden="true" className="swatch" style={{ background: entry.color }}/>{entry.name} <b>{format(entry.value ?? 0)}</b></span>)}</div>;
}

const AXIS = { stroke: "var(--chart-axis)", tick: { fill: "var(--muted)", fontSize: 11 }, tickLine: false } as const;

/** Revenue (and gross profit, same currency axis) over time; a figures table is the accessible twin. */
function Trend({ value }: { value: AnalyticsResult }): React.JSX.Element {
  const { t, language } = useText(), profit = value.profit !== undefined;
  const data = value.trend.map(point => ({ ...point, label: keyLabel(point.key, value.bucket, language), long: value.bucket === "week" ? `${t("weekOf")} ${keyLabel(point.key, "week", language)}` : keyLabel(point.key, value.bucket, language, true) }));
  return <>
    <div className="chart-frame" role="img" aria-label={`${t("salesOverTime")}: ${data.length} ${t(`bucket_${value.bucket}`)}`}>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)"/>
          <XAxis dataKey="label" {...AXIS} minTickGap={24}/>
          <YAxis {...AXIS} axisLine={false} width={56} tickFormatter={(minor: number) => compact(minor, language)}/>
          <Tooltip cursor={{ stroke: "var(--chart-axis)" }} labelFormatter={(_label, payload) => String(payload[0]?.payload?.long ?? "")}
            content={props => <ChartTooltip active={props.active} payload={props.payload as never} label={props.label as string} format={minor => formatMoney(minor, language)}/>}/>
          {profit && <Legend iconType="plainline" itemSorter={item => item.dataKey === "revenueMinor" ? 0 : 1} wrapperStyle={{ fontSize: 12, color: "var(--muted)" }}/>}
          <Line type="linear" dataKey="revenueMinor" name={t("revenue")} stroke={SERIES[0]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false}/>
          {profit && <Line type="linear" dataKey="grossProfitMinor" name={t("grossProfit")} stroke={SERIES[1]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false}/>}
        </LineChart>
      </ResponsiveContainer>
    </div>
    <details className="chart-table"><summary>{t("viewFigures")}</summary><div className="table-wrap"><table><thead><tr><th>{t(`bucket_${value.bucket}`)}</th><th className="numeric">{t("transactions")}</th><th className="numeric">{t("revenue")}</th>{profit && <th className="numeric">{t("grossProfit")}</th>}</tr></thead>
      <tbody>{data.map(point => <tr key={point.key}><td>{point.long}</td><td className="numeric">{point.transactions}</td><td className={`money numeric ${point.revenueMinor < 0 ? "negative" : ""}`}>{formatMoney(point.revenueMinor, language)}</td>
        {profit && <td className={`money numeric ${(point.grossProfitMinor ?? 0) < 0 ? "negative" : ""}`}>{formatMoney(point.grossProfitMinor ?? 0, language)}</td>}</tr>)}</tbody></table></div></details>
  </>;
}

/** Weekday × hour grid, one hue from light to dark; hours outside trading are trimmed. */
function Heatmap({ cells }: { cells: readonly AnalyticsCell[] }): React.JSX.Element {
  const { t, language } = useText();
  const grid = useMemo(() => new Map(cells.map(cell => [`${cell.weekday}:${cell.hour}`, cell])), [cells]);
  if (cells.length === 0) return <p className="muted">{t("noReportData")}</p>;
  const hours = cells.map(cell => cell.hour), first = Math.min(8, ...hours), last = Math.max(19, ...hours);
  const columns = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const peak = Math.max(...cells.map(cell => cell.transactions));
  const busiest = cells.reduce((best, cell) => cell.transactions > best.transactions || cell.transactions === best.transactions && cell.revenueMinor > best.revenueMinor ? cell : best);
  const hour = (value: number): string => `${String(value).padStart(2, "0")}:00`;
  const describe = (weekday: number, at: number, cell: AnalyticsCell | undefined): string =>
    `${weekdayName(weekday, language, "long")} ${hour(at)}–${hour((at + 1) % 24)} · ${cell?.transactions ?? 0} ${t("salesCount")}${cell === undefined ? "" : ` · ${formatMoney(cell.revenueMinor, language)}`}`;
  return <>
    <p className="busiest"><span className="eyebrow">{t("busiest")}</span>{describe(busiest.weekday, busiest.hour, busiest)}</p>
    <div className="heatmap" role="table" aria-label={t("busyTimes")} style={{ gridTemplateColumns: `max-content repeat(${columns.length}, minmax(18px, 1fr))` }}>
      <div role="row" className="heatmap-row"><span role="columnheader"/>{columns.map(at => <span role="columnheader" key={at} className="heatmap-hour">{at % 2 === 0 ? at : ""}<span className="sr-only">{hour(at)}</span></span>)}</div>
      {MONDAY_FIRST.map(weekday => <div role="row" className="heatmap-row" key={weekday}>
        <span role="rowheader" className="heatmap-day">{weekdayName(weekday, language, "short")}</span>
        {columns.map(at => {
          const cell = grid.get(`${weekday}:${at}`), share = cell === undefined ? 0 : cell.transactions / peak;
          return <span role="cell" key={at} className={`heatmap-cell ${cell === undefined ? "is-empty" : ""}`} title={describe(weekday, at, cell)} aria-label={describe(weekday, at, cell)}
            style={cell === undefined ? undefined : { background: `color-mix(in oklab, var(--chart-1) ${Math.round(15 + 85 * share)}%, var(--surface-soft))` }}/>;
        })}
      </div>)}
    </div>
    <div className="heatmap-scale" aria-hidden="true"><span>{t("fewerSales")}</span><i className="ramp"/><span>{t("moreSales")}</span></div>
  </>;
}

/** Ranked horizontal bars (one series, one colour) with the full figures in a table beneath. */
function BestSellers({ products, truncated }: { products: readonly AnalyticsProduct[]; truncated: boolean }): React.JSX.Element {
  const { t, language } = useText(), withProfit = products.some(row => row.grossProfitMinor !== undefined);
  const [rank, setRank] = useState<Rank>("revenue");
  const metric = (row: AnalyticsProduct): number => rank === "quantity" ? row.soldThousandths : rank === "profit" ? row.grossProfitMinor ?? 0 : row.revenueMinor;
  const sorted = [...products].sort((a, b) => metric(b) - metric(a) || a.name.localeCompare(b.name));
  const top = sorted.slice(0, 10).map(row => ({ name: row.name, value: metric(row) }));
  const format = (value: number): string => rank === "quantity" ? formatQuantity(value, language) : formatMoney(value, language);
  if (products.length === 0) return <p className="muted">{t("noReportData")}</p>;
  return <>
    <div className="segmented small" role="group" aria-label={t("rankBy")}>
      {(withProfit ? ["revenue", "quantity", "profit"] as const : ["revenue", "quantity"] as const).map(id => <button key={id} type="button" aria-pressed={rank === id} onClick={() => setRank(id)}>{t(`rank_${id}`)}</button>)}
    </div>
    <div className="chart-frame" role="img" aria-label={`${t("rep_fastMoving")}: ${top.map(row => `${row.name} ${format(row.value)}`).join(", ")}`}>
      <ResponsiveContainer width="100%" height={Math.max(120, top.length * 34 + 16)}>
        <BarChart data={top} layout="vertical" margin={{ top: 0, right: 96, bottom: 0, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide domain={[0, "dataMax"]}/>
          <YAxis type="category" dataKey="name" {...AXIS} axisLine={false} width={160} interval={0} tickFormatter={(name: string) => name.length > 22 ? `${name.slice(0, 21)}…` : name}/>
          <Tooltip cursor={{ fill: "var(--surface-hover)" }} content={props => <ChartTooltip active={props.active} payload={props.payload as never} label={props.label as string} format={format}/>}/>
          <Bar dataKey="value" name={t(`rank_${rank}`)} fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
            <LabelList dataKey="value" position="right" formatter={(value: unknown) => format(Number(value))} fill="var(--muted)" fontSize={11}/>
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
    <details className="chart-table"><summary>{t("viewFigures")}</summary><div className="table-wrap"><table><thead><tr><th>{t("name")}</th><th className="numeric">{t("itemsSold")}</th><th className="numeric">{t("revenue")}</th>{withProfit && <th className="numeric">{t("grossProfit")}</th>}</tr></thead>
      <tbody>{sorted.slice(0, 50).map(row => <tr key={row.productId}><td>{row.name}</td><td className={`numeric ${row.soldThousandths < 0 ? "negative" : ""}`}>{formatQuantity(row.soldThousandths, language)}</td>
        <td className={`money numeric ${row.revenueMinor < 0 ? "negative" : ""}`}>{formatMoney(row.revenueMinor, language)}</td>
        {withProfit && <td className={`money numeric ${(row.grossProfitMinor ?? 0) < 0 ? "negative" : ""}`}>{formatMoney(row.grossProfitMinor ?? 0, language)}</td>}</tr>)}</tbody></table></div>
      {(truncated || sorted.length > 50) && <p className="hint">{t("truncatedRows")}</p>}</details>
  </>;
}

/** Part-to-whole donut, at most five slices plus "Others", with a legend table carrying every value. */
function Share({ lines, id }: { lines: readonly ReportLine[]; id: string }): React.JSX.Element {
  const { t, language } = useText();
  const positive = lines.filter(line => line.totalMinor > 0), total = positive.reduce((sum, line) => sum + line.totalMinor, 0);
  if (total === 0) return <p className="muted">{t("noReportData")}</p>;
  const head = positive.length > SLICES + 1 ? positive.slice(0, SLICES) : positive;
  const rest = positive.slice(head.length).reduce((sum, line) => sum + line.totalMinor, 0);
  const slices = [...head.map((line, index) => ({ key: line.key, label: line.label, value: line.totalMinor, fill: SERIES[index]! })),
    ...(rest > 0 ? [{ key: "__others", label: t("others"), value: rest, fill: "var(--chart-other)" }] : [])];
  const share = (value: number): string => new Intl.NumberFormat(locale(language), { style: "percent", maximumFractionDigits: 0 }).format(value / total);
  return <div className="share">
    <div className="donut" role="img" aria-label={slices.map(slice => `${slice.label} ${share(slice.value)}`).join(", ")}>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="96%" stroke="var(--surface)" strokeWidth={2} startAngle={90} endAngle={-270} isAnimationActive={false}/>
          <Tooltip content={props => <ChartTooltip active={props.active} payload={(props.payload ?? []).map(entry => ({ name: String(entry.name), value: Number(entry.value), color: String((entry.payload as { fill: string }).fill) }))} format={value => `${formatMoney(value, language)} · ${share(value)}`}/>}/>
        </PieChart>
      </ResponsiveContainer>
      <span className="donut-total"><small>{t("total")}</small>{compact(total, language)}</span>
    </div>
    <table className="legend-table" aria-label={id}><tbody>{slices.map(slice => <tr key={slice.key}>
      <td><i aria-hidden="true" className="swatch" style={{ background: slice.fill }}/>{slice.label}</td>
      <td className="money numeric">{formatAmount(slice.value, language)}</td><td className="numeric muted">{share(slice.value)}</td></tr>)}</tbody></table>
  </div>;
}

/** Ranked named customers: a table, since names, counts, amounts and dates are all read exactly. */
function Customers({ rows, total }: { rows: NonNullable<AnalyticsResult["customers"]>; total: number }): React.JSX.Element {
  const { t, language } = useText();
  if (rows.length === 0) return <p className="muted">{t("noReportData")}</p>;
  const best = Math.max(1, ...rows.map(row => row.revenueMinor));
  const date = (instant: string): string => new Intl.DateTimeFormat(locale(language), { day: "numeric", month: "short", year: "numeric" }).format(new Date(instant));
  return <div className="table-wrap"><table><thead><tr><th>#</th><th>{t("customer")}</th><th className="numeric">{t("purchasesCount")}</th><th className="numeric">{t("revenue")}</th><th className="numeric">{t("shareOfSales")}</th><th className="numeric">{t("lastPurchase")}</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={row.customerId}><td className="muted">{index + 1}</td><td><strong>{row.name}</strong></td><td className="numeric">{row.transactions}</td>
      <td className="money numeric"><span className="inline-bar" aria-hidden="true"><i style={{ width: `${Math.max(0, row.revenueMinor) / best * 100}%` }}/></span>{formatMoney(row.revenueMinor, language)}</td>
      <td className="numeric muted">{total > 0 ? new Intl.NumberFormat(locale(language), { style: "percent", maximumFractionDigits: 1 }).format(row.revenueMinor / total) : "—"}</td>
      <td className="numeric">{date(row.lastPurchaseAt)}</td></tr>)}</tbody></table></div>;
}

