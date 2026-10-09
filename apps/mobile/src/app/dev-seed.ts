/**
 * A shop to develop against, without a server.
 *
 * Explicit developer fixture for the legacy-to-local migration flow.
 * Run `npm run dev:mobile:demo` to opt in; normal boot never invents a shop.
 *
 * It is kept honest in four ways so it cannot quietly become production:
 *
 * 1. It is called only when the database holds no business at all, so it can
 *    never touch a device that has real data on it.
 * 2. It is called only under `__DEV__`, so a release build that somehow reached
 *    an unenrolled device shows standalone setup rather than inventing a shop.
 * 3. `EXPO_PUBLIC_DEMO_SHOP=1` is required; unset/0 never enrolls a demo.
 * 4. It writes nothing to the outbox, and the session it writes has **no
 *    token**: these rows are local only, and a sync would be refused rather
 *    than putting a fictional business on somebody's server.
 */

import type { Database } from "@kolo/core/data/database/driver";

/** Fixed identifiers, so a developer's data survives a reload. */
const BUSINESS = "00000000-0000-7000-8000-000000000001";
const USER = "00000000-0000-7000-8000-000000000002";
const DEVICE = "00000000-0000-7000-8000-000000000003";
const TILL_ACCOUNT = "00000000-0000-7000-8000-000000000004";
const WALLET_ACCOUNT = "00000000-0000-7000-8000-000000000005";
const SESSION = "00000000-0000-7000-8000-000000000006";

/** Enough of a catalogue to type into a search box. */
const CATALOGUE: ReadonlyArray<
  readonly [id: string, name: string, unit: string, price: number, cost: number, barcode: string]
> = [
  ["00000000-0000-7000-8000-000000000101", "Riz parfumé 5kg", "sac", 6_500, 5_000, "6001234567890"],
  ["00000000-0000-7000-8000-000000000102", "Sucre 1kg", "paquet", 900, 700, "6001234567891"],
  ["00000000-0000-7000-8000-000000000103", "Huile de palme 1L", "bouteille", 1_200, 950, "6001234567892"],
  ["00000000-0000-7000-8000-000000000104", "Savon de Marseille", "morceau", 350, 250, "6001234567893"],
  ["00000000-0000-7000-8000-000000000105", "Lait Nido 400g", "boîte", 3_200, 2_600, "6001234567894"],
  ["00000000-0000-7000-8000-000000000106", "Maggi cube", "sachet", 100, 70, "6001234567895"],
  ["00000000-0000-7000-8000-000000000107", "Spaghetti 500g", "paquet", 600, 450, "6001234567896"],
  ["00000000-0000-7000-8000-000000000108", "Sardine boîte", "boîte", 800, 600, "6001234567897"],
];

/**
 * Creates a demo shop if the database is empty. Returns whether it did.
 *
 * Stock is put on the shelf with an opening `ADJUSTMENT` rather than a
 * purchase, because nobody bought it — inventing a delivery would put a
 * fictional cost into §8's valuation and a fictional bill into a wholesaler's
 * ledger. An adjustment is the honest way to say "this was already here".
 */
export function seedDemoShop(database: Database): boolean {
  if (!__DEV__ || process.env["EXPO_PUBLIC_DEMO_SHOP"] !== "1") {
    return false;
  }
  const existing = database.get(`SELECT id FROM businesses LIMIT 1`);
  if (existing !== undefined) {
    return false;
  }

  const at = new Date().toISOString();
  database.transaction((tx) => {
    tx.run(
      `INSERT INTO businesses (id, name, currency, created_at, updated_at)
       VALUES (?, 'Boutique Chez Jean', 'XAF', ?, ?)`,
      [BUSINESS, at, at],
    );
    tx.run(
      `INSERT INTO users (id, business_id, name, role, created_at, updated_at)
       VALUES (?, ?, 'Jean Mbarga', 'OWNER', ?, ?)`,
      [USER, BUSINESS, at, at],
    );
    tx.run(
      `INSERT INTO devices (id, business_id, label, platform, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'Caisse 1', 'ANDROID', ?, ?, ?)`,
      [DEVICE, BUSINESS, at, at, at],
    );
    for (const [id, name, kind] of [
      [TILL_ACCOUNT, "Caisse", "CASH"],
      [WALLET_ACCOUNT, "MTN Mobile Money", "MOBILE_MONEY"],
    ] as const) {
      tx.run(
        `INSERT INTO financial_accounts (id, business_id, name, kind, currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'XAF', ?, ?)`,
        [id, BUSINESS, name, kind, at, at],
      );
    }

    // The session a login would have written, minus the token — which is what
    // stops this shop from ever reaching a server (§37, ADR-012).
    tx.run(
      `INSERT INTO device_session
         (id, session_id, business_id, user_id, device_id, issued_at, expires_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      [SESSION, BUSINESS, USER, DEVICE, at, "2099-01-01T00:00:00.000Z"],
    );

    for (const [id, name, unit, price, cost, barcode] of CATALOGUE) {
      tx.run(
        `INSERT INTO products
           (id, business_id, name, unit, divisible, barcode, purchase_price_minor,
            selling_price_minor, currency, minimum_stock, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'XAF', 0, ?, ?)`,
        [id, BUSINESS, name, unit, barcode, cost, price, at, at],
      );
      tx.run(
        `INSERT INTO inventory_movements
           (id, business_id, product_id, type, quantity, reason,
            user_id, device_id, occurred_at, recorded_at)
         VALUES (?, ?, ?, 'ADJUSTMENT', 40000, 'stock de départ',
                 ?, ?, ?, ?)`,
        [`${id.slice(0, 24)}9001`, BUSINESS, id, USER, DEVICE, at, at],
      );
    }
  });

  return true;
}

