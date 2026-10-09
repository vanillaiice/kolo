import { useEffect, useState } from "react";
import { BackHandler, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { capabilities } from "@kolo/core/application/queries";
import type { Permission } from "@kolo/core/identity/permissions";
import { useText, LanguageControl, type TextKey } from "../../app/i18n.tsx";
import { PosScreen } from "../pos/PosScreen.tsx";
import { CategoriesScreen } from "./CategoriesScreen.tsx";
import { ProductsScreen } from "./ProductsScreen.tsx";
import { PeopleScreen } from "./PeopleScreen.tsx";
import { PurchasesScreen } from "./PurchasesScreen.tsx";
import { AccountsScreen } from "./AccountsScreen.tsx";
import { ExpensesScreen } from "./ExpensesScreen.tsx";
import { ReportsScreen } from "./ReportsScreen.tsx";
import { ReceiptsScreen } from "./ReceiptsScreen.tsx";
import { Button, styles, useRevision } from "./ui.tsx";
import type { ShopProps } from "./types.ts";

type Section = "categories" | "pos" | "products" | "customers" | "suppliers" | "purchases" | "accounts" | "expenses" | "reports" | "receipts";
const sections: readonly { id: Section; all?: readonly Permission[]; any?: readonly Permission[] }[] = [
  { id: "pos", all: ["sales.create", "products.view"] }, { id: "products", all: ["products.view"] }, { id: "categories", all: ["products.view"] },
  { id: "customers", all: ["customers.view"] }, { id: "suppliers", all: ["suppliers.view"] },
  { id: "purchases", all: ["purchases.view"] }, { id: "accounts", all: ["finance.accounts.view", "cash.view"] },
  { id: "expenses", all: ["expenses.view"] }, { id: "reports", any: ["reports.sales", "reports.financial", "reports.inventory", "reports.customers", "reports.suppliers"] },
  { id: "receipts", any: ["sales.view", "sales.view_own"] },
];
/** Permission-aware mobile navigation. Till draft remains mounted across operational tabs; lock discards it. */
export function ShopScreen({ database, context, branchId, businessName, userName, onLock, onTransfer, onStaff }: Omit<ShopProps, "permissions"> & {
  readonly businessName: string; readonly userName: string; readonly onLock: () => void; readonly onTransfer?: (() => void) | undefined; readonly onStaff?: (() => void) | undefined;
}): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database, ["authority"]);
  void revision;
  let permissions: readonly Permission[] = [];
  try { permissions = capabilities(context); } catch { /* No views are exposed under a locked/inactive context. */ }
  const available = sections.filter(section => (section.all ?? []).every(p => permissions.includes(p)) && (section.any === undefined || section.any.some(p => permissions.includes(p))));
  const [selected, setSelected] = useState<Section>("pos"), [receiptId, setReceiptId] = useState<string>();
  const section = available.some(item => item.id === selected) ? selected : available[0]?.id;
  const props: ShopProps = { database, context, branchId, permissions };
  useEffect(() => { const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
    if (section === undefined || section === available[0]?.id) return false;
    setSelected(available[0]!.id); return true;
  }); return () => subscription.remove(); }, [section, available[0]?.id]);
  return <SafeAreaView edges={["top", "bottom"]} style={styles.screen}>
    <View style={{ padding: 12, gap: 8 }}><Text style={styles.title}>{businessName}</Text><Text style={styles.text}>{userName}</Text>
      <LanguageControl /><View style={styles.row}><Button label={t("lock")} onPress={onLock} />
        {onTransfer && <Button label={t("transfer")} onPress={onTransfer} />}{onStaff && <Button label={t("staff")} onPress={onStaff} />}</View>
    </View>
    <View><ScrollView horizontal contentContainerStyle={{ padding: 12, gap: 8 }} keyboardShouldPersistTaps="handled">{available.map(item => <Button key={item.id} label={`${section === item.id ? "• " : ""}${t(item.id as TextKey)}`} onPress={() => { setSelected(item.id); if (item.id === "receipts") setReceiptId(undefined); }} />)}</ScrollView></View>
    {available.some(item => item.id === "pos") && <View style={{ flex: section === "pos" ? 1 : 0, display: section === "pos" ? "flex" : "none" }}><PosScreen {...props} onReceipt={id => { setReceiptId(id); setSelected("receipts"); }} /></View>}
    {section === "categories" && <CategoriesScreen {...props} />}
    {section === "products" && <ProductsScreen {...props} />}{section === "customers" && <PeopleScreen {...props} kind="customer" />}
    {section === "suppliers" && <PeopleScreen {...props} kind="supplier" />}{section === "purchases" && <PurchasesScreen {...props} />}
    {section === "accounts" && <AccountsScreen {...props} />}{section === "expenses" && <ExpensesScreen {...props} />}
    {section === "reports" && <ReportsScreen {...props} />}{section === "receipts" && <ReceiptsScreen key={receiptId ?? "history"} {...props} initialId={receiptId} businessName={businessName} />}
    {section === undefined && <Text accessibilityRole="alert" style={styles.error}>{t("noPermission")}</Text>}
  </SafeAreaView>;
}
