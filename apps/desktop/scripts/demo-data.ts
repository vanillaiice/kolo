/**
 * Builds a realistic demo shop through the real desktop operations and saves it as an
 * encrypted backup, so it can be restored on any installation (Linux, Windows, Wine).
 *
 * Usage: npm run demo:desktop -- [output directory] [days, default 90]
 *
 * Every write goes through `DesktopApplication`, exactly as the renderer would call it,
 * with a simulated clock that walks forward through the shop's history. Only the OS
 * vault is replaced by an in-memory AES key: the vault never leaves this process, and
 * the restored installation stores its own codes in its own vault.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, randomUUIDv7 } from "node:crypto";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import type { TransferDocument } from "@kolo/core/backup/types";
import { pickedBytes } from "../src/electron/transfer.ts";
import { DesktopApplication } from "../src/electron/application.ts";
import { localCredentialsOnDesktop, desktopExchangeCrypto, desktopTransferCrypto, type NativeSafeStorage } from "../src/electron/local-credentials.ts";
import type { Result, WorkspaceView } from "../src/shared/service.ts";

const OWNER_SECRET = "482915", CASHIER_SECRET = "731264", MANAGER_SECRET = "590372";
const BACKUP_PASSWORD = "kolo-demo-2026";
const outputDirectory = resolve(process.argv[2] ?? "kolo-demo");
const days = Math.max(7, Math.min(365, Number(process.argv[3] ?? 90)));

// Seeded generator: the same choices each run (identifiers still differ).
let seed = 20261009;
function random(): number { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function between(low: number, high: number): number { return low + Math.floor(random() * (high - low + 1)); }
function pick<T>(items: readonly T[]): T { return items[Math.floor(random() * items.length)]!; }
function chance(probability: number): boolean { return random() < probability; }
function weighted<T extends { readonly weight: number }>(items: readonly T[]): T {
  let left = random() * items.reduce((sum, item) => sum + item.weight, 0);
  for (const item of items) { left -= item.weight; if (left <= 0) return item; }
  return items[items.length - 1]!;
}

function value<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${result.error.code}`);
  return result.value;
}

function memoryVault(): NativeSafeStorage {
  const key = randomBytes(32);
  return { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async message => { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, cipher.update(message, "utf8"), cipher.final(), cipher.getAuthTag()]); },
    decryptStringAsync: async bytes => { const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return { result: Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"), shouldReEncrypt: false }; } };
}

/** Name, unit, divisible, price, cost, barcode suffix, opening stock (units), sales weight. */
type Item = readonly [name: string, unit: string, divisible: boolean, price: number, cost: number, stock: number, weight: number];
const CATALOGUE: Readonly<Record<string, readonly Item[]>> = {
  "Céréales et féculents": [
    ["Riz parfumé 25kg", "sac", false, 18_500, 16_000, 12, 3], ["Riz parfumé (vrac)", "kg", true, 800, 640, 80, 9],
    ["Farine de blé 1kg", "paquet", false, 750, 580, 40, 5], ["Spaghetti Panzani 500g", "paquet", false, 600, 450, 60, 8],
    ["Macaroni 500g", "paquet", false, 550, 420, 40, 4], ["Semoule de maïs 1kg", "paquet", false, 700, 520, 30, 4],
    ["Haricots rouges (vrac)", "kg", true, 1_000, 780, 40, 5], ["Gari blanc (vrac)", "kg", true, 600, 450, 50, 6],
  ],
  "Huiles et condiments": [
    ["Huile Mayor 1L", "bouteille", false, 1_400, 1_150, 48, 8], ["Huile Diamaor 5L", "bidon", false, 6_800, 5_900, 10, 2],
    ["Huile de palme (vrac)", "litre", true, 1_100, 850, 30, 4], ["Cube Maggi", "cube", false, 25, 18, 1_200, 10],
    ["Sel fin 1kg", "paquet", false, 300, 210, 40, 4], ["Tomate concentrée 70g", "boîte", false, 150, 105, 150, 9],
    ["Poivre blanc 50g", "sachet", false, 400, 280, 30, 2], ["Mayonnaise Bama 470g", "pot", false, 2_100, 1_700, 12, 2],
  ],
  "Petit-déjeuner": [
    ["Sucre en morceaux 1kg", "boîte", false, 1_000, 800, 40, 6], ["Sucre en poudre (vrac)", "kg", true, 850, 690, 50, 5],
    ["Lait Nido 400g", "boîte", false, 3_200, 2_650, 18, 3], ["Lait Peak sachet 18g", "sachet", false, 100, 72, 300, 7],
    ["Café Nescafé 50g", "boîte", false, 1_800, 1_450, 15, 2], ["Lipton thé (25 sachets)", "boîte", false, 900, 700, 20, 2],
    ["Ovaltine 400g", "boîte", false, 2_600, 2_150, 12, 2], ["Pain de mie", "paquet", false, 800, 600, 15, 5],
  ],
  "Conserves": [
    ["Sardines Joly 125g", "boîte", false, 500, 380, 90, 7], ["Maquereau à la tomate 425g", "boîte", false, 1_100, 880, 30, 3],
    ["Corned beef 340g", "boîte", false, 1_900, 1_550, 15, 2], ["Petits pois 400g", "boîte", false, 700, 540, 20, 2],
  ],
  "Boissons": [
    ["Eau Supermont 1,5L", "bouteille", false, 400, 300, 120, 9], ["Eau Tangui 0,5L", "bouteille", false, 250, 180, 120, 7],
    ["Coca-Cola 33cl", "canette", false, 500, 380, 96, 7], ["Top Ananas 60cl", "bouteille", false, 500, 380, 72, 6],
    ["Jus Foléré 50cl", "bouteille", false, 300, 200, 40, 3], ["Malta Guinness 33cl", "bouteille", false, 600, 470, 48, 4],
    ["Vitamalt 33cl", "bouteille", false, 600, 470, 48, 3],
  ],
  "Hygiène et entretien": [
    ["Savon Azur", "morceau", false, 250, 180, 120, 6], ["Savon de Marseille 400g", "morceau", false, 500, 380, 40, 3],
    ["Omo 500g", "sachet", false, 900, 720, 40, 4], ["Javel La Croix 1L", "bouteille", false, 800, 600, 24, 2],
    ["Dentifrice Signal 100ml", "tube", false, 900, 700, 24, 2], ["Papier hygiénique (4 rouleaux)", "paquet", false, 1_200, 950, 24, 2],
    ["Couches Pampers T4 (x10)", "paquet", false, 3_500, 2_900, 12, 1], ["Serviettes Always", "paquet", false, 1_000, 780, 24, 2],
  ],
  "Divers": [
    ["Allumettes (x10)", "paquet", false, 250, 170, 40, 2], ["Bougie", "pièce", false, 100, 65, 100, 2],
    ["Piles AA (x2)", "paquet", false, 500, 350, 30, 1], ["Sachet plastique", "pièce", false, 25, 12, 500, 3],
    ["Pétrole lampant (vrac)", "litre", true, 700, 560, 40, 2], ["Charbon de bois", "sac", false, 3_000, 2_400, 10, 1],
    ["Crédit MTN 1000", "carte", false, 1_000, 950, 50, 3], ["Crédit Orange 1000", "carte", false, 1_000, 950, 50, 3],
  ],
};
const CUSTOMERS = [
  ["Awa Ndiaye", "+237 677 12 34 56", "Quartier Mvog-Mbi", 50_000], ["Paul Essomba", "+237 699 45 67 01", "Rue des Manguiers", 30_000],
  ["Marie-Claire Atangana", "+237 655 33 21 90", "Nkolndongo", 40_000], ["Ibrahim Moussa", "+237 670 88 12 45", "Briqueterie", 25_000],
  ["Restaurant Chez Tanty", "+237 691 00 22 33", "Carrefour Elig-Essono", 150_000], ["Pasteur Nkoulou", "+237 677 54 32 10", undefined, 20_000],
  ["Fatou Bello", "+237 696 71 82 93", "Mokolo", 15_000], ["École Les Petits Génies", "+237 222 23 45 67", "Essos", 200_000],
  ["Jean-Pierre Mbida", "+237 680 11 22 33", undefined, 0], ["Bernadette Ngo Nyemb", "+237 694 56 78 12", "Mimboman", 35_000],
] as const;
const SUPPLIERS = [
  ["Grossiste Ets Fotso & Fils", "+237 233 42 11 00", "Marché Mokolo, Yaoundé", "M. Fotso"],
  ["Société des Eaux Minérales (SEMC)", "+237 233 50 60 70", "Douala", "Service commercial"],
  ["Boissons du Cameroun — dépôt Essos", "+237 222 21 33 44", "Essos, Yaoundé", "Mme Abena"],
  ["Hygiène Plus Distribution", "+237 699 99 01 02", "Akwa, Douala", "Didier"],
  ["Coopérative agricole de la Lékié", "+237 677 30 40 50", "Monatélé", "Président"],
] as const;
const SUPPLIER_OF: Readonly<Record<string, number>> = {
  "Céréales et féculents": 0, "Huiles et condiments": 0, "Petit-déjeuner": 0, "Conserves": 0, "Boissons": 2, "Hygiène et entretien": 3, "Divers": 0,
};

