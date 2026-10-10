import { z } from "zod";
import { PERMISSIONS } from "./permissions.ts";
import { canonicalJson } from "./canonical.ts";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const whole = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const money = whole.nonnegative();
const positive = whole.positive();
const timestamp = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const text = z.string().max(2048);
const name = z.string().min(1).max(120).refine(value => value.trim().length > 0);
const reference = z.string().min(1).max(120);
const permission = z.enum(PERMISSIONS);
const role = z.enum(["OWNER", "MANAGER", "CASHIER", "INVENTORY", "ACCOUNTANT"]);
const accountKind = z.enum(["CASH", "MOBILE_MONEY", "BANK", "CARD", "OTHER"]);
const types = z.enum(["OPENING_BALANCE", "PURCHASE", "SALE", "SALE_RETURN", "PURCHASE_RETURN", "ADJUSTMENT", "STOCK_COUNT", "DAMAGE"]);
const stock = z.strictObject({ id: uuid, product_id: uuid, type: types, quantity: whole.refine(value => value !== 0),
  unit_cost_minor: money.optional(), reference_kind: z.enum(["SALE", "PURCHASE"]).optional(), reference_id: uuid.optional(),
  reason: text.optional(), occurred_at: timestamp.optional() });
const payment = z.strictObject({ id: uuid, account_id: uuid, amount_minor: positive, reference: text.optional(), note: text.optional(), occurred_at: timestamp.optional() });
const saleItem = z.strictObject({ id: uuid, product_id: uuid, name, unit_price_minor: money, quantity: positive,
  discount_minor: money.optional(), tax_rate_basis_points: whole.min(0).max(10000).optional(), unit_cost_minor: money.optional() });
const cashMovement = z.strictObject({ id: uuid, account_id: uuid, type: z.enum(["OPENING_BALANCE", "CASH_IN", "CASH_OUT", "TRANSFER_IN", "TRANSFER_OUT", "ADJUSTMENT"]),
  amount_minor: whole.refine(value => value !== 0), counterpart_id: uuid.optional(), reason: text.optional(), occurred_at: timestamp });

const returned = z.strictObject({ id: uuid, original_id: uuid, prior_id: uuid.optional(), reason: z.string().min(1).max(2048).refine(value => value.trim().length > 0),
  items: z.array(z.strictObject({ id: uuid, original_item_id: uuid, quantity: positive, movement_id: uuid })).min(1).max(200),
  refunds: z.array(z.strictObject({ id: uuid, account_id: uuid, amount_minor: positive })).max(100), debt_transaction_id: uuid.optional() });

