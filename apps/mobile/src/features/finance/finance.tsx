import { useMemo, useState } from "react";
import { accounts, paymentAccounts } from "@kolo/core/application/queries";
import { account as accountRead } from "@kolo/core/application/records";
import { adjustCashToCount, moveCash, reconcileCash, saveAccount } from "@kolo/core/application/operations";
import type { Account, AccountKind } from "@kolo/core/data/finance/accounts";
import type { Reconciliation } from "@kolo/core/data/finance/cash";
import { moneyEntry } from "@kolo/core/domain/entry";
import { formatMoney } from "@kolo/core/domain/money";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText } from "../../app/i18n.tsx";
import { useLeaveGuard, useNav, useParams } from "../../app/navigation.tsx";
import { usePermissions, useRevision, useSession } from "../../app/session.tsx";
import { FormProblem, useAction } from "../../components/command.tsx";
import { Button, Confirm, EmptyState, Facts, Field, ListRow, Notice, PagedList, Picker, Screen, Section, Segmented, Toggle } from "../../components/ui.tsx";
import { nextVersion, requireVersion, useRecord, useRequestId } from "../shared.tsx";

const KINDS: readonly AccountKind[] = ["CASH", "MOBILE_MONEY", "BANK", "CARD", "OTHER"];

/** Accounts with derived balances; creation on the list. */
export function AccountsScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context } = useSession(), permissions = usePermissions(), revision = useRevision(["accounts"]), [archived, setArchived] = useState(false);
  return <Screen title={t("accounts")} onBack={nav.back} scroll={false} actions={permissions.includes("finance.accounts.manage") ? <Button label={t("new")} variant="ghost" onPress={() => nav.push("accountForm", {})} /> : undefined}>
    <PagedList<Account & { onHandMinor: number }> revision={revision} identify={item => item.id} deps={[archived]} load={page => accounts(context, { ...page, includeInactive: archived })}
      header={<Toggle label={t("showArchived")} value={archived} onChange={setArchived} hint={t("hint.showArchived")} />} empty={{ title: t("noAccounts") }}
      render={item => <ListRow title={item.name} subtitle={t(item.kind)} tag={item.active ? undefined : t("archived")} trailing={formatMoney(item.onHandMinor)} trailingTone={item.onHandMinor < 0 ? "danger" : "normal"}
        onPress={() => nav.push("account", { accountId: item.id })} />} />
  </Screen>;
}

/** One account: balance and the separate money in/out, transfer and count tasks. */
export function AccountScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { accountId } = useParams("account"), { context } = useSession(), permissions = usePermissions(), action = useAction();
  const revision = useRevision(["accounts"]), [archiving, setArchiving] = useState(false);
  const { value: item, failed } = useRecord(() => accountRead(context, accountId), [context, accountId, revision]);
  if (item === undefined) return <Screen title={t("account")} onBack={nav.back}>{failed ? <Notice tone="error" text={t("loadFailed")} /> : <EmptyState title={t("notFound")} />}</Screen>;
  const toggle = (): void => action.run(() => {
    const stored = accountRead(context, accountId); requireVersion(stored, item.updatedAt);
    const { onHandMinor: _, ...rest } = stored!;
    if (!saveAccount(context, { ...rest, active: !rest.active, updatedAt: nextVersion(rest.updatedAt) })) throw new FormProblem("newerEdit");
  });
  const move = permissions.includes("cash.move") && item.active;
  return <Screen title={item.name} eyebrow={t(item.kind)} onBack={nav.back}>
    {!item.active && <Notice tone="warning" text={t("archivedAccountHelp")} />}
    {item.onHandMinor !== undefined && <Section><Facts items={[[t("balance"), formatMoney(item.onHandMinor), item.onHandMinor < 0 ? "danger" : "strong"]]} /></Section>}
    {move && <Section title={t("moneyTasks")}>
      <Button label={t("cashIn")} variant="secondary" onPress={() => nav.push("money", { accountId, mode: "in" })} />
      <Button label={t("cashOut")} variant="secondary" onPress={() => nav.push("money", { accountId, mode: "out" })} />
      <Button label={t("transferCash")} variant="secondary" onPress={() => nav.push("money", { accountId, mode: "transfer" })} />
    </Section>}
    {item.active && permissions.includes("cash.count") && <Button label={t("countCash")} variant="secondary" onPress={() => nav.push("cashCount", { accountId })} />}
    {action.notice}
    {permissions.includes("finance.accounts.manage") && item.active && <Button label={t("edit")} variant="secondary" onPress={() => nav.push("accountForm", { accountId })} />}
    {permissions.includes("finance.accounts.manage") && <Button label={t(item.active ? "archive" : "restore")} variant={item.active ? "danger" : "secondary"} onPress={() => item.active ? setArchiving(true) : toggle()} />}
    <Confirm visible={archiving} destructive title={t("archiveAccountTitle", { name: item.name })} text={t("archiveAccountText")} confirmLabel={t("archive")} onCancel={() => setArchiving(false)}
      onConfirm={() => { setArchiving(false); toggle(); }} />
  </Screen>;
}