async function main(): Promise<void> {
  const workDirectory = mkdtempSync(join(tmpdir(), "kolo-demo-"));
  try {
    const slots = nodeWorkspaceFiles(join(workDirectory, "data")), database = slots.openActive(); migrate(database);
    let clock = Date.parse("2026-10-09T18:00:00.000Z") - days * 86_400_000;
    const at = (): string => new Date(clock).toISOString(), advance = (minutes: number): void => { clock += minutes * 60_000; };
    const saved: TransferDocument[] = [];
    const app = new DesktopApplication({ database, credentials: localCredentialsOnDesktop(join(workDirectory, "vault"), memoryVault()), newId: randomUUIDv7, now: at },
      desktopExchangeCrypto, { files: slots, dialogs: { open: async () => undefined, save: async document => { saved.push(document); return true; } },
        crypto: desktopTransferCrypto, onActivated: async () => undefined });
    await app.initialize();

    // Day 0: the owner sets the shop up.
    clock += 7 * 3_600_000;
    const setup = value(await app.createShop({ businessName: "Alimentation Chez Mama Ngono", ownerName: "Mama Ngono", deviceLabel: "Caisse principale", cashAccountName: "Caisse", secret: OWNER_SECRET }), "setup");
    const ownerId = setup.members[0]!.id;
    let current: { userId: string; sessionId: string } | undefined;
    const as = async (userId: string, secret: string): Promise<string> => {
      if (current?.userId === userId) return current.sessionId;
      if (current !== undefined) value(await app.lock(), "lock");
      const view: WorkspaceView = value(await app.unlock({ userId, secret }), "unlock");
      current = { userId, sessionId: view.sessionId! }; return current.sessionId;
    };
    let session = await as(ownerId, OWNER_SECRET);

    const staffRows = [["Aïcha Bello", "CASHIER", CASHIER_SECRET], ["Serge Onana", "MANAGER", MANAGER_SECRET]] as const;
    const staffIds: string[] = [];
    for (const [name, role, secret] of staffRows) {
      value(await app.createStaff({ sessionId: session, name, role, secret }), `staff ${name}`); advance(2);
      // Creating staff can refresh identity state; re-open the owner's session afterwards.
      current = undefined; session = await as(ownerId, OWNER_SECRET);
    }
    for (const member of value(await app.listStaff({ sessionId: session }), "staff")) if (!member.isSelf) staffIds.push(member.id);
    const [cashierId, managerId] = staffIds as [string, string];
    // The owner trusts both to sell on credit to known customers.
    for (const userId of staffIds) value(await app.setStaffPermission({ sessionId: session, userId, permission: "customers.credit", allowed: true }), "credit permission");

    const cash = value(await app.listAccounts({ sessionId: session }), "accounts").items[0]!;
    const account = async (name: string, kind: "MOBILE_MONEY" | "BANK"): Promise<string> =>
      value(await app.createAccount({ sessionId: session, requestId: randomUUID(), name, kind }), name).id;
    const mtn = await account("MTN Mobile Money", "MOBILE_MONEY"), orange = await account("Orange Money", "MOBILE_MONEY"), bank = await account("Afriland First Bank", "BANK");
    // Opening float in the till and on the wallets.
    for (const [id, amount] of [[cash.id, 50_000], [mtn, 25_000], [orange, 15_000], [bank, 400_000]] as const)
      value(await app.moveMoney({ sessionId: session, requestId: randomUUID(), accountId: id, direction: "in", amountMinor: amount, reason: "Fonds de départ" }), "opening float");

    interface Product { id: string; name: string; divisible: boolean; price: number; cost: number; weight: number; category: string; stock: number; reorder: number; }
    const products: Product[] = [];
    let barcode = 6_181_000_000_000;
    for (const [categoryName, items] of Object.entries(CATALOGUE)) {
      const category = value(await app.createCategory({ sessionId: session, requestId: randomUUID(), name: categoryName }), categoryName);
      for (const [name, unit, divisible, price, cost, stock, weight] of items) {
        barcode += between(1, 97);
        const created = value(await app.createProduct({ sessionId: session, requestId: randomUUID(), name, unit, divisible, sellingPriceMinor: price,
          purchasePriceMinor: cost, barcode: String(barcode), openingThousandths: stock * 1000 }), name);
        const reorder = Math.max(2, Math.round(stock / 4));
        const detail = value(await app.updateProduct({ sessionId: session, productId: created.id, version: created.version, name, unit, barcode: String(barcode),
          sellingPriceMinor: price, purchasePriceMinor: cost, categoryId: category.id, minimumStockThousandths: reorder * 1000 }), `categorise ${name}`);
        products.push({ id: detail.id, name, divisible, price, cost, weight, category: categoryName, stock: stock * 1000, reorder: reorder * 1000 });
        advance(1);
      }
    }
    const customers: { id: string; name: string; owed: number; limit: number }[] = [];
    for (const [name, phone, address, limit] of CUSTOMERS) {
      const created = value(await app.createCustomer({ sessionId: session, requestId: randomUUID(), name, phone, ...(address === undefined ? {} : { address }), creditLimitMinor: limit }), name);
      customers.push({ id: created.id, name, owed: 0, limit });
    }
    const suppliers: string[] = [];
    for (const [name, phone, address, contact] of SUPPLIERS)
      suppliers.push(value(await app.createSupplier({ sessionId: session, requestId: randomUUID(), name, phone, address, contact }), name).id);

    const counts = { sales: 0, creditSales: 0, purchases: 0, expenses: 0, payments: 0, returns: 0, refused: 0 };
    const recentSales: { saleId: string; customer: boolean }[] = [];
    const accounts = { cash: cash.id, mtn, orange, bank };
    let tillCash = 50_000;

    for (let day = 0; day < days; day++) {
      const morning = Date.parse(new Date(Date.parse("2026-10-09T00:00:00.000Z") - (days - day) * 86_400_000).toISOString());
      clock = Math.max(clock, morning + 7 * 3_600_000 + between(0, 40) * 60_000);
      const date = new Date(clock), weekday = date.getUTCDay(), monthDay = date.getUTCDate();
      if (weekday === 0 && chance(0.6)) continue; // Often closed on Sundays.

      // Aïcha runs the till most days; Serge covers on her day off.
      const tillOperator = weekday === 3 ? { id: managerId, secret: MANAGER_SECRET } : { id: cashierId, secret: CASHIER_SECRET };
      let tillSession = await as(tillOperator.id, tillOperator.secret);
      const busy = weekday === 6 ? 1.5 : monthDay >= 25 || monthDay <= 3 ? 1.3 : 1;
      const saleCount = Math.round(between(14, 30) * busy);
      for (let n = 0; n < saleCount; n++) {
        advance(between(8, 45) * (13 * 60 / 30 / saleCount) * 1.6);
        const lineCount = chance(0.45) ? 1 : chance(0.6) ? between(2, 3) : between(4, 7);
        const chosen = new Map<string, { product: Product; quantity: number }>();
        for (let i = 0; i < lineCount; i++) {
          const product = weighted(products);
          if (chosen.has(product.id)) continue;
          const quantity = product.divisible ? pick([250, 500, 500, 1000, 1000, 1500, 2000, 3000]) : 1000 * (chance(0.7) ? 1 : between(2, product.price <= 150 ? 10 : 4));
          if (product.stock - quantity < 0) continue;
          chosen.set(product.id, { product, quantity });
        }
        if (chosen.size === 0) continue;
        const lines = [...chosen.values()].map(({ product, quantity }) => ({ productId: product.id, quantity, unitPriceMinor: product.price }));
        const total = [...chosen.values()].reduce((sum, { product, quantity }) => sum + Math.round(product.price * quantity / 1000), 0);
        let discountMinor = 0;
        if (total >= 10_000 && chance(0.25)) discountMinor = Math.min(500, Math.round(total * 0.03 / 25) * 25);
        if (discountMinor > 0) tillSession = await as(ownerId, OWNER_SECRET); // Discounts need sales.discount.
        const payable = total - discountMinor, roll = random();
        const customer = roll < 0.12 ? pick(customers) : undefined;
        let payments: { accountId: string; amountMinor: number }[];
        if (customer !== undefined && customer.limit > 0) {
          const paid = chance(0.4) ? Math.round(payable * pick([0.25, 0.5]) / 25) * 25 : 0;
          payments = paid > 0 ? [{ accountId: accounts.cash, amountMinor: paid }] : [];
        } else if (roll < 0.30) payments = [{ accountId: accounts.mtn, amountMinor: payable }];
        else if (roll < 0.38) payments = [{ accountId: accounts.orange, amountMinor: payable }];
        else if (roll < 0.43 && payable >= 2_000) { const part = Math.round(payable / 2 / 25) * 25; payments = [{ accountId: accounts.cash, amountMinor: part }, { accountId: accounts.mtn, amountMinor: payable - part }]; }
        else payments = [{ accountId: accounts.cash, amountMinor: payable }];
        const onCredit = customer !== undefined && customer.limit > 0;
        const result = await app.checkout({ sessionId: tillSession, requestId: randomUUID(), payments, lines,
          ...(onCredit ? { customerId: customer.id } : {}), ...(discountMinor > 0 ? { discountMinor } : {}) });
        if (!result.ok) { counts.refused++; if (process.env["DEMO_DEBUG"]) process.stderr.write(`checkout ${result.error.code} credit=${onCredit} discount=${discountMinor}\n`); if (discountMinor > 0) tillSession = await as(tillOperator.id, tillOperator.secret); continue; }
        counts.sales++;
        for (const { product, quantity } of chosen.values()) product.stock -= quantity;
        for (const payment of payments) if (payment.accountId === accounts.cash) tillCash += payment.amountMinor;
        if (onCredit) { counts.creditSales++; customer.owed += payable - payments.reduce((sum, payment) => sum + payment.amountMinor, 0); }
        recentSales.push({ saleId: result.value.saleId, customer: onCredit }); if (recentSales.length > 40) recentSales.shift();
        if (discountMinor > 0) tillSession = await as(tillOperator.id, tillOperator.secret);
      }

      // Customers settle part of their debt, mostly at the end of the month.
      for (const customer of customers) {
        if (customer.owed <= 0 || !chance(monthDay >= 25 || monthDay <= 5 ? 0.35 : 0.08)) continue;
        const amount = Math.min(customer.owed, Math.max(500, Math.round(customer.owed * pick([0.3, 0.5, 1]) / 100) * 100));
        const paidTo = chance(0.5) ? accounts.cash : accounts.mtn;
        if ((await app.receiveCustomerPayment({ sessionId: tillSession, requestId: randomUUID(), customerId: customer.id, accountId: paidTo, amountMinor: amount, note: "Règlement" })).ok) {
          customer.owed -= amount; counts.payments++; if (paidTo === accounts.cash) tillCash += amount;
        }
        advance(between(3, 10));
      }

      // Occasional returns of a recent sale (damaged or wrong item).
      if (chance(0.08) && recentSales.length > 5) {
        session = await as(ownerId, OWNER_SECRET);
        const sale = recentSales[between(0, recentSales.length - 3)]!;
        const source = await app.returnSource({ sessionId: session, kind: "SALE", originalId: sale.saleId });
        if (source.ok) {
          const item = source.value.items.find(entry => entry.originalQuantity > entry.returnedQuantity);
          if (item !== undefined) {
            const quantity = item.originalQuantity - item.returnedQuantity >= 2000 ? 1000 : item.originalQuantity - item.returnedQuantity;
            const preview = await app.previewReturn({ sessionId: session, kind: "SALE", originalId: sale.saleId, items: [{ originalItemId: item.id, quantity }] });
            if (preview.ok) {
              const refund = sale.customer ? undefined : { accountId: accounts.cash, amountMinor: preview.value.totalMinor };
              const recorded = await app.recordReturn({ sessionId: session, requestId: randomUUID(), kind: "SALE", originalId: sale.saleId,
                ...(source.value.priorId === undefined ? {} : { priorId: source.value.priorId }), reason: pick(["Produit abîmé", "Date de péremption dépassée", "Erreur de produit"]),
                items: [{ originalItemId: item.id, quantity }], ...(refund === undefined ? {} : { refund }) });
              if (recorded.ok) { counts.returns++; if (refund !== undefined) tillCash -= refund.amountMinor; }
            }
          }
        }
      }

      // Evening: the owner restocks, pays bills and banks the takings.
      advance(between(20, 50));
      session = await as(ownerId, OWNER_SECRET);
      const low = products.filter(product => product.stock <= product.reorder);
      const bySupplier = new Map<number, Product[]>();
      for (const product of low) { const supplier = SUPPLIER_OF[product.category]!; bySupplier.set(supplier, [...(bySupplier.get(supplier) ?? []), product]); }
      if (chance(0.25)) bySupplier.set(1, [...(bySupplier.get(1) ?? []), ...products.filter(product => product.name.startsWith("Eau"))]);
      if (chance(0.1)) bySupplier.set(4, [...(bySupplier.get(4) ?? []), ...products.filter(product => /vrac/.test(product.name) && !/sucre|pétrole/i.test(product.name))]);
      for (const [supplier, items] of bySupplier) {
        const unique = [...new Map(items.map(item => [item.id, item])).values()];
        const lines = unique.map(product => {
          const units = Math.max(product.reorder / 1000 * 3, 6);
          const cost = chance(0.15) ? Math.round(product.cost * 1.05) : product.cost;
          return { productId: product.id, quantity: units * 1000, unitCostMinor: cost };
        });
        const total = lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitCostMinor / 1000), 0);
        const from = total > 150_000 ? accounts.bank : accounts.cash;
        const paid = chance(0.3) ? Math.round(total * pick([0.5, 0.7]) / 100) * 100 : total;
        const payable = from === accounts.cash ? Math.min(paid, tillCash) : paid;
        const purchase = await app.recordPurchase({ sessionId: session, requestId: randomUUID(), supplierId: suppliers[supplier]!, reference: `BL-${String(counts.purchases + 1041).padStart(5, "0")}`,
          lines, ...(payable > 0 ? { payment: { accountId: from, amountMinor: payable } } : {}) });
        if (purchase.ok) {
          counts.purchases++;
          for (const line of lines) products.find(product => product.id === line.productId)!.stock += line.quantity;
          if (from === accounts.cash) tillCash -= payable;
        } else { counts.refused++; if (process.env["DEMO_DEBUG"]) process.stderr.write(`purchase ${purchase.error.code}\n`); }
        advance(between(5, 15));
      }

      const expense = async (category: string, amountMinor: number, description: string, accountId = accounts.cash): Promise<void> => {
        if (accountId === accounts.cash && amountMinor > tillCash) accountId = accounts.bank;
        if ((await app.recordExpense({ sessionId: session, requestId: randomUUID(), accountId, category, amountMinor, description })).ok) {
          counts.expenses++; if (accountId === accounts.cash) tillCash -= amountMinor;
        }
        advance(between(2, 6));
      };
      if (monthDay === 1) await expense("RENT", 85_000, "Loyer de la boutique", accounts.bank);
      if (monthDay === 28) { await expense("SALARY", 60_000, "Salaire Aïcha", accounts.bank); await expense("SALARY", 75_000, "Salaire Serge", accounts.bank); }
      if (monthDay === 10) await expense("ELECTRICITY", between(18, 26) * 1_000, "Facture ENEO");
      if (monthDay === 12) await expense("WATER", between(4, 7) * 1_000, "Facture CAMWATER");
      if (monthDay === 5) await expense("INTERNET", 10_000, "Forfait internet", accounts.mtn);
      if (chance(0.3)) await expense("TRANSPORT", between(2, 8) * 500, "Transport marchandises");
      if (chance(0.05)) await expense("MAINTENANCE", between(5, 20) * 1_000, pick(["Réparation congélateur", "Ampoules et électricité", "Serrure du magasin"]));
      if (chance(0.06)) await expense("PACKAGING", between(3, 6) * 1_000, "Sachets et emballages");

      // Occasional damage, monthly count of a few shelves.
      if (chance(0.07)) {
        const product = pick(products.filter(item => item.stock >= 2000));
        if ((await app.moveStock({ sessionId: session, requestId: randomUUID(), productId: product.id, kind: "damage", quantityThousandths: 1000, reason: pick(["Emballage déchiré", "Produit périmé", "Bouteille cassée"]) })).ok) product.stock -= 1000;
      }
      if (monthDay === 15) for (const product of products.filter(() => chance(0.15))) {
        const counted = Math.max(0, product.stock - (chance(0.3) ? (product.divisible ? 500 : 1000) : 0));
        if ((await app.countStock({ sessionId: session, requestId: randomUUID(), productId: product.id, countedThousandths: counted, reason: "Inventaire du 15" })).ok) product.stock = counted;
        advance(1);
      }

      // Bank the surplus cash twice a week and count the drawer.
      if ((weekday === 2 || weekday === 5) && tillCash > 120_000) {
        const amount = Math.floor((tillCash - 60_000) / 5_000) * 5_000;
        if ((await app.transferMoney({ sessionId: session, requestId: randomUUID(), fromAccountId: accounts.cash, toAccountId: accounts.bank, amountMinor: amount, reason: "Versement banque" })).ok) tillCash -= amount;
      }
      if (weekday === 6 && chance(0.5)) await app.countCash({ sessionId: session, accountId: accounts.cash, countedMinor: tillCash });
      if (chance(0.15)) {
        const supplier = pick(suppliers), statement = await app.getSupplier({ sessionId: session, supplierId: supplier });
        const owed = statement.ok ? statement.value.outstandingMinor : 0;
        if (owed > 0) {
          const amount = Math.min(owed, Math.round(owed * pick([0.5, 1]) / 100) * 100);
          if ((await app.paySupplier({ sessionId: session, requestId: randomUUID(), supplierId: supplier, accountId: accounts.bank, amountMinor: amount, note: "Règlement fournisseur" })).ok) counts.payments++;
        }
      }
      if (day % 10 === 0) process.stdout.write(`day ${day + 1}/${days}: ${counts.sales} sales\n`);
    }

    // Save the encrypted backup that the desktop app restores.
    session = await as(ownerId, OWNER_SECRET);
    await app.seal();
    if (process.env["DEMO_DEBUG"]) {
      const size = (sql: string): number => Number(Object.values(database.get(sql)!)[0]);
      process.stderr.write(`database ${(size("PRAGMA page_count") * size("PRAGMA page_size") / 1048576).toFixed(1)} MiB, events ${size("SELECT count(*) FROM event_journal")}\n`);
      for (const row of database.all("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 8")) process.stderr.write(`  ${String(row["name"])} ${(Number(row["bytes"]) / 1048576).toFixed(1)} MiB\n`);
    }
    value(await app.saveBackup({ sessionId: session, password: BACKUP_PASSWORD }), "backup");
    const document = saved[saved.length - 1]!;
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, document.filename), document.bytes);
    writeFileSync(join(outputDirectory, "README.txt"), [
      "kolo demo shop: Alimentation Chez Mama Ngono", "",
      `Backup file: ${document.filename}`, `Backup password: ${BACKUP_PASSWORD}`, "",
      "Restore: start kolo on a fresh installation, choose Restore a backup, pick the file,",
      "enter the backup password, confirm the shop name and choose a code for this computer.", "",
      `History: ${days} days ending 2026-10-09. ${counts.sales} sales (${counts.creditSales} on credit), ${counts.purchases} supplier deliveries,`,
      `${counts.expenses} expenses, ${counts.payments} debt payments, ${counts.returns} returns, ${products.length} products, ${customers.length} customers, ${suppliers.length} suppliers.`, "",
      "The code you choose while restoring opens the owner, Mama Ngono. Staff codes are per computer and do not",
      "travel in a backup: reset Aïcha Bello (cashier) and Serge Onana (manager) from Staff to sign in as them.", "",
    ].join("\n"));
    process.stdout.write(`${JSON.stringify(counts)}\nWrote ${join(outputDirectory, document.filename)}\n`);
    await app.dispose(); database.close();
    await verifyRestore(document, counts.sales);
  } finally { rmSync(workDirectory, { recursive: true, force: true }); }
}

