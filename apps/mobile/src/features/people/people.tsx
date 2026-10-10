import { useMemo, useState } from "react";
import { customers, paymentAccounts, statement, suppliers } from "@kolo/core/application/queries";
import { customer as customerRead, supplier as supplierRead } from "@kolo/core/application/records";
import { paySupplier, receiveCustomerPayment, saveCustomer, saveSupplier } from "@kolo/core/application/operations";
import type { Account } from "@kolo/core/data/finance/accounts";
import type { Row } from "@kolo/core/data/database/driver";
import { moneyEntry } from "@kolo/core/domain/entry";
import { formatMoney } from "@kolo/core/domain/money";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText, type TextKey } from "../../app/i18n.tsx";
import { useLeaveGuard, useNav, useParams } from "../../app/navigation.tsx";
import { usePermissions, useRevision, useSession } from "../../app/session.tsx";
import { FormProblem, useAction } from "../../components/command.tsx";
import { Button, Confirm, EmptyState, Facts, Field, ListRow, Notice, PagedList, Picker, RowGroup, Screen, Section, Toggle } from "../../components/ui.tsx";
import { formatDate, nextVersion, requireVersion, useRecord, useRequestId } from "../shared.tsx";

type Kind = "customer" | "supplier";
const ENTRY_KEYS: Record<string, TextKey> = { CREDIT_SALE: "ledger.CREDIT_SALE", PURCHASE: "ledger.PURCHASE", PAYMENT: "ledger.PAYMENT", RETURN: "ledger.RETURN",
  ADJUSTMENT: "ledger.ADJUSTMENT", OPENING_BALANCE: "ledger.OPENING_BALANCE", WRITE_OFF: "ledger.WRITE_OFF" };
const read = (kind: Kind, context: Parameters<typeof customerRead>[0], id: string) => kind === "customer" ? customerRead(context, id) : supplierRead(context, id);

/** Customers or suppliers with derived balances; creation on the list. */
function PeopleList({ kind }: { readonly kind: Kind }): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context } = useSession(), permissions = usePermissions(), revision = useRevision(kind === "customer" ? ["customers"] : ["suppliers"]);
  const [archived, setArchived] = useState(false), canManage = permissions.includes(kind === "customer" ? "customers.manage" : "suppliers.manage");
  return <Screen title={t(kind === "customer" ? "customers" : "suppliers")} onBack={nav.back} scroll={false}
    actions={canManage ? <Button label={t("new")} variant="ghost" onPress={() => nav.push("personForm", { kind })} /> : undefined}>
    <PagedList<{ id: string; name: string; phone?: string | undefined; active: boolean; outstandingMinor: number }> revision={revision} identify={item => item.id} deps={[archived, kind]}
      load={page => kind === "customer" ? customers(context, { ...page, includeInactive: archived }) : suppliers(context, { ...page, includeInactive: archived })}
      header={<Toggle label={t("showArchived")} value={archived} onChange={setArchived} />} empty={{ title: t(kind === "customer" ? "noCustomers" : "noSuppliers") }}
      render={item => <ListRow title={item.name} subtitle={item.phone} tag={item.active ? undefined : t("archived")}
        trailing={item.outstandingMinor === 0 ? undefined : formatMoney(item.outstandingMinor)} trailingTone={item.outstandingMinor > 0 ? "danger" : "muted"}
        onPress={() => nav.push("person", { kind, id: item.id })} />} />
  </Screen>;
}
/** Customer list. */
export function CustomersScreen(): React.JSX.Element { return <PeopleList kind="customer" />; }
/** Supplier list. */
export function SuppliersScreen(): React.JSX.Element { return <PeopleList kind="supplier" />; }