/** Create, rename or re-kind an account from the displayed version. */
export function AccountFormScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { accountId } = useParams("accountForm"), { context, branchId } = useSession(), action = useAction(), request = useRequestId();
  const loaded = useMemo(() => { try { return accountId === undefined ? undefined : accountRead(context, accountId); } catch { return undefined; } }, [context, accountId]);
  const [name, setName] = useState(loaded?.name ?? ""), [kind, setKind] = useState<AccountKind>(loaded?.kind ?? "CASH");
  useLeaveGuard(name !== (loaded?.name ?? ""));
  const save = (): void => action.run(() => {
    if (name.trim() === "") throw new FormProblem("nameRequired");
    const now = new Date().toISOString();
    if (loaded === undefined) {
      if (accountRead(context, request.current) === undefined) saveAccount(context, { id: request.current, branchId, name: name.trim(), kind, currency: "XAF", active: true, createdAt: now, updatedAt: now });
      return request.current;
    }
    const stored = accountRead(context, loaded.id); requireVersion(stored, loaded.updatedAt);
    const { onHandMinor: _, ...rest } = stored!;
    if (!saveAccount(context, { ...rest, name: name.trim(), kind, updatedAt: nextVersion(rest.updatedAt) })) throw new FormProblem("newerEdit");
    return loaded.id;
  }, id => { request.renew(); if (loaded === undefined) nav.replace("account", { accountId: id }); else nav.leave(); });
  return <Screen title={loaded === undefined ? t("newAccount") : t("edit")} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={save} /></>}>
    <Section><Field label={t("name")} value={name} onChange={setName} autoFocus hint={t("hint.accountName")} />
      <Segmented label={t("kind")} hint={t("hint.accountKind")} value={kind} onChange={setKind} options={KINDS.map(id => ({ id, label: t(id) }))} /></Section>
  </Screen>;
}

