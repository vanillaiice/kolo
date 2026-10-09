import { useState } from "react";
import { Text, View } from "react-native";
import { purchases, products, suppliers, paymentAccounts } from "@kolo/core/application/queries";
import { recordPurchase } from "@kolo/core/application/operations";
import type { Product } from "@kolo/core/data/products/products";
import type { Supplier } from "@kolo/core/data/suppliers/suppliers";
import type { Account } from "@kolo/core/data/finance/accounts";
import type { DeliveryLine } from "@kolo/core/data/purchases/purchases";
import { moneyEntry, quantityEntry } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import { purchaseTotals, subtotalOf } from "@kolo/core/rules/pricing";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { ReturnForm } from "./ReturnForm.tsx";
import { Browse, Picker } from "./browse.tsx";
import { Button, Field, styles, useCommand, useRevision } from "./ui.tsx";
import type { ShopProps } from "./types.ts";

/** Multi-line stock receipt with door payment or separately derived supplier credit. */
export function PurchasesScreen({ database, context, permissions, branchId }: ShopProps): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database, ["purchases", "products", "suppliers", "accounts", "authority"]), command = useCommand();
  const [returningId, setReturningId] = useState<string>();
  const [editing, setEditing] = useState(false), [product, setProduct] = useState<Product>(), [supplier, setSupplier] = useState<Supplier>(), [account, setAccount] = useState<Account>();
  const [lines, setLines] = useState<readonly (DeliveryLine & { name: string })[]>([]), [quantity, setQuantity] = useState("1"), [cost, setCost] = useState(""), [paid, setPaid] = useState("0"), [reason, setReason] = useState(""), [reference, setReference] = useState("");
  let total: number | undefined;
  try { total = subtotalOf(lines.map(line => ({ unitPriceMinor: line.unitCostMinor, quantity: line.quantity }))); } catch { /* Overflow blocks submission in the shared operation. */ }
  const header = <View style={{ gap: 12 }}>{permissions.includes("purchases.create") && <Button label={t("newPurchase")} onPress={() => setEditing(!editing)} />}
    {editing && <><Picker label={t("supplier")} value={supplier} onChange={setSupplier} optional load={query => suppliers(context, query)} revision={revision} />
      <Field label={t("reference")} value={reference} onChange={setReference} />
      <Picker label={t("products")} value={product} onChange={value => { setProduct(value); setCost(String(value?.purchasePriceMinor ?? "")); }} load={query => products(context, query)} revision={revision} />
      <Field label={t("quantity")} value={quantity} onChange={setQuantity} numeric /><Field label={t("cost")} value={cost} onChange={setCost} numeric />
      <Button label={t("addLine")} disabled={product === undefined} onPress={() => command.validate(() => { const qty = quantityEntry(quantity, product!.divisible), unitCostMinor = moneyEntry(cost); if (qty === 0) throw new Error("zero"); setLines(current => [...current, { id: newIdOnDevice(), movementId: newIdOnDevice(), productId: product!.id, name: product!.name, quantity: qty, unitCostMinor }]); }, () => { setProduct(undefined); setQuantity("1"); setCost(""); })} />
      {lines.map(line => <View key={line.id} style={styles.card}><Text style={styles.text}>{line.name} · {formatQuantity(line.quantity)} × {formatMoney(line.unitCostMinor)}</Text><Button label={t("remove")} onPress={() => setLines(current => current.filter(item => item.id !== line.id))} /></View>)}
      <Text style={styles.title}>{t("total")}: {total === undefined ? t("TOO_LARGE") : formatMoney(total)}</Text><Text style={styles.text}>{t("fullPayment")}</Text>
      {permissions.includes("purchases.pay") && <><Field label={t("purchasePaid")} value={paid} onChange={setPaid} numeric /><Picker label={t("account")} value={account} onChange={setAccount} load={query => paymentAccounts(context, query)} revision={revision} /><Field label={t("reason")} value={reason} onChange={setReason} /></>}
      <Button label={t("recordPurchase")} disabled={lines.length === 0 || total === undefined} onPress={() => command.run(() => {
        const amountMinor = permissions.includes("purchases.pay") ? moneyEntry(paid) : 0;
        if (amountMinor > 0 && account === undefined) throw new Error("account");
        const payments = amountMinor === 0 ? [] : [{ id: newIdOnDevice(), accountId: account!.id, amountMinor, reason: reason.trim() }];
        const totals = purchaseTotals({ lines, payments, supplierId: supplier?.id });
        recordPurchase(context, { id: newIdOnDevice(), branchId, supplierId: supplier?.id, reference: reference.trim() || undefined,
          lines, payments, supplierTransactionId: totals.outstandingMinor > 0 ? newIdOnDevice() : undefined, eventId: newIdOnDevice(), occurredAt: new Date().toISOString() });
      }, () => { setLines([]); setPaid("0"); setReason(""); setReference(""); setEditing(false); })} />
    </>}{returningId !== undefined && <ReturnForm database={database} context={context} permissions={permissions} branchId={branchId} kind="PURCHASE" originalId={returningId} onClose={() => setReturningId(undefined)} />}{command.message}</View>;
  return <Browse<ReturnType<typeof purchases>["items"][number]> revision={revision} searchable={false} identify={item => item.id} load={query => purchases(context, query)} header={header}
    render={item => <><Text style={styles.text}>{item.occurredAt} · {item.supplierName} · {item.reference}</Text><Text style={styles.title}>{formatMoney(item.totalMinor)}</Text>{permissions.includes("purchases.create") && permissions.includes("purchases.pay") && <Button label={t("returnGoods")} onPress={() => { setReturningId(item.id); setEditing(false); }} />}</>} />;
}
