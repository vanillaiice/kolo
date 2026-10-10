import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import * as SystemUI from "expo-system-ui";
import { preferredAppearance, preferredLanguage, type PreferenceKey, type PreferenceStorage } from "../data/database/preferences.ts";
import { resolveTheme, ThemeContext, type Appearance } from "../components/theme.ts";
import { translate, type Language, type TextKey, type TextValues } from "./strings.ts";

export type { Language, TextKey } from "./strings.ts";
type StorageError = "languageLoadFailed" | "languageSaveFailed" | "preferenceLoadFailed" | "preferenceSaveFailed" | undefined;
type PreferencesValue = {
  language: Language;
  setLanguage: (value: Language) => void;
  appearance: Appearance;
  setAppearance: (value: Appearance) => void;
  storageError: StorageError;
  retry: () => void;
};
const PreferencesContext = createContext<PreferencesValue>({ language: "fr", setLanguage: () => undefined, appearance: "system", setAppearance: () => undefined, storageError: undefined, retry: () => undefined });

/**
 * Loads device language and appearance before screens render and reports persistence
 * failures without blocking work. Both live in the device preference database, outside
 * shop backups and events, so restoring or replacing a shop keeps them.
 */
export function PreferencesProvider({ children, storage }: { readonly children: ReactNode; readonly storage: PreferenceStorage }): React.JSX.Element {
  const [initial] = useState(() => ({ language: preferredLanguage(storage), appearance: preferredAppearance(storage) }));
  const [language, updateLanguage] = useState(initial.language.language);
  const [appearance, updateAppearance] = useState(initial.appearance.appearance);
  const [storageError, setStorageError] = useState<StorageError>(initial.language.failed ? "languageLoadFailed" : initial.appearance.failed ? "preferenceLoadFailed" : undefined);
  const system = useColorScheme();
  const theme = resolveTheme(appearance, system);
  useEffect(() => { void SystemUI.setBackgroundColorAsync(theme.colors.canvas).catch(() => undefined); }, [theme.colors.canvas]);
  const save = (key: PreferenceKey, value: string): void => {
    try { storage.write(key, value); setStorageError(undefined); }
    catch { setStorageError(key === "language" ? "languageSaveFailed" : "preferenceSaveFailed"); }
  };
  const value: PreferencesValue = {
    language, appearance, storageError,
    setLanguage: next => { updateLanguage(next); save("language", next); },
    setAppearance: next => { updateAppearance(next); save("appearance", next); },
    retry: () => { save("language", language); save("appearance", appearance); },
  };
  return <PreferencesContext.Provider value={value}><ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider></PreferencesContext.Provider>;
}

/** Selects keyed UI text without placing translated prose in business commands. */
export function useText(): { t: (key: TextKey, values?: TextValues) => string; language: Language; setLanguage: (value: Language) => void } {
  const { language, setLanguage } = useContext(PreferencesContext);
  return { language, setLanguage, t: (key, values) => translate(language, key, values) };
}

/** Device language/appearance and the last preference storage failure. */
export function usePreferences(): PreferencesValue { return useContext(PreferencesContext); }

/** The device locale tag for number and date formatting. */
export function localeOf(language: Language): string { return language === "fr" ? "fr-FR" : "en-GB"; }
