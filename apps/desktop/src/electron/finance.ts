import { accounts, expenses, capabilities, type Page } from "@kolo/core/application/queries";
import { saveAccount, moveCash, reconcileCash, adjustCashToCount, recordExpense as writeExpense } from "@kolo/core/application/operations";
import { accountOf, type Account } from "@kolo/core/data/finance/accounts";
import { balanceOfAccount } from "@kolo/core/data/finance/cash";
import type { Queryable, Row } from "@kolo/core/data/database/driver";
import { unlockedActor } from "@kolo/core/identity/workspace";
import { WorkspaceError, type OperationContext } from "@kolo/core/identity/types";
import type { AccountKind, AccountView, CashCountView, ExpenseCategory, ExpenseView } from "../shared/service.js";
import { object, text, uuid, whole, boolean, page, optional } from "./validation.ts";
import { CommandError, nextVersion, type Host } from "./host.ts";

const kinds: readonly AccountKind[] = ["CASH", "MOBILE_MONEY", "BANK", "CARD", "OTHER"];
const categories: readonly ExpenseCategory[] = ["RENT", "ELECTRICITY", "WATER", "TRANSPORT", "SALARY", "PACKAGING", "MAINTENANCE", "INTERNET", "MARKETING", "OTHER"];
function kind(value: unknown): AccountKind { if (!kinds.includes(value as AccountKind)) throw new WorkspaceError("invalid_input"); return value as AccountKind; }
function category(value: unknown): ExpenseCategory { if (!categories.includes(value as ExpenseCategory)) throw new WorkspaceError("invalid_input"); return value as ExpenseCategory; }
function view(account: Account, onHandMinor?: number): AccountView {
  return { id: account.id, name: account.name, kind: account.kind, active: account.active, version: account.updatedAt, ...(onHandMinor === undefined ? {} : { onHandMinor }) };
}
function stored(tx: Queryable, context: OperationContext, id: string): AccountView {
  const account = accountOf(tx, context.businessId, id);
  if (account === undefined) throw new WorkspaceError("scope_mismatch");
  return view(account, balanceOfAccount(tx, context.businessId, id).onHandMinor);
}
/** Movements return the balance only to actors who may see it; others get the account without it. */
function after(tx: Queryable, context: OperationContext, id: string): AccountView {
  const permissions = capabilities(context);
  return permissions.includes("finance.accounts.view") && permissions.includes("cash.view") ? stored(tx, context, id) : view(accountOf(tx, context.businessId, id)!);
}

