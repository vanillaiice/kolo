import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { expenses, paymentAccounts, products, purchases, receipt, receipts, suppliers, type Receipt, type ReceiptSummary } from "@kolo/core/application/queries";
import { expense as expenseRead, purchase as purchaseRead } from "@kolo/core/application/records";
import { recordExpense, recordPurchase } from "@kolo/core/application/operations";
import { previewReturn, returnableItems, returnPurchase, returnSale } from "@kolo/core/application/returns";
import type { Row } from "@kolo/core/data/database/driver";
import { shortReceiptNumber } from "@kolo/core/domain/receipt-number";
import type { Account } from "@kolo/core/data/finance/accounts";
import type { Product } from "@kolo/core/data/products/products";
import type { Supplier } from "@kolo/core/data/suppliers/suppliers";
import type { Category as ExpenseCategory } from "@kolo/core/data/expenses/expenses";
import type { DeliveryLine } from "@kolo/core/data/purchases/purchases";
import { moneyEntry, quantityEntry, quantityInput } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity, formatRate } from "@kolo/core/domain/money";
import { lineTotal, purchaseTotals, subtotalOf } from "@kolo/core/rules/pricing";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { printDocument, shareText } from "../../data/output/print-on-device.ts";
import { useText, type TextKey } from "../../app/i18n.tsx";
import { useLeaveGuard, useNav, useParams } from "../../app/navigation.tsx";
import { useDraft, usePermissions, useRevision, useSession } from "../../app/session.tsx";
import { FormProblem, useAction } from "../../components/command.tsx";
import { spacing } from "../../components/theme.ts";
import { Button, Confirm, EmptyState, Facts, Field, ListRow, Notice, PagedList, Picker, Screen, Section, Segmented, useStyles } from "../../components/ui.tsx";
import { formatDate, useRecord, useRequestId } from "../shared.tsx";
import { receiptHtml, receiptText, type ReceiptLabels } from "./receipt-output.ts";

type ActivityTab = "sales" | "purchases" | "expenses";
export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = ["RENT", "ELECTRICITY", "WATER", "TRANSPORT", "SALARY", "PACKAGING", "MAINTENANCE", "INTERNET", "MARKETING", "OTHER"];

/** Sales receipts, purchases and expenses, each a bounded newest-first list with creation on the list. */
export function ActivityScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), { context } = useSession(), permissions = usePermissions();
  const tabs = ([["sales", permissions.includes("sales.view") || permissions.includes("sales.view_own")], ["purchases", permissions.includes("purchases.view")], ["expenses", permissions.includes("expenses.view")]] as const)
    .filter(([, allowed]) => allowed).map(([id]) => id);
  const [chosen, setChosen] = useDraft<ActivityTab>("activity-tab", () => tabs[0] ?? "sales"), tab = tabs.includes(chosen) ? chosen : tabs[0];
  const revision = useRevision(tab === "sales" ? ["sales"] : tab === "purchases" ? ["purchases", "suppliers"] : ["expenses", "accounts"]);
  const create = tab === "purchases" && permissions.includes("purchases.create") ? () => nav.push("purchaseNew") : tab === "expenses" && permissions.includes("expenses.create") ? () => nav.push("expenseNew") : undefined;
  const switcher = tabs.length > 1 ? <Segmented value={tab} onChange={setChosen} options={tabs.map(id => ({ id, label: t(`activity.${id}` as TextKey) }))} /> : null;
  return <Screen title={t("tab.activity")} scroll={false} actions={create === undefined ? undefined : <Button label={t("new")} variant="ghost" onPress={create} />}>
    {tab === undefined ? <EmptyState title={t("noPermission")} /> : tab === "sales"
      ? <PagedList<ReceiptSummary> key="sales" searchable={false} revision={revision} identify={item => item.id} load={page => receipts(context, page)} header={switcher} empty={{ title: t("noSales") }}
          render={item => <ListRow title={shortReceiptNumber(item.number)} subtitle={[formatDate(item.occurredAt, language), item.customerName].filter(Boolean).join(" · ")} trailing={formatMoney(item.totalMinor)}
            onPress={() => nav.push("receipt", { saleId: item.id })} />} />
      : tab === "purchases"
      ? <PagedList<ReturnType<typeof purchases>["items"][number]> key="purchases" searchable={false} revision={revision} identify={item => item.id} load={page => purchases(context, page)} header={switcher} empty={{ title: t("noPurchases") }}
          render={item => <ListRow title={item.supplierName || t("noSupplier")} subtitle={[formatDate(item.occurredAt, language), item.reference].filter(Boolean).join(" · ")} trailing={formatMoney(item.totalMinor)}
            onPress={() => nav.push("purchase", { purchaseId: item.id })} />} />
      : <PagedList<Row> key="expenses" searchable={false} revision={revision} identify={row => String(row["id"])} load={page => expenses(context, page)} header={switcher} empty={{ title: t("noExpenses") }}
          render={row => { const amount = Number(row["amount_minor"]);
            return <ListRow title={t(String(row["category"]) as TextKey)} subtitle={[formatDate(String(row["occurred_at"]), language), typeof row["description"] === "string" ? row["description"] : undefined].filter(Boolean).join(" · ")}
              tag={row["reversed"] === 1 ? t("reversed") : amount < 0 ? t("reversal") : undefined} trailing={formatMoney(amount)} trailingTone={amount < 0 ? "muted" : "normal"}
              onPress={() => nav.push("expense", { expenseId: String(row["id"]) })} />; }} />}
  </Screen>;
}

