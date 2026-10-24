import { useState } from "react";
import { Text, View } from "react-native";
import Constants from "expo-constants";
import { supportedCpuArchitectures } from "expo-device";
import type { Permission } from "@kolo/core/identity/permissions";
import { rememberMember } from "@kolo/core/identity/workspace";
import { useText } from "../../app/i18n.tsx";
import { useNav } from "../../app/navigation.tsx";
import { usePermissions, useSession } from "../../app/session.tsx";
import { AppearanceControl, LanguageControl } from "../../components/controls.tsx";
import { spacing, useTheme } from "../../components/theme.ts";
import { Button, Confirm, Field, ListRow, Notice, RowGroup, Screen, Section, Toggle, useStyles } from "../../components/ui.tsx";
import { FormProblem, useAction } from "../../components/command.tsx";
import { PhotoUsage } from "../products/photos.tsx";
import { SystemNotificationsToggle, useUnreadAlerts } from "./alerts.tsx";
import type { PlatformCheck } from "@kolo/core/application/platform-check";
import { checkThisDevice } from "../../data/platform-check-on-device.ts";

/** Secondary destinations, each shown only to actors whose permissions open it, in a fixed order. */
export function MoreScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), session = useSession(), permissions = usePermissions(), has = (p: Permission): boolean => permissions.includes(p);
  const unread = useUnreadAlerts();
  const items = [
    <ListRow key="alerts" title={t("alerts")} subtitle={unread > 0 ? t("alertsUnread", { count: unread }) : t("alertsMenuHelp")} trailing={unread > 0 ? String(unread) : undefined} trailingTone="danger" onPress={() => nav.push("alerts")} />,
    has("customers.view") && <ListRow key="customers" title={t("customers")} subtitle={t("customersMenuHelp")} onPress={() => nav.push("customers")} />,
    has("suppliers.view") && <ListRow key="suppliers" title={t("suppliers")} subtitle={t("suppliersMenuHelp")} onPress={() => nav.push("suppliers")} />,
    has("finance.accounts.view") && has("cash.view") && <ListRow key="accounts" title={t("accounts")} subtitle={t("accountsMenuHelp")} onPress={() => nav.push("accounts")} />,
    (has("reports.sales") || has("reports.financial") || has("reports.inventory") || has("reports.customers") || has("reports.suppliers")) && <ListRow key="reports" title={t("reports")} subtitle={t("reportsMenuHelp")} onPress={() => nav.push("reports")} />,
    has("reports.sales") && <ListRow key="analytics" title={t("analytics")} subtitle={t("analyticsMenuHelp")} onPress={() => nav.push("analytics")} />,
    has("users.view") && <ListRow key="staff" title={t("staff")} subtitle={t("staffMenuHelp")} onPress={() => nav.push("staff")} />,
    has("audit.view") && <ListRow key="journal" title={t("journal")} subtitle={t("journalMenuHelp")} onPress={() => nav.push("journal")} />,
    session.isOwner && has("business.settings") && <ListRow key="devices" title={t("devicesTitle")} subtitle={t("devicesMenuHelp")} onPress={() => nav.push("devices")} />,
    <ListRow key="settings" title={t("settings")} subtitle={t("settingsMenuHelp")} onPress={() => nav.push("settings")} />,
  ].filter(Boolean);
  return <Screen title={t("tab.more")} eyebrow={session.businessName}>
    <Section><Text style={s.body}>{t("signedInAs", { name: session.userName })}</Text><Button label={t("lock")} variant="secondary" onPress={session.lock} /></Section>
    <RowGroup>{items}</RowGroup>
  </Screen>;
}

/** Device settings: language, appearance, photo storage and About. They are device preferences, outside shop backups. */
export function SettingsScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), permissions = usePermissions(), session = useSession();
  return <Screen title={t("settings")} onBack={nav.back}>
    <Section title={t("session")}><Toggle label={t("staySignedIn")} value={session.rememberSession} onChange={session.setRememberSession} hint={t("staySignedInHelp")} /></Section>
    {permissions.includes("business.settings") && <Section title={t("shopSettings")}><RowGroup>
      <ListRow title={t("taxTitle")} subtitle={t("taxMenuHelp")} onPress={() => nav.push("shopTax")} />
      <ListRow title={t("termsTitle")} subtitle={t("termsMenuHelp")} onPress={() => nav.push("shopTerms")} /></RowGroup></Section>}
    <BiometricSettings />
    <Section><LanguageControl /><AppearanceControl /><SystemNotificationsToggle /><Text style={s.muted}>{t("devicePreferencesHelp")}</Text></Section>
    {permissions.includes("products.view") && <Section title={t("photoStorage")}><PhotoUsage /><Text style={s.muted}>{t("photoStorageHelp")}</Text></Section>}
    <RowGroup><ListRow title={t("about")} onPress={() => nav.push("about")} /></RowGroup>
    {session.isOwner && permissions.includes("business.settings") && <RowGroup><ListRow title={t("resetDevice")} subtitle={t("resetDeviceHelp")} onPress={() => nav.push("reset")} /></RowGroup>}
  </Screen>;
}

/**
 * Fingerprint or face unlock: each member opts in on this phone; the owner can switch it off for the
 * phone, which forgets every member's enrollment. The system prompt counts as a screen KOLO opened.
 */
