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
  // Taking shop data off the device in bulk (a CSV export). Owners only unless granted.
  "data.export",
] as const;

/** A known local capability; unknown strings are refused at runtime. */
export type Permission = (typeof PERMISSIONS)[number];
/** Roles supply defaults; operations authorize individual permissions. */
export type Role = "OWNER" | "MANAGER" | "CASHIER" | "INVENTORY" | "ACCOUNTANT";
/** A role the owner may assign and whose permissions the shop may edit (ADR-037); the owner always holds everything. */
export type StaffRole = Exclude<Role, "OWNER">;
/** Assignable roles, in the order screens list them. */
export const STAFF_ROLES: readonly StaffRole[] = ["MANAGER", "CASHIER", "INVENTORY", "ACCOUNTANT"];

const DEFAULTS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  MANAGER: PERMISSIONS.filter(p => ![
    "users.manage", "business.settings", "audit.view", "finance.accounts.manage", "data.export",
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

/** Recognizes an assignable role; `OWNER` and unknown strings are refused. */
export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

/** The built-in permissions of a role, used whenever the shop has not edited that role. */
export function defaultPermissions(role: Role): readonly Permission[] {
  if (!Object.hasOwn(DEFAULTS, role)) throw new Error("unknown local role or permission");
  return DEFAULTS[role];
}

/**
 * Resolves the role's permissions plus grants minus revocations; unknown input fails closed. `base` is the shop's
 * edited set for a staff role (ADR-037); undefined or null means the built-in defaults. The owner always holds every
 * permission the role gives, whatever `base` says.
 */
export function resolvePermissions(role: Role, granted: readonly Permission[], revoked: readonly Permission[], base?: readonly Permission[] | null): readonly Permission[] {
  if (!Object.hasOwn(DEFAULTS, role) || ![...granted, ...revoked, ...(base ?? [])].every(isPermission)) {
    throw new Error("unknown local role or permission");
  }
  const selected = new Set([...(role === "OWNER" || base == null ? DEFAULTS[role] : base), ...granted]);
  return PERMISSIONS.filter(p => selected.has(p) && !revoked.includes(p));
}
