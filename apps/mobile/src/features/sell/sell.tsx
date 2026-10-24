import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Keyboard, Text, TextInput, View, useWindowDimensions } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { completeSale } from "@kolo/core/application/operations";
import { productPhotoDigests } from "@kolo/core/application/photos";
import { categories, customers, paymentAccounts, products, scannedProduct, stockLevels } from "@kolo/core/application/queries";
import type { Product } from "@kolo/core/data/products/products";
import type { Category } from "@kolo/core/data/products/categories";
import type { Account } from "@kolo/core/data/finance/accounts";
import { moneyEntry, quantityEntry, quantityInput } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity } from "@kolo/core/domain/money";
import { addPayment, addProduct, emptyCart, removeLine, removePayment, setCustomer, setDiscount, setQuantity, toCart, view, type CartState } from "@kolo/core/domain/pos/cart";
import { lineTotal } from "@kolo/core/rules/pricing";
import { keepableChange } from "@kolo/core/rules/customer-settlement";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText, type TextKey } from "../../app/i18n.tsx";
import { useNav } from "../../app/navigation.tsx";
import { useDraft, usePermissions, useRevision, useSession } from "../../app/session.tsx";
import { FormProblem, useAction } from "../../components/command.tsx";
import { spacing, useTheme, WIDE_LAYOUT } from "../../components/theme.ts";
import { Button, Divider, EmptyState, Field, ListRow, Notice, Picker, RowGroup, Screen, Section, Segmented, Toggle, useDebounced, usePages, useStyles } from "../../components/ui.tsx";
import { Thumbnail } from "../products/photos.tsx";

/** How a sale is settled: cash (one account, full amount), split across accounts, or partly on a customer's credit. */
export type Settlement = "cash" | "split" | "credit";
/** The till draft: kept for the session across navigation, cleared on lock, and replaced only after a durable sale. */
export interface SellDraft {
  readonly cart: CartState;
  /** Stable identities of this checkout attempt; a repeated tap or retry resolves to the same sale. */
  readonly saleId: string; readonly eventId: string; readonly creditId: string;
  /** Identities of the customer payment that keeps the change on account, drawn with the sale's. */
  readonly changeId: string; readonly changeEventId: string;
  /** The named customer leaves the change on their account as an advance. */
  readonly keepChange?: boolean | undefined;
  readonly customer?: { readonly id: string; readonly name: string } | undefined;
  /** Display names of payment accounts used in this cart, never balances. */
  readonly accountNames: Readonly<Record<string, string>>;
  /** Whole/fractional rule per product in the cart. */
  readonly divisible: Readonly<Record<string, boolean>>;
  readonly settlement: Settlement;
  readonly cashAccount?: { readonly id: string; readonly name: string } | undefined;
}
function freshDraft(): SellDraft {
  return { cart: emptyCart, saleId: newIdOnDevice(), eventId: newIdOnDevice(), creditId: newIdOnDevice(), changeId: newIdOnDevice(), changeEventId: newIdOnDevice(), accountNames: {}, divisible: {}, settlement: "cash" };
}
/** The session's till draft. */
export function useSellDraft(): [SellDraft, (update: SellDraft | ((current: SellDraft) => SellDraft)) => void, () => void] {
  return useDraft<SellDraft>("sell", freshDraft);
}
const PROBLEM_KEYS: Record<string, TextKey> = { EMPTY: "EMPTY", OVERPAID: "OVERPAID", DISCOUNT_EXCEEDS_SALE: "DISCOUNT_EXCEEDS_SALE", CREDIT_NEEDS_CUSTOMER: "CREDIT_NEEDS_CUSTOMER",
  LINE_DISCOUNT_EXCEEDS_LINE: "LINE_DISCOUNT_EXCEEDS_LINE", INVALID_AMOUNT: "INVALID_AMOUNT", TOO_LARGE: "TOO_LARGE" };

/** Persistent cart summary: item count and total, opening the cart. */
function CartBar({ draft, onOpen }: { readonly draft: SellDraft; readonly onOpen: () => void }): React.JSX.Element {
  const { t } = useText(), totals = view(draft.cart);
  return <Button label={t("cartSummary", { count: draft.cart.lines.length, total: formatMoney(totals.totalMinor) })} onPress={onOpen} />;
}