/** Contact details, balance, recent statement and the collection or payment action. */
export function PersonScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), { kind, id } = useParams("person"), { context } = useSession(), permissions = usePermissions(), action = useAction();
  const revision = useRevision(kind === "customer" ? ["customers", "sales"] : ["suppliers", "purchases"]), [archiving, setArchiving] = useState(false);
  const { value: item, failed } = useRecord(() => read(kind, context, id), [context, kind, id, revision]);
  if (item === undefined) return <Screen title={t(kind)} onBack={nav.back}>{failed ? <Notice tone="error" text={t("loadFailed")} /> : <EmptyState title={t("notFound")} />}</Screen>;
  const canManage = permissions.includes(kind === "customer" ? "customers.manage" : "suppliers.manage"), canSettle = permissions.includes(kind === "customer" ? "customers.pay" : "purchases.pay");
  const limit = kind === "customer" ? (item as { creditLimitMinor?: number }).creditLimitMinor : undefined;
  const toggle = (): void => action.run(() => {
    const stored = read(kind, context, id); requireVersion(stored, item.updatedAt);
    const next = { ...stored!, active: !stored!.active, updatedAt: nextVersion(stored!.updatedAt) };
    if (!(kind === "customer" ? saveCustomer(context, next) : saveSupplier(context, next))) throw new FormProblem("newerEdit");
  });
  return <Screen title={item.name} eyebrow={t(kind)} onBack={nav.back}>
    {!item.active && <Notice tone="warning" text={t("archivedPersonHelp")} />}
    <Section><Facts items={[[kind === "customer" ? t("customerOwes") : t("shopOwes"), formatMoney(item.outstandingMinor), item.outstandingMinor > 0 ? "danger" : "strong"],
      [t("phone"), item.phone], [t("limit"), limit === undefined ? undefined : formatMoney(limit)], [t("updated"), formatDate(item.updatedAt, language, false)]]} />
      {item.outstandingMinor < 0 && <Notice tone="info" text={t("inAdvance", { amount: formatMoney(-item.outstandingMinor) })} />}</Section>
    {canSettle && item.active && <Button label={t(kind === "customer" ? "receive" : "paySupplier")} onPress={() => nav.push("settle", { kind, id })} />}
    <RowGroup><ListRow title={t("statement")} onPress={() => nav.push("statement", { kind, id })} /></RowGroup>
    {action.notice}
    {canManage && item.active && <Button label={t("edit")} variant="secondary" onPress={() => nav.push("personForm", { kind, id })} />}
    {canManage && <Button label={t(item.active ? "archive" : "restore")} variant={item.active ? "danger" : "secondary"} onPress={() => item.active ? setArchiving(true) : toggle()} />}
    <Confirm visible={archiving} destructive title={t("archivePersonTitle", { name: item.name })} text={t("archivePersonText")} confirmLabel={t("archive")} onCancel={() => setArchiving(false)}
      onConfirm={() => { setArchiving(false); toggle(); }} />
  </Screen>;
}

/** Create or edit a customer (with optional credit limit) or supplier from the displayed version. */
export function PersonFormScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { kind, id } = useParams("personForm"), { context } = useSession(), action = useAction(), request = useRequestId();
  const loaded = useMemo(() => { try { return id === undefined ? undefined : read(kind, context, id); } catch { return undefined; } }, [context, kind, id]);
  const [name, setName] = useState(loaded?.name ?? ""), [phone, setPhone] = useState(loaded?.phone ?? "");
  const initialLimit = kind === "customer" ? (loaded as { creditLimitMinor?: number } | undefined)?.creditLimitMinor : undefined;
  const [limit, setLimit] = useState(initialLimit === undefined ? "" : String(initialLimit));
  useLeaveGuard(name !== (loaded?.name ?? "") || phone !== (loaded?.phone ?? ""));
  const save = (): void => action.run(() => {
    if (name.trim() === "") throw new FormProblem("nameRequired");
    const now = new Date().toISOString(), details = { name: name.trim(), phone: phone.trim() || undefined, ...(kind === "customer" ? { creditLimitMinor: limit.trim() === "" ? undefined : moneyEntry(limit) } : {}) };
    if (loaded === undefined) {
      if (read(kind, context, request.current) === undefined) {
        const record = { id: request.current, ...details, active: true, createdAt: now, updatedAt: now };
        if (kind === "customer") saveCustomer(context, record); else saveSupplier(context, record);
      }
      return request.current;
    }
    const stored = read(kind, context, loaded.id); requireVersion(stored, loaded.updatedAt);
    const next = { ...stored!, ...details, updatedAt: nextVersion(stored!.updatedAt) };
    if (!(kind === "customer" ? saveCustomer(context, next) : saveSupplier(context, next))) throw new FormProblem("newerEdit");
    return loaded.id;
  }, saved => { request.renew(); if (loaded === undefined) nav.replace("person", { kind, id: saved }); else nav.leave(); });
  return <Screen title={loaded === undefined ? t(kind === "customer" ? "newCustomer" : "newSupplier") : t("edit")} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={save} /></>}>
    <Section><Field label={t("name")} value={name} onChange={setName} autoFocus /><Field label={t("phone")} value={phone} onChange={setPhone} kind="phone" />
      {kind === "customer" && <Field label={t("limit")} value={limit} onChange={setLimit} kind="money" />}</Section>
  </Screen>;
}