/** Strict v2 payload schemas for every current business/authority event. No credentials/tokens. */
export const EVENT_PAYLOAD_SCHEMAS = {
  SALE_RETURNED: z.strictObject({ returned }),
  PURCHASE_RETURNED: z.strictObject({ returned }),
  CATEGORY_SAVED: z.strictObject({ category: z.strictObject({ id: uuid, name, active: z.boolean(), created_at: timestamp, updated_at: timestamp }) }),
  PRODUCT_SAVED: z.strictObject({ product: z.strictObject({ id: uuid, category_id: uuid.optional(), name, unit: name,
    selling_price_minor: money, purchase_price_minor: money.optional(), sku: text.optional(), barcode: text.optional(), description: text.optional(), brand: text.optional(),
    divisible: z.boolean().optional(), active: z.boolean().optional(), tax_rate_basis_points: whole.min(0).max(10000).optional(), minimum_stock: money.optional(), created_at: timestamp, updated_at: timestamp }) }),
  /** A product's additional categories (its main category stays on PRODUCT_SAVED); last write wins per product. */
  PRODUCT_CATEGORIES_SET: z.strictObject({ product_id: uuid, category_ids: z.array(uuid).max(20).refine(ids => new Set(ids).size === ids.length), updated_at: timestamp }),
  CUSTOMER_SAVED: z.strictObject({ customer: z.strictObject({ id: uuid, name, phone: text.optional(), address: text.optional(), notes: text.optional(),
    credit_limit_minor: money.optional(), active: z.boolean().optional(), created_at: timestamp, updated_at: timestamp }) }),
  SUPPLIER_SAVED: z.strictObject({ supplier: z.strictObject({ id: uuid, name, phone: text.optional(), address: text.optional(), contact: text.optional(), notes: text.optional(),
    active: z.boolean().optional(), created_at: timestamp, updated_at: timestamp }) }),
  ACCOUNT_SAVED: z.strictObject({ account: z.strictObject({ id: uuid, branch_id: uuid.optional(), name, kind: accountKind,
    number: text.optional(), notes: text.optional(), active: z.boolean().optional(), created_at: timestamp, updated_at: timestamp }) }),
  SALE_COMPLETED: z.strictObject({ sale: z.strictObject({ id: uuid, number: reference, occurred_at: timestamp, items: z.array(saleItem).min(1).max(200),
    customer_id: uuid.optional(), credit_transaction_id: uuid.optional(), discount_minor: money.optional(), note: text.optional() }),
    payments: z.array(payment).max(100), movements: z.array(stock).min(1).max(200) }),
  PURCHASE_RECORDED: z.strictObject({ purchase: z.strictObject({ id: uuid, occurred_at: timestamp, items: z.array(z.strictObject({ id: uuid, product_id: uuid, unit_cost_minor: money, quantity: positive })).min(1).max(200),
    supplier_id: uuid.optional(), supplier_transaction_id: uuid.optional(), reference: text.optional(), note: text.optional() }),
    payments: z.array(z.strictObject({ id: uuid, account_id: uuid, amount_minor: whole.negative(), reason: name, occurred_at: timestamp })).max(100),
    movements: z.array(stock).min(1).max(200) }),
  CUSTOMER_PAYMENT: z.strictObject({ payment: z.strictObject({ id: uuid, customer_id: uuid, account_id: uuid, amount_minor: positive, note: text.optional(), occurred_at: timestamp }) }),
  SUPPLIER_PAYMENT: z.strictObject({ payment: z.strictObject({ id: uuid, supplier_id: uuid, account_id: uuid, amount_minor: positive, note: text.optional(), occurred_at: timestamp }) }),
  STOCK_MOVED: z.strictObject({ movements: z.array(stock).min(1).max(200) }),
  CASH_MOVED: z.strictObject({ movements: z.array(cashMovement).min(1).max(200) }),
  EXPENSE_RECORDED: z.strictObject({ expense: z.strictObject({ id: uuid, category: z.enum(["RENT", "ELECTRICITY", "WATER", "TRANSPORT", "SALARY", "PACKAGING", "MAINTENANCE", "INTERNET", "MARKETING", "OTHER"]),
    account_id: uuid, amount_minor: whole.refine(value => value !== 0), occurred_at: timestamp, description: text.optional(), reference: text.optional(), reverses_id: uuid.optional() }) }),
  WORKSPACE_CREATED: z.strictObject({ business: z.strictObject({ id: uuid, name, currency: z.literal("XAF") }),
    owner: z.strictObject({ id: uuid, name }), device: z.strictObject({ id: uuid, label: name, platform: z.enum(["ANDROID", "IOS", "DESKTOP"]), public_key: z.string().min(1).max(8192) }),
    accounts: z.array(z.strictObject({ id: uuid, name, kind: accountKind })).min(1).max(20) }),
  LEGACY_WORKSPACE_ADOPTED: z.strictObject({ business_id: uuid, owner_id: uuid, device_id: uuid, public_key: z.string().min(1).max(8192), provenance: z.literal("unsigned_v1_snapshot") }),
  MEMBER_CREATED: z.strictObject({ user_id: uuid, name, role: role.exclude(["OWNER"]), revision: z.literal(1) }),
  PERMISSION_GRANTED: z.strictObject({ user_id: uuid, permission, revision: positive }),
  PERMISSION_REVOKED: z.strictObject({ user_id: uuid, permission, revision: positive }),
  MEMBER_SUSPENDED: z.strictObject({ user_id: uuid, revision: positive }),
  MEMBER_REINSTATED: z.strictObject({ user_id: uuid, revision: positive }),
  MEMBER_ACCESS_RESET: z.strictObject({ user_id: uuid, revision: positive }),
  OWNER_ACCESS_RECOVERED: z.strictObject({ user_id: uuid, revision: positive }),
} as const;

/** Current supported event names; unknown signed names/versions can be retained unapplied. */
export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;
/** Checked per-event payload after structural validation; business rules remain shared core rules. */
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

/** Stable parser failures without echoing untrusted financial/customer data. */
export class EventContractError extends Error {
  readonly code: "invalid_event" | "invalid_payload" | "unsupported_event";
  constructor(code: EventContractError["code"]) { super(code); this.name = "EventContractError"; this.code = code; }
}

/** Signed immutable v2 facts; policy claims are validated against trusted current authority. */
export const journalEnvelopeSchema = z.strictObject({
  event_id: uuid, business_id: uuid, origin_device_id: uuid, actor_id: uuid,
  origin_sequence: positive, event_type: z.string().min(1).max(80), event_version: positive,
  occurred_at: timestamp, branch_id: uuid.nullable(), authority_revision: positive,
  required_permissions: z.array(permission).max(PERMISSIONS.length).refine(values => new Set(values).size === values.length),
  payload: z.record(z.string(), z.json()),
});
/** Complete, detached Ed25519 proof; content includes every immutable envelope field. */
export const signedJournalEventSchema = z.strictObject({ envelope: journalEnvelopeSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().regex(/^[a-f0-9]{128}$/) });
export type JournalEnvelope = z.infer<typeof journalEnvelopeSchema>;
export type SignedJournalEvent = z.infer<typeof signedJournalEventSchema>;

/** Structural validation and bounded canonical bytes, without asserting signature/trust. */
export function parseJournalEnvelope(input: unknown): JournalEnvelope {
  try { canonicalJson(input); } catch { throw new EventContractError("invalid_event"); }
  const result = journalEnvelopeSchema.safeParse(input);
  if (!result.success) throw new EventContractError("invalid_event");
  try { canonicalJson(result.data); } catch { throw new EventContractError("invalid_event"); }
  return result.data;
}
/** Rejects unknown current payload fields; unsupported signed versions are distinguishable. */
export function parseEventPayload<T extends EventType>(type: T, version: number, input: unknown): EventPayload<T> {
  if (version !== 2 || !Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, type)) throw new EventContractError("unsupported_event");
  try { canonicalJson(input); } catch { throw new EventContractError("invalid_payload"); }
  const result = EVENT_PAYLOAD_SCHEMAS[type].safeParse(input);
  if (!result.success) throw new EventContractError("invalid_payload");
  try { canonicalJson(result.data); } catch { throw new EventContractError("invalid_payload"); }
  return result.data as EventPayload<T>;
}
