import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { auditTrail, type AuditEntry, type AuditGroup, type AuditSubject } from "@kolo/core/application/audit";
import { formatMoney, formatQuantity, formatRate } from "@kolo/core/domain/money";
import type { Permission } from "@kolo/core/identity/permissions";
import type { ChangedDomain } from "@kolo/core/data/database/changes";
import { useText, type Language, type TextKey } from "../../app/i18n.tsx";
import { strings, translate, permissionKeys } from "../../app/strings.ts";
import { useNav } from "../../app/navigation.tsx";
import { useRevision, useSession } from "../../app/session.tsx";
import { type as typography, useTheme } from "../../components/theme.ts";
import { Button, ListRow, Notice, PagedList, Screen, Sheet, useStyles } from "../../components/ui.tsx";
import { usePeriod } from "../reports/reports.tsx";
import { formatDate, useRecord } from "../shared.tsx";

const GROUPS: readonly AuditGroup[] = ["sales", "purchases", "stock", "money", "catalogue", "people", "staff", "devices", "settings", "other"];
/** Every domain a journal fact can touch, so a commit or a synced fact refreshes the list. */
const DOMAINS: readonly ChangedDomain[] = ["products", "inventory", "sales", "customers", "suppliers", "purchases", "accounts", "expenses", "authority", "settings"];
const known = (key: string): key is TextKey => Object.hasOwn(strings, key);

/** The stored code in words: a role, permission, movement, expense category or tax rule; unknown codes as stored. */
function codeText(entry: AuditEntry, language: Language): string | undefined {
  const code = entry.facts.code;
  if (code === undefined) return undefined;
  if (entry.type.startsWith("PERMISSION_") && Object.hasOwn(permissionKeys, code)) return translate(language, permissionKeys[code as Permission]);
  const key = [entry.type === "MEMBER_CREATED" ? `role.${code}` : "", entry.type === "PAYMENT_TERMS_SET" ? (code === "SUPPLIER" ? "suppliers" : "customers") : "",
    entry.type === "CASH_MOVED" ? `jd.cash.${code}` : "", `jd.${code}`, `movement.${code}`, code].find(known);
  return key === undefined ? code : translate(language, key);
}

/** One line of what an entry recorded, from its facts only; the same reading as the desktop journal. */
export function journalDetails(entry: AuditEntry, language: Language): string {
  const f = entry.facts, t = (key: TextKey, values?: Record<string, string | number>): string => translate(language, key, values);
  const money = (minor: number): string => formatMoney(minor, language), parts: string[] = [];
  const change = (key: TextKey, now: number | undefined, before: number | undefined): void => {
    if (now !== undefined) parts.push(t(key, { value: before === undefined ? money(now) : `${money(before)} → ${money(now)}` }));
  };
  const code = codeText(entry, language);
  if (code !== undefined) parts.push(code);
  if (entry.type === "PRODUCT_SAVED") { change("jd.price", f.amountMinor, f.previousAmountMinor); if (f.previousCostMinor !== undefined) change("jd.cost", f.costMinor, f.previousCostMinor); }
  else if (entry.type === "CASH_COUNTED") { if (f.amountMinor !== undefined && f.amountMinor !== 0) parts.push(t("jd.difference", { value: money(f.amountMinor) })); }
  else if (f.amountMinor !== undefined) parts.push(money(f.amountMinor));
  if (f.quantityThousandths !== undefined) parts.push(formatQuantity(f.quantityThousandths, language));
  if (f.lines !== undefined && f.lines > 1) parts.push(t("jd.lines", { count: f.lines }));
  if (f.counted !== undefined && f.expected !== undefined) {
    const amount = (value: number): string => entry.type === "STOCK_COUNTED" ? formatQuantity(value, language) : money(value);
    parts.push(t("jd.counted", { counted: amount(f.counted), expected: amount(f.expected) }));
  }
  if (f.days !== undefined) parts.push(f.days === null ? t("jd.defaultDays") : t("jd.days", { count: f.days }));
  if (f.rateBasisPoints !== undefined) parts.push(formatRate(f.rateBasisPoints, language));
  if (f.enabled !== undefined) parts.push(t(f.enabled ? "jd.on" : "jd.off"));
  if (f.created === true) parts.push(t("jd.new"));
  if (f.active === false) parts.push(t("jd.archived"));
  if (f.reversal === true) parts.push(t("jd.reversal"));
  if (f.reference !== undefined && f.reference !== entry.subject?.name) parts.push(f.reference);
  if (f.reason !== undefined) parts.push(`«\u00a0${f.reason}\u00a0»`);
  const line = parts.join(" · ");
  return line.charAt(0).toLocaleUpperCase(language) + line.slice(1);
}

