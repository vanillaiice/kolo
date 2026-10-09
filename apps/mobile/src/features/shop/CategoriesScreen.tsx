import { useState } from "react";
import { Text, View } from "react-native";
import { categories } from "@kolo/core/application/queries";
import { saveCategory } from "@kolo/core/application/operations";
import type { Category } from "@kolo/core/data/products/categories";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { Browse } from "./browse.tsx";
import { Button, Field, Toggle, styles, useCommand, useRevision } from "./ui.tsx";
import type { ShopProps } from "./types.ts";
/** Category details use authorized atomic saves and signed exchange, like product details. */
export function CategoriesScreen({ database, context, permissions }: ShopProps): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database, ["products", "authority"]), command = useCommand();
  const [selected, setSelected] = useState<Category>(), [editing, setEditing] = useState(false), [name, setName] = useState(""), [archived, setArchived] = useState(false);
  return <Browse<Category> key={archived ? "all" : "active"} revision={revision} identify={item => item.id} load={query => categories(context, { ...query, includeInactive: archived })}
    header={<View style={{ gap: 12 }}>{permissions.includes("products.create") && <Button label={t("newCategory")} onPress={() => { setSelected(undefined); setName(""); setEditing(true); }} />}<Toggle label={t("showArchived")} value={archived} onChange={setArchived} />
      {editing && <><Field label={t("name")} value={name} onChange={setName} /><Button label={t("save")} onPress={() => command.run(() => {
        const now = new Date().toISOString(); return saveCategory(context, { id: selected?.id ?? newIdOnDevice(), name: name.trim(), active: selected?.active ?? true, createdAt: selected?.createdAt ?? now, updatedAt: now });
      }, () => setEditing(false))} /><Button label={t("cancel")} onPress={() => setEditing(false)} /></>}{command.message}</View>}
    render={item => <><Text style={styles.title}>{item.name}{!item.active ? ` · ${t("archived")}` : ""}</Text>
      {permissions.includes("products.edit") && <Button label={t("edit")} onPress={() => { setSelected(item); setName(item.name); setEditing(true); }} />}
      {permissions.includes("products.archive") && <Button label={t(item.active ? "archive" : "restore")} onPress={() => command.run(() => saveCategory(context, { ...item, active: !item.active, updatedAt: new Date().toISOString() }))} />}
    </>} />;
}
