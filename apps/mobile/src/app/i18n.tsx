import { createContext, useContext, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { preferredLanguage, type LanguageStorage } from "../data/database/preferences.ts";
import { colors, TOUCH_TARGET } from "../components/theme.ts";
import { translate, type Language, type TextKey, type TextValues } from "./strings.ts";

export type { Language, TextKey } from "./strings.ts";
type LanguageContextValue = {
  language: Language;
  setLanguage: (value: Language) => void;
  storageError: "languageLoadFailed" | "languageSaveFailed" | undefined;
};
const LanguageContext = createContext<LanguageContextValue>({ language: "fr", setLanguage: () => undefined, storageError: undefined });

/** Loads the device language before screens render and reports persistence failures without blocking work. */
export function LanguageProvider({ children, storage }: { readonly children: ReactNode; readonly storage: LanguageStorage }): React.JSX.Element {
  const [initial] = useState(() => preferredLanguage(storage));
  const [language, updateLanguage] = useState(initial.language);
  const [storageError, setStorageError] = useState<LanguageContextValue["storageError"]>(initial.failed ? "languageLoadFailed" : undefined);
  const setLanguage = (value: Language): void => {
    updateLanguage(value);
    try { storage.write(value); setStorageError(undefined); }
    catch { setStorageError("languageSaveFailed"); }
  };
  return <LanguageContext.Provider value={{ language, setLanguage, storageError }}>{children}</LanguageContext.Provider>;
}

/** Selects keyed UI text without placing translated prose in business commands. */
export function useText(): { t: (key: TextKey, values?: TextValues) => string; language: Language; setLanguage: (value: Language) => void } {
  const { language, setLanguage } = useContext(LanguageContext);
  return { language, setLanguage, t: (key, values) => translate(language, key, values) };
}

/** Language selection is available before setup/unlock as well as on operational and transfer screens. */
export function LanguageControl({ disabled = false }: { readonly disabled?: boolean }): React.JSX.Element {
  const { language, setLanguage, storageError } = useContext(LanguageContext);
  const t = (key: TextKey): string => translate(language, key);
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Text style={{ color: colors.text }}>{t("language")}</Text>
      {(["fr", "en"] as const).map(value => <Pressable key={value} accessibilityRole="radio"
        accessibilityLabel={value === "fr" ? "Français" : "English"}
        accessibilityState={{ selected: language === value, disabled }} disabled={disabled}
        onPress={() => setLanguage(value)} style={{ minHeight: TOUCH_TARGET, padding: 12, justifyContent: "center", borderRadius: 6,
          borderWidth: language === value ? 2 : 1, borderColor: language === value ? colors.accent : colors.border }}>
        <Text style={{ color: colors.text }}>{value === "fr" ? "Français" : "English"}</Text>
      </Pressable>)}
    </View>
    {storageError !== undefined && <>
      <Text accessibilityRole="alert" style={{ color: colors.warning }}>{t(storageError)}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
        onPress={() => setLanguage(language)} style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }}>
        <Text style={{ color: colors.text }}>{t("retry")}</Text>
      </Pressable>
    </>}
  </View>;
}
