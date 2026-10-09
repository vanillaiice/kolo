import type { Permission } from "@kolo/core/identity/permissions";
import type { Receipt, Page, PageQuery } from "@kolo/core/application/queries";

/** Stable application failures; native exception text, credentials and paths never cross the bridge. */
export type FailureCode = "invalid_input" | "invalid_credential" | "retry_later" | "recovery_required" |
  "credential_unavailable" | "actor_inactive" | "permission_denied" | "scope_mismatch" | "setup_pending" |
  "locked" | "legacy_installation" | "already_configured" | "not_configured" | "busy" | "unavailable" |
  "request_conflict" | "price_changed" | "storage_failed";
/** Serializable results make transport and operation failures explicit. */
export type Result<T> = { readonly ok: true; readonly value: T } |
  { readonly ok: false; readonly error: { readonly code: FailureCode; readonly retryAt?: string } };
/** Public installation metadata, with a transient session marker rather than an operation capability. */
export interface WorkspaceView {
  readonly state: "empty" | "legacy" | "pending" | "locked" | "unlocked";
  readonly shopName: string | null;
  readonly members: readonly { readonly id: string; readonly name: string }[];
  readonly actor: { readonly name: string; readonly isOwner: boolean; readonly permissions: readonly Permission[] } | null;
  readonly sessionId: string | null;
}
/** Bounded product facts safe for DOM clients; authority, provenance and secret references stay in the host. */
export interface ProductView {
  readonly id: string; readonly name: string; readonly unit: string; readonly divisible: boolean;
  readonly barcode?: string; readonly sellingPriceMinor: number; readonly purchasePriceMinor?: number;
  readonly onHandThousandths?: number; readonly categoryId?: string; readonly minimumStockThousandths: number;
  /** Archived products stay in history and can be restored; they cannot be sold or stocked. */
  readonly active: boolean;
  /** Opaque stored version; an edit names the version it was made from. */
  readonly version: string;
}
/** Catalogue grouping. Archived categories remain attached to existing products. */
export interface CategoryView { readonly id: string; readonly name: string; readonly active: boolean; readonly version: string; }
/** One immutable stock movement; corrections appear as later compensating rows. */
export interface StockMovementView {
  readonly id: string; readonly occurredAt: string; readonly type: string; readonly quantityThousandths: number; readonly reason?: string;
}
/** Catalogue pages may include archived rows for restoring them. */
export type CatalogueQuery = SessionRequest & PageQuery & { readonly includeInactive?: boolean };
/** Every protected call binds to the currently displayed actor session, including queued calls. */
export interface SessionRequest { readonly sessionId: string; }
/** Fresh shop setup. The host supplies identity, platform, currency and initial account policy. */
export interface SetupRequest {
  readonly businessName: string; readonly ownerName: string; readonly deviceLabel: string;
  readonly cashAccountName: string; readonly secret: string;
}
/** Stable request identity doubles as the created product identity for safe creation retries. */
export interface ProductRequest extends SessionRequest {
  readonly requestId: string; readonly name: string; readonly unit: string; readonly divisible: boolean;
  readonly barcode?: string; readonly sellingPriceMinor: number; readonly purchasePriceMinor?: number;
  readonly openingThousandths: number;
}
/**
 * Detail edit made from a displayed version. An identical retry returns the stored product;
 * any other change since that version is refused rather than overwritten. Whole/fractional
 * quantities and archive state are not edited here.
 */
