import type { Queryable, Row, SqlValue } from "../data/database/driver.ts";
import { sqlInteger } from "../data/database/safe-values.ts";
import { authorizedOperation } from "../identity/internal-authority.ts";
import { WorkspaceError, type OperationContext } from "../identity/types.ts";
import type { Permission } from "../identity/permissions.ts";
import { subtotalOf } from "../rules/pricing.ts";
import type { Cursor } from "./queries.ts";
import { AUDIT_EXPORT_LIMIT } from "../domain/audit-csv.ts";
export { AUDIT_EXPORT_LIMIT };

/**
 * The operation journal (spec §39, `audit.view`): who did what, when, on which device.
 *
 * Read from the signed event journal, which holds every till's facts once they have synced, plus the few checks that
 * only this device records because they change nothing (a cash count, a correction or stock count that matched).
 * Nothing is stored for the view; entries are summarized on demand from the immutable facts. Clients localize from
 * `type`, `subject` and `facts`; no display text is produced here, and no key material leaves a payload.
 */

/** Families the journal can be narrowed to. */
export type AuditGroup = "sales" | "purchases" | "stock" | "money" | "catalogue" | "people" | "staff" | "devices" | "settings" | "other";
export const AUDIT_GROUPS: readonly AuditGroup[] = ["sales", "purchases", "stock", "money", "catalogue", "people", "staff", "devices", "settings", "other"];

const TYPES: Readonly<Record<Exclude<AuditGroup, "other">, readonly string[]>> = {
  sales: ["SALE_COMPLETED", "SALE_RETURNED", "CUSTOMER_PAYMENT"],
  purchases: ["PURCHASE_RECORDED", "PURCHASE_RETURNED", "SUPPLIER_PAYMENT"],
  stock: ["STOCK_MOVED", "STOCK_COUNTED"],
  money: ["CASH_MOVED", "EXPENSE_RECORDED", "ACCOUNT_SAVED", "CASH_COUNTED", "CASH_RECONCILED"],
  catalogue: ["PRODUCT_SAVED", "CATEGORY_SAVED", "PRODUCT_CATEGORIES_SET", "PRODUCT_TAX_SET"],
  people: ["CUSTOMER_SAVED", "SUPPLIER_SAVED", "PAYMENT_TERMS_SET"],
  staff: ["WORKSPACE_CREATED", "LEGACY_WORKSPACE_ADOPTED", "MEMBER_CREATED", "PERMISSION_GRANTED", "PERMISSION_REVOKED", "PERMISSION_OVERRIDE_CLEARED", "MEMBER_ROLE_CHANGED", "ROLE_PERMISSIONS_SET", "CUSTOM_ROLE_SET", "MEMBER_SUSPENDED", "MEMBER_REINSTATED", "MEMBER_ACCESS_RESET", "OWNER_ACCESS_RECOVERED"],
  devices: ["DEVICE_TRUSTED", "DEVICE_REVOKED", "DEVICE_ENCRYPTION_KEY", "SHOP_KEY_GRANTED", "SERVER_ENDPOINT_SET", "SERVER_ENDPOINT_CLEARED", "SHOP_BACKUP_KEY"],
  settings: ["TAX_SETTINGS_SET"],
};
const KNOWN = Object.values(TYPES).flat();

/** The family an event or local check belongs to; names this version does not know are `other`. */
export function auditGroupOf(type: string): AuditGroup {
  for (const [group, types] of Object.entries(TYPES)) if (types.includes(type)) return group as AuditGroup;
  return "other";
}

/** What an entry is about, or what it involved besides. Names are as recorded at the time when the fact carries one. */
export interface AuditSubject {
  readonly kind: "product" | "category" | "customer" | "supplier" | "account" | "member" | "device" | "sale" | "purchase" | "shop";
  readonly id: string;
  /** Absent when this device has never heard of the record (a fact not yet synced, or a name never sent). */
  readonly name?: string | undefined;
}

