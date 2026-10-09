import type { Category } from "@kolo/core/data/products/categories";
import type { Row } from "@kolo/core/data/database/driver";
import { useState } from "react";
import { Text, View } from "react-native";
import { products, productStock, stockHistory, categories, category } from "@kolo/core/application/queries";
import { saveProduct, adjustStock, countStock } from "@kolo/core/application/operations";
import type { Product } from "@kolo/core/data/products/products";
import { moneyEntry, quantityEntry, quantityInput } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { Browse, Picker } from "./browse.tsx";
import { Button, Field, Toggle, styles, useCommand, useRevision } from "./ui.tsx";
import type { ShopProps } from "./types.ts";

/** Catalogue editing and explicit stock count/adjustment use shared authorized offline commands. */
export function ProductsScreen({ database, context, permissions, branchId }: ShopProps): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database, ["products", "inventory", "authority"]), command = useCommand();
  const [selected, setSelected] = useState<Product>(), [editing, setEditing] = useState(false), [archived, setArchived] = useState(false);
  const [name, setName] = useState(""), [unit, setUnit] = useState(""), [barcode, setBarcode] = useState(""), [price, setPrice] = useState(""), [cost, setCost] = useState(""), [minimum, setMinimum] = useState("0"), [divisible, setDivisible] = useState(false);
  const [group, setGroup] = useState<Category>();
  const [quantity, setQuantity] = useState(""), [reason, setReason] = useState("");
  const edit = (item?: Product): void => { setSelected(item); setName(item?.name ?? ""); setUnit(item?.unit ?? ""); setBarcode(item?.barcode ?? ""); setPrice(String(item?.sellingPriceMinor ?? "")); setCost(String(item?.purchasePriceMinor ?? "")); setMinimum(quantityInput(item?.minimumStock ?? 0)); setDivisible(item?.divisible ?? false); setGroup(item?.categoryId === undefined ? undefined : category(context, item.categoryId)); setEditing(true); };
  const form = editing ? <View style={{ gap: 12 }}>
    <Picker label={t("category")} value={group} onChange={setGroup} optional load={query => categories(context, query)} revision={revision} />
    <Field label={t("name")} value={name} onChange={setName} /><Field label={t("unit")} value={unit} onChange={setUnit} />
    <Field label={t("barcode")} value={barcode} onChange={setBarcode} /><Field label={t("price")} value={price} onChange={setPrice} numeric />
    <Field label={t("cost")} value={cost} onChange={setCost} numeric /><Toggle label={t("divisible")} value={divisible} onChange={setDivisible} />
    <Field label={t("minimum")} value={minimum} onChange={setMinimum} numeric />
    <Button label={t("save")} onPress={() => command.run(() => {
      const now = new Date().toISOString();
      return saveProduct(context, { ...selected, id: selected?.id ?? newIdOnDevice(), categoryId: group?.id, name: name.trim(), unit: unit.trim(), barcode: barcode.trim() || undefined,
        sellingPriceMinor: moneyEntry(price), purchasePriceMinor: cost.trim() === "" ? undefined : moneyEntry(cost), divisible,
        minimumStock: quantityEntry(minimum, divisible), currency: "XAF", taxRateBasisPoints: selected?.taxRateBasisPoints ?? 0,
        active: selected?.active ?? true, createdAt: selected?.createdAt ?? now, updatedAt: now });
    }, () => { setEditing(false); setSelected(undefined); })} />
    <Button label={t("cancel")} onPress={() => setEditing(false)} />
  </View> : null;
  if (selected !== undefined && !editing) {
    let stock: number | undefined;
    try { if (permissions.includes("inventory.view")) stock = productStock(context, selected.id).onHandThousandths; } catch { /* History below exposes a retryable read failure. */ }
    return <Browse<Row> revision={revision} searchable={false} identify={row => String(row["id"])} load={query => stockHistory(context, selected.id, query)}
      render={row => <Text style={styles.text}>{String(row["occurred_at"])} · {String(row["type"])} · {formatQuantity(Number(row["quantity"]))} · {String(row["reason"] ?? "")}</Text>}
      header={<View style={{ gap: 12 }}><Button label={t("back")} onPress={() => { setSelected(undefined); setQuantity(""); setReason(""); }} /><Text style={styles.title}>{selected.name}</Text>
        {stock !== undefined && <Text style={stock < 0 ? styles.error : styles.text}>{t("stock")}: {formatQuantity(stock)} {stock < 0 ? `· ${t("negativeStock")}` : ""}</Text>}
        {permissions.includes("products.edit") && <Button label={t("edit")} onPress={() => edit(selected)} />}
        {permissions.includes("products.archive") && <Button label={t(selected.active ? "archive" : "restore")} onPress={() => command.run(() => saveProduct(context, { ...selected, active: !selected.active, updatedAt: new Date().toISOString() }), () => setSelected(undefined))} />}
        {selected.active && (permissions.includes("inventory.adjust") || permissions.includes("inventory.count")) && <>
          <Field label={t("quantity")} value={quantity} onChange={setQuantity} numeric /><Field label={t("reason")} value={reason} onChange={setReason} />
          {permissions.includes("inventory.count") && <Button label={t("countStock")} onPress={() => command.run(() => { countStock(context, { productId: selected.id, countedThousandths: quantityEntry(quantity, selected.divisible), reason, branchId }); }, () => { setQuantity(""); setReason(""); })} />}
          {permissions.includes("inventory.adjust") && (["OPENING_BALANCE", "ADJUSTMENT", "DAMAGE"] as const).map(type => <Button key={type} label={t(type === "OPENING_BALANCE" ? "opening" : type === "DAMAGE" ? "damage" : "adjust")} onPress={() => command.run(() => {
            const quantityValue = quantityEntry(quantity, selected.divisible), at = new Date().toISOString();
            adjustStock(context, { id: newIdOnDevice(), productId: selected.id, branchId, type, quantity: type === "DAMAGE" ? -quantityValue : quantityValue, reason: reason.trim(), occurredAt: at }, newIdOnDevice());
          }, () => { setQuantity(""); setReason(""); })} />)}
        </>}{command.message}<Text style={styles.title}>{t("history")}</Text></View>} />;
  }
  return <Browse<Product> key={archived ? "all" : "active"} revision={revision} identify={item => item.id} load={query => products(context, { ...query, includeInactive: archived })}
    header={<View style={{ gap: 12 }}>{permissions.includes("products.create") && <Button label={t("newProduct")} onPress={() => edit()} />}<Toggle label={t("showArchived")} value={archived} onChange={setArchived} />{form}{command.message}</View>}
    render={item => <><Text style={styles.title}>{item.name}{!item.active ? ` · ${t("archived")}` : ""}</Text><Text style={styles.text}>{formatMoney(item.sellingPriceMinor)}</Text><Button label={t("stock")} onPress={() => setSelected(item)} /></>} />;
}