/**
 * Product selection. The scanner field submits an exact barcode on Enter (unknown and archived codes
 * are reported, never replaced by a name match) and keeps focus for the next scan; typed names search
 * after a short pause. On wide screens the cart sits beside the catalogue.
 */
export function SellScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { context, businessName } = useSession(), permissions = usePermissions();
  const revision = useRevision(["products", "inventory"]), [draft, setDraft] = useSellDraft();
  const [term, setTerm] = useState(""), query = useDebounced(term.trim()), [notice, setNotice] = useState<{ key: TextKey; values?: Record<string, string> }>();
  const [category, setCategory] = useState<Category>(), input = useRef<TextInput>(null), { width } = useWindowDimensions(), { colors } = useTheme();
  const showStock = permissions.includes("inventory.view");
  const add = (product: Product, units = 1000): void => {
    setDraft(current => ({ ...current, cart: addProduct(current.cart, product, { lineId: newIdOnDevice(), movementId: newIdOnDevice() }, units),
      divisible: { ...current.divisible, [product.id]: product.divisible } }));
    setTerm(""); setNotice({ key: "addedToCart", values: { name: product.name } });
  };
  const scan = (): void => {
    const code = term.trim(); if (code === "") return;
    try {
      const product = scannedProduct(context, code);
      // A scan keeps the scanner field focused for the next code; a tap on a row does not open the keyboard.
      if (product !== undefined) { add(product); input.current?.focus(); return; }
      const archived = products(context, { term: code, includeInactive: true, limit: 5 }).items.some(item => item.barcode === code && !item.active);
      setNotice({ key: archived ? "scanArchived" : "scanMissing", values: { code } }); setTerm("");
    } catch { setNotice({ key: "loadFailed" }); }
    input.current?.focus();
  };
  // With no search and no category the whole catalogue is listed, a bounded page at a time.
  type Row = Product & { readonly stock?: number; readonly photo?: string };
  const results = usePages<Row>(page => {
    const result = products(context, { ...page, ...(query === "" ? {} : { term: query }), ...(category === undefined ? {} : { categoryId: category.id }) }), ids = result.items.map(item => item.id);
    const stock = showStock ? stockLevels(context, ids) : undefined, photos = productPhotoDigests(context, ids);
    return { ...result, items: result.items.map(item => ({ ...item, ...(stock?.has(item.id) ? { stock: stock.get(item.id)! } : {}), ...(photos.has(item.id) ? { photo: photos.get(item.id)! } : {}) })) };
  }, [query, category?.id, showStock], revision);
  const wide = width >= WIDE_LAYOUT * 1.4;
  const catalogue = <FlatList data={results.items} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled" style={{ flex: 1 }} ItemSeparatorComponent={Divider}
    initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7} onEndReachedThreshold={0.5} onEndReached={results.loadMore}
    ListFooterComponent={results.more ? <View style={{ padding: spacing.lg }}><Button label={t("more")} variant="secondary" onPress={results.loadMore} /></View>
      : results.capped ? <Text style={[s.muted, { textAlign: "center", padding: spacing.lg }]}>{t("refineSearch")}</Text> : null}
    ListHeaderComponent={<View style={{ padding: spacing.lg, gap: spacing.md }}>
      <Field label={t("scan")} value={term} onChange={setTerm} onSubmit={scan} inputRef={input} kind="code" hint={t("scanHint")} />
      {notice !== undefined && <Notice tone={notice.key === "addedToCart" ? "success" : "warning"} text={t(notice.key, notice.values)} />}
      <Picker<Category> label={t("category")} value={category} onChange={setCategory} optional placeholder={t("allCategories")} load={page => categories(context, page)} revision={revision} hint={t("hint.tillCategory")} />
    </View>}
    ListEmptyComponent={results.failed ? <Notice tone="error" text={t("loadFailed")} action={<Button label={t("retry")} variant="secondary" onPress={results.retry} />} />
      : <EmptyState title={query === "" && category === undefined ? t("noProducts") : t("noMatches")} text={query === "" && category === undefined ? t("noProductsHelp") : undefined} />}
    renderItem={({ item }) => {
      const stock = item.stock;
      return <ListRow title={item.name} leading={<Thumbnail productId={item.id} name={item.name} digest={item.photo ?? null} />}
        subtitle={[item.barcode, stock === undefined ? undefined : `${t("stock")} ${formatQuantity(stock)}${stock < 0 ? ` · ${t("negativeStock")}` : ""}`].filter(Boolean).join(" · ")}
        trailing={formatMoney(item.sellingPriceMinor)} onPress={() => { Keyboard.dismiss(); add(item); }} accessibilityLabel={t("addProductLabel", { name: item.name, price: formatMoney(item.sellingPriceMinor) })} />;
    }} />;
  return <Screen title={t("tab.sell")} eyebrow={businessName} scroll={false} footer={wide || draft.cart.lines.length === 0 ? undefined : <CartBar draft={draft} onOpen={() => nav.push("cart")} />}>
    {wide ? <View style={{ flex: 1, flexDirection: "row" }}><View style={{ flex: 3 }}>{catalogue}</View><View style={{ flex: 2, borderLeftWidth: 1, borderLeftColor: colors.border }}><CartBody wide /></View></View> : catalogue}
    {!wide && draft.cart.lines.length === 0 && <Text style={[s.muted, { textAlign: "center", padding: spacing.sm }]}>{t("emptyCart")}</Text>}
  </Screen>;
}