/** Figures and codes for one entry; each type fills the ones that apply. Money is XAF, quantity thousandths. */
export interface AuditFacts {
  /** Sale or delivery total, payment, expense, refund or cash amount; a product's selling price. */
  readonly amountMinor?: number;
  /** The selling price before this save, when it changed. */
  readonly previousAmountMinor?: number;
  readonly costMinor?: number;
  readonly previousCostMinor?: number;
  readonly quantityThousandths?: number;
  /** How many lines or movements the fact carried. */
  readonly lines?: number;
  /** Movement type, expense category, role, permission, tax rule or device platform, as stored. */
  readonly code?: string;
  readonly reason?: string;
  /** Receipt number, delivery reference or server address. */
  readonly reference?: string;
  readonly created?: boolean;
  readonly active?: boolean;
  /** An expense entry that cancels an earlier one. */
  readonly reversal?: boolean;
  /** Counts: what the books expected and what was counted (XAF for cash, thousandths for stock). */
  readonly expected?: number;
  readonly counted?: number;
  readonly days?: number | null;
  readonly rateBasisPoints?: number;
  readonly enabled?: boolean;
}

/** One journal entry, newest first. */
export interface AuditEntry {
  readonly id: string;
  /** The event or check name, e.g. `SALE_COMPLETED`, `PERMISSION_GRANTED`, `CASH_COUNTED`. */
  readonly type: string;
  readonly group: AuditGroup;
  /** When it was recorded on its till (ISO instant). */
  readonly occurredAt: string;
  readonly actor: { readonly id: string; readonly name?: string | undefined };
  readonly device: { readonly id: string; readonly label?: string | undefined };
  /** `journal`: a signed shop fact; `this_device`: a check only this device records. */
  readonly source: "journal" | "this_device";
  /** For journal facts: whether this device applied it, or held it back (quarantined, deferred, unsupported). */
  readonly status?: string | undefined;
  readonly subject?: AuditSubject | undefined;
  /** The other party, account or record involved (customer of a sale, account of a payment, transfer target). */
  readonly related?: AuditSubject | undefined;
  readonly facts: AuditFacts;
}

/** Narrowing for {@link auditTrail}. Times are a half-open ISO range; IDs come from earlier entries or the lists returned. */
export interface AuditQuery {
  readonly from?: string | undefined;
  readonly until?: string | undefined;
  readonly actorId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly group?: AuditGroup | undefined;
  /** Entries about, or involving, this record: a product's sales and stock moves, a member's permissions. */
  readonly subjectId?: string | undefined;
  /** Continuation from a previous page: `name` is the occurredAt, `id` the entry ID. */
  readonly after?: Cursor | undefined;
  /** 1–200, default 50. */
  readonly limit?: number | undefined;
}

/** A page of the journal with the shop's members and devices, for naming filters. */
export interface AuditPage {
  readonly items: readonly AuditEntry[];
  readonly next?: Cursor | undefined;
  readonly members: readonly { readonly id: string; readonly name: string }[];
  readonly devices: readonly { readonly id: string; readonly label: string }[];
}

const ID = /^[0-9a-f][0-9a-f-]{7,63}$/;
function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new WorkspaceError("invalid_input");
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new WorkspaceError("invalid_input");
  return value;
}

/**
 * One page of the operation journal under `audit.view`, newest first, narrowed by period, member, device, family or
 * record. Received facts appear once synced, with the member and device that made them; a held-back fact shows its status.
 */
export function auditTrail(context: OperationContext, query: AuditQuery = {}): AuditPage {
  return readPage(context, query, ["audit.view"]);
}

