import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { protectedCredentials } from "@kolo/core/identity/credentials";
import { createWorkspace, unlockWorkspace } from "@kolo/core/identity/workspace";
import { saveProduct, adjustStock, completeSale } from "@kolo/core/application/operations";
import { createBackup } from "@kolo/core/application/backup";
import { sealPendingEvents } from "@kolo/core/application/exchange";
import { LARGE_TRANSFER_LIMITS } from "@kolo/core/backup/types";
import { fixtureCrypto, transferCrypto } from "./crypto.ts";

export interface FixtureOptions { products: number; sales: number; days: number; seed: number; name: string; password: string }
/** Signed fixtures exercise the same authorized operations as the apps, in a fresh shop only. */
export async function generateFixture(options: FixtureOptions): Promise<{ text: string; products: number; sales: number; elapsedMs: number }> {
  const start = performance.now(), directory = mkdtempSync(join(tmpdir(), "kolo-cli-fixture-"));
  const files = nodeWorkspaceFiles(directory, { limits: () => LARGE_TRANSFER_LIMITS });
  const database = files.openActive();
  const secrets = new Map<string, string>();
  let clock = new Date(Date.UTC(2026, 0, 1)).toISOString(), seed = options.seed;
  const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const ports = { database, newId: randomUUIDv7, now: () => clock, credentials: protectedCredentials({
    read: async key => secrets.get(key), write: async (key, value) => { secrets.set(key, value); }, forget: async key => { secrets.delete(key); },
  }, fixtureCrypto) };
  try {
    migrate(database);
    const installation = await createWorkspace({ businessName: options.name, ownerName: "Fixture owner", secret: "654321", deviceLabel: "CLI fixture", platform: "DESKTOP", currency: "XAF" }, ports);
    const context = await unlockWorkspace({ userId: installation.ownerId, secret: "654321" }, ports);
    const seal = async (): Promise<void> => { while (await sealPendingEvents(context, transferCrypto, 1000) === 1000) { /* Drain bounded batches. */ } };
    const accountId = String(database.get("SELECT id FROM financial_accounts LIMIT 1")!["id"]);
    const products: { id: string; name: string; price: number; cost: number }[] = [];
    for (let i = 0; i < options.products; i++) {
      const product = { id: randomUUIDv7(), name: `Product ${String(i + 1).padStart(5, "0")}`, price: 100 + Math.floor(random() * 100) * 50, cost: 0 };
      product.cost = Math.floor(product.price * 0.6);
      saveProduct(context, { ...product, unit: "unit", divisible: false, barcode: `CLI${i + 1}`, sellingPriceMinor: product.price,
        purchasePriceMinor: product.cost, currency: "XAF", taxRateBasisPoints: 0, minimumStock: 1000, active: true, createdAt: clock, updatedAt: clock });
      adjustStock(context, { id: randomUUIDv7(), productId: product.id, type: "OPENING_BALANCE", quantity: (options.sales + 100) * 1000,
        unitCostMinor: product.cost, unitCostCurrency: "XAF", occurredAt: clock }, randomUUIDv7());
      products.push(product);
      if ((i + 1) % 1000 === 0) await seal();
    }
    for (let i = 0; i < options.sales; i++) {
      clock = new Date(Date.UTC(2026, 0, 1) + Math.floor(i / Math.max(1, options.sales) * options.days * 86400000)).toISOString();
      const product = products[Math.floor(random() * products.length)]!;
      completeSale(context, { id: randomUUIDv7(), number: `FIX-${String(i + 1).padStart(8, "0")}`, eventId: randomUUIDv7(), occurredAt: clock,
        lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: product.id, name: product.name, unitPriceMinor: product.price, unitCostMinor: product.cost, quantity: 1000 }],
        payments: [{ id: randomUUIDv7(), accountId, amountMinor: product.price }] });
      if ((i + 1) % 1000 === 0) await seal();
    }
    const document = await createBackup(context, options.password, files, transferCrypto);
    return { text: document.text, products: options.products, sales: options.sales, elapsedMs: Math.round(performance.now() - start) };
  } finally {
    secrets.clear(); database.close(); files.close(); rmSync(directory, { recursive: true, force: true });
  }
}
