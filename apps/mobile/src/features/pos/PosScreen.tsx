import { useRef, useState } from "react";
import { FlatList, Text, TextInput, View } from "react-native";
import { completeSale } from "@kolo/core/application/operations";
import { customers, paymentAccounts, products, scannedProduct, productStock } from "@kolo/core/application/queries";
import type { Product } from "@kolo/core/data/products/products";
import type { Customer } from "@kolo/core/data/customers/customers";
import type { Account } from "@kolo/core/data/finance/accounts";
import { moneyEntry, quantityEntry } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import { addPayment, addProduct, emptyCart, isComplete, removeLine, removePayment, setCustomer, setDiscount, setQuantity, toCart, view, type CartState } from "@kolo/core/domain/pos/cart";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { Picker } from "../shop/browse.tsx";
import { Button, Field, styles, useCommand, useRevision } from "../shop/ui.tsx";
import type { ShopProps } from "../shop/types.ts";

/** Offline cash/split/credit till. Hardware scanners submit exact barcodes through the keyboard input. */
export function PosScreen({ database, context, permissions, branchId, onReceipt }: ShopProps & { readonly onReceipt: (id: string) => void }): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database, ["products", "inventory", "customers", "accounts", "authority"]), command = useCommand();
  const [cart, setCart] = useState<CartState>(emptyCart), [term, setTerm] = useState(""), [quantity, setQuantityText] = useState("1"), [product, setProduct] = useState<Product>(), [customer, setCustomerValue] = useState<Customer>(), [account, setAccount] = useState<Account>(), [amount, setAmount] = useState(""), [discount, setDiscountText] = useState("0"), [notice, setNotice] = useState(false);
  const searchBox = useRef<React.ComponentRef<typeof TextInput>>(null);
  const completed = useRef<CartState | undefined>(undefined);
  const totals = view(cart), creditAllowed = permissions.includes("customers.credit");
  const add = (item: Product, units = 1000): void => { setCart(current => addProduct(current, item, { lineId: newIdOnDevice(), movementId: newIdOnDevice() }, units)); setTerm(""); setNotice(false); searchBox.current?.focus(); };
  let results: readonly Product[] = [], failed = false;
  try { if (term.trim() !== "") results = products(context, { term, limit: 8 }).items; } catch { failed = true; }
  return <FlatList style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" data={cart.lines} keyExtractor={line => line.id}
    ListHeaderComponent={<View style={{ gap: 12 }}><Text style={styles.title}>{t("pos")}</Text><Text style={styles.text}>{t("offline")}</Text>
      <TextInput ref={searchBox} accessibilityLabel={t("scan")} placeholder={t("scan")} value={term} onChangeText={setTerm} autoCorrect={false} autoCapitalize="none" submitBehavior="submit" style={styles.input}
        onSubmitEditing={() => command.validate(() => { const scanned = scannedProduct(context, term); if (scanned === undefined) { setNotice(true); return; } add(scanned); })} />
      {failed && <Text accessibilityRole="alert" style={styles.error}>{t("error")}</Text>}{notice && <Text style={styles.error}>{t("scanMissing")}</Text>}
      {results.map(item => <Button key={item.id} label={`${item.name} · ${formatMoney(item.sellingPriceMinor)}`} onPress={() => add(item)} />)}
      <Picker label={t("products")} value={product} onChange={setProduct} load={query => products(context, query)} revision={revision} />
      {product !== undefined && <><Field label={t("quantity")} value={quantity} onChange={setQuantityText} numeric /><Button label={t("add")} onPress={() => command.validate(() => { const units = quantityEntry(quantity, product.divisible); if (units === 0) throw new Error("zero"); add(product, units); }, () => { setProduct(undefined); setQuantityText("1"); })} /></>}
      {creditAllowed && permissions.includes("customers.view") && <Picker label={t("customer")} value={customer} optional onChange={value => { setCustomerValue(value); setCart(current => setCustomer(current, value?.id)); }} load={query => customers(context, query)} revision={revision} />}
    </View>}
    ListEmptyComponent={<Text style={styles.text}>{t("emptyCart")}</Text>}
    renderItem={({ item }) => {
      let stock: number | undefined; try { if (permissions.includes("inventory.view")) stock = productStock(context, item.productId).onHandThousandths; } catch { /* Checkout will recheck reference and permission. */ }
      return <View style={styles.card}><Text style={styles.title}>{item.name}</Text><Text style={styles.text}>{formatQuantity(item.quantity)} × {formatMoney(item.unitPriceMinor)}</Text>
        {stock !== undefined && <Text style={stock < 0 ? styles.error : styles.text}>{t("stock")}: {formatQuantity(stock)}{stock < 0 ? ` · ${t("negativeStock")}` : ""}</Text>}
        <View style={styles.row}><Button label="−" onPress={() => setCart(current => setQuantity(current, item.id, item.quantity - 1000))} /><Button label="+" onPress={() => setCart(current => setQuantity(current, item.id, item.quantity + 1000))} /><Button label={t("remove")} onPress={() => setCart(current => removeLine(current, item.id))} /></View>
      </View>;
    }}
    ListFooterComponent={<View style={{ gap: 12 }}>{permissions.includes("sales.discount") && <><Field label={t("discount")} value={discount} onChange={setDiscountText} numeric /><Button label={t("save")} onPress={() => command.validate(() => { const value = moneyEntry(discount); setCart(current => setDiscount(current, value)); })} /></>}
      <Text style={styles.title}>{t("total")}: {formatMoney(totals.totalMinor)}</Text><Text style={styles.text}>{t("paid")}: {formatMoney(totals.paidMinor)} · {t("due")}: {formatMoney(totals.outstandingMinor)}</Text>
      <Picker label={t("account")} value={account} onChange={setAccount} load={query => paymentAccounts(context, query)} revision={revision} />
      <Field label={t("amount")} value={amount} onChange={setAmount} numeric />
      <View style={styles.row}><Button label={t("payment")} disabled={account === undefined || cart.lines.length === 0} onPress={() => command.run(() => { const value = moneyEntry(amount); if (value === 0 || value > totals.outstandingMinor) throw new Error("payment"); setCart(current => addPayment(current, { id: newIdOnDevice(), accountId: account!.id, amountMinor: value })); }, () => setAmount(""))} />
        <Button label={t("takeRest")} disabled={account === undefined || totals.outstandingMinor <= 0 || cart.lines.length === 0} onPress={() => setCart(current => addPayment(current, { id: newIdOnDevice(), accountId: account!.id, amountMinor: view(current).outstandingMinor }))} /></View>
      {cart.payments.map(payment => <View key={payment.id} style={styles.card}><Text style={styles.text}>{payment.accountId === account?.id ? account.name : payment.accountId} · {formatMoney(payment.amountMinor)}</Text><Button label={t("remove")} onPress={() => setCart(current => removePayment(current, payment.id))} /></View>)}
      {creditAllowed && cart.customerId !== undefined && totals.outstandingMinor > 0 && <Text style={styles.text}>{t("credit")}</Text>}
      {totals.problems[0] !== undefined && cart.lines.length > 0 && <Text style={styles.error}>{t(totals.problems[0])}</Text>}
      {command.message}<Button label={t("checkout")} disabled={!isComplete(totals) || (!creditAllowed && totals.outstandingMinor > 0)} onPress={() => {
        if (completed.current === cart) return;
        command.run(() => { const now = new Date().toISOString(), saleId = newIdOnDevice();
          completeSale(context, toCart(cart, { saleId, businessId: context.businessId, branchId, number: `V-${now.slice(0, 10).replace(/-/g, "")}-${saleId.replace(/-/g, "")}`, userId: context.userId, deviceId: context.deviceId, occurredAt: now, recordedAt: now, eventId: newIdOnDevice(), creditTransactionId: newIdOnDevice() }));
          completed.current = cart; setCart(emptyCart); setCustomerValue(undefined); setAmount(""); setDiscountText("0"); onReceipt(saleId);
        });
      }} />
    </View>} />;
}
