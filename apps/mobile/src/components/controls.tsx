import { View } from "react-native";
import { usePreferences, useText } from "../app/i18n.tsx";
import { spacing } from "./theme.ts";
import { Button, Notice, Segmented } from "./ui.tsx";

/** Language choice, available before setup as well as in Settings; names stay in their own language. */
export function LanguageControl(): React.JSX.Element {
  const { t } = useText(), { language, setLanguage } = usePreferences();
  return <View style={{ gap: spacing.sm }}>
    <Segmented label={t("language")} hint={t("hint.language")} value={language} onChange={setLanguage} options={[{ id: "fr", label: "Français" }, { id: "en", label: "English" }]} />
    <PreferenceProblem />
  </View>;
}

/** System, light or dark appearance for this device. */
export function AppearanceControl(): React.JSX.Element {
  const { t } = useText(), { appearance, setAppearance } = usePreferences();
  return <Segmented label={t("appearance")} hint={t("hint.appearance")} value={appearance} onChange={setAppearance}
    options={[{ id: "system", label: t("appearance.system") }, { id: "light", label: t("appearance.light") }, { id: "dark", label: t("appearance.dark") }]} />;
}

/** A failed preference read/write leaves work available and offers a retry. */
export function PreferenceProblem(): React.JSX.Element | null {
  const { t } = useText(), { storageError, retry } = usePreferences();
  return storageError === undefined ? null : <Notice tone="warning" text={t(storageError)} action={<Button label={t("retry")} variant="secondary" onPress={retry} />} />;
}
