import { useState } from "react";
import { Text, View } from "react-native";
import { accounts, paymentAccounts } from "@kolo/core/application/queries";
import { saveAccount, moveCash, reconcileCash, adjustCashToCount } from "@kolo/core/application/operations";
import type { Account, AccountKind } from "@kolo/core/data/finance/accounts";
import type { Reconciliation } from "@kolo/core/data/finance/cash";
import { moneyEntry } from "@kolo/core/domain/entry";
import { formatMoney } from "@kolo/core/domain/money";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { Browse, Picker } from "./browse.tsx";
import { Button, Choices, Field, Toggle, styles, useCommand, useRevision } from "./ui.tsx";
import type { ShopProps } from "./types.ts";

const kinds: readonly AccountKind[] = ["CASH", "MOBILE_MONEY", "BANK", "CARD", "OTHER"];
/** Financial accounts, atomic two-leg transfers and explicit count/reconciliation workflow. */
export function AccountsScreen({ database, context, permissions, branchId }: ShopProps): React.JSX.Element {
  const { t } = useText(), revision = useRevision(database, ["accounts", "authority"]), command = useCommand();
  const [selected, setSelected] = useState<Account>(), [editing, setEditing] = useState(false), [archived, setArchived] = useState(false);
  const [name, setName] = useState(""), [kind, setKind] = useState<AccountKind>("CASH"), [amount, setAmount] = useState(""), [reason, setReason] = useState(""), [destination, setDestination] = useState<Account>();
  const [counted, setCounted] = useState(""), [comparison, setComparison] = useState<{ result: Reconciliation; revision: string }>();
  const edit = (item?: Account): void => { setSelected(item); setName(item?.name ?? ""); setKind(item?.kind ?? "CASH"); setEditing(true); };
  const manage = permissions.includes("finance.accounts.manage");
  const form = editing ? <View style={{ gap: 12 }}><Field label={t("name")} value={name} onChange={setName} />
    <Choices label={t("kind")} value={kind} items={kinds.map(id => ({ id, name: t(id) }))} onChange={value => setKind(value as AccountKind)} />
    <Button label={t("save")} onPress={() => command.run(() => { const now = new Date().toISOString(); return saveAccount(context, { ...selected, id: selected?.id ?? newIdOnDevice(), branchId: selected?.branchId ?? branchId, name: name.trim(), kind, currency: "XAF", active: selected?.active ?? true, createdAt: selected?.createdAt ?? now, updatedAt: now }); }, () => { setEditing(false); setSelected(undefined); })} />
    <Button label={t("cancel")} onPress={() => setEditing(false)} /></View> : null;
  return <Browse<Account & { onHandMinor: number }> key={archived ? "all" : "active"} revision={revision} identify={item => item.id} load={query => accounts(context, { ...query, includeInactive: archived })}
    header={<View style={{ gap: 12 }}>{manage && <Button label={t("newAccount")} onPress={() => edit()} />}<Toggle label={t("showArchived")} value={archived} onChange={setArchived} />{form}
      {selected !== undefined && !editing && <View style={styles.card}><Button label={t("back")} onPress={() => { setSelected(undefined); setAmount(""); setCounted(""); setReason(""); setComparison(undefined); }} /><Text style={styles.title}>{selected.name}</Text>
        {manage && <><Button label={t("edit")} onPress={() => edit(selected)} /><Button label={t(selected.active ? "archive" : "restore")} onPress={() => command.run(() => saveAccount(context, { ...selected, active: !selected.active, updatedAt: new Date().toISOString() }), () => setSelected(undefined))} /></>}
        {selected.active && permissions.includes("cash.move") && <><Field label={t("amount")} value={amount} onChange={setAmount} numeric /><Field label={t("reason")} value={reason} onChange={setReason} />
          {(["CASH_IN", "CASH_OUT"] as const).map(type => <Button key={type} label={t(type === "CASH_IN" ? "cashIn" : "cashOut")} onPress={() => command.run(() => { const value = moneyEntry(amount); moveCash(context, { eventId: newIdOnDevice(), movements: [{ id: newIdOnDevice(), accountId: selected.id, branchId, type, amountMinor: type === "CASH_OUT" ? -value : value, reason: reason.trim(), occurredAt: new Date().toISOString() }] }); }, () => setAmount(""))} />)}
          <Picker label={t("destination")} value={destination} onChange={setDestination} load={query => paymentAccounts(context, query)} revision={revision} />
          <Button label={t("transferCash")} disabled={destination === undefined || destination.id === selected.id} onPress={() => command.run(() => { const value = moneyEntry(amount), at = new Date().toISOString(); moveCash(context, { eventId: newIdOnDevice(), movements: [
            { id: newIdOnDevice(), accountId: selected.id, counterpartId: destination!.id, branchId, type: "TRANSFER_OUT", amountMinor: -value, reason: reason.trim(), occurredAt: at },
            { id: newIdOnDevice(), accountId: destination!.id, counterpartId: selected.id, branchId, type: "TRANSFER_IN", amountMinor: value, reason: reason.trim(), occurredAt: at },
          ] }); }, () => setAmount(""))} /></>}
        {selected.active && permissions.includes("cash.count") && <><Field label={t("counted")} value={counted} onChange={value => { setCounted(value); setComparison(undefined); }} numeric />
          <Text style={styles.text}>{t("correctionHint")}</Text><Button label={t("countCash")} onPress={() => command.run(() => { setComparison({ result: reconcileCash(context, selected.id, moneyEntry(counted)), revision }); })} />
          {comparison !== undefined && comparison.revision === revision && <><Text style={styles.text}>{t("expected")}: {formatMoney(comparison.result.expectedMinor)} · {t("difference")}: {formatMoney(comparison.result.differenceMinor)}</Text>
            {permissions.includes("cash.reconcile") && permissions.includes("cash.move") && <><Field label={t("reason")} value={reason} onChange={setReason} /><Button label={t("correctCash")} onPress={() => command.run(() => { adjustCashToCount(context, { accountId: selected.id, countedMinor: moneyEntry(counted), reason, branchId }); }, () => setComparison(undefined))} /></>}
          </>}
        </>}
      </View>}{command.message}</View>}
    render={item => <><Text style={styles.title}>{item.name}{!item.active ? ` · ${t("archived")}` : ""}</Text><Text style={styles.text}>{formatMoney(item.onHandMinor)}</Text><Button label={t("edit")} onPress={() => { setSelected(item); setComparison(undefined); }} /></>} />;
}