/** A saved receipt reread from SQLite with its original snapshots and recorded returns; share and print never touch the sale. */
export function ReceiptScreen(): React.JSX.Element {
  const { t, language } = useText(), s = useStyles(), nav = useNav(), { saleId, fresh } = useParams("receipt"), session = useSession(), permissions = usePermissions();
  const revision = useRevision(["sales"]), action = useAction(), [attempt, setAttempt] = useState(0);
  const { value: saved, failed } = useRecord<Receipt>(() => receipt(session.context, saleId), [session.context, saleId, revision, attempt]);
  if (saved === undefined) return <Screen title={t("receipt")} onBack={nav.back}>{failed ? <Notice tone="error" text={t("loadFailed")} action={<Button label={t("retry")} variant="secondary" onPress={() => setAttempt(n => n + 1)} />} /> : <EmptyState title={t("notFound")} />}</Screen>;
  const labels: ReceiptLabels = { receipt: t("receipt"), customer: t("customer"), discount: t("discountLabel"), total: t("total"), paid: t("paid"), due: t("due"), returned: t("returned"),
    date: formatDate(saved.occurredAt, language), footer: t("receiptFooter"), taxIncluded: t("taxIncluded"), taxNumber: t("taxNumber"), changeKept: t("changeKeptLabel") };
  const output = (work: () => Promise<void>): void => { void action.runAsync(() => session.systemUi(work)); };
  return <Screen title={`${t("receipt")} ${shortReceiptNumber(saved.number)}`} onBack={fresh === true ? undefined : nav.back} footer={fresh === true ? <Button label={t("newSale")} onPress={() => nav.popTo("sell")} /> : undefined}>
    {fresh === true && <Notice tone="success" text={t("saleSaved")} />}
    <Section>
      <Text style={[s.heading, { textAlign: "center" }]}>{session.businessName}</Text>
      <Text style={[s.muted, { textAlign: "center" }]}>{formatDate(saved.occurredAt, language)}{saved.customerName === undefined ? "" : ` · ${saved.customerName}`}</Text>
      {saved.lines.map(line => <View key={line.id} style={{ gap: 2 }}>
        <View style={s.between}><Text style={[s.body, { flex: 1 }]}>{line.name}</Text><Text style={s.amount}>{formatMoney(lineTotal(line))}</Text></View>
        <Text style={s.muted}>{formatQuantity(line.quantity)} × {formatMoney(line.unitPriceMinor)}</Text></View>)}
      <Facts items={[...(saved.discountMinor > 0 ? [[t("discountLabel"), `− ${formatMoney(saved.discountMinor)}`] as const] : []), [t("total"), formatMoney(saved.totalMinor), "strong"],
        ...saved.payments.map(payment => [payment.name, formatMoney(payment.amountMinor)] as const),
        ...(saved.changeKeptMinor === undefined ? [] : [[t("changeKeptLabel"), formatMoney(saved.changeKeptMinor)] as const]),
        ...(saved.outstandingMinor > 0 ? [[saved.customerName === undefined ? t("due") : t("owedBy", { name: saved.customerName }), formatMoney(saved.outstandingMinor), "danger"] as const] : []),
        ...(saved.returnedMinor > 0 ? [[t("returned"), formatMoney(saved.returnedMinor)] as const] : []),
        ...(saved.tax?.groups.map(group => [`${t("taxIncluded")} ${saved.tax!.label} ${formatRate(group.rateBasisPoints, language)}`, formatMoney(group.taxMinor)] as const) ?? []),
        ...(saved.tax?.registration === undefined ? [] : [[t("taxNumber"), saved.tax.registration] as const])]} />
    </Section>
    {action.notice}
    <Button label={t("share")} variant="secondary" busy={action.busy} onPress={() => output(() => shareText(receiptText(saved, session.businessName, labels)))} />
    <Button label={t("printReceipt")} variant="secondary" busy={action.busy} onPress={() => output(() => printDocument(receiptHtml(saved, session.businessName, labels)))} hint={t("printHint")} />
    {permissions.includes("sales.refund") && <Button label={t("returnGoods")} variant="secondary" onPress={() => nav.push("returnForm", { kind: "SALE", originalId: saleId })} />}
  </Screen>;
}

