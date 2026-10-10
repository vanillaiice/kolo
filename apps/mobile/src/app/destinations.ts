import type { Permission } from "@kolo/core/identity/permissions";
import { TABS, type Tab } from "./navigation-types.ts";

/** Which primary destinations a permission set opens, in fixed order; More (settings, lock) is always available. */
export function availableTabs(permissions: readonly Permission[]): readonly Tab[] {
  const has = (p: Permission): boolean => permissions.includes(p);
  return TABS.filter(tab => tab === "sell" ? has("sales.create") && has("products.view") : tab === "products" ? has("products.view")
    : tab === "activity" ? has("sales.view") || has("sales.view_own") || has("purchases.view") || has("expenses.view") : true);
}