export interface ProductUpdateRequest extends SessionRequest {
  readonly productId: string; readonly version: string; readonly name: string; readonly unit: string;
  readonly barcode?: string; readonly sellingPriceMinor: number; readonly purchasePriceMinor?: number;
  readonly categoryId?: string; readonly minimumStockThousandths: number;
}
/** Manual stock received outside a supplier purchase, or stock lost to damage. The request ID names the movement. */
export interface StockMoveRequest extends SessionRequest {
  readonly requestId: string; readonly productId: string; readonly kind: "add" | "damage";
  readonly quantityThousandths: number; readonly reason: string;
}
/** Observed shelf quantity; the host records the difference from current stock at the moment it commits. */
export interface StockCountRequest extends SessionRequest {
  readonly requestId: string; readonly productId: string; readonly countedThousandths: number; readonly reason: string;
}
/** Cash checkout carries only selected facts; the host derives actor, shop, time, stock and event IDs. */
export interface CheckoutRequest extends SessionRequest {
  readonly requestId: string; readonly accountId: string;
  readonly lines: readonly { readonly productId: string; readonly quantity: number; readonly unitPriceMinor: number }[];
}
/** Platform-neutral UI service. Electron implements it with named preload calls; a future web adapter can replace it. */
export interface ShopService {
  /** Public boot status; no credentials or key references are returned. */
  getWorkspace(): Promise<Result<WorkspaceView>>;
  /** Offline setup commits a locked shop; a separate credential proof unlocks it. */
  createShop(input: SetupRequest): Promise<Result<WorkspaceView>>;
  /** Resumes a durable interrupted setup without generating another installation. */
  finishSetup(input: { readonly secret: string }): Promise<Result<WorkspaceView>>;
  /** Opens a transient local actor session. */
  unlock(input: { readonly userId: string; readonly secret: string }): Promise<Result<WorkspaceView>>;
  /** Invalidates the session and pending unlocks without changing business records. */
  lock(): Promise<Result<WorkspaceView>>;
  /** Owner recovery uses the separately stored recovery key, then leaves the till locked. */
  recoverAccess(input: { readonly recoveryCode: string; readonly newSecret: string }): Promise<Result<WorkspaceView>>;
  /** Requires both current owner authority and a fresh credential proof. */
  recoveryKey(input: SessionRequest & { readonly secret: string }): Promise<Result<string | null>>;
  /** Bounded literal catalogue search with optional stock according to current permissions. */
  listProducts(input: CatalogueQuery): Promise<Result<Page<ProductView>>>;
  /** One product, including archived ones, so open detail views follow later changes. */
  getProduct(input: SessionRequest & { readonly productId: string }): Promise<Result<ProductView>>;
  /** Exact barcode lookup; absent/archived/ambiguous codes return no match. */
  scanProduct(input: SessionRequest & { readonly barcode: string }): Promise<Result<ProductView | null>>;
  /** Atomic product plus optional opening stock; same-ID differing requests are refused. */
  createProduct(input: ProductRequest): Promise<Result<ProductView>>;
  /** Edits details of an active product under edit (and, for prices, price) authority. */
  updateProduct(input: ProductUpdateRequest): Promise<Result<ProductView>>;
  /** Archives or restores a product from its displayed version under archive authority. */
  setProductActive(input: SessionRequest & { readonly productId: string; readonly version: string; readonly active: boolean }): Promise<Result<ProductView>>;
  /** Bounded categories, optionally including archived ones. */
  listCategories(input: CatalogueQuery): Promise<Result<Page<CategoryView>>>;
  /** Creates a category whose ID is the stable request ID; matching retries return it. */
  createCategory(input: SessionRequest & { readonly requestId: string; readonly name: string }): Promise<Result<CategoryView>>;
  /** Renames, archives or restores a category from its displayed version. */
  updateCategory(input: SessionRequest & { readonly categoryId: string; readonly version: string; readonly name: string; readonly active: boolean }): Promise<Result<CategoryView>>;
  /** Adds or removes stock for one active product; matching retries record nothing more. */
  moveStock(input: StockMoveRequest): Promise<Result<ProductView>>;
  /** Records a shelf count; a retried count never recounts against later sales. */
  countStock(input: StockCountRequest): Promise<Result<{ readonly deltaThousandths: number; readonly product: ProductView }>>;
  /** Newest-first bounded stock movements of one product under inventory-view authority. */
  stockHistory(input: SessionRequest & { readonly productId: string; readonly after?: PageQuery["after"]; readonly limit?: number }): Promise<Result<Page<StockMovementView>>>;
  /** Bounded account names for cash checkout, without disclosing financial balances. */
  listCashAccounts(input: SessionRequest & PageQuery): Promise<Result<Page<{ readonly id: string; readonly name: string }>>>;
  /** Atomic cash sale; identical retries return the original saved sale ID. */
  checkout(input: CheckoutRequest): Promise<Result<{ readonly saleId: string }>>;
  /** Reads the immutable persisted receipt under current sales-view authority. */
  getReceipt(input: SessionRequest & { readonly saleId: string }): Promise<Result<Receipt>>;
  /** Bounded actor-scoped saved receipt history. */
  listReceipts(input: SessionRequest & PageQuery): Promise<Result<Page<{ readonly id: string; readonly number: string; readonly occurredAt: string }>>>;
  /** Invalidation only: subscribers reread bounded pages; no business database mirror. */
  onChanged(listener: () => void): () => void;
}