/** Restores the backup on a fresh installation, as the app's restore screen does, and reads it back. */
async function verifyRestore(document: TransferDocument, expectedSales: number): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "kolo-demo-restore-"));
  try {
    const slots = nodeWorkspaceFiles(join(directory, "data")), opened: { app?: DesktopApplication; database?: ReturnType<typeof slots.openActive> } = {};
    const credentials = localCredentialsOnDesktop(join(directory, "vault"), memoryVault());
    const serve = async (database: ReturnType<typeof slots.openActive>): Promise<DesktopApplication> => {
      const app = new DesktopApplication({ database, credentials, newId: randomUUIDv7, now: () => new Date().toISOString() }, desktopExchangeCrypto,
        { files: slots, dialogs: { open: async () => pickedBytes(document.bytes), save: async () => false }, crypto: desktopTransferCrypto,
          onActivated: async next => { migrate(next); const previous = opened.app; opened.app = await serve(next); opened.database = next; void previous?.dispose(); } });
      await app.initialize(); return app;
    };
    const first = slots.openActive(); migrate(first); opened.database = first; opened.app = await serve(first);
    const preview = value(await opened.app.openBackup({ password: BACKUP_PASSWORD }), "open backup");
    value(await opened.app.restoreBackup({ confirmedName: preview.businessName, deviceLabel: "Vérification", secret: "135790" }), "restore");
    const app = opened.app!, workspace = value(await app.getWorkspace(), "workspace");
    const owner = workspace.members.find(member => member.name === "Mama Ngono") ?? workspace.members[0]!;
    const sessionId = value(await app.unlock({ userId: owner.id, secret: "135790" }), "unlock restored").sessionId!;
    const sales = value(await app.report({ sessionId, kind: "sales", from: "2020-01-01T00:00:00.000Z", until: "2030-01-01T00:00:00.000Z" }), "sales report");
    const debt = value(await app.report({ sessionId, kind: "customerDebt", from: "2020-01-01T00:00:00.000Z", until: "2030-01-01T00:00:00.000Z" }), "debt report");
    const products = value(await app.listProducts({ sessionId, limit: 100 }), "products").items.length;
    const cashier = workspace.members.find(member => member.name === "Aïcha Bello");
    value(await app.lock(), "lock restored");
    const staffCodes = cashier !== undefined && (await app.unlock({ userId: cashier.id, secret: CASHIER_SECRET })).ok;
    process.stdout.write(`Staff codes after restore: ${staffCodes ? "kept" : "must be reset by the owner"}\n`);
    process.stdout.write(`Restore check: ${workspace.shopName}, ${workspace.members.length} members, ${products} products, ${JSON.stringify(sales)}, debtors ${"lines" in debt ? debt.lines.length : 0}\n`);
    if (!JSON.stringify(sales).includes(String(expectedSales))) throw new Error(`restored sales do not show ${expectedSales} sales`);
    await app.dispose(); opened.database?.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

await main();