/** A labelled value that opens a short list in a sheet; for members, devices and operation types. */
function Choice({ label, value, options, onChange }: {
  readonly label: string; readonly value: string; readonly options: readonly { readonly id: string; readonly label: string }[]; readonly onChange: (id: string) => void;
}): React.JSX.Element {
  const { t } = useText(), s = useStyles(), { colors } = useTheme(), [open, setOpen] = useState(false);
  const current = options.find(option => option.id === value)?.label ?? options[0]?.label ?? "";
  return <View style={{ gap: 6 }}>
    <Text style={{ ...typography.label, color: colors.muted }}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${current}`} accessibilityHint={t("opensChooser")} onPress={() => setOpen(true)}
      style={[s.input, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}>
      <Text style={s.body}>{current}</Text><Text style={{ color: colors.muted }}>▾</Text>
    </Pressable>
    <Sheet visible={open} title={label} onClose={() => setOpen(false)}>
      {options.map(option => <ListRow key={option.id} title={option.label} tag={option.id === value ? t("selected") : undefined} onPress={() => { onChange(option.id); setOpen(false); }} />)}
    </Sheet>
  </View>;
}

/**
 * The operation journal under audit.view: newest first, narrowed by period, member, device and type. Tapping an entry
 * shows every operation that involved its record (a product's price changes, sales and counts).
 */
export function JournalScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), { context } = useSession(), revision = useRevision(DOMAINS);
  const { period, control } = usePeriod("journal-period", "last7");
  const [actorId, setActorId] = useState(""), [deviceId, setDeviceId] = useState(""), [group, setGroup] = useState(""), [subject, setSubject] = useState<AuditSubject>();
  // Members and devices name the filters; one small read, refreshed with the roster.
  const names = useRecord(() => auditTrail(context, { limit: 1 }), [context, revision]).value;
  const filters = { ...(period ?? {}), ...(actorId === "" ? {} : { actorId }), ...(deviceId === "" ? {} : { deviceId }),
    ...(group === "" ? {} : { group: group as AuditGroup }), ...(subject === undefined ? {} : { subjectId: subject.id }) };
  const name = (value: AuditSubject): string => value.name ?? t("journalUnknown");
  const header = <>
    <Notice text={t("journalHelp")} />
    {control}
    <Choice label={t("journalWho")} value={actorId} onChange={setActorId} options={[{ id: "", label: t("journalAnyone") }, ...(names?.members ?? []).map(m => ({ id: m.id, label: m.name }))]} />
    <Choice label={t("journalDevice")} value={deviceId} onChange={setDeviceId} options={[{ id: "", label: t("journalAnyDevice") }, ...(names?.devices ?? []).map(d => ({ id: d.id, label: d.label }))]} />
    <Choice label={t("journalFamily")} value={group} onChange={setGroup} options={[{ id: "", label: t("journalAnyGroup") }, ...GROUPS.map(id => ({ id, label: t(`jg.${id}` as TextKey) }))]} />
    {subject !== undefined && <Notice tone="info" text={t("journalOnlyRecord", { name: name(subject) })} action={<Button label={t("journalClearRecord")} variant="secondary" onPress={() => setSubject(undefined)} />} />}
  </>;
  return <Screen title={t("journal")} onBack={nav.back} scroll={false}>
    <PagedList<AuditEntry> searchable={false} revision={revision} deps={[JSON.stringify(filters)]} identify={entry => entry.id} header={header}
      empty={{ title: t("journalEmpty") }}
      load={page => period === undefined ? { items: [] } : auditTrail(context, { ...filters, limit: 30, ...(page.after === undefined ? {} : { after: page.after }) })}
      render={entry => {
        const action = known(`j.${entry.type}`) ? t(`j.${entry.type}` as TextKey) : `${t("j.other")} (${entry.type})`;
        const by = t("journalByOn", { who: entry.actor.name ?? t("journalUnknown"), device: entry.device.label ?? t("journalUnknown") });
        const details = journalDetails(entry, language);
        const status = entry.status !== undefined && entry.status !== "applied" && known(`jst.${entry.status}`) ? t(`jst.${entry.status}` as TextKey) : undefined;
        return <ListRow title={entry.subject === undefined ? action : `${action} · ${name(entry.subject)}${entry.related?.name === undefined ? "" : ` · ${entry.related.name}`}`}
          subtitle={[`${formatDate(entry.occurredAt, language)} · ${by}`, details].filter(Boolean).join("\n")}
          tag={status ?? (entry.source === "this_device" ? t("journalThisDevice") : undefined)}
          onPress={entry.subject === undefined || entry.subject.id === subject?.id ? undefined : () => setSubject(entry.subject)} />;
      }} />
  </Screen>;
}
