import type { Row } from "@kolo/core/data/database/driver";
import { useState } from "react";
import { Text, View } from "react-native";
import { customers, suppliers, statement, paymentAccounts, personBalance } from "@kolo/core/application/queries";
import { saveCustomer, saveSupplier, receiveCustomerPayment, paySupplier } from "@kolo/core/application/operations";
import type { Customer } from "@kolo/core/data/customers/customers";
import type { Supplier } from "@kolo/core/data/suppliers/suppliers";
import type { Account } from "@kolo/core/data/finance/accounts";
import { moneyEntry } from "@kolo/core/domain/entry";
import { formatMoney } from "@kolo/core/domain/money";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { Browse, Picker } from "./browse.tsx";
import { Button, Field, Toggle, styles, useCommand, useRevision } from "./ui.tsx";
import type { ShopProps } from "./types.ts";

type Person = (Customer | Supplier) & { outstandingMinor: number };
/** Separate receivable/payable screens share UI, while all balances and commands keep their domain. */
export function PeopleScreen({ kind, database, context, permissions, branchId }: ShopProps & { readonly kind: "customer" | "supplier" }): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database, ["customers", "suppliers", "accounts", "authority"]), command = useCommand();
  const customer = kind === "customer", canManage = permissions.includes(customer ? "customers.manage" : "suppliers.manage"), canPay = permissions.includes(customer ? "customers.pay" : "purchases.pay");
  const [selected, setSelected] = useState<Person>(), [editing, setEditing] = useState(false), [archived, setArchived] = useState(false);
  const [name, setName] = useState(""), [phone, setPhone] = useState(""), [limit, setLimit] = useState(""), [amount, setAmount] = useState(""), [account, setAccount] = useState<Account>();
  const edit = (item?: Person): void => { setSelected(item); setName(item?.name ?? ""); setPhone(item?.phone ?? ""); setLimit(String((item as Customer | undefined)?.creditLimitMinor ?? "")); setEditing(true); };
  const form = editing ? <View style={{ gap: 12 }}><Field label={t("name")} value={name} onChange={setName} /><Field label={t("phone")} value={phone} onChange={setPhone} />
    {customer && <Field label={t("limit")} value={limit} onChange={setLimit} numeric />}
    <Button label={t("save")} onPress={() => command.run(() => { const at = new Date().toISOString(), base = { ...selected, id: selected?.id ?? newIdOnDevice(), name: name.trim(), phone: phone.trim() || undefined, active: selected?.active ?? true, createdAt: selected?.createdAt ?? at, updatedAt: at };
      if (customer) return saveCustomer(context, { ...base, creditLimitMinor: limit.trim() === "" ? undefined : moneyEntry(limit) }); else return saveSupplier(context, base);
    }, () => { setSelected(undefined); setEditing(false); })} /><Button label={t("cancel")} onPress={() => setEditing(false)} /></View> : null;
  let balance: number | undefined;
  try { if (selected !== undefined) balance = personBalance(context, kind, selected.id); } catch { /* Read failure is visible in the ledger. */ }
  if (selected !== undefined && !editing) return <Browse<Row> searchable={false} revision={revision} identify={row => String(row["id"])} load={query => statement(context, kind, selected.id, query)}
    render={row => <Text style={styles.text}>{String(row["occurred_at"])} · {String(row["type"])} · {formatMoney(Number(row["amount_minor"]))}{row["reference_id"] ? ` · ${String(row["reference_id"])}` : ""}</Text>}
    header={<View style={{ gap: 12 }}><Button label={t("back")} onPress={() => { setSelected(undefined); setAmount(""); setAccount(undefined); }} /><Text style={styles.title}>{selected.name}</Text>{balance !== undefined && <Text style={styles.text}>{t("due")}: {formatMoney(balance)}</Text>}
      {canManage && <><Button label={t("edit")} onPress={() => edit(selected)} /><Button label={t(selected.active ? "archive" : "restore")} onPress={() => command.run(() => {
        const base = { ...selected, active: !selected.active, updatedAt: new Date().toISOString() }; if (customer) return saveCustomer(context, base); else return saveSupplier(context, base);
      }, () => setSelected(undefined))} /></>}
      {canPay && selected.active && <><Field label={t("amount")} value={amount} onChange={setAmount} numeric />
        <Picker label={t("account")} value={account} onChange={setAccount} load={query => paymentAccounts(context, query)} revision={revision} />
        <Button label={t(customer ? "receive" : "paySupplier")} disabled={account === undefined} onPress={() => command.run(() => {
          const base = { id: newIdOnDevice(), branchId, accountId: account!.id, amountMinor: moneyEntry(amount), occurredAt: new Date().toISOString(), eventId: newIdOnDevice() };
          if (customer) receiveCustomerPayment(context, { ...base, customerId: selected.id }); else paySupplier(context, { ...base, supplierId: selected.id });
        }, () => { setAmount(""); })} /></>}{command.message}<Text style={styles.title}>{t("statement")}</Text></View>} />;
  return <Browse<Person> key={archived ? "all" : "active"} revision={revision} identify={item => item.id} load={query => customer ? customers(context, { ...query, includeInactive: archived }) : suppliers(context, { ...query, includeInactive: archived })}
    header={<View style={{ gap: 12 }}>{canManage && <Button label={t(customer ? "newCustomer" : "newSupplier")} onPress={() => edit()} />}<Toggle label={t("showArchived")} value={archived} onChange={setArchived} />{form}{command.message}</View>}
    render={item => <><Text style={styles.title}>{item.name}{!item.active ? ` · ${t("archived")}` : ""}</Text><Text style={styles.text}>{item.phone} · {t("due")}: {formatMoney(item.outstandingMinor)}</Text><Button label={t("statement")} onPress={() => setSelected(item)} /></>} />;
}