/** Cart lines, customer and discount; the payment step follows. */
export function CartScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav();
  return <Screen title={t("cart")} onBack={nav.back} scroll={false}><CartBody /></Screen>;
}

function CartBody({ wide = false }: { readonly wide?: boolean }): React.JSX.Element {
  const { t } = useText(), s = useStyles(), { colors } = useTheme(), nav = useNav(), { context } = useSession(), permissions = usePermissions();
  const revision = useRevision(["customers"]), [draft, setDraft] = useSellDraft(), totals = view(draft.cart);
  const [editing, setEditing] = useState<Record<string, string>>({}), [discount, setDiscountText] = useState(draft.cart.discountMinor === 0 ? "" : String(draft.cart.discountMinor));
  const [problem, setProblem] = useState<TextKey>();
  const commitQuantity = (lineId: string, productId: string): void => {
    const text = editing[lineId]; if (text === undefined) return;
    try { const units = quantityEntry(text, draft.divisible[productId] ?? false); setDraft(current => ({ ...current, cart: setQuantity(current.cart, lineId, units) })); setProblem(undefined); }
    catch { setProblem("INVALID_AMOUNT"); }
    setEditing(current => { const { [lineId]: _, ...rest } = current; return rest; });
  };
  const applyDiscount = (): void => {
    try { const value = discount.trim() === "" ? 0 : moneyEntry(discount); setDraft(current => ({ ...current, cart: setDiscount(current.cart, value) })); setProblem(undefined); }
    catch { setProblem("INVALID_AMOUNT"); }
  };
  const issue = totals.problems.find(item => item !== "EMPTY" && item !== "CREDIT_NEEDS_CUSTOMER" && item !== "OVERPAID");
  // The cart's quantity and discount fields scroll clear of the keyboard.
  return <FlatList data={draft.cart.lines} keyExtractor={line => line.id} keyboardShouldPersistTaps="handled" style={{ flex: 1 }} ItemSeparatorComponent={Divider}
    // The props type comes from a different react-native type root than this package resolves; the shape is the same.
    renderScrollComponent={props => <KeyboardAwareScrollView {...(props as object)} bottomOffset={spacing.xl} />}
    ListHeaderComponent={wide ? <View style={{ padding: spacing.lg }}><Text accessibilityRole="header" style={s.heading}>{t("cart")}</Text></View> : null}
    ListEmptyComponent={<EmptyState title={t("emptyCart")} text={t("emptyCartHelp")} />}
    renderItem={({ item: line }) => {
      const units = editing[line.id] ?? quantityInput(line.quantity);
      return <View style={{ padding: spacing.lg, gap: spacing.sm, backgroundColor: colors.surface }}>
        <View style={s.between}><Text style={[s.body, { fontWeight: "600", flex: 1 }]}>{line.name}</Text>
          <Text style={s.amount}>{formatMoney(lineTotal(line))}</Text></View>
        <View style={s.between}><Text style={s.muted}>{formatQuantity(line.quantity)} × {formatMoney(line.unitPriceMinor)}</Text>
          <Button label={t("remove")} variant="ghost" accessibilityLabel={t("removeLineLabel", { name: line.name })} style={{ paddingHorizontal: 0 }}
            onPress={() => setDraft(current => ({ ...current, cart: removeLine(current.cart, line.id) }))} /></View>
        <Text style={{ fontSize: 13, fontWeight: "600", color: colors.muted }}>{t("quantity")}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Button label="−" variant="secondary" style={{ width: 56 }} accessibilityLabel={t("decrease", { name: line.name })} onPress={() => setDraft(current => ({ ...current, cart: setQuantity(current.cart, line.id, line.quantity - 1000) }))} />
          <View style={{ flex: 1 }}><Field label={t("quantity")} labelHidden hint={null} value={units} kind="quantity" onChange={value => setEditing(current => ({ ...current, [line.id]: value }))} onSubmit={() => commitQuantity(line.id, line.productId)} /></View>
          <Button label="+" variant="secondary" style={{ width: 56 }} accessibilityLabel={t("increase", { name: line.name })} onPress={() => setDraft(current => ({ ...current, cart: setQuantity(current.cart, line.id, line.quantity + 1000) }))} />
        </View>
        {editing[line.id] !== undefined && <Button label={t("applyQuantity")} variant="secondary" onPress={() => commitQuantity(line.id, line.productId)} />}
      </View>;
    }}
    ListFooterComponent={draft.cart.lines.length === 0 ? null : <View style={{ padding: spacing.lg, gap: spacing.md }}>
      {permissions.includes("customers.view") && <Picker<{ readonly id: string; readonly name: string; readonly phone?: string | undefined }> label={t("customer")} optional placeholder={t("anonymous")} value={draft.customer === undefined ? undefined : { id: draft.customer.id, name: draft.customer.name }}
        onChange={value => setDraft(current => ({ ...current, customer: value === undefined ? undefined : { id: value.id, name: value.name }, cart: setCustomer(current.cart, value?.id),
          settlement: value === undefined && current.settlement === "credit" ? "cash" : current.settlement }))}
        load={page => customers(context, page)} revision={revision} describe={item => item.phone} hint={t("hint.saleCustomer")} />}
      {permissions.includes("sales.discount") && <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: colors.muted }}>{t("discount")}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <View style={{ flex: 1 }}><Field label={t("discount")} labelHidden value={discount} onChange={setDiscountText} kind="money" onSubmit={applyDiscount} hint={t("hint.discount")} /></View>
          <Button label={t("apply")} variant="secondary" onPress={applyDiscount} /></View></View>}
      {problem !== undefined && <Notice tone="error" text={t(problem)} />}
      {issue !== undefined && <Notice tone="error" text={t(PROBLEM_KEYS[issue] ?? "error")} />}
      <Section>
        {totals.subtotalMinor !== totals.totalMinor && <View style={s.between}><Text style={s.muted}>{t("subtotal")}</Text><Text style={s.amount}>{formatMoney(totals.subtotalMinor)}</Text></View>}
        {draft.cart.discountMinor > 0 && <View style={s.between}><Text style={s.muted}>{t("discountLabel")}</Text><Text style={s.amount}>− {formatMoney(draft.cart.discountMinor)}</Text></View>}
        <View style={s.between}><Text style={s.heading}>{t("total")}</Text><Text style={s.total}>{formatMoney(totals.totalMinor)}</Text></View>
      </Section>
      <Button label={t("toPayment")} disabled={issue !== undefined} onPress={() => nav.push("payment")} />
    </View>} />;
}