/** A received purchase with its lines, door payment and remaining payable. */
export function PurchaseScreen(): React.JSX.Element {
  const { t, language } = useText(), s = useStyles(), nav = useNav(), { purchaseId } = useParams("purchase"), { context } = useSession(), permissions = usePermissions();
  const revision = useRevision(["purchases", "suppliers"]);
  const { value: item, failed } = useRecord(() => purchaseRead(context, purchaseId), [context, purchaseId, revision]);
  if (item === undefined) return <Screen title={t("purchase")} onBack={nav.back}>{failed ? <Notice tone="error" text={t("loadFailed")} /> : <EmptyState title={t("notFound")} />}</Screen>;
  return <Screen title={item.supplierName || t("noSupplier")} eyebrow={t("purchase")} onBack={nav.back}>
    <Section><Facts items={[[t("date"), formatDate(item.occurredAt, language)], [t("reference"), item.reference], [t("total"), formatMoney(item.totalMinor), "strong"],
      [t("paid"), formatMoney(item.paidMinor)], [t("owedToSupplier"), item.outstandingMinor > 0 ? formatMoney(item.outstandingMinor) : undefined, "danger"], [t("returned"), item.returnedMinor > 0 ? formatMoney(item.returnedMinor) : undefined]]} /></Section>
    <Section title={t("lines")}>{item.lines.map(line => <View key={line.id} style={s.between}><Text style={[s.body, { flex: 1 }]}>{line.name}</Text>
      <Text style={s.muted}>{formatQuantity(line.quantity)} × {formatMoney(line.unitCostMinor)}</Text></View>)}</Section>
    {permissions.includes("purchases.create") && permissions.includes("purchases.pay") && <Button label={t("returnGoods")} variant="secondary" onPress={() => nav.push("returnForm", { kind: "PURCHASE", originalId: purchaseId })} />}
  </Screen>;
}

type DraftLine = DeliveryLine & { readonly name: string };
interface PurchaseDraft {
  readonly id: string; readonly eventId: string; readonly supplierTransactionId: string; readonly step: 1 | 2 | 3;
  readonly supplier?: { readonly id: string; readonly name: string } | undefined; readonly reference: string; readonly lines: readonly DraftLine[];
  readonly paid: string; readonly account?: { readonly id: string; readonly name: string } | undefined; readonly reason: string;
}
const freshPurchase = (): PurchaseDraft => ({ id: newIdOnDevice(), eventId: newIdOnDevice(), supplierTransactionId: newIdOnDevice(), step: 1, reference: "", lines: [], paid: "", reason: "" });