/** Accounts with derived balances under finance.accounts.view and cash.view. */
export function listAccounts(host: Host, input: unknown): Page<AccountView> {
  const data = object(input, ["sessionId", "term", "after", "limit", "includeInactive"]), context = host.actor(data);
  const result = accounts(context, page(data)); return { ...result, items: result.items.map(item => view(item, item.onHandMinor)) };
}
/** Creates an account named by its request ID; only this actor's identical creation counts as a retry. */
export function createAccount(host: Host, input: unknown): AccountView {
  const data = object(input, ["sessionId", "requestId", "name", "kind"]), context = host.actor(data, ["finance.accounts.manage", "finance.accounts.view", "cash.view"]);
  const id = uuid(data["requestId"]), name = text(data["name"]), accountKind = kind(data["kind"]), at = host.ports.now();
  return host.ports.database.transaction(tx => {
    if (tx.get(`SELECT 1 FROM financial_accounts WHERE id=?`, [id]) !== undefined) {
      const original = accountOf(tx, context.businessId, id);
      const actor = tx.get(`SELECT user_id FROM local_audit WHERE business_id=? AND device_id=? AND action='ACCOUNT_SAVED' AND entity_id=? ORDER BY occurred_at LIMIT 1`, [context.businessId, context.deviceId, id]);
      if (original === undefined || actor?.["user_id"] !== context.userId || original.createdAt !== original.updatedAt || original.name !== name || original.kind !== accountKind) throw new CommandError("request_conflict");
      return stored(tx, context, id);
    }
    saveAccount(context, { id, name, kind: accountKind, currency: "XAF", active: true, createdAt: at, updatedAt: at, branchId: unlockedActor(context).branchId });
    return stored(tx, context, id);
  });
}
/** Renames, re-kinds, archives or restores an account from the displayed version. */
export function updateAccount(host: Host, input: unknown): AccountView {
  const data = object(input, ["sessionId", "accountId", "version", "name", "kind", "active"]), context = host.actor(data, ["finance.accounts.manage", "finance.accounts.view", "cash.view"]);
  const id = uuid(data["accountId"]), version = text(data["version"], 64), name = text(data["name"]), accountKind = kind(data["kind"]), active = boolean(data["active"]);
  return host.ports.database.transaction(tx => {
    const current = accountOf(tx, context.businessId, id);
    if (current === undefined) throw new WorkspaceError("scope_mismatch");
    if (current.name === name && current.kind === accountKind && current.active === active) return stored(tx, context, id);
    if (current.updatedAt !== version) throw new CommandError("request_conflict");
    if (!saveAccount(context, { ...current, name, kind: accountKind, active, updatedAt: nextVersion(host, current.updatedAt) })) throw new CommandError("request_conflict");
    return stored(tx, context, id);
  });
}
function sameMovement(saved: Row, context: OperationContext, expected: { accountId: string; type: string; amountMinor: number; reason: string; counterpartId?: string }): boolean {
  return saved["business_id"] === context.businessId && saved["user_id"] === context.userId && saved["device_id"] === context.deviceId && saved["account_id"] === expected.accountId &&
    saved["type"] === expected.type && saved["amount_minor"] === expected.amountMinor && saved["reason"] === expected.reason && saved["counterpart_id"] === (expected.counterpartId ?? null);
}
/** Money in or out of one active account under cash.move; the request ID is the movement ID. */
export function moveMoney(host: Host, input: unknown): AccountView {
  const data = object(input, ["sessionId", "requestId", "accountId", "direction", "amountMinor", "reason"]), context = host.actor(data, ["cash.move"]);
  if (data["direction"] !== "in" && data["direction"] !== "out") throw new WorkspaceError("invalid_input");
  const id = uuid(data["requestId"]), accountId = uuid(data["accountId"]), amount = whole(data["amountMinor"], 1), reason = text(data["reason"], 200);
  const type = data["direction"] === "in" ? "CASH_IN" : "CASH_OUT", amountMinor = type === "CASH_IN" ? amount : -amount;
  return host.ports.database.transaction(tx => {
    const saved = tx.get(`SELECT * FROM account_movements WHERE id=?`, [id]);
    if (saved !== undefined) { if (!sameMovement(saved, context, { accountId, type, amountMinor, reason })) throw new CommandError("request_conflict"); }
    else moveCash(context, { eventId: host.ports.newId(), movements: [{ id, accountId, type, amountMinor, reason, occurredAt: host.ports.now(), branchId: unlockedActor(context).branchId }] });
    return after(tx, context, accountId);
  });
}
/** Atomic transfer between two different active accounts; the request ID names the outgoing leg. */
export function transferMoney(host: Host, input: unknown): AccountView {
  const data = object(input, ["sessionId", "requestId", "fromAccountId", "toAccountId", "amountMinor", "reason"]), context = host.actor(data, ["cash.move"]);
  const id = uuid(data["requestId"]), from = uuid(data["fromAccountId"]), to = uuid(data["toAccountId"]), amount = whole(data["amountMinor"], 1), reason = text(data["reason"], 200);
  if (from === to) throw new WorkspaceError("invalid_input");
  return host.ports.database.transaction(tx => {
    const saved = tx.get(`SELECT * FROM account_movements WHERE id=?`, [id]);
    if (saved !== undefined) { if (!sameMovement(saved, context, { accountId: from, type: "TRANSFER_OUT", amountMinor: -amount, reason, counterpartId: to })) throw new CommandError("request_conflict"); }
    else {
      const at = host.ports.now(), branchId = unlockedActor(context).branchId;
      moveCash(context, { eventId: host.ports.newId(), movements: [
        { id, accountId: from, counterpartId: to, type: "TRANSFER_OUT", amountMinor: -amount, reason, occurredAt: at, branchId },
        { id: host.ports.newId(), accountId: to, counterpartId: from, type: "TRANSFER_IN", amountMinor: amount, reason, occurredAt: at, branchId },
      ] });
    }
    return after(tx, context, from);
  });
}
/** Compares a count with the expected balance under cash.count; audit only, no money moves. */
export function countCash(host: Host, input: unknown): CashCountView {
  const data = object(input, ["sessionId", "accountId", "countedMinor"]), context = host.actor(data, ["cash.count"]);
  const accountId = uuid(data["accountId"]), counted = whole(data["countedMinor"]);
  if (accountOf(host.ports.database, context.businessId, accountId)?.active !== true) throw new WorkspaceError("scope_mismatch");
  const { expectedMinor, countedMinor, differenceMinor } = reconcileCash(context, accountId, counted); return { expectedMinor, countedMinor, differenceMinor };
}
/** Corrects the books to a count; a retried correction returns its original result instead of correcting again. */
export function correctCash(host: Host, input: unknown): CashCountView {
  const data = object(input, ["sessionId", "requestId", "accountId", "countedMinor", "reason"]), context = host.actor(data, ["cash.count", "cash.reconcile", "cash.move"]);
  const id = uuid(data["requestId"]), accountId = uuid(data["accountId"]), counted = whole(data["countedMinor"]), reason = text(data["reason"], 200);
  return host.ports.database.transaction(tx => {
    const prior = tx.get(`SELECT user_id,device_id,entity_id,payload FROM local_audit WHERE business_id=? AND action='CASH_RECONCILED' AND json_extract(payload,'$.requestId')=?`, [context.businessId, id]);
    if (prior !== undefined) {
      const facts = JSON.parse(String(prior["payload"])) as CashCountView & { reason: string };
      if (prior["user_id"] !== context.userId || prior["device_id"] !== context.deviceId || prior["entity_id"] !== accountId || facts.countedMinor !== counted || facts.reason !== reason) throw new CommandError("request_conflict");
      return { expectedMinor: facts.expectedMinor, countedMinor: facts.countedMinor, differenceMinor: facts.differenceMinor };
    }
    if (tx.get(`SELECT 1 FROM account_movements WHERE id=?`, [id]) !== undefined) throw new CommandError("request_conflict");
    if (accountOf(tx, context.businessId, accountId)?.active !== true) throw new WorkspaceError("scope_mismatch");
    const { expectedMinor, countedMinor, differenceMinor } = adjustCashToCount(context, { accountId, countedMinor: counted, reason, requestId: id, branchId: unlockedActor(context).branchId });
    return { expectedMinor, countedMinor, differenceMinor };
  });
}
function expense(tx: Queryable, context: OperationContext, row: Row): ExpenseView {
  const reversed = row["reversed"] ?? tx.get(`SELECT 1 AS n FROM expenses WHERE business_id=? AND reverses_id=?`, [context.businessId, row["id"]!])?.["n"] ?? 0;
  return { id: String(row["id"]), occurredAt: String(row["occurred_at"]), category: row["category"] as ExpenseCategory, amountMinor: Number(row["amount_minor"]),
    accountId: String(row["account_id"]), accountName: accountOf(tx, context.businessId, String(row["account_id"]))?.name ?? "", reversed: Number(reversed) === 1,
    ...(typeof row["description"] === "string" ? { description: row["description"] } : {}), ...(typeof row["reference"] === "string" ? { reference: row["reference"] } : {}),
    ...(typeof row["reverses_id"] === "string" ? { reversesId: row["reverses_id"] } : {}) };
}
function storedExpense(tx: Queryable, context: OperationContext, id: string): ExpenseView {
  const row = tx.get(`SELECT * FROM expenses WHERE business_id=? AND id=?`, [context.businessId, id]);
  if (row === undefined) throw new WorkspaceError("scope_mismatch");
  return expense(tx, context, row);
}
/** Newest-first bounded expenses under expenses.view. */
export function listExpenses(host: Host, input: unknown): Page<ExpenseView> {
  const data = object(input, ["sessionId", "after", "limit"]), context = host.actor(data), result = expenses(context, page(data));
  return { ...result, items: result.items.map(row => expense(host.ports.database, context, row)) };
}
/** Records an expense from one active account; the request ID is the expense ID. */
export function recordExpense(host: Host, input: unknown): ExpenseView {
  const data = object(input, ["sessionId", "requestId", "accountId", "category", "amountMinor", "description", "reference"]), context = host.actor(data, ["expenses.create"]);
  const id = uuid(data["requestId"]), accountId = uuid(data["accountId"]), group = category(data["category"]), amountMinor = whole(data["amountMinor"], 1);
  const description = optional(data["description"], value => text(value, 200)), reference = optional(data["reference"], value => text(value, 120));
  return host.ports.database.transaction(tx => {
    const saved = tx.get(`SELECT * FROM expenses WHERE id=?`, [id]);
    if (saved !== undefined) {
      if (saved["business_id"] !== context.businessId || saved["user_id"] !== context.userId || saved["device_id"] !== context.deviceId || saved["account_id"] !== accountId || saved["category"] !== group ||
        saved["amount_minor"] !== amountMinor || saved["description"] !== (description ?? null) || saved["reference"] !== (reference ?? null) || saved["reverses_id"] !== null) throw new CommandError("request_conflict");
    } else writeExpense(context, { id, accountId, category: group, amountMinor, ...(description === undefined ? {} : { description }), ...(reference === undefined ? {} : { reference }),
      occurredAt: host.ports.now(), eventId: host.ports.newId(), branchId: unlockedActor(context).branchId });
    return storedExpense(tx, context, id);
  });
}
/** Compensates one unreversed expense; the request ID is the reversal's ID. */
export function reverseExpense(host: Host, input: unknown): ExpenseView {
  const data = object(input, ["sessionId", "requestId", "expenseId"]), context = host.actor(data, ["expenses.create"]);
  const id = uuid(data["requestId"]), expenseId = uuid(data["expenseId"]);
  return host.ports.database.transaction(tx => {
    const saved = tx.get(`SELECT * FROM expenses WHERE id=?`, [id]);
    if (saved !== undefined) {
      if (saved["business_id"] !== context.businessId || saved["user_id"] !== context.userId || saved["device_id"] !== context.deviceId || saved["reverses_id"] !== expenseId) throw new CommandError("request_conflict");
      return storedExpense(tx, context, expenseId);
    }
    const original = tx.get(`SELECT * FROM expenses WHERE business_id=? AND id=?`, [context.businessId, expenseId]);
    if (original === undefined) throw new WorkspaceError("scope_mismatch");
    if (Number(original["amount_minor"]) <= 0 || tx.get(`SELECT 1 FROM expenses WHERE business_id=? AND reverses_id=?`, [context.businessId, expenseId]) !== undefined) throw new CommandError("request_conflict");
    writeExpense(context, { id, reversesId: expenseId, accountId: String(original["account_id"]), category: original["category"] as ExpenseCategory, amountMinor: -Number(original["amount_minor"]),
      ...(typeof original["description"] === "string" ? { description: original["description"] } : {}), ...(typeof original["branch_id"] === "string" ? { branchId: original["branch_id"] } : {}),
      occurredAt: host.ports.now(), eventId: host.ports.newId() });
    return storedExpense(tx, context, expenseId);
  });
}
