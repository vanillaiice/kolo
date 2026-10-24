import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { auditExport, auditTrail, type AuditEntry, type AuditGroup, type AuditSubject } from "@kolo/core/application/audit";
import { heldBackFacts, reviewQuarantinedEvent, type HeldBackFact } from "@kolo/core/application/event-application";
import { AUDIT_CSV_COLUMNS, auditCsv, type AuditCsvText } from "@kolo/core/domain/audit-csv";
import { formatMoney, formatQuantity, formatRate } from "@kolo/core/domain/money";
import type { Permission } from "@kolo/core/identity/permissions";
import type { ChangedDomain } from "@kolo/core/data/database/changes";
import { useText, type Language, type TextKey } from "../../app/i18n.tsx";
import { strings, translate, permissionKeys } from "../../app/strings.ts";
import { useNav } from "../../app/navigation.tsx";
import { usePermissions, useRevision, useSession } from "../../app/session.tsx";
import { type as typography, useTheme } from "../../components/theme.ts";
import { Button, Confirm, ListRow, Notice, PagedList, Screen, Sheet, useStyles } from "../../components/ui.tsx";
import { usePeriod } from "../reports/reports.tsx";
import { useAction } from "../../components/command.tsx";
import { saveTextFile } from "../../data/output/print-on-device.ts";
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
  const key = [["MEMBER_CREATED", "MEMBER_ROLE_CHANGED", "ROLE_PERMISSIONS_SET", "CUSTOM_ROLE_SET"].includes(entry.type) ? `role.${code}` : "", entry.type === "PAYMENT_TERMS_SET" ? (code === "SUPPLIER" ? "suppliers" : "customers") : "",
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

/** The operation's name in the current language, with its code when this version does not know it. */
function operationText(entry: AuditEntry, language: Language): string {
  return known(`j.${entry.type}`) ? translate(language, `j.${entry.type}` as TextKey) : `${translate(language, "j.other")} (${entry.type})`;
}

/** Spreadsheet wording for an export in the current language; the same columns as the desktop export. */
function csvText(language: Language): AuditCsvText {
  const t = (key: TextKey): string => translate(language, key);
  return { headings: Object.fromEntries(AUDIT_CSV_COLUMNS.map(column => [column, t(`jc.${column}` as TextKey)])) as AuditCsvText["headings"],
    operation: entry => operationText(entry, language), details: entry => journalDetails(entry, language),
    source: entry => t(entry.source === "this_device" ? "journalThisDevice" : "journalShopWide"),
    status: entry => entry.status !== undefined && entry.status !== "applied" && known(`jst.${entry.status}`) ? t(`jst.${entry.status}` as TextKey) : "",
    unknown: t("journalUnknown") };
}

/** A labelled value that opens a short list in a sheet; for members, devices and operation types. */
function Choice({ label, hint, value, options, onChange }: {
  readonly label: string; readonly hint: string; readonly value: string; readonly options: readonly { readonly id: string; readonly label: string }[]; readonly onChange: (id: string) => void;
}): React.JSX.Element {
  const { t } = useText(), s = useStyles(), { colors } = useTheme(), [open, setOpen] = useState(false);
  const current = options.find(option => option.id === value)?.label ?? options[0]?.label ?? "";
  return <View style={{ gap: 6 }}>
    <Text style={{ ...typography.label, color: colors.muted }}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${current}`} accessibilityHint={`${hint} ${t("opensChooser")}`} onPress={() => setOpen(true)}
      android_ripple={{ color: colors.selected }} style={({ pressed }) => [s.input, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, pressed && { backgroundColor: colors.surfaceSoft }]}>
      <Text style={s.body}>{current}</Text><Text style={{ color: colors.muted }}>▾</Text>
    </Pressable>
    <Text style={s.muted}>{hint}</Text>
    <Sheet visible={open} title={label} onClose={() => setOpen(false)}>
      {/* A long staff or device list scrolls inside the sheet instead of being cut off. */}
      <ScrollView>{options.map(option => <ListRow key={option.id} title={option.label} tag={option.id === value ? t("selected") : undefined} onPress={() => { onChange(option.id); setOpen(false); }} />)}</ScrollView>
    </Sheet>
  </View>;
}

/**
 * Owner only: other tills' facts held back for a reason the owner may approve. Each approval names the exact fact
 * and its reason; the fact is then applied under every other check and can still be refused.
 */
function HeldBack({ revision }: { readonly revision: string }): React.JSX.Element | null {
  const { t, language } = useText(), s = useStyles(), { context } = useSession(), [done, setDone] = useState(0), [confirming, setConfirming] = useState<HeldBackFact>();
  const list = useRecord(() => heldBackFacts(context), [context, revision, done]).value, action = useAction();
  const approve = (fact: HeldBackFact): void => { setConfirming(undefined); action.run(() => reviewQuarantinedEvent(context, fact.eventId, fact.digest), () => setDone(value => value + 1)); };
  const type = (fact: HeldBackFact): string => known(`j.${fact.type}`) ? translate(language, `j.${fact.type}` as TextKey) : fact.type;
  if (list === undefined || list.length === 0) return action.notice;
  return <View style={s.panel}>
    <Text accessibilityRole="header" style={s.heading}>{t("heldBackTitle")}</Text><Text style={s.muted}>{t("heldBackHelp")}</Text>
    {list.map(fact => <ListRow key={fact.eventId} title={type(fact)} tag={t("heldBackApprove")} onPress={() => setConfirming(fact)}
      subtitle={`${formatDate(fact.occurredAt, language)} · ${t("journalByOn", { who: fact.actorName ?? t("journalUnknown"), device: fact.deviceLabel ?? t("journalUnknown") })}\n${t(`heldBack.${fact.reason}` as TextKey)}`} />)}
    {action.notice}
    <Confirm visible={confirming !== undefined} title={confirming === undefined ? "" : type(confirming)} text={confirming === undefined ? undefined : t(`heldBack.${confirming.reason}` as TextKey)}
      confirmLabel={t("heldBackConfirm")} onConfirm={() => { if (confirming !== undefined) approve(confirming); }} onCancel={() => setConfirming(undefined)} />
  </View>;
}

/**
 * The operation journal under audit.view: newest first, narrowed by period, member, device and type. Tapping an entry
 * shows every operation that involved its record (a product's price changes, sales and counts).
 */
export function JournalScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), session = useSession(), { context } = session, revision = useRevision(DOMAINS);
  const { state: days, period, control } = usePeriod("journal-period", "last7");
  const [actorId, setActorId] = useState(""), [deviceId, setDeviceId] = useState(""), [group, setGroup] = useState(""), [subject, setSubject] = useState<AuditSubject>();
  // Members and devices name the filters; one small read, refreshed with the roster.
  const names = useRecord(() => auditTrail(context, { limit: 1 }), [context, revision]).value;
  const filters = { ...(period ?? {}), ...(actorId === "" ? {} : { actorId }), ...(deviceId === "" ? {} : { deviceId }),
    ...(group === "" ? {} : { group: group as AuditGroup }), ...(subject === undefined ? {} : { subjectId: subject.id }) };
  const name = (value: AuditSubject): string => value.name ?? t("journalUnknown");
  const canExport = usePermissions().includes("data.export"), exporting = useAction(), [exported, setExported] = useState<{ count: number; truncated: boolean }>();
  // Every operation matching the filters in one file, saved in a folder the member picks.
  const exportCsv = (): void => { if (period === undefined) return; void exporting.runAsync(async () => {
    const { items, truncated } = auditExport(context, filters);
    const filename = `kolo-journal-${days.from}_${days.to}.csv`;
    const saved = await session.systemUi(() => saveTextFile(filename, "text/csv", auditCsv(items, csvText(language), language === "fr" ? ";" : ",")));
    return saved ? { count: items.length, truncated } : undefined;
  }, result => { if (result !== undefined) setExported(result); }); };
  const header = <>
    {session.isOwner && <HeldBack revision={revision} />}
    <Notice text={t("journalHelp")} />
    {control}
    <Choice label={t("journalWho")} hint={t("hint.journalWho")} value={actorId} onChange={setActorId} options={[{ id: "", label: t("journalAnyone") }, ...(names?.members ?? []).map(m => ({ id: m.id, label: m.name }))]} />
    <Choice label={t("journalDevice")} hint={t("hint.journalDevice")} value={deviceId} onChange={setDeviceId} options={[{ id: "", label: t("journalAnyDevice") }, ...(names?.devices ?? []).map(d => ({ id: d.id, label: d.label }))]} />
    <Choice label={t("journalFamily")} hint={t("hint.journalFamily")} value={group} onChange={setGroup} options={[{ id: "", label: t("journalAnyGroup") }, ...GROUPS.map(id => ({ id, label: t(`jg.${id}` as TextKey) }))]} />
    {canExport && <Button label={t("journalExport")} hint={t("journalExportHelp")} variant="secondary" busy={exporting.busy} disabled={period === undefined} onPress={exportCsv} />}
    {exporting.notice}
    {exported !== undefined && <Notice tone={exported.truncated ? "warning" : "success"} text={t(exported.truncated ? "journalExportTruncated" : exported.count === 1 ? "journalExportedOne" : "journalExported", { count: exported.count })} />}
    {subject !== undefined && <Notice tone="info" text={t("journalOnlyRecord", { name: name(subject) })} action={<Button label={t("journalClearRecord")} variant="secondary" onPress={() => setSubject(undefined)} />} />}
  </>;
  return <Screen title={t("journal")} onBack={nav.back} scroll={false}>
    <PagedList<AuditEntry> searchable={false} revision={revision} deps={[JSON.stringify(filters)]} identify={entry => entry.id} header={header}
      empty={{ title: t("journalEmpty") }}
      load={page => period === undefined ? { items: [] } : auditTrail(context, { ...filters, limit: 30, ...(page.after === undefined ? {} : { after: page.after }) })}
      render={entry => {
        const action = operationText(entry, language);
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