/**
 * Payment: cash needs no input (the first cash account and the exact total), split allocates named
 * accounts, credit leaves the rest on a named customer. One final action records the sale with the
 * draft's stable IDs; a failure keeps the draft, success clears it and opens the saved receipt.
 */
export function PaymentScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), { colors } = useTheme(), nav = useNav(), { context, database, branchId } = useSession(), permissions = usePermissions();
  const revision = useRevision(["accounts", "customers"]), [draft, setDraft, clearDraft] = useSellDraft(), action = useAction();
  const [account, setAccount] = useState<Account>(), [amount, setAmount] = useState(""), [received, setReceived] = useState("");
  const totals = view(draft.cart), creditAllowed = permissions.includes("customers.credit") && permissions.includes("customers.view");
  useEffect(() => {
    if (draft.cashAccount !== undefined) return;
    try {
      const cash = paymentAccounts(context, { limit: 30 }).items.find(item => item.kind === "CASH");
      if (cash !== undefined) setDraft(current => ({ ...current, cashAccount: { id: cash.id, name: cash.name } }));
    } catch { /* The account picker below stays available. */ }
  }, [context, draft.cashAccount, setDraft]);
  const settlements: { id: Settlement; label: string }[] = [{ id: "cash", label: t("settle.cash") }, { id: "split", label: t("settle.split") }, ...(creditAllowed ? [{ id: "credit" as const, label: t("settle.credit") }] : [])];
  const cashTotals = useMemo(() => {
    if (draft.settlement !== "cash" || draft.cashAccount === undefined) return totals;
    return view(addPayment({ ...draft.cart, payments: [] }, { id: "cash", accountId: draft.cashAccount.id, amountMinor: totals.totalMinor }));
  }, [draft, totals]);
  let receivedMinor: number | undefined;
  try { receivedMinor = received.trim() === "" ? undefined : moneyEntry(received); } catch { receivedMinor = undefined; }
  const owing = draft.settlement === "cash" ? 0 : totals.outstandingMinor;
  // A named customer paying cash in full may leave the change on account as an advance (customers.pay).
  const keepable = draft.settlement === "cash" && draft.cashAccount !== undefined && permissions.includes("customers.pay")
    ? keepableChange({ hasCustomer: draft.customer !== undefined, cashDueMinor: totals.totalMinor, tenderedMinor: receivedMinor, outstandingMinor: 0 }) : 0;
  const keptMinor = draft.keepChange === true ? keepable : 0;
  const ready = draft.cart.lines.length > 0 && (draft.settlement === "cash" ? draft.cashAccount !== undefined || totals.totalMinor === 0
    : draft.settlement === "split" ? totals.outstandingMinor === 0 && totals.problems.length === 0 : draft.customer !== undefined && totals.problems.filter(item => item !== "CREDIT_NEEDS_CUSTOMER").length === 0);
  const addAllocation = (): void => action.run(() => {
    if (account === undefined) throw new FormProblem("chooseAccount");
    const value = amount.trim() === "" ? totals.outstandingMinor : moneyEntry(amount);
    if (value <= 0 || value > totals.outstandingMinor) throw new FormProblem("paymentTooLarge");
    setDraft(current => ({ ...current, cart: addPayment(current.cart, { id: newIdOnDevice(), accountId: account.id, amountMinor: value }), accountNames: { ...current.accountNames, [account.id]: account.name } }));
  }, () => { setAmount(""); setAccount(undefined); });
  const checkout = (): void => action.run(() => {
    // The draft's sale ID already recorded means an earlier tap succeeded: resolve to that sale, never a second one.
    const recorded = database.get(`SELECT id FROM sales WHERE business_id = ? AND id = ?`, [context.businessId, draft.saleId]) !== undefined;
    if (!recorded) {
      const cart = draft.settlement === "cash" && totals.totalMinor > 0 ? addPayment({ ...draft.cart, payments: [] }, { id: newIdOnDevice(), accountId: draft.cashAccount!.id, amountMinor: totals.totalMinor })
        : draft.cart;
      const now = new Date().toISOString();
      completeSale(context, toCart(cart, { saleId: draft.saleId, businessId: context.businessId, branchId, number: `V-${now.slice(0, 10).replace(/-/g, "")}-${draft.saleId.replace(/-/g, "").slice(-12)}`,
        userId: context.userId, deviceId: context.deviceId, occurredAt: now, recordedAt: now, eventId: draft.eventId, creditTransactionId: draft.creditId }),
      keptMinor > 0 ? { id: draft.changeId, eventId: draft.changeEventId, accountId: draft.cashAccount!.id, amountMinor: keptMinor } : undefined);
    }
    return draft.saleId;
  }, saleId => { clearDraft(); nav.popTo("sell"); nav.push("receipt", { saleId, fresh: true }); });
  const visibleTotals = draft.settlement === "cash" ? cashTotals : totals;
  return <Screen title={t("payment")} onBack={nav.back} footer={<>
    {action.notice}
    <Button label={draft.settlement === "credit" && owing > 0 ? t("checkoutCredit", { total: formatMoney(totals.totalMinor) }) : t("checkoutTotal", { total: formatMoney(totals.totalMinor) })}
      disabled={!ready} onPress={checkout} />
  </>}>
    <Section><View style={s.between}><Text style={s.heading}>{t("total")}</Text><Text style={s.total}>{formatMoney(totals.totalMinor)}</Text></View>
      <Text style={s.muted}>{t("itemCount", { count: draft.cart.lines.length })}{draft.customer !== undefined ? ` · ${draft.customer.name}` : ""}</Text></Section>
    <Segmented label={t("settlement")} hint={t("hint.settlement")} value={draft.settlement} options={settlements} onChange={value => setDraft(current => ({ ...current, settlement: value,
      cart: value === "cash" ? { ...current.cart, payments: [] } : current.cart }))} />
    {draft.settlement === "cash" && <Section>
      <Picker<Account> label={t("account")} value={draft.cashAccount === undefined ? undefined : { id: draft.cashAccount.id, name: draft.cashAccount.name } as Account}
        onChange={value => setDraft(current => ({ ...current, cashAccount: value === undefined ? undefined : { id: value.id, name: value.name } }))} load={page => paymentAccounts(context, page)} revision={revision} hint={t("hint.collectAccount")} />
      <Field label={t("received")} value={received} onChange={setReceived} kind="money" hint={t("receivedHint")} />
      {keepable > 0 && <Toggle label={t("keepChangeAsCredit", { name: draft.customer!.name })} value={draft.keepChange === true} onChange={value => setDraft(current => ({ ...current, keepChange: value }))} hint={t("hint.keepChange")} />}
      {keptMinor > 0 ? <Text style={[s.amount, { color: colors.primary }]}>{t("changeKept", { amount: formatMoney(keptMinor) })}</Text>
        : receivedMinor !== undefined && receivedMinor >= visibleTotals.totalMinor && <Text style={[s.amount, { color: colors.primary }]}>{t("changeDue", { amount: formatMoney(receivedMinor - visibleTotals.totalMinor) })}</Text>}
      {receivedMinor !== undefined && receivedMinor < visibleTotals.totalMinor && <Notice tone="warning" text={t("receivedShort", { amount: formatMoney(visibleTotals.totalMinor - receivedMinor) })} />}
    </Section>}
    {draft.settlement !== "cash" && <Section title={t("payments")}>
      {draft.cart.payments.length === 0 && <Text style={s.muted}>{draft.settlement === "credit" ? t("creditNoPayment") : t("noPaymentsYet")}</Text>}
      <RowGroup>{draft.cart.payments.map(payment => <ListRow key={payment.id} title={draft.accountNames[payment.accountId] ?? t("account")} trailing={formatMoney(payment.amountMinor)}
        onPress={() => setDraft(current => ({ ...current, cart: removePayment(current.cart, payment.id) }))} accessibilityLabel={t("removePaymentLabel", { amount: formatMoney(payment.amountMinor) })} />)}</RowGroup>
      {totals.outstandingMinor > 0 && <>
        <Picker<Account> label={t("account")} value={account} onChange={setAccount} load={page => paymentAccounts(context, page)} revision={revision} hint={t("hint.collectAccount")} />
        <Field label={t("amount")} value={amount} onChange={setAmount} kind="money" hint={t("amountDefaultsRemaining", { amount: formatMoney(totals.outstandingMinor) })} />
        <Button label={t("addPayment")} variant="secondary" onPress={addAllocation} />
      </>}
      <View style={s.between}><Text style={s.muted}>{t("remaining")}</Text><Text style={s.amount}>{formatMoney(totals.outstandingMinor)}</Text></View>
    </Section>}
    {draft.settlement === "credit" && (draft.customer === undefined
      ? <Notice tone="warning" text={t("creditNeedsCustomer")} action={<Button label={t("chooseCustomer")} variant="secondary" onPress={nav.back} />} />
      : owing > 0 && <Notice tone="warning" text={t("customerWillOwe", { name: draft.customer.name, amount: formatMoney(owing) })} />)}
  </Screen>;
}