function readPage(context: OperationContext, query: AuditQuery, required: readonly Permission[]): AuditPage {
  const limit = query.limit ?? 50;
  if (query === null || typeof query !== "object" || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new WorkspaceError("invalid_input");
  const from = query.from === undefined ? undefined : instant(query.from), until = query.until === undefined ? undefined : instant(query.until);
  if (from !== undefined && until !== undefined && from >= until) throw new WorkspaceError("invalid_input");
  if (query.group !== undefined && !AUDIT_GROUPS.includes(query.group)) throw new WorkspaceError("invalid_input");
  if (query.after !== undefined && (query.after === null || typeof query.after !== "object")) throw new WorkspaceError("invalid_input");
  const after = query.after === undefined ? undefined : { at: instant(query.after.name), id: id(query.after.id) };
  const actorId = query.actorId === undefined ? undefined : id(query.actorId), deviceId = query.deviceId === undefined ? undefined : id(query.deviceId);
  const subjectId = query.subjectId === undefined ? undefined : id(query.subjectId);

  return authorizedOperation(context, required, (_db, tx) => {
    const shop = context.businessId, values: SqlValue[] = [shop, shop];
    const where: string[] = [];
    if (from !== undefined) { where.push("occurred_at >= ?"); values.push(from); }
    if (until !== undefined) { where.push("occurred_at < ?"); values.push(until); }
    if (actorId !== undefined) { where.push("actor_id = ?"); values.push(actorId); }
    if (deviceId !== undefined) { where.push("device_id = ?"); values.push(deviceId); }
    if (query.group !== undefined) {
      const types = query.group === "other" ? KNOWN : TYPES[query.group];
      where.push(`type ${query.group === "other" ? "NOT IN" : "IN"} (${types.map(() => "?").join(",")})`); values.push(...types);
    }
    // IDs are quoted wherever they appear in a fact, so a quoted match finds every fact that names the record.
    if (subjectId !== undefined) { where.push(`(entity_id = ? OR instr(body, ?) > 0)`); values.push(subjectId, `"${subjectId}"`); }
    if (after !== undefined) { where.push("(occurred_at, id) < (?, ?)"); values.push(after.at, after.id); }
    values.push(limit + 1);
    const rows = tx.all(`SELECT * FROM (
        SELECT 'journal' AS source, e.event_id AS id, e.event_type AS type, e.actor_id, e.origin_device_id AS device_id, e.occurred_at, e.canonical AS body, a.status, NULL AS entity_id
          FROM event_journal e LEFT JOIN applied_events a ON a.event_id = e.event_id WHERE e.business_id = ?
        UNION ALL
        SELECT 'this_device', event_id, action, user_id, device_id, occurred_at, payload, NULL, entity_id
          FROM local_audit WHERE business_id = ? AND (action = 'CASH_COUNTED'
            OR (action = 'CASH_RECONCILED' AND json_extract(payload, '$.differenceMinor') = 0)
            OR (action = 'STOCK_COUNTED' AND json_extract(payload, '$.delta') = 0))
      )${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`} ORDER BY occurred_at DESC, id DESC LIMIT ?`, values);
    const shown = rows.slice(0, limit), last = shown.at(-1);
    const names = new Names(tx, shop);
    const drafts = shown.map(row => summarize(tx, shop, row));
    const members = tx.all(`SELECT id, name FROM users WHERE business_id = ? ORDER BY name, id`, [shop]).map(row => ({ id: String(row["id"]), name: String(row["name"]) }));
    const devices = tx.all(`SELECT id, label FROM devices WHERE business_id = ? ORDER BY label, id`, [shop]).map(row => ({ id: String(row["id"]), label: String(row["label"]) }));
    const memberName = new Map(members.map(member => [member.id, member.name])), deviceLabel = new Map(devices.map(device => [device.id, device.label]));
    return {
      items: drafts.map(draft => ({ ...draft,
        actor: { id: draft.actor.id, name: memberName.get(draft.actor.id) }, device: { id: draft.device.id, label: deviceLabel.get(draft.device.id) },
        subject: names.fill(draft.subject), related: names.fill(draft.related) })),
      next: rows.length > limit && last !== undefined ? { name: String(last["occurred_at"]), id: String(last["id"]) } : undefined,
      members, devices,
    };
  });
}

const TABLES: Readonly<Partial<Record<AuditSubject["kind"], { readonly table: string; readonly column: string }>>> = {
  product: { table: "products", column: "name" }, category: { table: "categories", column: "name" }, customer: { table: "customers", column: "name" },
  supplier: { table: "suppliers", column: "name" }, account: { table: "financial_accounts", column: "name" }, member: { table: "users", column: "name" },
  device: { table: "devices", column: "label" }, sale: { table: "sales", column: "number" }, purchase: { table: "purchases", column: "reference" },
};

/** Current names for subjects whose fact did not carry one, looked up once per record. */
class Names {
  readonly #cache = new Map<string, string | undefined>();
  readonly tx: Queryable;
  readonly shop: string;
  constructor(tx: Queryable, shop: string) { this.tx = tx; this.shop = shop; }
  fill(subject: AuditSubject | undefined): AuditSubject | undefined {
    if (subject === undefined || subject.name !== undefined) return subject;
    const source = TABLES[subject.kind];
    if (source === undefined) return subject;
    const key = `${subject.kind}:${subject.id}`;
    if (!this.#cache.has(key)) {
      const value = this.tx.get(`SELECT ${source.column} AS name FROM ${source.table} WHERE business_id = ? AND id = ?`, [this.shop, subject.id])?.["name"];
      this.#cache.set(key, typeof value === "string" ? value : undefined);
    }
    const name = this.#cache.get(key);
    return name === undefined ? subject : { ...subject, name };
  }
}

type Draft = Omit<AuditEntry, "actor" | "device"> & { readonly actor: { readonly id: string }; readonly device: { readonly id: string } };
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
function subject(kind: AuditSubject["kind"], idValue: unknown, name?: unknown): AuditSubject | undefined {
  const value = str(idValue);
  if (value === undefined) return undefined;
  const label = str(name);
  return label === undefined ? { kind, id: value } : { kind, id: value, name: label };
}
/** Drops absent facts so entries stay small and compare cleanly. */
function facts(input: Record<string, unknown>): AuditFacts {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as AuditFacts;
}
function total(items: readonly Json[], price: string, discount?: number): number | undefined {
  try {
    const subtotal = subtotalOf(items.map(item => ({ unitPriceMinor: num(item[price]) ?? -1, quantity: num(item["quantity"]) ?? 0, discountMinor: num(item["discount_minor"]) })));
    return subtotal - (discount ?? 0);
  } catch { return undefined; }
}

function summarize(tx: Queryable, shop: string, row: Row): Draft {
  const type = String(row["type"]), source = row["source"] === "journal" ? "journal" : "this_device";
  let body: Json;
  try { body = object(JSON.parse(String(row["body"]))); } catch { body = {}; }
  const base = { id: String(row["id"]), type, group: auditGroupOf(type), occurredAt: String(row["occurred_at"]), source,
    actor: { id: String(row["actor_id"]) }, device: { id: String(row["device_id"]) },
    ...(typeof row["status"] === "string" ? { status: row["status"] } : {}) } as const;
  const described = source === "journal" ? describe(tx, shop, type, object(body["payload"]), base.id, base.occurredAt) : local(type, String(row["entity_id"]), body);
  return { ...base, ...described };
}

type Described = Pick<AuditEntry, "subject" | "related" | "facts">;

/** Local checks: a cash count, a matching correction, a matching stock count. */
function local(type: string, entityId: string, payload: Json): Described {
  if (type === "STOCK_COUNTED") return { subject: { kind: "product", id: entityId }, facts: facts({ expected: num(payload["expectedThousandths"]), counted: num(payload["countedThousandths"]), reason: str(payload["reason"]) }) };
  return { subject: { kind: "account", id: entityId }, facts: facts({ expected: num(payload["expectedMinor"]), counted: num(payload["countedMinor"]), amountMinor: num(payload["differenceMinor"]), reason: str(payload["reason"]) }) };
}

function describe(tx: Queryable, shop: string, type: string, payload: Json, eventId: string, occurredAt: string): Described {
  switch (type) {
    case "SALE_COMPLETED": {
      const sale = object(payload["sale"]), items = list(sale["items"]);
      return { subject: subject("sale", sale["id"], sale["number"]), related: subject("customer", sale["customer_id"]),
        facts: facts({ amountMinor: total(items, "unit_price_minor", num(sale["discount_minor"])), lines: items.length, reference: str(sale["number"]) }) };
    }
    case "SALE_RETURNED": case "PURCHASE_RETURNED": {
      const returned = object(payload["returned"]), sale = type === "SALE_RETURNED";
      const amount = tx.get(`SELECT total_minor FROM business_returns WHERE business_id = ? AND id = ?`, [shop, str(returned["id"]) ?? ""])?.["total_minor"];
      return { subject: subject(sale ? "sale" : "purchase", returned["original_id"]),
        facts: facts({ amountMinor: amount === undefined ? undefined : sqlInteger(amount), lines: list(returned["items"]).length, reason: str(returned["reason"]) }) };
    }
    case "PURCHASE_RECORDED": {
      const purchase = object(payload["purchase"]), items = list(purchase["items"]);
      return { subject: subject("supplier", purchase["supplier_id"]) ?? subject("purchase", purchase["id"], purchase["reference"]),
        facts: facts({ amountMinor: total(items, "unit_cost_minor"), lines: items.length, reference: str(purchase["reference"]) }) };
    }
    case "CUSTOMER_PAYMENT": case "SUPPLIER_PAYMENT": {
      const payment = object(payload["payment"]), customer = type === "CUSTOMER_PAYMENT";
      return { subject: subject(customer ? "customer" : "supplier", payment[customer ? "customer_id" : "supplier_id"]), related: subject("account", payment["account_id"]),
        facts: facts({ amountMinor: num(payment["amount_minor"]), reason: str(payment["note"]) }) };
    }
    case "STOCK_MOVED": {
      const movements = list(payload["movements"]), first = movements[0] ?? {}, single = movements.length === 1;
      return { subject: single ? subject("product", first["product_id"]) : undefined,
        facts: facts({ code: str(first["type"]), lines: movements.length, quantityThousandths: single ? num(first["quantity"]) : undefined, reason: str(first["reason"]), costMinor: single ? num(first["unit_cost_minor"]) : undefined }) };
    }
    case "CASH_MOVED": {
      // A transfer is an out and an in; it reads from the side the money left.
      const movements = list(payload["movements"]), first = movements.find(m => m["type"] === "TRANSFER_OUT") ?? movements[0] ?? {};
      return { subject: subject("account", first["account_id"]), related: subject("account", first["counterpart_id"]),
        facts: facts({ code: str(first["type"]), amountMinor: num(first["amount_minor"]), reason: str(first["reason"]), lines: movements.length }) };
    }
    case "EXPENSE_RECORDED": {
      const expense = object(payload["expense"]);
      return { subject: subject("account", expense["account_id"]),
        facts: facts({ code: str(expense["category"]), amountMinor: num(expense["amount_minor"]), reason: str(expense["description"]), reference: str(expense["reference"]), reversal: expense["reverses_id"] === undefined ? undefined : true }) };
    }
    case "PRODUCT_SAVED": {
      const product = object(payload["product"]), productId = str(product["id"]) ?? "";
      const before = previous(tx, shop, "PRODUCT_SAVED", productId, eventId, occurredAt), prior = object(before?.["product"]);
      const price = num(product["selling_price_minor"]), cost = num(product["purchase_price_minor"]);
      const oldPrice = num(prior["selling_price_minor"]), oldCost = num(prior["purchase_price_minor"]);
      return { subject: subject("product", productId, product["name"]),
        facts: facts({ amountMinor: price, previousAmountMinor: before !== undefined && oldPrice !== price ? oldPrice : undefined,
          costMinor: cost, previousCostMinor: before !== undefined && oldCost !== cost ? oldCost : undefined,
          created: before === undefined, active: bool(product["active"]) }) };
    }
    case "CATEGORY_SAVED": case "CUSTOMER_SAVED": case "SUPPLIER_SAVED": case "ACCOUNT_SAVED": {
      const [key, kind] = ({ CATEGORY_SAVED: ["category", "category"], CUSTOMER_SAVED: ["customer", "customer"], SUPPLIER_SAVED: ["supplier", "supplier"], ACCOUNT_SAVED: ["account", "account"] } as const)[type];
      const record = object(payload[key]);
      return { subject: subject(kind, record["id"], record["name"]),
        facts: facts({ created: str(record["created_at"]) !== undefined && record["created_at"] === record["updated_at"], active: bool(record["active"]), code: str(record["kind"]) }) };
    }
    case "PRODUCT_CATEGORIES_SET":
      return { subject: subject("product", payload["product_id"]), facts: facts({ lines: list(payload["category_ids"]).length }) };
    case "PRODUCT_TAX_SET":
      return { subject: subject("product", payload["product_id"]), facts: facts({ code: str(payload["rule"]), rateBasisPoints: num(payload["rate_basis_points"]) }) };
    case "TAX_SETTINGS_SET":
      return { facts: facts({ enabled: bool(payload["enabled"]), rateBasisPoints: num(payload["standard_rate_basis_points"]), reference: str(payload["label"]) }) };
    case "PAYMENT_TERMS_SET":
      return { subject: subject(payload["party"] === "SUPPLIER" ? "supplier" : "customer", payload["party_id"]),
        facts: facts({ code: str(payload["party"]), days: payload["days"] === null ? null : num(payload["days"]) }) };
    case "WORKSPACE_CREATED": {
      const business = object(payload["business"]);
      return { subject: subject("shop", business["id"], business["name"]), facts: {} };
    }
    case "MEMBER_CREATED":
      return { subject: subject("member", payload["user_id"], payload["name"]), facts: facts({ code: str(payload["role"]) }) };
    case "PERMISSION_GRANTED": case "PERMISSION_REVOKED": case "PERMISSION_OVERRIDE_CLEARED":
      return { subject: subject("member", payload["user_id"]), facts: facts({ code: str(payload["permission"]) }) };
    case "MEMBER_ROLE_CHANGED": {
      // A custom role is named as it is now; its base role is what the member holds underneath.
      const custom = str(payload["custom_role_id"]), name = custom === undefined ? undefined : tx.get(`SELECT name FROM custom_roles WHERE business_id = ? AND id = ?`, [shop, custom])?.["name"];
      return { subject: subject("member", payload["user_id"]), facts: facts(custom === undefined ? { code: str(payload["role"]) } : { reference: str(name) ?? str(payload["role"]) }) };
    }
    case "CUSTOM_ROLE_SET":
      return { facts: facts({ reference: str(payload["name"]), code: str(payload["base_role"]), lines: list(payload["permissions"]).length,
        created: payload["revision"] === 1 ? true : undefined, active: payload["deleted"] === true ? false : undefined }) };
    case "ROLE_PERMISSIONS_SET":
      return { facts: facts({ code: str(payload["role"]), lines: payload["permissions"] === null ? undefined : list(payload["permissions"]).length }) };
    case "MEMBER_SUSPENDED": case "MEMBER_REINSTATED": case "MEMBER_ACCESS_RESET": case "OWNER_ACCESS_RECOVERED":
      return { subject: subject("member", payload["user_id"]), facts: {} };
    case "DEVICE_TRUSTED": {
      const device = object(payload["device"]);
      return { subject: subject("device", device["id"], device["label"]), facts: facts({ code: str(device["platform"]) }) };
    }
    case "DEVICE_REVOKED": case "DEVICE_ENCRYPTION_KEY": case "SHOP_KEY_GRANTED":
      return { subject: subject("device", payload["device_id"]), facts: {} };
    case "SERVER_ENDPOINT_SET":
      return { facts: facts({ reference: str(payload["url"]) }) };
    default:
      return { facts: {} };
  }
}

/** The payload of the latest earlier fact of this type naming this record, for showing what a save changed. */
function previous(tx: Queryable, shop: string, type: string, recordId: string, eventId: string, occurredAt: string): Json | undefined {
  if (recordId === "") return undefined;
  const row = tx.get(`SELECT canonical FROM event_journal WHERE business_id = ? AND event_type = ? AND instr(canonical, ?) > 0 AND (occurred_at, event_id) < (?, ?)
    ORDER BY occurred_at DESC, event_id DESC LIMIT 1`, [shop, type, `"${recordId}"`, occurredAt, eventId]);
  if (row === undefined) return undefined;
  try { return object(object(JSON.parse(String(row["canonical"])))["payload"]); } catch { return undefined; }
}


/**
 * Every entry matching `query` (its cursor and limit ignored), newest first, read page by page up to
 * {@link AUDIT_EXPORT_LIMIT}; `truncated` says more matched. Taking the journal away needs `data.export` as well as
 * `audit.view`, checked on every page, so a revocation stops an export already under way.
 */
export function auditExport(context: OperationContext, query: Omit<AuditQuery, "after" | "limit"> = {}, maximum = AUDIT_EXPORT_LIMIT): { readonly items: readonly AuditEntry[]; readonly truncated: boolean } {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > AUDIT_EXPORT_LIMIT) throw new WorkspaceError("invalid_input");
  const items: AuditEntry[] = [];
  let after: Cursor | undefined;
  for (;;) {
    const page = readPage(context, { ...query, after: undefined, limit: Math.min(200, maximum - items.length), ...(after === undefined ? {} : { after }) }, ["audit.view", "data.export"]);
    items.push(...page.items);
    if (page.next === undefined) return { items, truncated: false };
    if (items.length >= maximum) return { items, truncated: true };
    after = page.next;
  }
}
