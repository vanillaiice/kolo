import { useState } from "react";
import { Text, View } from "react-native";
import { expenses, paymentAccounts } from "@kolo/core/application/queries";
import { recordExpense } from "@kolo/core/application/operations";
import type { Row } from "@kolo/core/data/database/driver";
import type { Account } from "@kolo/core/data/finance/accounts";
import type { Category } from "@kolo/core/data/expenses/expenses";
import { moneyEntry } from "@kolo/core/domain/entry";
import { formatMoney } from "@kolo/core/domain/money";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { Browse, Picker } from "./browse.tsx";
import { Button, Choices, Field, styles, useCommand, useRevision } from "./ui.tsx";
import type { ShopProps } from "./types.ts";
const categories: readonly Category[] = ["RENT", "ELECTRICITY", "WATER", "TRANSPORT", "SALARY", "PACKAGING", "MAINTENANCE", "INTERNET", "MARKETING", "OTHER"];
/** Spending and compensating expense reversals preserve immutable financial history. */
export function ExpensesScreen({ database, context, permissions, branchId }: ShopProps): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database, ["expenses", "accounts", "authority"]), command = useCommand();
  const [editing, setEditing] = useState(false), [category, setCategory] = useState<Category>("OTHER"), [account, setAccount] = useState<Account>();
  const [amount, setAmount] = useState(""), [description, setDescription] = useState(""), [reference, setReference] = useState("");
  const canWrite = permissions.includes("expenses.create");
  return <Browse<Row> searchable={false} revision={revision} identify={row => String(row["id"])} load={query => expenses(context, query)}
    header={<View style={{ gap: 12 }}>{canWrite && <Button label={t("newExpense")} onPress={() => setEditing(!editing)} />}{editing && <>
      <Choices label={t("category")} value={category} items={categories.map(id => ({ id, name: t(id) }))} onChange={value => setCategory(value as Category)} />
      <Picker label={t("account")} value={account} onChange={setAccount} load={query => paymentAccounts(context, query)} revision={revision} />
      <Field label={t("amount")} value={amount} onChange={setAmount} numeric /><Field label={t("description")} value={description} onChange={setDescription} /><Field label={t("reference")} value={reference} onChange={setReference} />
      <Button label={t("save")} disabled={account === undefined} onPress={() => command.run(() => recordExpense(context, { id: newIdOnDevice(), branchId, accountId: account!.id, category, amountMinor: moneyEntry(amount), description: description.trim() || undefined, reference: reference.trim() || undefined, occurredAt: new Date().toISOString(), eventId: newIdOnDevice() }), () => { setAmount(""); setDescription(""); setReference(""); setEditing(false); })} />
    </>}{command.message}</View>}
    render={row => <><Text style={styles.title}>{t(row["category"] as Category)} · {formatMoney(Number(row["amount_minor"]))}</Text><Text style={styles.text}>{String(row["occurred_at"])} · {String(row["description"] ?? "")}</Text>
      {row["reversed"] === 1 && <Text style={styles.text}>{t("reversed")}</Text>}
      {canWrite && Number(row["amount_minor"]) > 0 && row["reversed"] === 0 && <Button label={t("reverseExpense")} onPress={() => command.run(() => recordExpense(context, { id: newIdOnDevice(), branchId: typeof row["branch_id"] === "string" ? row["branch_id"] : undefined, accountId: String(row["account_id"]), category: row["category"] as Category, amountMinor: -Number(row["amount_minor"]), reversesId: String(row["id"]), description: typeof row["description"] === "string" ? row["description"] : undefined, occurredAt: new Date().toISOString(), eventId: newIdOnDevice() }))} />}
    </>} />;
}