/** Receive a delivery: supplier → items → payment and review. The draft survives navigation; partial payment leaves a supplier debt. */
export function PurchaseNewScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { context, database, branchId } = useSession(), permissions = usePermissions();
  const revision = useRevision(["products", "suppliers", "accounts"]), action = useAction(), [draft, setDraft, clear] = useDraft<PurchaseDraft>("purchase", freshPurchase);
  const [product, setProduct] = useState<Product>(), [quantity, setQuantity] = useState("1"), [cost, setCost] = useState("");
  useLeaveGuard(false);
  let total: number | undefined;
  try { total = subtotalOf(draft.lines.map(line => ({ unitPriceMinor: line.unitCostMinor, quantity: line.quantity }))); } catch { total = undefined; }
  const set = (patch: Partial<PurchaseDraft>): void => setDraft(current => ({ ...current, ...patch }));
  const addLine = (): void => action.run(() => {
    if (product === undefined) throw new FormProblem("chooseProduct");
    if (draft.lines.some(line => line.productId === product.id)) throw new FormProblem("productAlreadyListed");
    const units = quantityEntry(quantity, product.divisible), unitCostMinor = moneyEntry(cost);
    if (units === 0) throw new FormProblem("quantityRequired");
    set({ lines: [...draft.lines, { id: newIdOnDevice(), movementId: newIdOnDevice(), productId: product.id, name: product.name, quantity: units, unitCostMinor }] });
  }, () => { setProduct(undefined); setQuantity("1"); setCost(""); });
  const receive = (): void => action.run(() => {
    // An earlier tap that committed resolves to that purchase instead of receiving the goods twice.
    if (database.get(`SELECT id FROM purchases WHERE business_id = ? AND id = ?`, [context.businessId, draft.id]) === undefined) {
      const amountMinor = permissions.includes("purchases.pay") && draft.paid.trim() !== "" ? moneyEntry(draft.paid) : 0;
      if (amountMinor > 0 && draft.account === undefined) throw new FormProblem("chooseAccount");
      const payments = amountMinor === 0 ? [] : [{ id: newIdOnDevice(), accountId: draft.account!.id, amountMinor, reason: draft.reason.trim() || t("purchasePayment") }];
      const totals = purchaseTotals({ lines: draft.lines, payments, supplierId: draft.supplier?.id });
      recordPurchase(context, { id: draft.id, branchId, supplierId: draft.supplier?.id, reference: draft.reference.trim() || undefined, lines: draft.lines, payments,
        supplierTransactionId: totals.outstandingMinor > 0 ? draft.supplierTransactionId : undefined, eventId: draft.eventId, occurredAt: new Date().toISOString() });
    }
    return draft.id;
  }, id => { clear(); nav.replace("purchase", { purchaseId: id }); });
  let paidMinor = 0; try { paidMinor = draft.paid.trim() === "" ? 0 : moneyEntry(draft.paid); } catch { paidMinor = 0; }
  const owed = total === undefined ? 0 : Math.max(0, total - paidMinor);
  const steps = [{ id: "1", label: t("stepSupplier") }, { id: "2", label: t("stepItems") }, { id: "3", label: t("stepPayment") }] as const;
  return <Screen title={t("newPurchase")} onBack={nav.back} footer={<>{action.notice}
    {draft.step < 3 ? <Button label={t("continue")} disabled={draft.step === 2 && draft.lines.length === 0} onPress={() => set({ step: (draft.step + 1) as 2 | 3 })} />
      : <Button label={t("recordPurchase")} disabled={draft.lines.length === 0 || total === undefined || draft.supplier === undefined && owed > 0} onPress={receive} />}
    <Button label={t("discardDraft")} variant="ghost" onPress={() => { clear(); nav.leave(); }} />
  </>}>
    <Segmented value={String(draft.step) as "1" | "2" | "3"} options={steps} onChange={value => set({ step: Number(value) as 1 | 2 | 3 })} />
    {draft.step === 1 && <Section title={t("stepSupplier")}>
      <Picker<Supplier> label={t("supplier")} optional placeholder={t("noSupplier")} value={draft.supplier as Supplier | undefined} onChange={value => set({ supplier: value === undefined ? undefined : { id: value.id, name: value.name } })}
        load={page => suppliers(context, page)} revision={revision} />
      <Field label={t("reference")} value={draft.reference} onChange={value => set({ reference: value })} hint={t("referenceHelp")} />
      <Text style={s.muted}>{t("fullPayment")}</Text>
    </Section>}
    {draft.step === 2 && <>
      <Section title={t("addLine")}>
        <Picker<Product> label={t("product")} value={product} onChange={value => { setProduct(value); setCost(value?.purchasePriceMinor === undefined ? "" : String(value.purchasePriceMinor)); }} load={page => products(context, page)} revision={revision} />
        <Field label={t("quantity")} value={quantity} onChange={setQuantity} kind="quantity" /><Field label={t("unitCost")} value={cost} onChange={setCost} kind="money" />
        <Button label={t("addLine")} variant="secondary" disabled={product === undefined} onPress={addLine} />
      </Section>
      <Section title={t("lines")}>
        {draft.lines.length === 0 && <Text style={s.muted}>{t("noLinesYet")}</Text>}
        {draft.lines.map(line => <ListRow key={line.id} title={line.name} subtitle={`${formatQuantity(line.quantity)} × ${formatMoney(line.unitCostMinor)}`}
          trailing={formatMoney(lineTotal({ unitPriceMinor: line.unitCostMinor, quantity: line.quantity }))} onPress={() => set({ lines: draft.lines.filter(item => item.id !== line.id) })}
          accessibilityLabel={t("removeLineLabel", { name: line.name })} />)}
        <View style={s.between}><Text style={s.heading}>{t("total")}</Text><Text style={s.amount}>{total === undefined ? t("TOO_LARGE") : formatMoney(total)}</Text></View>
      </Section>
    </>}
    {draft.step === 3 && <>
      <Section title={t("review")}><Facts items={[[t("supplier"), draft.supplier?.name ?? t("noSupplier")], [t("lines"), String(draft.lines.length)], [t("total"), total === undefined ? t("TOO_LARGE") : formatMoney(total), "strong"]]} /></Section>
      {permissions.includes("purchases.pay") && <Section title={t("doorPayment")}>
        <Field label={t("purchasePaid")} value={draft.paid} onChange={value => set({ paid: value })} kind="money" hint={t("purchasePaidHelp")} />
        {paidMinor > 0 && <Picker<Account> label={t("account")} value={draft.account as Account | undefined} onChange={value => set({ account: value === undefined ? undefined : { id: value.id, name: value.name } })}
          load={page => paymentAccounts(context, page)} revision={revision} />}
        {paidMinor > 0 && <Field label={t("reason")} value={draft.reason} onChange={value => set({ reason: value })} />}
      </Section>}
      {owed > 0 && (draft.supplier === undefined ? <Notice tone="error" text={t("fullPayment")} /> : <Notice tone="warning" text={t("supplierWillBeOwed", { name: draft.supplier.name, amount: formatMoney(owed) })} />)}
    </>}
  </Screen>;
}

