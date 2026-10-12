import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@kolo/contracts/canonical";
import { transferUuid } from "@kolo/contracts/transfer";
import { saveProduct, adjustStock } from "@kolo/core/application/operations";
import { products, capabilities } from "@kolo/core/application/queries";
import { productOf, type Product } from "@kolo/core/data/products/products";
import { sealPendingEvents } from "@kolo/core/application/exchange";
import type { OperationContext } from "@kolo/core/identity/types";
import { TillState, atomicPrivateWrite, privatePath } from "./till-state.ts";
import { transferCrypto } from "./crypto.ts";

export function allProducts(context: OperationContext): Product[] {
  const result: Product[] = [];
  let page = products(context, { limit: 100, includeInactive: true });
  for (;;) { result.push(...page.items); if (!page.next) return result; page = products(context, { limit: 100, includeInactive: true, after: page.next }); }
}
interface ImportDocument { id: string; rows: Record<string, unknown>[] }
interface Plan { digest: string; at: string; kind: string; businessId: string; deviceId: string }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Import requires JSON objects");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, maximum = 120): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}: use integer minor units or thousandths`);
  return value;
}
function uuid(value: unknown): string {
  const parsed = transferUuid.safeParse(value); if (!parsed.success) throw new Error("Import IDs must be lowercase UUIDs"); return parsed.data;
}
function idFor(job: string, index: number, at: string): string {
  const hash = createHash("sha256").update(`kolo.cli-import.v1\0${job}\0${index}`).digest("hex");
  const time = Date.parse(at).toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export async function importData(till: TillState, kind: string, input: unknown, secret: string): Promise<{ id: string; rows: number; duplicate: boolean }> {
  if (!["products", "prices", "stock"].includes(kind)) throw new Error("Import supports products, prices or stock");
  const body = object(input);
  if (Object.keys(body).some(key => !["id", "rows"].includes(key))) throw new Error("Import accepts only id and rows");
  const id = uuid(body["id"]);
  if (!Array.isArray(body["rows"]) || body["rows"].length === 0 || body["rows"].length > 10000) throw new Error("Import requires 1–10000 rows");
  const document: ImportDocument = { id, rows: body["rows"].map(object) };
  const digest = createHash("sha256").update(canonicalJson({ kind, document }, 16 * 1024 * 1024)).digest("hex");
  const root = join(till.directory, "imports");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 }); privatePath(root, true);
  const path = join(root, `${id}.json`);
  let context = await till.unlock(secret);
  const previous: Plan | undefined = existsSync(path) ? (privatePath(path), JSON.parse(readFileSync(path, "utf8")) as Plan) : undefined;
  if (previous && (previous.digest !== digest || previous.kind !== kind || previous.businessId !== context.businessId || previous.deviceId !== context.deviceId)) throw new Error("Import ID already belongs to different content or a different till");
  const plan: Plan = previous ?? { digest, kind, at: new Date().toISOString(), businessId: context.businessId, deviceId: context.deviceId };
  if (!previous) atomicPrivateWrite(path, JSON.stringify(plan));
  // Stable event IDs let a retry recognize an atomic commit even if the process
  // stopped before printing its result or finishing the native signatures.
  const eventSeed = `${context.deviceId}:${id}`;
  const eventIdAt = (index: number): string => idFor(eventSeed, index, plan.at);
  const marker = eventIdAt(0);
  if (till.database.get("SELECT event_id FROM event_journal WHERE event_id=? AND business_id=? AND origin_device_id=?", [marker, context.businessId, context.deviceId])) {
    while (await sealPendingEvents(context, transferCrypto, 1000) === 1000) { /* Resume signature attachment. */ }
    return { id, rows: document.rows.length, duplicate: true };
  }
  let counter = 0;
  // Clock is fixed only during the synchronous commit, so authentication retry
  // timers and later sync retain the real clock.
  let importing = false;
  context = await till.unlock(secret, () => importing ? plan.at : new Date().toISOString(), () => eventIdAt(counter++));
  if (!capabilities(context).includes("products.view")) throw new Error("permission_denied");
  const seen = new Set<string>();
  importing = true;
  try {
    till.database.transaction(() => {
      for (const row of document.rows) {
        const productId = uuid(row["id"]);
        if (seen.has(productId)) throw new Error("Duplicate product ID in import"); seen.add(productId);
        const existing = productOf(till.database, context.businessId, productId);
        if (kind === "stock") {
          if (Object.keys(row).some(key => !["id", "quantityThousandths", "reason"].includes(key))) throw new Error("Stock rows accept id, quantityThousandths and reason");
          if (!existing) throw new Error("Unknown product ID");
          const eventId = eventIdAt(counter++);
          adjustStock(context, { id: eventIdAt(counter++), productId, type: "ADJUSTMENT", quantity: integer(row["quantityThousandths"], "quantityThousandths", -Number.MAX_SAFE_INTEGER), reason: text(row["reason"], "reason"), occurredAt: plan.at }, eventId);
        } else {
          const allowed = kind === "prices" ? ["id", "sellingPriceMinor", "purchasePriceMinor"] : ["id", "name", "unit", "divisible", "sellingPriceMinor", "purchasePriceMinor", "barcode", "minimumStock", "active"];
          if (Object.keys(row).some(key => !allowed.includes(key))) throw new Error(`Unsupported field in ${kind} import`);
          if (kind === "prices" && !existing) throw new Error("Unknown product ID");
          if (kind === "prices" && row["sellingPriceMinor"] === undefined && row["purchasePriceMinor"] === undefined) throw new Error("Price rows require a price");
          const name = row["name"] === undefined ? existing?.name : text(row["name"], "name");
          const unit = row["unit"] === undefined ? existing?.unit : text(row["unit"], "unit");
          const divisible = row["divisible"] ?? existing?.divisible ?? false, active = row["active"] ?? existing?.active ?? true;
          if (!name || !unit || typeof divisible !== "boolean" || typeof active !== "boolean") throw new Error("Product rows require name, unit and valid booleans");
          const sellingPriceMinor = integer(row["sellingPriceMinor"] ?? existing?.sellingPriceMinor, "sellingPriceMinor");
          const purchasePriceMinor = row["purchasePriceMinor"] === undefined ? existing?.purchasePriceMinor : integer(row["purchasePriceMinor"], "purchasePriceMinor");
          const barcode = row["barcode"] === undefined ? existing?.barcode : text(row["barcode"], "barcode", 256);
          if (!saveProduct(context, { ...existing, id: productId, name, unit, divisible, active, sellingPriceMinor, purchasePriceMinor, barcode,
            minimumStock: integer(row["minimumStock"] ?? existing?.minimumStock ?? 0, "minimumStock"), taxRateBasisPoints: existing?.taxRateBasisPoints ?? 0,
            currency: "XAF", createdAt: existing?.createdAt ?? plan.at, updatedAt: plan.at })) throw new Error("Product update lost to a newer edit; sync and submit a new import ID");
        }
      }
    });
  } finally { importing = false; }
  while (await sealPendingEvents(context, transferCrypto, 1000) === 1000) { /* Seal all committed facts. */ }
  return { id, rows: document.rows.length, duplicate: false };
}
