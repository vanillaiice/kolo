import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import { closeConsistent } from "../data/database/integrity.ts";
import type { Database } from "../data/database/driver.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import { createWorkspace, grantPermission, revokePermission, unlockWorkspace } from "../identity/workspace.ts";
import { createLocalMember } from "../identity/members.ts";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "../identity/types.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";
import Papa from "papaparse";
import { auditExport, auditGroupOf, auditTrail, type AuditEntry, type AuditQuery } from "./audit.ts";
import { AUDIT_CSV_COLUMNS, auditCsv, type AuditCsvText } from "../domain/audit-csv.ts";

const start = Date.parse("2026-10-06T09:00:00.000Z"), secret = "fixture-secret";
const databases: Database[] = [];
afterEach(() => { closeConsistent(databases.splice(0)); });
const pem = (): string => generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey;
const code = (expected: string) => (error: unknown): boolean => error instanceof WorkspaceError && error.code === expected;

async function fixture() {
  const db = openDatabase(); databases.push(db); migrate(db);
  // Each fact a second after the last, so order and periods are unambiguous.
  let clock = start;
  const now = (): string => new Date(clock += 1000).toISOString();
  const ports: WorkspacePorts = { database: db, now, newId: randomUUIDv7,
    credentials: { provision: async () => ({ publicKey: pem(), keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() }),
      inspect: async () => ({ publicKey: pem(), keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() }), verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "DESKTOP", currency: "XAF", secret }, ports);
  const owner = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const account = queries.paymentAccounts(owner).items[0]!.id;
  /** One session is open at a time: signing someone in locks the previous context. */
  const login = (userId: string): Promise<OperationContext> => unlockWorkspace({ userId, secret }, ports);
  const member = (context: OperationContext, name: string, role: "MANAGER" | "CASHIER" | "ACCOUNTANT"): Promise<string> => createLocalMember(context, { name, role, secret });
  const product = (context: OperationContext, name: string, price: number, id: string = randomUUIDv7()): string => {
    commands.saveProduct(context, { id, name, unit: "unit", currency: "XAF", sellingPriceMinor: price, purchasePriceMinor: 600, taxRateBasisPoints: 0, minimumStock: 0, divisible: false, active: true, createdAt: new Date(start).toISOString(), updatedAt: now() });
    return id;
  };
  const sell = (context: OperationContext, productId: string, quantity: number, price: number, customerId?: string | undefined, paid = Math.round(quantity * price / 1000)): string => {
    const id = randomUUIDv7();
    commands.completeSale(context, { id, number: `R-${id.slice(-4)}`, occurredAt: now(), eventId: randomUUIDv7(), customerId,
      lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId, name: "Line", unitPriceMinor: price, quantity }],
      payments: paid > 0 ? [{ id: randomUUIDv7(), accountId: account, amountMinor: paid }] : [], ...(customerId !== undefined && paid < quantity * price / 1000 ? { creditTransactionId: randomUUIDv7() } : {}) });
    return id;
  };
  return { db, owner, account, login, member, product, sell, now, ownerId: installation.ownerId, deviceId: installation.deviceId };
}
const all = (context: OperationContext, query: AuditQuery = {}): AuditEntry[] => {
  const items: AuditEntry[] = [];
  let page = auditTrail(context, { ...query, limit: 200 });
  items.push(...page.items);
  while (page.next !== undefined) { page = auditTrail(context, { ...query, limit: 200, after: page.next }); items.push(...page.items); }
  return items;
};

it("only members holding audit.view read the journal; an owner can grant it to a manager", async () => {
  const f = await fixture(), manager = await f.member(f.owner, "Shareholder", "MANAGER"), cashier = await f.member(f.owner, "Cashier", "CASHIER"), accountant = await f.member(f.owner, "Books", "ACCOUNTANT");
  const cashierSession = await f.login(cashier);
  assert.throws(() => auditTrail(cashierSession), code("permission_denied"));
  const managerSession = await f.login(manager);
  assert.throws(() => auditTrail(managerSession), code("permission_denied"), "managers do not see the journal by default");
  assert.ok(auditTrail(await f.login(accountant)).items.length > 0);
  grantPermission(await f.login(f.ownerId), manager, "audit.view");
  const entries = all(await f.login(manager));
  assert.ok(entries.some(entry => entry.type === "PERMISSION_GRANTED" && entry.subject?.name === "Shareholder" && entry.facts.code === "audit.view" && entry.actor.name === "Owner"),
    "the grant itself is in the journal, naming who granted what to whom");
  revokePermission(await f.login(f.ownerId), manager, "audit.view");
  const revoked = await f.login(manager);
  assert.throws(() => auditTrail(revoked), code("permission_denied"), "revocation applies at once");
});

