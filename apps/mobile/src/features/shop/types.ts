import type { Database } from "@kolo/core/data/database/driver";
import type { OperationContext } from "@kolo/core/identity/types";
import type { Permission } from "@kolo/core/identity/permissions";
/** Unlocked operational screens share the database capability and current display permissions. */
export interface ShopProps { readonly database: Database; readonly context: OperationContext; readonly permissions: readonly Permission[]; readonly branchId?: string | undefined; }