/** One expense; a reversal is a new compensating entry and the original stays visible. */
export function ExpenseScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), { expenseId } = useParams("expense"), { context } = useSession(), permissions = usePermissions(), action = useAction();
  const revision = useRevision(["expenses"]), [confirming, setConfirming] = useState(false), request = useRequestId();
  const { value: item, failed } = useRecord(() => expenseRead(context, expenseId), [context, expenseId, revision]);
  if (item === undefined) return <Screen title={t("expense")} onBack={nav.back}>{failed ? <Notice tone="error" text={t("loadFailed")} /> : <EmptyState title={t("notFound")} />}</Screen>;
  const reverse = (): void => action.run(() => {
    if (expenseRead(context, request.current) === undefined)
      recordExpense(context, { id: request.current, branchId: item.branchId, accountId: item.accountId, category: item.category as ExpenseCategory, amountMinor: -item.amountMinor, reversesId: item.id,
        description: item.description, occurredAt: new Date().toISOString(), eventId: newIdOnDevice() });
  }, () => request.renew(), "expenseReversed");
  return <Screen title={t(item.category as TextKey)} eyebrow={t("expense")} onBack={nav.back}>
    {item.reversedBy !== undefined && <Notice tone="info" text={t("expenseWasReversed")} />}
    {item.reversesId !== undefined && <Notice tone="info" text={t("expenseIsReversal")} />}
    <Section><Facts items={[[t("amount"), formatMoney(item.amountMinor), "strong"], [t("account"), item.accountName], [t("date"), formatDate(item.occurredAt, language)],
      [t("description"), item.description], [t("reference"), item.reference]]} /></Section>
    {action.notice}
    {permissions.includes("expenses.create") && item.amountMinor > 0 && item.reversedBy === undefined && <Button label={t("reverseExpense")} variant="danger" onPress={() => setConfirming(true)} />}
    <Confirm visible={confirming} destructive title={t("reverseExpense")} text={t("reverseExpenseText", { amount: formatMoney(item.amountMinor) })} confirmLabel={t("reverseExpense")}
      onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); reverse(); }} />
  </Screen>;
}