it("summarizes sales, price changes, expenses, payments and member changes with who, where and when", async () => {
  const f = await fixture(), ada = await f.member(f.owner, "Ada", "MANAGER");
  const barrow = f.product(f.owner, "Wheelbarrow", 25_000);
  commands.adjustStock(f.owner, { id: randomUUIDv7(), productId: barrow, type: "OPENING_BALANCE", quantity: 10_000, reason: "Opening", occurredAt: f.now() }, randomUUIDv7());
  const customer: string = randomUUIDv7();
  commands.saveCustomer(f.owner, { id: customer, name: "Moussa", createdAt: f.now(), updatedAt: f.now(), active: true });
  const sale = f.sell(await f.login(ada), barrow, 2000, 25_000, customer, 30_000);
  const owner = await f.login(f.ownerId);
  f.product(owner, "Wheelbarrow", 27_500, barrow);
  commands.recordExpense(owner, { id: randomUUIDv7(), category: "SALARY", accountId: f.account, amountMinor: 80_000, description: "Welder, October", occurredAt: f.now(), eventId: randomUUIDv7() });
  commands.receiveCustomerPayment(owner, { id: randomUUIDv7(), customerId: customer, accountId: f.account, amountMinor: 5000, occurredAt: f.now(), eventId: randomUUIDv7() });

  const entries = all(owner), byType = (type: string): AuditEntry[] => entries.filter(entry => entry.type === type);
  for (let index = 1; index < entries.length; index++)
    assert.ok(entries[index - 1]!.occurredAt >= entries[index]!.occurredAt, "newest first");
  const sold = byType("SALE_COMPLETED")[0]!;
  assert.deepEqual([sold.group, sold.actor.name, sold.device.label, sold.source, sold.status, sold.subject?.id, sold.related?.name, sold.facts.amountMinor, sold.facts.lines],
    ["sales", "Ada", "Till", "journal", "applied", sale, "Moussa", 50_000, 1]);
  const [repriced, created] = byType("PRODUCT_SAVED");
  assert.deepEqual([repriced!.facts.amountMinor, repriced!.facts.previousAmountMinor, repriced!.facts.created, repriced!.facts.previousCostMinor], [27_500, 25_000, false, undefined],
    "a re-save shows the old price, and no cost change when the cost stayed");
  assert.deepEqual([created!.facts.created, created!.facts.previousAmountMinor], [true, undefined]);
  const expense = byType("EXPENSE_RECORDED")[0]!;
  assert.deepEqual([expense.group, expense.facts.code, expense.facts.amountMinor, expense.facts.reason, expense.subject?.kind], ["money", "SALARY", 80_000, "Welder, October", "account"]);
  const payment = byType("CUSTOMER_PAYMENT")[0]!;
  assert.deepEqual([payment.subject?.name, payment.related?.kind, payment.facts.amountMinor], ["Moussa", "account", 5000]);
  const opening = byType("STOCK_MOVED")[0]!;
  assert.deepEqual([opening.subject?.name, opening.facts.code, opening.facts.quantityThousandths, opening.facts.reason], ["Wheelbarrow", "OPENING_BALANCE", 10_000, "Opening"]);
  assert.deepEqual(byType("MEMBER_CREATED").map(entry => [entry.subject?.name, entry.facts.code]), [["Ada", "MANAGER"]]);
  assert.ok(byType("WORKSPACE_CREATED").length === 1);
  const json = JSON.stringify(entries);
  assert.ok(!json.includes("BEGIN PUBLIC KEY") && !json.includes("ciphertext"), "no key material leaves a fact");
});

