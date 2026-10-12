import type { ReportKind } from "@kolo/core/application/report-views";
import type { ReturnKind } from "@kolo/core/data/returns/returns";

/** Primary destinations in their fixed order. */
export type Tab = "sell" | "products" | "activity" | "more";
export const TABS: readonly Tab[] = ["sell", "products", "activity", "more"];

/** Every screen and its parameters. Lists push details; details push actions. */
export interface RouteMap {
  sell: undefined; cart: undefined; payment: undefined; receipt: { readonly saleId: string; readonly fresh?: boolean };
  products: undefined; product: { readonly productId: string }; productForm: { readonly productId?: string };
  stockMove: { readonly productId: string; readonly kind: "ADJUSTMENT" | "DAMAGE" | "OPENING_BALANCE" | "COUNT" };
  stockHistory: { readonly productId: string }; categories: undefined; categoryForm: { readonly categoryId?: string };
  activity: undefined; purchase: { readonly purchaseId: string }; purchaseNew: undefined; expense: { readonly expenseId: string }; expenseNew: undefined;
  returnForm: { readonly kind: ReturnKind; readonly originalId: string };
  more: undefined; customers: undefined; suppliers: undefined;
  person: { readonly kind: "customer" | "supplier"; readonly id: string }; personForm: { readonly kind: "customer" | "supplier"; readonly id?: string };
  settle: { readonly kind: "customer" | "supplier"; readonly id: string }; statement: { readonly kind: "customer" | "supplier"; readonly id: string };
  accounts: undefined; account: { readonly accountId: string }; accountForm: { readonly accountId?: string };
  money: { readonly accountId: string; readonly mode: "in" | "out" | "transfer" }; cashCount: { readonly accountId: string };
  reports: undefined; report: { readonly kind: ReportKind }; analytics: undefined;
  staff: undefined; staffMember: { readonly userId: string }; staffNew: undefined;
  devices: undefined; backupCreate: undefined; backupRestore: undefined; addTill: undefined; exchangeSend: undefined; exchangeReceive: undefined;
  exchangeConfirm: undefined; exchangeStatus: undefined; recoveryKey: undefined; serverSync: undefined;
  settings: undefined; about: undefined; reset: undefined;
  alerts: undefined; shopTax: undefined; shopTerms: undefined;
  partyTerms: { readonly kind: "customer" | "supplier"; readonly id: string }; productTax: { readonly productId: string };
}
export type RouteName = keyof RouteMap;
export interface Route<K extends RouteName = RouteName> { readonly key: string; readonly name: K; readonly params: RouteMap[K] }

