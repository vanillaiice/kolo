import { useState, type ReactNode } from "react";
import { FlatList, Text, View } from "react-native";
import type { Cursor, Page, PageQuery } from "@kolo/core/application/queries";
import { useText } from "../../app/i18n.tsx";
import { Button, Field, styles } from "./ui.tsx";

/** Bounded list with explicit pagination; a changed SQLite domain resets its continuation. */
export function Browse<T>({ load, revision, identify, render, header, searchable = true }: {
  readonly load: (query: PageQuery) => Page<T>; readonly revision: string; readonly identify: (item: T) => string;
  readonly render: (item: T) => ReactNode; readonly header?: ReactNode; readonly searchable?: boolean;
}): React.JSX.Element {
  const { t } = useText(), [term, setTerm] = useState(""), [cursor, setCursor] = useState<{ after: Cursor; revision: string }>(), [refresh, setRefresh] = useState(0);
  void refresh;
  let page: Page<T> = { items: [] }, failed = false;
  try { page = load({ term, ...(cursor?.revision === revision ? { after: cursor.after } : {}) }); } catch { failed = true; }
  return <FlatList data={page.items} keyExtractor={identify} style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
    ListHeaderComponent={<View style={{ gap: 12 }}>{header}{searchable && <Field label={t("search")} value={term} onChange={value => { setTerm(value); setCursor(undefined); }} />}</View>}
    ListEmptyComponent={<Text style={failed ? styles.error : styles.text}>{t(failed ? "error" : "empty")}</Text>}
    renderItem={({ item }) => <View style={styles.card}>{render(item)}</View>}
    ListFooterComponent={<View style={styles.row}>{failed && <Button label={t("retry")} onPress={() => setRefresh(value => value + 1)} />}{cursor && <Button label={t("first")} onPress={() => setCursor(undefined)} />}{page.next && <Button label={t("more")} onPress={() => setCursor({ after: page.next!, revision })} />}</View>} />;
}

/** Searchable local chooser; shows one page only and preserves an explicit selected label. */
export function Picker<T extends { readonly id: string; readonly name: string }>({ label, value, onChange, load, revision, optional = false }: {
  readonly label: string; readonly value: T | undefined; readonly onChange: (value: T | undefined) => void;
  readonly load: (query: PageQuery) => Page<T>; readonly revision: string; readonly optional?: boolean;
}): React.JSX.Element {
  const { t } = useText(), [open, setOpen] = useState(false), [term, setTerm] = useState(""), [cursor, setCursor] = useState<{ after: Cursor; revision: string }>(), [refresh, setRefresh] = useState(0);
  void refresh;
  let page: Page<T> = { items: [] }, failed = false;
  if (open) try { page = load({ term, ...(cursor?.revision === revision ? { after: cursor.after } : {}) }); } catch { failed = true; }
  return <View style={{ gap: 8 }}><Button label={`${label}: ${value?.name ?? t("none")}`} onPress={() => setOpen(!open)} />
    {open && <><Field label={t("search")} value={term} onChange={text => { setTerm(text); setCursor(undefined); }} />
      {optional && <Button label={t("none")} onPress={() => { onChange(undefined); setOpen(false); }} />}
      {page.items.map(item => <Button key={item.id} label={item.name} onPress={() => { onChange(item); setOpen(false); }} />)}
      {page.items.length === 0 && <Text style={failed ? styles.error : styles.text}>{t(failed ? "error" : "empty")}</Text>}
      {failed && <Button label={t("retry")} onPress={() => setRefresh(value => value + 1)} />}
      {cursor && <Button label={t("first")} onPress={() => setCursor(undefined)} />}
      {page.next && <Button label={t("more")} onPress={() => setCursor({ after: page.next!, revision })} />}
    </>}
  </View>;
}
