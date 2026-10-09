/** Granular local permissions, retaining the archived server's role defaults. */
export const PERMISSIONS = [
  "products.view", "products.create", "products.edit", "products.price", "products.archive",
  "inventory.view", "inventory.receive", "inventory.adjust", "inventory.count",
  "sales.create", "sales.view", "sales.view_own", "sales.refund", "sales.discount",
  "customers.view", "customers.manage", "customers.credit",
  "suppliers.view", "suppliers.manage", "purchases.view", "purchases.create", "purchases.pay",
  "expenses.view", "expenses.create", "finance.accounts.view", "finance.accounts.manage",
  "cash.view", "cash.count", "cash.reconcile", "reports.sales", "reports.inventory",
  "reports.customers", "reports.suppliers", "reports.financial",
  "users.view", "users.manage", "business.settings", "audit.view",
  "customers.pay", "customers.credit_override", "sales.price_override", "cash.move",
] as const;

/** A known local capability; unknown strings are refused at runtime. */
export type Permission = (typeof PERMISSIONS)[number];
/** Roles supply defaults; operations authorize individual permissions. */
export type Role = "OWNER" | "MANAGER" | "CASHIER" | "INVENTORY" | "ACCOUNTANT";

const DEFAULTS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  MANAGER: PERMISSIONS.filter(p => ![
    "users.manage", "business.settings", "audit.view", "finance.accounts.manage",
  ].includes(p)),
  CASHIER: ["products.view", "inventory.view", "sales.create", "sales.view_own", "customers.view", "customers.pay"],
  INVENTORY: [
    "products.view", "products.create", "products.edit", "products.archive", "inventory.view",
    "inventory.receive", "inventory.adjust", "inventory.count", "suppliers.view", "purchases.view", "reports.inventory",
  ],
  ACCOUNTANT: [
    "products.view", "inventory.view", "sales.view", "customers.view", "suppliers.view", "purchases.view",
    "expenses.view", "expenses.create", "finance.accounts.view", "cash.view", "reports.sales",
    "reports.inventory", "reports.customers", "reports.suppliers", "reports.financial", "audit.view",
  ],
};

/** Recognizes a catalog entry without accepting arbitrary permission strings. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** Resolves defaults plus grants minus revocations; unknown input fails closed. */
export function resolvePermissions(role: Role, granted: readonly Permission[], revoked: readonly Permission[]): readonly Permission[] {
  if (!Object.hasOwn(DEFAULTS, role) || ![...granted, ...revoked].every(isPermission)) {
    throw new Error("unknown local role or permission");
  }
  const selected = new Set([...DEFAULTS[role], ...granted]);
  return PERMISSIONS.filter(p => selected.has(p) && !revoked.includes(p));
}
