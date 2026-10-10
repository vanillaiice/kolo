import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useText } from "../../app/i18n.tsx";
import { radius, spacing, TOUCH_TARGET, useTheme } from "../../components/theme.ts";
import { Button, Facts, useStyles } from "../../components/ui.tsx";

/** One labelled value; `display` is the exact figure shown and read aloud. */
export interface Datum { readonly key: string; readonly label: string; readonly value: number; readonly display: string }

/** A figures table, the accessible twin of every chart. */
function Figures({ data }: { readonly data: readonly Datum[] }): React.JSX.Element {
  return <Facts items={data.map(item => [item.label, item.display] as const)} />;
}
/** Shows the figures instead of the chart on request. */
function WithFigures({ data, children }: { readonly data: readonly Datum[]; readonly children: React.ReactNode }): React.JSX.Element {
  const { t } = useText(), [table, setTable] = useState(false);
  return <View style={{ gap: spacing.sm }}>{table ? <Figures data={data} /> : children}
    <Button label={t(table ? "showChart" : "showFigures")} variant="ghost" onPress={() => setTable(!table)} style={{ alignSelf: "flex-start", paddingHorizontal: 0 }} /></View>;
}

/** Horizontal bars, longest first as given; negative values are drawn in the danger colour. */
export function Bars({ data, color }: { readonly data: readonly Datum[]; readonly color?: string }): React.JSX.Element {
  const s = useStyles(), { colors } = useTheme(), max = Math.max(1, ...data.map(item => Math.abs(item.value)));
  return <WithFigures data={data}>{data.map(item => <View key={item.key} accessible accessibilityLabel={`${item.label}: ${item.display}`} style={{ gap: 4 }}>
    <View style={s.between}><Text style={[s.muted, { flex: 1 }]} numberOfLines={2}>{item.label}</Text><Text style={[s.amount, { fontSize: 14 }]}>{item.display}</Text></View>
    <View style={{ height: 10, backgroundColor: colors.chartGrid, borderRadius: 5, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(1, Math.round(Math.abs(item.value) / max * 100))}%`, height: 10, borderRadius: 5, backgroundColor: item.value < 0 ? colors.danger : color ?? colors.chart[0] }} /></View>
  </View>)}</WithFigures>;
}

/** Part-to-whole as one stacked bar with a legend; five slices then "Others", as on the desktop donuts. */
export function Shares({ data }: { readonly data: readonly Datum[] }): React.JSX.Element {
  const { t } = useText(), s = useStyles(), { colors } = useTheme();
  const positive = data.filter(item => item.value > 0), head = positive.slice(0, 5), rest = positive.slice(5);
  const slices = [...head, ...(rest.length === 0 ? [] : [{ key: "others", label: t("others"), value: rest.reduce((sum, item) => sum + item.value, 0), display: "" }])];
  const total = slices.reduce((sum, item) => sum + item.value, 0) || 1;
  const color = (index: number, key: string): string => key === "others" ? colors.chartOther : colors.chart[index % colors.chart.length]!;
  return <WithFigures data={data}>
    <View importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", height: 16, borderRadius: radius.control, overflow: "hidden", backgroundColor: colors.chartGrid }}>
      {slices.map((item, index) => <View key={item.key} style={{ flex: item.value / total, backgroundColor: color(index, item.key) }} />)}</View>
    {slices.map((item, index) => <View key={item.key} accessible accessibilityLabel={`${item.label}: ${Math.round(item.value / total * 100)} %${item.display ? `, ${item.display}` : ""}`} style={[s.row, { flexWrap: "nowrap" }]}>
      <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: color(index, item.key) }} />
      <Text style={[s.body, { flex: 1 }]} numberOfLines={1}>{item.label}</Text>
      <Text style={s.muted}>{Math.round(item.value / total * 100)} %</Text></View>)}
  </WithFigures>;
}

/**
 * Trend as columns with selectable points: tapping a column shows its exact values. Only a few axis
 * labels are drawn; every point keeps its exact figure in the selection and the figures table.
 */
export function Trend({ data, secondary }: { readonly data: readonly Datum[]; readonly secondary?: readonly Datum[] | undefined }): React.JSX.Element {
  const s = useStyles(), { colors } = useTheme(), [selected, setSelected] = useState(data.length - 1);
  const max = Math.max(1, ...data.map(item => item.value), ...(secondary ?? []).map(item => item.value));
  const labelEvery = Math.max(1, Math.ceil(data.length / 4)), point = data[Math.min(selected, data.length - 1)];
  return <WithFigures data={secondary === undefined ? data : data.flatMap((item, index) => [item, { ...secondary[index]!, label: `${item.label} · ${secondary[index]!.label}` }])}>
    {point !== undefined && <View style={s.between} accessibilityLiveRegion="polite"><Text style={s.muted}>{point.label}</Text>
      <Text style={s.amount}>{point.display}{secondary?.[selected] !== undefined ? ` · ${secondary[selected]!.display}` : ""}</Text></View>}
    <View style={{ flexDirection: "row", alignItems: "flex-end", height: 140, gap: data.length > 40 ? 0 : 2, borderBottomWidth: 1, borderBottomColor: colors.chartGrid }}>
      {data.map((item, index) => <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={`${item.label}: ${item.display}`} accessibilityState={{ selected: index === selected }}
        onPress={() => setSelected(index)} hitSlop={{ top: 8, bottom: 8 }} style={{ flex: 1, height: "100%", justifyContent: "flex-end", minHeight: TOUCH_TARGET }}>
        <View style={{ height: `${Math.max(1, item.value / max * 100)}%`, backgroundColor: index === selected ? colors.primary : colors.chart[0], opacity: index === selected ? 1 : 0.7, borderTopLeftRadius: 2, borderTopRightRadius: 2 }} />
        {secondary?.[index] !== undefined && secondary[index]!.value > 0 && <View style={{ position: "absolute", bottom: `${Math.min(100, secondary[index]!.value / max * 100)}%`, left: 0, right: 0, height: 2, backgroundColor: colors.chart[1] }} />}
      </Pressable>)}
    </View>
    <View style={{ flexDirection: "row" }} importantForAccessibility="no-hide-descendants">{data.map((item, index) => <Text key={item.key} numberOfLines={1}
      style={{ flex: 1, fontSize: 10, color: colors.muted, textAlign: "center", opacity: index % labelEvery === 0 ? 1 : 0 }}>{index % labelEvery === 0 ? item.label : ""}</Text>)}</View>
  </WithFigures>;
}

/** Weekday × hour activity grid; darker cells sold more. Each cell is read with its exact figures. */
export function Heatmap({ cells, weekdays, display }: { readonly cells: readonly { weekday: number; hour: number; transactions: number; revenueMinor: number }[]; readonly weekdays: readonly { day: number; label: string }[]; readonly display: (cell: { transactions: number; revenueMinor: number }) => string }): React.JSX.Element {
  const { colors } = useTheme(), { t } = useText(), max = Math.max(1, ...cells.map(cell => cell.transactions));
  const hours = cells.length === 0 ? [] : Array.from({ length: Math.max(...cells.map(c => c.hour)) - Math.min(...cells.map(c => c.hour)) + 1 }, (_, i) => Math.min(...cells.map(c => c.hour)) + i);
  const data = cells.filter(cell => cell.transactions > 0).sort((a, b) => b.transactions - a.transactions).slice(0, 12)
    .map(cell => ({ key: `${cell.weekday}-${cell.hour}`, label: `${weekdays.find(day => day.day === cell.weekday)?.label ?? ""} ${String(cell.hour).padStart(2, "0")}h`, value: cell.transactions, display: display(cell) }));
  if (cells.length === 0) return <Text style={{ color: colors.muted }}>{t("noActivity")}</Text>;
  return <WithFigures data={data}>
    <View style={{ gap: 2 }}>{weekdays.map(day => <View key={day.day} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <Text style={{ width: 36, fontSize: 11, color: colors.muted }}>{day.label}</Text>
      {hours.map(hour => { const cell = cells.find(item => item.weekday === day.day && item.hour === hour), share = (cell?.transactions ?? 0) / max;
        return <View key={hour} accessible={cell !== undefined} accessibilityLabel={cell === undefined ? undefined : `${day.label} ${hour}h: ${display(cell)}`}
          style={{ flex: 1, aspectRatio: 1, maxHeight: 22, borderRadius: 3, backgroundColor: cell === undefined ? colors.chartGrid : colors.primary, opacity: cell === undefined ? 1 : 0.2 + 0.8 * share }} />; })}
    </View>)}
      <View style={{ flexDirection: "row", gap: 2, paddingLeft: 38 }}>{hours.map(hour => <Text key={hour} style={{ flex: 1, fontSize: 9, color: colors.muted, textAlign: "center" }}>{hour % 3 === 0 ? hour : ""}</Text>)}</View>
    </View>
  </WithFigures>;
}