it("shows checks only this device records: cash counts and counts that matched", async () => {
  const f = await fixture(), barrow = f.product(f.owner, "Wheelbarrow", 25_000);
  commands.adjustStock(f.owner, { id: randomUUIDv7(), productId: barrow, type: "OPENING_BALANCE", quantity: 4000, reason: "Opening", occurredAt: f.now() }, randomUUIDv7());
  assert.equal(commands.countStock(f.owner, { productId: barrow, countedThousandths: 4000, reason: "Friday count" }), 0);
  assert.equal(commands.countStock(f.owner, { productId: barrow, countedThousandths: 3000, reason: "Saturday count" }), -1000);
  commands.reconcileCash(f.owner, f.account, 1500);
  commands.adjustCashToCount(f.owner, { accountId: f.account, countedMinor: 0, reason: "Matches" });
  const entries = all(f.owner);
  const local = entries.filter(entry => entry.source === "this_device").map(entry => [entry.type, entry.group, entry.subject?.kind, entry.facts.expected, entry.facts.counted, entry.facts.reason ?? null]);
  assert.deepEqual(local, [["CASH_RECONCILED", "money", "account", 0, 0, "Matches"], ["CASH_COUNTED", "money", "account", 0, 1500, null], ["STOCK_COUNTED", "stock", "product", 4000, 4000, "Friday count"]]);
  assert.equal(entries.find(entry => entry.type === "CASH_COUNTED")!.facts.amountMinor, 1500, "the difference counted");
  const counted = entries.filter(entry => entry.type === "STOCK_MOVED" && entry.facts.code === "STOCK_COUNT");
  assert.deepEqual(counted.map(entry => [entry.facts.quantityThousandths, entry.facts.reason]), [[-1000, "Saturday count"]], "a count that differed appears once, as the signed movement");
  assert.equal(entries.filter(entry => entry.type === "STOCK_COUNTED").length, 1);
});

it("narrows by period, member, device, family and record, and pages without gaps or repeats", async () => {
  const f = await fixture(), ada = await f.member(f.owner, "Ada", "CASHIER");
  const barrow = f.product(f.owner, "Wheelbarrow", 25_000), bars = f.product(f.owner, "Iron bar", 3000);
  const middle = f.now(), cashier = await f.login(ada);
  for (let index = 0; index < 7; index++) f.sell(cashier, index % 2 === 0 ? barrow : bars, 1000, index % 2 === 0 ? 25_000 : 3000);
  const end = f.now(), owner = await f.login(f.ownerId);
  const everything = all(owner);

  const mine = all(owner, { actorId: ada });
  assert.deepEqual(new Set(mine.map(entry => entry.type)), new Set(["SALE_COMPLETED"]));
  assert.equal(mine.length, 7);
  assert.deepEqual(all(owner, { deviceId: f.deviceId }).length, everything.length, "one till made everything");
  assert.deepEqual(all(owner, { deviceId: randomUUIDv7() }), []);
  assert.ok(all(owner, { group: "staff" }).every(entry => entry.group === "staff"));
  assert.ok(all(owner, { group: "catalogue" }).every(entry => entry.type === "PRODUCT_SAVED"));
  assert.deepEqual(all(owner, { group: "other" }), []);
  const period = all(owner, { from: middle, until: end });
  assert.equal(period.length, 7);
  assert.ok(period.every(entry => entry.occurredAt >= middle && entry.occurredAt < end));
  const barrowHistory = all(owner, { subjectId: barrow });
  assert.deepEqual(barrowHistory.map(entry => entry.type).sort(), ["PRODUCT_SAVED", "SALE_COMPLETED", "SALE_COMPLETED", "SALE_COMPLETED", "SALE_COMPLETED"],
    "a record's history includes the facts that involve it");

  const seen: string[] = [];
  let page = auditTrail(owner, { limit: 3 });
  for (;;) {
    assert.ok(page.items.length <= 3);
    seen.push(...page.items.map(entry => entry.id));
    if (page.next === undefined) break;
    page = auditTrail(owner, { limit: 3, after: page.next });
  }
  assert.deepEqual(seen, everything.map(entry => entry.id), "small pages join into the whole journal in order");
  assert.equal(new Set(seen).size, seen.length);
  const names = auditTrail(owner, { limit: 1 });
  assert.deepEqual(names.members.map(m => m.name), ["Ada", "Owner"]);
  assert.deepEqual(names.devices.map(d => d.label), ["Till"]);
});

