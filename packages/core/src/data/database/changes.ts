import type { Database } from "./driver.ts";

/** Query domains invalidated after a successful SQLite commit; no business records are cached. */
export type ChangedDomain = "products" | "inventory" | "sales" | "customers" | "suppliers" | "purchases" | "accounts" | "expenses" | "authority" | "settings" | "notifications";
const tables: Record<string, readonly ChangedDomain[]> = {
  business_returns: ["sales", "purchases", "inventory", "customers", "suppliers", "accounts"],
  business_return_items: ["sales", "purchases", "inventory"], business_return_refunds: ["accounts"],
  products: ["products"], categories: ["products"], category_names: ["products"], product_photos: ["products"], product_categories: ["products"], product_category_sets: ["products"], inventory_movements: ["inventory"],
  sales: ["sales"], sale_items: ["sales"], sale_payments: ["sales", "accounts"],
  customers: ["customers"], customer_transactions: ["customers", "accounts"],
  suppliers: ["suppliers"], supplier_transactions: ["suppliers", "accounts"],
  purchases: ["purchases"], purchase_items: ["purchases"],
  financial_accounts: ["accounts"], account_movements: ["accounts"], expenses: ["expenses", "accounts"],
  shop_tax_settings: ["settings", "sales"], product_tax_rules: ["products"], payment_terms: ["settings", "customers", "suppliers"], notification_state: ["notifications"],
  local_memberships: ["authority"], users: ["authority"], devices: ["authority"], businesses: ["authority"],
};
type Listener = { domains: readonly ChangedDomain[]; notify: () => void };
const listeners = new WeakMap<Database, Set<Listener>>();
const revisions = new WeakMap<Database, Partial<Record<ChangedDomain, number>>>();

/** Subscribes to committed changes. Unsubscribe on screen unmount/database replacement. */
export function subscribeChanges(database: Database, domains: readonly ChangedDomain[], notify: () => void): () => void {
  let set = listeners.get(database);
  if (set === undefined) { set = new Set(); listeners.set(database, set); }
  const listener = { domains: [...domains], notify }; set.add(listener);
  return () => { set.delete(listener); };
}

/** Stable snapshot for useSyncExternalStore; read again after a notification. */
export function changeRevision(database: Database, domains: readonly ChangedDomain[]): string {
  const values = revisions.get(database);
  return domains.map(domain => values?.[domain] ?? 0).join(":");
}

/** @internal Conservative table-to-domain mapping for successful bound writes in the SQLite adapters. */
export function domainsForWrite(sql: string): readonly ChangedDomain[] {
  const table = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`\[]?(\w+)/i.exec(sql)?.[1]?.toLowerCase();
  return table === undefined ? [] : tables[table] ?? [];
}

/** @internal Called after the outer COMMIT and after resetting transaction depth. Observer errors cannot fail a committed write. */
export function publishChanges(database: Database, domains: ReadonlySet<ChangedDomain>): void {
  if (domains.size === 0) return;
  let values = revisions.get(database);
  if (values === undefined) { values = {}; revisions.set(database, values); }
  for (const domain of domains) values[domain] = (values[domain] ?? 0) + 1;
  for (const listener of [...listeners.get(database) ?? []]) {
    if (listener.domains.some(domain => domains.has(domain))) {
      try { listener.notify(); } catch { /* A view must never turn durable success into a reported command failure. */ }
    }
  }
}