/** Record an expense from one account; "Other" needs a description. */
export function ExpenseNewScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context, branchId } = useSession(), revision = useRevision(["accounts"]), action = useAction(), request = useRequestId();
  const [category, setCategory] = useState<ExpenseCategory>("OTHER"), [account, setAccount] = useState<Account>(), [amount, setAmount] = useState(""), [description, setDescription] = useState(""), [reference, setReference] = useState("");
  useLeaveGuard(amount !== "" || description !== "");
  const save = (): void => action.run(() => {
    if (account === undefined) throw new FormProblem("chooseAccount");
    if (category === "OTHER" && description.trim() === "") throw new FormProblem("descriptionRequired");
    if (expenseRead(context, request.current) === undefined)
      recordExpense(context, { id: request.current, branchId, accountId: account.id, category, amountMinor: moneyEntry(amount), description: description.trim() || undefined,
        reference: reference.trim() || undefined, occurredAt: new Date().toISOString(), eventId: newIdOnDevice() });
    return request.current;
  }, id => { request.renew(); nav.replace("expense", { expenseId: id }); });
  return <Screen title={t("newExpense")} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={save} /></>}>
    <Section>
      <Segmented label={t("category")} value={category} onChange={setCategory} options={EXPENSE_CATEGORIES.map(id => ({ id, label: t(id) }))} />
      <Picker<Account> label={t("account")} value={account} onChange={setAccount} load={page => paymentAccounts(context, page)} revision={revision} />
      <Field label={t("amount")} value={amount} onChange={setAmount} kind="money" />
      <Field label={t("description")} value={description} onChange={setDescription} hint={category === "OTHER" ? t("descriptionRequired") : undefined} />
      <Field label={t("reference")} value={reference} onChange={setReference} />
    </Section>
  </Screen>;
}

/**
 * Partial or full return: remaining quantities → exact preview → refund (at most what was settled) and
 * ledger credit → confirmation. Recording names the predecessor it was previewed against; a return
 * recorded meanwhile is refused and the source is reloaded.
 */