/** Collect from a customer or pay a supplier from one account; the request ID is the ledger entry ID. */
export function SettleScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { kind, id } = useParams("settle"), { context, branchId } = useSession(), action = useAction(), request = useRequestId();
  const revision = useRevision(["accounts", kind === "customer" ? "customers" : "suppliers"]), [account, setAccount] = useState<Account>(), [amount, setAmount] = useState("");
  const item = useRecord(() => read(kind, context, id), [context, kind, id, revision]).value;
  useLeaveGuard(amount !== "");
  const save = (): void => action.run(() => {
    if (account === undefined) throw new FormProblem("chooseAccount");
    const value = amount.trim() === "" && item !== undefined && item.outstandingMinor > 0 ? item.outstandingMinor : moneyEntry(amount);
    if (value <= 0) throw new FormProblem("amountRequired");
    const base = { id: request.current, branchId, accountId: account.id, amountMinor: value, occurredAt: new Date().toISOString(), eventId: newIdOnDevice() };
    if (kind === "customer") receiveCustomerPayment(context, { ...base, customerId: id }); else paySupplier(context, { ...base, supplierId: id });
  }, () => { request.renew(); nav.leave(); });
  return <Screen title={t(kind === "customer" ? "receive" : "paySupplier")} eyebrow={item?.name} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={save} /></>}>
    {item !== undefined && <Section><Facts items={[[kind === "customer" ? t("customerOwes") : t("shopOwes"), formatMoney(item.outstandingMinor), "strong"]]} /></Section>}
    <Section>
      <Picker<Account> label={t("account")} value={account} onChange={setAccount} load={page => paymentAccounts(context, page)} revision={revision} />
      <Field label={t("amount")} value={amount} onChange={setAmount} kind="money" hint={item !== undefined && item.outstandingMinor > 0 ? t("amountDefaultsRemaining", { amount: formatMoney(item.outstandingMinor) }) : t("overpaymentHelp")} />
    </Section>
  </Screen>;
}

/** Newest-first signed statement: sales/purchases on credit positive, payments negative. */
export function StatementScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), { kind, id } = useParams("statement"), { context } = useSession(), revision = useRevision([kind === "customer" ? "customers" : "suppliers"]);
  const item = useRecord(() => read(kind, context, id), [context, kind, id, revision]).value;
  return <Screen title={t("statement")} eyebrow={item?.name} onBack={nav.back} scroll={false}>
    <PagedList<Row> searchable={false} revision={revision} identify={row => String(row["id"])} load={page => statement(context, kind, id, page)} empty={{ title: t("noEntries") }}
      render={row => { const amount = Number(row["amount_minor"]);
        return <ListRow title={t(ENTRY_KEYS[String(row["type"])] ?? "statement")} subtitle={`${formatDate(String(row["occurred_at"]), language)} · ${t("balanceAfter")} ${formatMoney(Number(row["balance_minor"]))}`} trailing={`${amount > 0 ? "+" : ""}${formatMoney(amount)}`} trailingTone={amount > 0 ? "danger" : "normal"} />; }} />
  </Screen>;
}