/** Money in, money out or a two-leg transfer, with a reason; the request ID names the (outgoing) movement. */
export function MoneyScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { accountId, mode } = useParams("money"), { context, branchId } = useSession(), action = useAction(), request = useRequestId();
  const revision = useRevision(["accounts"]), [amount, setAmount] = useState(""), [reason, setReason] = useState(""), [destination, setDestination] = useState<Account>();
  const item = useRecord(() => accountRead(context, accountId), [context, accountId, revision]).value;
  useLeaveGuard(amount !== "" || reason !== "");
  const save = (): void => action.run(() => {
    if (reason.trim() === "") throw new FormProblem("reasonRequired");
    const value = moneyEntry(amount), at = new Date().toISOString();
    if (value <= 0) throw new FormProblem("amountRequired");
    if (mode === "transfer") {
      if (destination === undefined || destination.id === accountId) throw new FormProblem("chooseOtherAccount");
      moveCash(context, { eventId: newIdOnDevice(), movements: [
        { id: request.current, accountId, counterpartId: destination.id, branchId, type: "TRANSFER_OUT", amountMinor: -value, reason: reason.trim(), occurredAt: at },
        { id: newIdOnDevice(), accountId: destination.id, counterpartId: accountId, branchId, type: "TRANSFER_IN", amountMinor: value, reason: reason.trim(), occurredAt: at }] });
    } else moveCash(context, { eventId: newIdOnDevice(), movements: [{ id: request.current, accountId, branchId, type: mode === "in" ? "CASH_IN" : "CASH_OUT", amountMinor: mode === "in" ? value : -value, reason: reason.trim(), occurredAt: at }] });
  }, () => { request.renew(); nav.leave(); });
  return <Screen title={t(mode === "in" ? "cashIn" : mode === "out" ? "cashOut" : "transferCash")} eyebrow={item?.name} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={save} /></>}>
    <Section>
      {mode === "transfer" && <Picker<Account> label={t("destination")} value={destination} onChange={setDestination} load={page => paymentAccounts(context, page)} revision={revision} hint={t("hint.transferDestination")} />}
      <Field label={t("amount")} value={amount} onChange={setAmount} kind="money" autoFocus={mode !== "transfer"} hint={t("hint.movementAmount")} />
      <Field label={t("reason")} value={reason} onChange={setReason} hint={t("hint.movementReason")} />
    </Section>
  </Screen>;
}

/**
 * Cash count: comparing records the comparison (audit only, no money moves); correcting is a separate
 * explicit action with a reason that books the difference.
 */
export function CashCountScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { accountId } = useParams("cashCount"), { context, branchId } = useSession(), permissions = usePermissions(), action = useAction();
  const revision = useRevision(["accounts"]), request = useRequestId(), [counted, setCounted] = useState(""), [reason, setReason] = useState(""), [confirming, setConfirming] = useState(false);
  const [comparison, setComparison] = useState<{ result: Reconciliation; revision: string; counted: number }>();
  const item = useRecord(() => accountRead(context, accountId), [context, accountId, revision]).value;
  useLeaveGuard(counted !== "" && comparison === undefined);
  const current = comparison?.revision === revision ? comparison : undefined;
  const compare = (): void => action.run(() => { const value = moneyEntry(counted); return { result: reconcileCash(context, accountId, value), revision, counted: value }; }, setComparison, "countCompared");
  const correct = (): void => action.run(() => {
    if (current === undefined) throw new FormProblem("compareFirst");
    if (reason.trim() === "") throw new FormProblem("reasonRequired");
    adjustCashToCount(context, { accountId, countedMinor: current.counted, reason: reason.trim(), branchId, requestId: request.current });
  }, () => { request.renew(); setComparison(undefined); setReason(""); }, "cashCorrected");
  return <Screen title={t("countCash")} eyebrow={item?.name} onBack={nav.back} footer={<>{action.notice}<Button label={t("compare")} onPress={compare} /></>}>
    <Section><Field label={t("counted")} value={counted} onChange={value => { setCounted(value); setComparison(undefined); }} kind="money" autoFocus hint={t("correctionHint")} /></Section>
    {current !== undefined && <Section title={t("comparison")}>
      <Facts items={[[t("expected"), formatMoney(current.result.expectedMinor)], [t("counted"), formatMoney(current.counted)],
        [t("difference"), formatMoney(current.result.differenceMinor), current.result.differenceMinor === 0 ? "strong" : "danger"]]} />
      {current.result.differenceMinor !== 0 && permissions.includes("cash.reconcile") && permissions.includes("cash.move") && <>
        <Field label={t("reason")} value={reason} onChange={setReason} hint={t("hint.correctionReason")} />
        <Button label={t("correctCash")} variant="danger" disabled={reason.trim() === ""} onPress={() => setConfirming(true)} /></>}
    </Section>}
    <Confirm visible={confirming} destructive title={t("correctCash")} text={t("correctCashText", { amount: formatMoney(current?.result.differenceMinor ?? 0) })} confirmLabel={t("correctCash")}
      onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); correct(); }} />
  </Screen>;
}