export function ReturnFormScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { kind, originalId } = useParams("returnForm"), { context } = useSession(), action = useAction();
  const revision = useRevision(["sales", "purchases", "inventory", "accounts"]), request = useRequestId(), [attempt, setAttempt] = useState(0);
  const [quantities, setQuantities] = useState<Record<string, string>>({}), [refund, setRefund] = useState(""), [reason, setReason] = useState(""), [account, setAccount] = useState<Account>(), [confirming, setConfirming] = useState(false);
  const source = useRecord(() => returnableItems(context, kind, originalId), [context, kind, originalId, revision, attempt]);
  const computed = useMemo(() => {
    if (source.value === undefined) return { invalid: false };
    try {
      const selection = source.value.items.map(item => ({ originalItemId: item.id, quantity: quantityEntry(quantities[item.id] ?? "0") })).filter(item => item.quantity > 0);
      if (selection.length === 0) return { invalid: false };
      const preview = previewReturn(context, kind, originalId, selection);
      const refundMinor = refund.trim() === "" ? source.value.counterpartyId === undefined ? preview.totalMinor : 0 : moneyEntry(refund);
      return { preview, refundMinor, invalid: refundMinor > preview.totalMinor || refundMinor > source.value.refundableMinor };
    } catch { return { invalid: true }; }
  }, [context, kind, originalId, source.value, quantities, refund]);
  useLeaveGuard(Object.values(quantities).some(value => value !== "" && value !== "0"));
  if (source.value === undefined) return <Screen title={t("returnGoods")} onBack={nav.back}>{source.failed ? <Notice tone="error" text={t("loadFailed")} /> : <EmptyState title={t("notFound")} />}</Screen>;
  const items = source.value, preview = computed.preview, refundMinor = computed.refundMinor ?? 0;
  const record = (): void => action.run(() => {
    if (preview === undefined) throw new FormProblem("quantityRequired");
    if (reason.trim() === "") throw new FormProblem("reasonRequired");
    if (refundMinor > 0 && account === undefined) throw new FormProblem("chooseAccount");
    const input = { id: request.current, eventId: newIdOnDevice(), originalId, priorId: preview.source.priorId, reason: reason.trim(),
      items: preview.lines.map(line => ({ id: newIdOnDevice(), movementId: newIdOnDevice(), originalItemId: line.originalItemId, quantity: line.quantity })),
      refunds: refundMinor > 0 ? [{ id: newIdOnDevice(), accountId: account!.id, amountMinor: refundMinor }] : [], debtTransactionId: preview.totalMinor > refundMinor ? newIdOnDevice() : undefined };
    if (kind === "SALE") returnSale(context, input); else returnPurchase(context, input);
  }, () => { request.renew(); nav.leave(); });
  const stale = action.message?.key === "returnConflict";
  return <Screen title={t("returnGoods")} eyebrow={t(kind === "SALE" ? "saleReturn" : "purchaseReturn")} onBack={nav.back}
    footer={<>{action.notice}{stale && <Button label={t("reloadSource")} variant="secondary" onPress={() => { setQuantities({}); setRefund(""); action.show(undefined); setAttempt(n => n + 1); }} />}
      <Button label={t("recordReturn")} disabled={computed.invalid || preview === undefined || reason.trim() === "" || refundMinor > 0 && account === undefined} onPress={() => setConfirming(true)} /></>}>
    <Section title={t("stepQuantities")}>
      <Button label={t("fullReturn")} variant="secondary" onPress={() => setQuantities(Object.fromEntries(items.items.map(item => [item.id, quantityInput(item.originalQuantity - item.returnedQuantity)])))} />
      {items.items.map(item => <View key={item.id} style={{ gap: spacing.xs }}>
        <Text style={[s.body, { fontWeight: "600" }]}>{item.name}</Text>
        <Text style={s.muted}>{t("remainingOf", { remaining: formatQuantity(item.originalQuantity - item.returnedQuantity), original: formatQuantity(item.originalQuantity) })}</Text>
        {item.originalQuantity > item.returnedQuantity && <Field label={t("quantityToReturn")} value={quantities[item.id] ?? ""} kind="quantity" onChange={value => setQuantities(current => ({ ...current, [item.id]: value }))} />}
      </View>)}
    </Section>
    {preview !== undefined && <Section title={t("stepRefund")}>
      <Facts items={[[t("returnValue"), formatMoney(preview.totalMinor), "strong"], [t("refundableUpTo"), formatMoney(Math.min(preview.totalMinor, items.refundableMinor))]]} />
      <Field label={t("refundAmount")} value={refund} onChange={setRefund} kind="money" hint={items.counterpartyId === undefined ? t("refundAllHelp") : t("returnHint")} />
      {refundMinor > 0 && <Picker<Account> label={t("account")} value={account} onChange={setAccount} revision={revision} load={page => paymentAccounts(context, page)} />}
      <Facts items={[[t("refund"), formatMoney(refundMinor)], [kind === "SALE" ? t("customerCredit") : t("supplierDebtReduction"), formatMoney(preview.totalMinor - refundMinor)]]} />
    </Section>}
    {computed.invalid && <Notice tone="error" text={t("returnInvalid")} />}
    <Section><Field label={t("reason")} value={reason} onChange={setReason} /></Section>
    <Confirm visible={confirming} title={t("confirmReturn")} text={t("confirmReturnText", { value: formatMoney(preview?.totalMinor ?? 0), refund: formatMoney(refundMinor) })} confirmLabel={t("recordReturn")}
      onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); record(); }} />
  </Screen>;
}