function BiometricSettings(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), session = useSession(), action = useAction(), { biometric, context } = session;
  const [, refresh] = useState(0), update = (): void => refresh(value => value + 1);
  const supported = biometric.usable() || !biometric.allowed();
  return <Section title={t("biometricTitle")}>
    {!biometric.allowed() ? <Text style={s.muted}>{t("biometricOffForPhone")}</Text>
      : !supported ? <Text style={s.muted}>{t("biometricUnavailable")}</Text>
      : <Toggle label={t("biometricToggle")} value={biometric.enrolled(context.userId)} hint={t("biometricHelp")}
          onChange={enabled => { void action.runAsync(async () => {
            if (enabled) await session.systemUi(() => biometric.enroll(rememberMember(context))); else await biometric.forget(context.userId);
          }, update); }} />}
    {session.isOwner && <Toggle label={t("biometricAllowed")} value={biometric.allowed()} hint={t("biometricAllowedHelp")}
      onChange={enabled => { void action.runAsync(() => biometric.setAllowed(enabled), update); }} />}
    {action.notice}
  </Section>;
}

/** Version, licence and what KOLO does with data on this phone. */
export function AboutScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), { colors } = useTheme(), nav = useNav();
  const version = Constants.expoConfig?.version ?? "0.0.0";
  // The first supported architecture names the APK to download (arm64-v8a or armeabi-v7a).
  const architecture = supportedCpuArchitectures?.[0];
  return <Screen title={t("about")} onBack={nav.back}>
    <View style={{ alignItems: "center", gap: spacing.xs, padding: spacing.lg }}>
      <Text style={{ fontSize: 30, fontWeight: "800", letterSpacing: 3, color: colors.brand }}>KOLO</Text>
      <Text style={s.muted}>{t("versionLabel", { version })}</Text>
      {architecture !== undefined && <Text selectable style={s.muted}>{t("architectureLabel", { architecture })}</Text>}<Text style={s.muted}>kolo · made by hblabs</Text></View>
    <Section title={t("licenseTitle")}><Text style={s.body}>{t("licenseText")}</Text></Section>
    <Section title={t("privacyTitle")}><Text style={s.body}>{t("privacyText")}</Text></Section>
    <DeviceCheck />
    <Section title={t("openSourceTitle")}>{["React Native · MIT", "Expo · MIT", "React · MIT", "react-native-quick-crypto · MIT", "Zod · MIT", "fflate · MIT"].map(line => <Text key={line} style={s.body}>{line}</Text>)}</Section>
  </Screen>;
}

/** Runs the platform check on this phone and lists every result, so an installed build can be checked by hand. */
function DeviceCheck(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), [busy, setBusy] = useState(false), [result, setResult] = useState<PlatformCheck>();
  const run = (): void => { setBusy(true); setResult(undefined); void checkThisDevice().then(setResult).finally(() => { setBusy(false); }); };
  return <Section title={t("deviceCheckTitle")}>
    <Text style={s.body}>{t("deviceCheckHelp")}</Text>
    <Button label={t("deviceCheckRun")} variant="secondary" busy={busy} onPress={run} />
    {result !== undefined && <Notice tone={result.ok ? "success" : "error"} text={t(result.ok ? "deviceCheckPassed" : "deviceCheckFailed")} />}
    {result?.checks.map(check => <Text key={check.name} selectable style={s.muted}>{`${check.ok ? "✓" : "✗"} ${check.name} · ${check.ms} ms${check.detail === undefined ? "" : ` · ${check.detail}`}`}</Text>)}
  </Section>;
}

/**
 * Owner-only device reset: after the typed shop name and the owner's code, every shop on this phone
 * (including kept safety copies) and its protected credentials are erased, and KOLO starts empty.
 * Language and appearance stay. Nothing leaves the phone, so an encrypted backup is the only way back.
 */
export function ResetScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), session = useSession(), action = useAction();
  const [typed, setTyped] = useState(""), [secret, setSecret] = useState(""), [confirming, setConfirming] = useState(false);
  const reset = (): void => { void action.runAsync(async () => {
    const row = session.database.get(`SELECT credential_reference FROM local_memberships WHERE business_id = ? AND user_id = ?`, [session.context.businessId, session.context.userId]);
    if (row === undefined || !await session.ports.credentials.verify(String(row["credential_reference"]), secret)) throw new FormProblem("identity.invalid_credential");
  }, () => { setSecret(""); session.resetDevice(); }); };
  return <Screen title={t("resetDevice")} onBack={nav.back} footer={<>{action.notice}
    <Button label={t("resetDevice")} variant="danger" busy={action.busy} disabled={typed.trim() !== session.businessName || secret === ""} onPress={() => setConfirming(true)} /></>}>
    <Notice tone="error" text={t("resetDeviceWarning", { shop: session.businessName })} />
    <Section>
      <Text style={s.body}>{t("resetDeviceBackupFirst")}</Text>
      <Button label={t("createBackup")} variant="secondary" onPress={() => nav.push("backupCreate")} />
    </Section>
    <Section>
      <Field label={t("typeCurrentShop", { name: session.businessName })} value={typed} onChange={setTyped} hint={t("hint.resetTyped")} />
      <Field label={t("localSecret")} value={secret} onChange={setSecret} kind="secret" hint={t("hint.resetSecret")} />
    </Section>
    <Confirm visible={confirming} destructive title={t("resetDeviceTitle")} text={t("resetDeviceConfirm", { shop: session.businessName })} confirmLabel={t("resetDevice")}
      onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); reset(); }} />
  </Screen>;
}