it("refuses malformed queries", async () => {
  const f = await fixture(), when = new Date(start).toISOString();
  const bad: unknown[] = [
    { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { from: "yesterday" }, { from: "2026-10-06T09:00:00Z" }, { from: when, until: when },
    { group: "everything" }, { actorId: "'; DROP TABLE users; --" }, { deviceId: 42 }, { subjectId: "\"" }, { after: { name: when, id: "x" } }, { after: { name: "later", id: randomUUIDv7() } },
  ];
  for (const query of bad) assert.throws(() => auditTrail(f.owner, query as AuditQuery), code("invalid_input"), JSON.stringify(query));
  assert.ok(auditTrail(f.owner, {}).items.length > 0, "nothing was harmed");
});

it("files every current event type under a family", () => {
  for (const type of ["SALE_COMPLETED", "PURCHASE_RETURNED", "STOCK_MOVED", "EXPENSE_RECORDED", "PRODUCT_TAX_SET", "PAYMENT_TERMS_SET", "PERMISSION_REVOKED", "SHOP_BACKUP_KEY", "TAX_SETTINGS_SET"])
    assert.notEqual(auditGroupOf(type), "other", type);
  assert.equal(auditGroupOf("SOMETHING_NEW"), "other");
});

const csvText: AuditCsvText = {
  headings: Object.fromEntries(AUDIT_CSV_COLUMNS.map(column => [column, column.toUpperCase()])) as AuditCsvText["headings"],
  operation: entry => `op ${entry.type}`, details: entry => entry.facts.reason ?? "", source: entry => entry.source, status: entry => entry.status ?? "", unknown: "?",
};
const parse = (csv: string, delimiter: string): string[][] => {
  assert.ok(csv.startsWith("\uFEFF"), "a byte-order mark for spreadsheets");
  const result = Papa.parse<string[]>(csv.slice(1), { delimiter, newline: "\r\n" });
  assert.deepEqual(result.errors, []);
  return result.data;
};

it("exports the whole filtered journal page by page, bounded, and says when it stopped early", async () => {
  const f = await fixture(), barrow = f.product(f.owner, "Wheelbarrow", 25_000);
  for (let index = 0; index < 450; index++) commands.adjustStock(f.owner, { id: randomUUIDv7(), productId: barrow, type: "ADJUSTMENT", quantity: 1000, reason: `Weld ${index}`, occurredAt: f.now() }, randomUUIDv7());
  const everything = all(f.owner), exported = auditExport(f.owner);
  assert.deepEqual([exported.truncated, exported.items.map(entry => entry.id)], [false, everything.map(entry => entry.id)], "more than two full pages, in order, none repeated");
  const stock = auditExport(f.owner, { group: "stock" });
  assert.equal(stock.items.length, 450);
  const capped = auditExport(f.owner, {}, 201);
  assert.deepEqual([capped.truncated, capped.items.map(entry => entry.id)], [true, everything.slice(0, 201).map(entry => entry.id)]);
  assert.equal(auditExport(f.owner, {}, everything.length).truncated, false, "exactly the limit is complete");
  for (const bad of [0, 20_001, 1.5]) assert.throws(() => auditExport(f.owner, {}, bad), code("invalid_input"));
  const manager = await f.member(f.owner, "Partner", "MANAGER"), books = await f.member(f.owner, "Books", "ACCOUNTANT");
  const partner = await f.login(manager);
  assert.throws(() => auditExport(partner), code("permission_denied"), "managers neither read nor export the journal by default");
  const accountant = await f.login(books);
  assert.ok(auditTrail(accountant).items.length > 0, "an accountant reads the journal");
  assert.throws(() => auditExport(accountant), code("permission_denied"), "but taking it away needs data.export");
  grantPermission(await f.login(f.ownerId), books, "data.export");
  assert.equal(auditExport(await f.login(books)).truncated, false, "granted, the export works");
  revokePermission(await f.login(f.ownerId), books, "data.export");
  const revoked = await f.login(books);
  assert.throws(() => auditExport(revoked), code("permission_denied"), "a revocation applies at once");
});

it("writes CSV a spreadsheet reads back cell for cell, with formulas defused and either separator", async () => {
  const f = await fixture(), barrow = f.product(f.owner, "Brouette « renforcée »; 2 roues", 25_000);
  const reasons = ["=HYPERLINK(\"http://x\")", "+1", "-2", "@SUM(A1)", "ligne 1\r\nligne 2", "guillemet \" et ; virgule ,", "\tonglet", "Été déjà — ok", ""];
  for (const reason of reasons.filter(Boolean)) commands.adjustStock(f.owner, { id: randomUUIDv7(), productId: barrow, type: "DAMAGE", quantity: -1000, reason, occurredAt: f.now() }, randomUUIDv7());
  const spent = randomUUIDv7();
  commands.recordExpense(f.owner, { id: spent, category: "OTHER", accountId: f.account, amountMinor: 1500, description: "Disc", occurredAt: f.now(), eventId: randomUUIDv7() });
  commands.recordExpense(f.owner, { id: randomUUIDv7(), category: "OTHER", accountId: f.account, amountMinor: -1500, description: "Disc", reversesId: spent, occurredAt: f.now(), eventId: randomUUIDv7() });
  const entries = auditExport(f.owner).items;
  for (const delimiter of [";", ","] as const) {
    const csv = auditCsv(entries, csvText, delimiter), rows = parse(csv, delimiter);
    assert.ok(csv.includes("\r\n") && !/[^\r]\n(?![^"]*"[^"]*$)/.test(csv.split("\r\n")[0]!), "CRLF rows");
    assert.deepEqual(rows[0], AUDIT_CSV_COLUMNS.map(column => column.toUpperCase()));
    assert.equal(rows.length, entries.length + 1);
    entries.forEach((entry, index) => {
      const row = rows[index + 1]!, cell = (column: typeof AUDIT_CSV_COLUMNS[number]): string => row[AUDIT_CSV_COLUMNS.indexOf(column)]!;
      assert.equal(cell("id"), entry.id); assert.equal(cell("utc"), entry.occurredAt); assert.equal(cell("type"), entry.type);
      const local = new Date(entry.occurredAt);
      assert.equal(new Date(`${cell("date")}T${cell("time")}`).getTime(), local.getTime() - local.getMilliseconds(), "local date and time name the same instant");
      assert.equal(cell("amount"), entry.facts.amountMinor === undefined ? "" : String(entry.facts.amountMinor), "amounts stay numbers, negatives included");
      const reason = entry.facts.reason ?? "";
      assert.equal(cell("details"), /^[=+\-@\t\r]/.test(reason) ? `'${reason}` : reason, "text a spreadsheet would run is prefixed, everything else is exact");
      assert.equal(cell("record"), entry.subject === undefined ? "" : entry.subject.name ?? "?");
    });
  }
});

it("round-trips arbitrary text through the CSV (fuzz)", () => {
  let seed = 7;
  const next = (below: number): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % below; };
  const alphabet = ["a", "é", ";", ",", "\"", "'", "\r", "\n", "\r\n", " ", "=", "+", "-", "@", "\t", "€", "🙂", "\u00a0"];
  for (let round = 0; round < 300; round++) {
    const reason = Array.from({ length: next(12) }, () => alphabet[next(alphabet.length)]).join("");
    const entry: AuditEntry = { id: `e${round}`, type: "STOCK_MOVED", group: "stock", occurredAt: "2026-10-06T09:00:00.000Z", actor: { id: "a", name: reason }, device: { id: "d" }, source: "journal", facts: { reason } };
    for (const delimiter of [";", ","] as const) {
      const row = parse(auditCsv([entry], csvText, delimiter), delimiter)[1]!;
      const expected = /^[=+\-@\t\r]/.test(reason) ? `'${reason}` : reason;
      assert.equal(row[AUDIT_CSV_COLUMNS.indexOf("member")], expected, JSON.stringify(reason));
      assert.equal(row[AUDIT_CSV_COLUMNS.indexOf("details")], expected);
      assert.equal(row[AUDIT_CSV_COLUMNS.indexOf("device")], "?");
    }
  }
});
