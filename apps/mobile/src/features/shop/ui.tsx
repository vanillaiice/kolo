import { ExchangeError } from "@kolo/core/exchange/types";
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { changeRevision, subscribeChanges, type ChangedDomain } from "@kolo/core/data/database/changes";
import type { Database } from "@kolo/core/data/database/driver";
import { WorkspaceError } from "@kolo/core/identity/types";
import { colors, TOUCH_TARGET } from "../../components/theme.ts";
import { useText } from "../../app/i18n.tsx";

/** React subscribes to domain revisions and then reads SQLite; no global copy of records. */
export function useRevision(database: Database, domains: readonly ChangedDomain[]): string {
  const key = domains.join(",");
  const subscribe = useCallback((notify: () => void) => subscribeChanges(database, key.split(",") as ChangedDomain[], notify), [database, key]);
  const snapshot = useCallback(() => changeRevision(database, key.split(",") as ChangedDomain[]), [database, key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
/** Accessible shared operational button with a 48 dp target. */
export function Button({ label, onPress, disabled = false }: { readonly label: string; readonly onPress: () => void; readonly disabled?: boolean }): React.JSX.Element {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, disabled && { opacity: 0.4 }]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}
/** Visible label remains available while typing, including hardware-keyboard input. */
export function Field({ label, value, onChange, numeric = false, onSubmit }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly numeric?: boolean; readonly onSubmit?: (() => void) | undefined }): React.JSX.Element {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChange} keyboardType={numeric ? "decimal-pad" : "default"} onSubmitEditing={onSubmit} submitBehavior="submit" autoCorrect={false} style={styles.input} /></View>;
}
/** Explicit choice values, bounded by the caller's paginated local lookup. */
export function Choices({ label, value, items, onChange }: { readonly label: string; readonly value: string; readonly items: readonly { id: string; name: string }[]; readonly onChange: (value: string) => void }): React.JSX.Element {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><View style={styles.row}>{items.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ selected: value === item.id }} onPress={() => onChange(item.id)} style={[styles.choice, value === item.id && styles.selected]}><Text style={styles.text}>{item.name}</Text></Pressable>)}</View></View>;
}
/** Accessible boolean field. */
export function Toggle({ label, value, onChange }: { readonly label: string; readonly value: boolean; readonly onChange: (value: boolean) => void }): React.JSX.Element {
  return <View style={styles.row}><Text style={styles.text}>{label}</Text><Switch accessibilityLabel={label} value={value} onValueChange={onChange} /></View>;
}
/** A form error never claims a failed command was saved. Successful callbacks run only after commit. */
export function useCommand(): { run: (work: () => unknown, after?: () => void) => void; validate: (work: () => unknown, after?: () => void) => void; message: ReactNode } {
  const { t } = useText(), [status, setStatus] = useState<"saved" | "newerEdit" | "error" | "denied" | "locked" | "returnConflict">();
  const execute = (work: () => unknown, after: (() => void) | undefined, persisted: boolean): void => {
    try { const result = work(); setStatus(persisted ? result === false ? "newerEdit" : "saved" : undefined); after?.(); }
    catch (error) { setStatus(error instanceof ExchangeError && error.code === "return_conflict" ? "returnConflict" : error instanceof WorkspaceError && error.code === "permission_denied" ? "denied" : error instanceof WorkspaceError && error.code === "locked" ? "locked" : "error"); }
  };
  return { run: (work, after) => execute(work, after, true), validate: (work, after) => execute(work, after, false),
    message: status === undefined ? null : <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={status === "saved" || status === "newerEdit" ? styles.text : styles.error}>{t(status)}</Text> };
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, content: { padding: 16, gap: 12 },
  title: { fontSize: 22, fontWeight: "700", color: colors.text }, text: { fontSize: 16, color: colors.text },
  label: { fontSize: 14, color: colors.text, fontWeight: "600" }, field: { gap: 6 },
  input: { minHeight: TOUCH_TARGET, borderWidth: 1, borderColor: colors.muted, borderRadius: 6, padding: 10, color: colors.text, backgroundColor: colors.surface },
  button: { minHeight: TOUCH_TARGET, backgroundColor: colors.accent, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 12, justifyContent: "center" },
  buttonText: { color: "white", fontSize: 16, fontWeight: "600", textAlign: "center" },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  card: { padding: 12, gap: 8, borderWidth: 1, borderColor: colors.muted, borderRadius: 8, marginBottom: 8 },
  choice: { minHeight: TOUCH_TARGET, padding: 12, borderWidth: 1, borderColor: colors.muted, borderRadius: 6 },
  selected: { borderColor: colors.accent, borderWidth: 2 }, error: { color: colors.warning, fontSize: 16 },
});
