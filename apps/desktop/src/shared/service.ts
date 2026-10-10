import type { Permission } from "@kolo/core/identity/permissions";
import type { Receipt, Page, PageQuery } from "@kolo/core/application/queries";

/** Stable application failures; native exception text, credentials and paths never cross the bridge. */
export type FailureCode = "invalid_input" | "invalid_credential" | "retry_later" | "recovery_required" |
  "credential_unavailable" | "actor_inactive" | "permission_denied" | "scope_mismatch" | "setup_pending" |
  "locked" | "legacy_installation" | "already_configured" | "not_configured" | "busy" | "unavailable" |
  "request_conflict" | "price_changed" | "storage_failed" | "credit_limit" | "stale_return" |
  /** File transfer failures; file contents and paths never cross the bridge. */
  "invalid_file" | "too_large" | "invalid_password" | "authentication_failed" | "unsupported_version" | "invalid_snapshot" | "confirmation_required" |
  "not_empty" | "pairing_pending" | "pairing_expired" | "pairing_conflict" | "invalid_pairing" | "activation_failed" | "cancelled" | "no_file" |
  /** Product photo failures: not a WebP/JPEG within limits, or the shop's photo storage is full. */
  "invalid_photo" | "photo_storage_full";
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
  /** SHA-256 of the product's photo on this computer, absent when it has none; fetch bytes with productPhoto. */
  readonly photo?: string;
  /** Additional categories besides the main `categoryId` (browsing only; reports use the main one). Present on single-product reads. */
  readonly otherCategoryIds?: readonly string[];
}
/** Catalogue grouping. Archived categories remain attached to existing products. */
export interface CategoryView { readonly id: string; readonly name: string; readonly active: boolean; readonly version: string; }
/** One immutable stock movement; corrections appear as later compensating rows. */
export interface StockMovementView {
  readonly id: string; readonly occurredAt: string; readonly type: string; readonly quantityThousandths: number; readonly reason?: string;
}
/** Catalogue pages may include archived rows for restoring them. */
/** `categoryId` (products only) keeps products whose main or additional category it is. */
export type CatalogueQuery = SessionRequest & PageQuery & { readonly includeInactive?: boolean; readonly categoryId?: string };
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
  /** Replaces the additional categories (at most 20, never the main one); omitted leaves them unchanged. */
  readonly otherCategoryIds?: readonly string[];
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
/**
 * Checkout carries only selected facts; the host derives actor, shop, time, stock and event IDs.
 * `payments` (one per account) may be split and may leave a balance on the named customer's
 * account. The legacy single `accountId` form records the exact total in that cash account.
 */
export interface CheckoutRequest extends SessionRequest {
  readonly requestId: string; readonly accountId?: string;
  readonly payments?: readonly { readonly accountId: string; readonly amountMinor: number }[];
  readonly customerId?: string;
  /** Whole-sale discount in francs, taken after the lines; needs sales.discount. */
  readonly discountMinor?: number;
  readonly lines: readonly { readonly productId: string; readonly quantity: number; readonly unitPriceMinor: number }[];
}
/** Account names and kinds for taking money, never balances. */
export interface PaymentAccountView { readonly id: string; readonly name: string; readonly kind: "CASH" | "MOBILE_MONEY" | "BANK" | "CARD" | "OTHER"; }
/** Customer details and current balance (positive: owed to the shop; negative: paid in advance). */
export interface CustomerView {
  readonly id: string; readonly name: string; readonly phone?: string; readonly address?: string; readonly notes?: string;
  /** Absent: no limit decided. Zero: no credit allowed. */
  readonly creditLimitMinor?: number;
  readonly outstandingMinor: number; readonly active: boolean; readonly version: string;
}
/** Editable customer details; absent optional fields are cleared. */
export interface CustomerDetails {
  readonly name: string; readonly phone?: string; readonly address?: string; readonly notes?: string; readonly creditLimitMinor?: number;
}
/** One immutable customer ledger entry, newest first; payments are negative. */
export interface StatementEntryView {
  readonly id: string; readonly occurredAt: string; readonly type: string; readonly amountMinor: number; readonly saleId?: string; readonly purchaseId?: string; readonly note?: string;
  /** Running balance after this entry (positive: owed), summed oldest first over the whole ledger. */
  readonly balanceMinor: number;
}
/** Supplier details and current payable (positive: the shop owes them). */
export interface SupplierView {
  readonly id: string; readonly name: string; readonly phone?: string; readonly address?: string; readonly contact?: string; readonly notes?: string;
  readonly outstandingMinor: number; readonly active: boolean; readonly version: string;
}
/** Editable supplier details; absent optional fields are cleared. */
export interface SupplierDetails { readonly name: string; readonly phone?: string; readonly address?: string; readonly contact?: string; readonly notes?: string; }
/**
 * A delivery received into stock at recorded unit costs. An optional single door payment is
 * taken from one account; any remainder is owed to the named supplier.
 */
export interface PurchaseRequest extends SessionRequest {
  readonly requestId: string; readonly supplierId?: string; readonly reference?: string;
  readonly lines: readonly { readonly productId: string; readonly quantity: number; readonly unitCostMinor: number }[];
  readonly payment?: { readonly accountId: string; readonly amountMinor: number };
}
/** Purchase history row with exact total from historical costs. */
export interface PurchaseSummary { readonly id: string; readonly occurredAt: string; readonly supplierName: string; readonly reference: string; readonly totalMinor: number; }
/** Immutable recorded delivery. */
export interface PurchaseView extends PurchaseSummary {
  readonly supplierId?: string;
  readonly lines: readonly { readonly id: string; readonly productId: string; readonly name: string; readonly quantity: number; readonly unitCostMinor: number }[];
  readonly paidMinor: number; readonly outstandingMinor: number;
}
/** Account kinds: an account is where money is, never a payment method. */
export type AccountKind = PaymentAccountView["kind"];
/** A financial account with its derived balance. */
export interface AccountView {
  readonly id: string; readonly name: string; readonly kind: AccountKind; readonly active: boolean; readonly version: string;
  /** Absent when the actor may move money but not view balances. */
  readonly onHandMinor?: number;
}
/** Expense categories shared with mobile and reports. */
export type ExpenseCategory = "RENT" | "ELECTRICITY" | "WATER" | "TRANSPORT" | "SALARY" | "PACKAGING" | "MAINTENANCE" | "INTERNET" | "MARKETING" | "OTHER";
/** One immutable expense; reversals are later negative entries naming the original. */
export interface ExpenseView {
  readonly id: string; readonly occurredAt: string; readonly category: ExpenseCategory; readonly amountMinor: number; readonly accountId: string; readonly accountName: string;
  readonly description?: string; readonly reference?: string; readonly reversesId?: string; readonly reversed: boolean;
}
/** Expected balance against a counted amount; a correction makes the books match the count. */
export interface CashCountView { readonly expectedMinor: number; readonly countedMinor: number; readonly differenceMinor: number; }
/** Report and analytics views are assembled in core so desktop and mobile show the same figures. */
export type { ReportKind, ReportLine, ReportResult, AnalyticsBucket, AnalyticsPoint, AnalyticsCell, AnalyticsProduct, AnalyticsCustomer, AnalyticsResult } from "@kolo/core/application/report-views";
import type { ReportKind, AnalyticsBucket, ReportResult, AnalyticsResult } from "@kolo/core/application/report-views";
/** What remains returnable from a sale or purchase, at the original net prices or costs. */
export interface ReturnSourceView {
  readonly kind: "SALE" | "PURCHASE"; readonly originalId: string; readonly priorId?: string; readonly hasCounterparty: boolean;
  /** Most money that may still be refunded: what the original settled in cash less earlier refunds. The rest goes to the ledger. */
  readonly refundableMinor: number;
  readonly items: readonly { readonly id: string; readonly name: string; readonly originalQuantity: number; readonly returnedQuantity: number }[];
}
/** Exact value of a selected return before it is recorded. */
export interface ReturnPreview { readonly totalMinor: number; readonly lines: readonly { readonly originalItemId: string; readonly quantity: number; readonly amountMinor: number }[] }
/**
 * Records a partial or full return against the predecessor the preview was made from. The
 * refund (sale: paid out; purchase: received back) is at most the value and at most the source's
 * `refundableMinor`; any remainder goes to the customer's or supplier's ledger. A return recorded meanwhile makes this one stale.
 */
export interface ReturnRequest extends SessionRequest {
  readonly requestId: string; readonly kind: "SALE" | "PURCHASE"; readonly originalId: string; readonly priorId?: string; readonly reason: string;
  readonly items: readonly { readonly originalItemId: string; readonly quantity: number }[];
  readonly refund?: { readonly accountId: string; readonly amountMinor: number };
}
/** A local staff member with effective permissions; no credential material is exposed. */
export interface StaffView {
  readonly id: string; readonly name: string; readonly role: "OWNER" | "MANAGER" | "CASHIER" | "INVENTORY" | "ACCOUNTANT"; readonly active: boolean;
  readonly isSelf: boolean; readonly permissions: readonly Permission[];
}
/** A checked backup file waiting for an explicit restore confirmation. */
export interface BackupFileView { readonly businessName: string; readonly ownerName: string; readonly createdAt: string; readonly appliedEvents: number; }
/** A checked pairing invite: compare the fingerprint with the owner's screen before accepting. */
export interface InviteView { readonly businessName: string; readonly ownerName: string; readonly fingerprint: string; readonly authorityAllowed: boolean; }
/** A checked pairing request: compare the code with the new till's screen before approving. */
export interface PairingRequestView { readonly deviceLabel: string; readonly businessName: string; readonly verificationCode: string; readonly authorityAllowed: boolean; }
/** Paired destinations, received batches and actionable diagnostics. */
export interface ExchangeView {
  readonly destinations: readonly { readonly id: string; readonly label: string; readonly pending: number }[];
  readonly batches: readonly { readonly batchId: string; readonly senderDeviceId: string; readonly createdAt: string }[];
  readonly diagnostics: readonly { readonly eventId: string; readonly code: string; readonly description: string; readonly action: string }[];
}
/** Assessment of a checked exchange file before import. */
export interface BundleView { readonly total: number; readonly ready: number; readonly duplicate: number; readonly deferred: number; readonly review: number; }
/** Whether a native save dialog wrote the prepared file (false when the user cancelled). */
export interface SavedFile { readonly saved: boolean; }
/** Platform-neutral UI service. Electron implements it with named preload calls; a future web adapter can replace it. */
/** Per-computer session behaviour. */
/** Per-computer preferences. `largeFiles` lifts transfer-file and photo-storage limits for powerful computers. */
export interface SessionPreferences { readonly rememberSession: boolean; readonly largeFiles: boolean }
/** A product photo ready for an <img>: a data URL (the renderer CSP allows data: images only). */
export interface PhotoView { readonly digest: string; readonly dataUrl: string }
/** Photos held by the shop on this computer against the active storage limit. */
export interface PhotoUsage { readonly photos: number; readonly bytes: number; readonly limitBytes: number }

export interface ShopService {
  /** Public boot status; no credentials or key references are returned. */
  getWorkspace(): Promise<Result<WorkspaceView>>;
  /**
   * From a locked/pending/legacy installation, confirms its displayed name and activates a
   * fresh empty local database. Existing files/credentials stay on disk; no old access is granted.
   */
  startNewShop(input: { readonly confirmedName: string }): Promise<Result<{ readonly activated: true }>>;
  /** Lists other local shops by display name; credentials remain protected. */
  savedShops(): Promise<Result<readonly { readonly id: string; readonly name: string }[]>>;
  /** Selects a saved local database while locked; unlocking still requires its credentials. */
  openSavedShop(input: { readonly id: string }): Promise<Result<{ readonly activated: true }>>;
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
  /** Whether this computer keeps the signed-in user open across restarts. Any signed-in user may read it. */
  sessionPreferences(input: SessionRequest): Promise<Result<SessionPreferences>>;
  /**
   * Turns staying signed in on or off for this computer. Enabling remembers the current user;
   * disabling forgets any remembered user so the next start is locked.
   */
  setRememberSession(input: SessionRequest & { readonly enabled: boolean }): Promise<Result<SessionPreferences>>;
  /**
   * Owner (business.settings) switch for this computer: raises backup/enrollment file limits from the
   * standard profile (48 MiB files) to the large one (about 500 MiB) and photo storage from 16 to 256 MiB.
   * Larger files open only on computers with the switch on.
   */
  setLargeFiles(input: SessionRequest & { readonly enabled: boolean }): Promise<Result<SessionPreferences>>;
  /**
   * Owner-only computer reset: with the typed shop name and the owner's code, every shop on this computer
   * (with safety copies), its credentials and the remembered session are erased and KOLO reopens empty.
   * Per-computer preferences stay. The renderer is told through the usual change notification.
   */
  resetComputer(input: SessionRequest & { readonly confirmedName: string; readonly secret: string }): Promise<Result<null>>;
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
  /** A product's photo under products.view, or null when this computer holds none. */
  productPhoto(input: SessionRequest & { readonly productId: string }): Promise<Result<PhotoView | null>>;
  /** Stores or replaces a product's photo (WebP or JPEG, at most 64 KiB and 512 px a side) under products.edit. */
  setProductPhoto(input: SessionRequest & { readonly productId: string; readonly bytes: Uint8Array }): Promise<Result<ProductView>>;
  /** Removes a product's photo under products.edit. */
  removeProductPhoto(input: SessionRequest & { readonly productId: string }): Promise<Result<ProductView>>;
  /** Photo storage used by the shop on this computer, under products.view. */
  photoUsage(input: SessionRequest): Promise<Result<PhotoUsage>>;
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
  /** Bounded payment account names and kinds for split checkout and collections. */
  listPaymentAccounts(input: SessionRequest & PageQuery): Promise<Result<Page<PaymentAccountView>>>;
  /** Bounded customers with balances under customers.view, optionally including archived ones. */
  listCustomers(input: CatalogueQuery): Promise<Result<Page<CustomerView>>>;
  /** One customer, archived or not, with current balance. */
  getCustomer(input: SessionRequest & { readonly customerId: string }): Promise<Result<CustomerView>>;
  /** Creates a customer named by the request ID; matching retries return it. */
  createCustomer(input: SessionRequest & CustomerDetails & { readonly requestId: string }): Promise<Result<CustomerView>>;
  /** Edits, archives or restores a customer from the displayed version. */
  updateCustomer(input: SessionRequest & CustomerDetails & { readonly customerId: string; readonly version: string; readonly active: boolean }): Promise<Result<CustomerView>>;
  /** Takes a customer's payment into one account; the request ID names the ledger entry. */
  receiveCustomerPayment(input: SessionRequest & { readonly requestId: string; readonly customerId: string; readonly accountId: string; readonly amountMinor: number; readonly note?: string }): Promise<Result<CustomerView>>;
  /** Newest-first bounded customer ledger. */
  customerStatement(input: SessionRequest & { readonly customerId: string; readonly after?: PageQuery["after"]; readonly limit?: number }): Promise<Result<Page<StatementEntryView>>>;
  /** Bounded suppliers with payables under suppliers.view, optionally including archived ones. */
  listSuppliers(input: CatalogueQuery): Promise<Result<Page<SupplierView>>>;
  /** One supplier, archived or not, with current payable. */
  getSupplier(input: SessionRequest & { readonly supplierId: string }): Promise<Result<SupplierView>>;
  /** Creates a supplier named by the request ID; matching retries return it. */
  createSupplier(input: SessionRequest & SupplierDetails & { readonly requestId: string }): Promise<Result<SupplierView>>;
  /** Edits, archives or restores a supplier from the displayed version. */
  updateSupplier(input: SessionRequest & SupplierDetails & { readonly supplierId: string; readonly version: string; readonly active: boolean }): Promise<Result<SupplierView>>;
  /** Pays a supplier from one account; the request ID names the ledger entry. */
  paySupplier(input: SessionRequest & { readonly requestId: string; readonly supplierId: string; readonly accountId: string; readonly amountMinor: number; readonly note?: string }): Promise<Result<SupplierView>>;
  /** Newest-first bounded supplier ledger; purchases positive, payments negative. */
  supplierStatement(input: SessionRequest & { readonly supplierId: string; readonly after?: PageQuery["after"]; readonly limit?: number }): Promise<Result<Page<StatementEntryView>>>;
  /** Records a delivery, its stock and any door payment/payable atomically; matching retries return the same ID. */
  recordPurchase(input: PurchaseRequest): Promise<Result<{ readonly purchaseId: string }>>;
  /** Bounded newest-first purchase history under purchases.view. */
  listPurchases(input: SessionRequest & { readonly after?: PageQuery["after"]; readonly limit?: number }): Promise<Result<Page<PurchaseSummary>>>;
  /** One recorded purchase with its lines and settlement. */
  getPurchase(input: SessionRequest & { readonly purchaseId: string }): Promise<Result<PurchaseView>>;
  /** Accounts with balances under finance.accounts.view and cash.view. */
  listAccounts(input: CatalogueQuery): Promise<Result<Page<AccountView>>>;
  /** Creates an account named by the request ID under finance.accounts.manage. */
  createAccount(input: SessionRequest & { readonly requestId: string; readonly name: string; readonly kind: AccountKind }): Promise<Result<AccountView>>;
  /** Renames, re-kinds, archives or restores an account from the displayed version. */
  updateAccount(input: SessionRequest & { readonly accountId: string; readonly version: string; readonly name: string; readonly kind: AccountKind; readonly active: boolean }): Promise<Result<AccountView>>;
  /** Money in or out of one account with a reason; the request ID names the movement. */
  moveMoney(input: SessionRequest & { readonly requestId: string; readonly accountId: string; readonly direction: "in" | "out"; readonly amountMinor: number; readonly reason: string }): Promise<Result<AccountView>>;
  /** Atomic two-leg transfer between accounts; the request ID names the outgoing leg. */
  transferMoney(input: SessionRequest & { readonly requestId: string; readonly fromAccountId: string; readonly toAccountId: string; readonly amountMinor: number; readonly reason: string }): Promise<Result<AccountView>>;
  /** Compares a counted amount with the expected balance; records audit only. */
  countCash(input: SessionRequest & { readonly accountId: string; readonly countedMinor: number }): Promise<Result<CashCountView>>;
  /** Corrects the books to a count with a reason; a retry returns the original result. */
  correctCash(input: SessionRequest & { readonly requestId: string; readonly accountId: string; readonly countedMinor: number; readonly reason: string }): Promise<Result<CashCountView>>;
  /** Newest-first bounded expenses under expenses.view. */
  listExpenses(input: SessionRequest & { readonly after?: PageQuery["after"]; readonly limit?: number }): Promise<Result<Page<ExpenseView>>>;
  /** Records an expense paid from one account; the request ID names the expense. */
  recordExpense(input: SessionRequest & { readonly requestId: string; readonly accountId: string; readonly category: ExpenseCategory; readonly amountMinor: number; readonly description?: string; readonly reference?: string }): Promise<Result<ExpenseView>>;
  /** Compensates an expense with an equal negative entry; it is never edited. */
  reverseExpense(input: SessionRequest & { readonly requestId: string; readonly expenseId: string }): Promise<Result<ExpenseView>>;
  /**
   * Reads one report for a period given as ISO instants [from, until), computed by the UI from
   * local calendar days. Period-free reports (valuation, debts, alerts) ignore the period.
   */
  report(input: SessionRequest & { readonly kind: ReportKind; readonly from: string; readonly until: string }): Promise<Result<ReportResult>>;
  /**
   * Reads light analytics for [from, until) under reports.sales, bucketing by the shop's local time
   * given as minutes east of UTC. The bucket defaults to one that keeps the trend readable.
   */
  analytics(input: SessionRequest & { readonly from: string; readonly until: string; readonly offsetMinutes: number; readonly bucket?: AnalyticsBucket }): Promise<Result<AnalyticsResult>>;
  /** Returnable lines of a sale (sales.refund) or purchase (purchases.create and purchases.pay). */
  returnSource(input: SessionRequest & { readonly kind: "SALE" | "PURCHASE"; readonly originalId: string }): Promise<Result<ReturnSourceView>>;
  /** Exact value of a selection against the current predecessor. */
  previewReturn(input: SessionRequest & { readonly kind: "SALE" | "PURCHASE"; readonly originalId: string; readonly items: ReturnRequest["items"] }): Promise<Result<ReturnPreview>>;
  /** Records a compensating return; the request ID names it and matching retries return it. */
  recordReturn(input: ReturnRequest): Promise<Result<{ readonly returnId: string }>>;
  /** Local staff under users.view. */
  listStaff(input: SessionRequest): Promise<Result<readonly StaffView[]>>;
  /** Owner-only: adds a member with a role and their own code; names must be unique among staff. */
  createStaff(input: SessionRequest & { readonly name: string; readonly role: Exclude<StaffView["role"], "OWNER">; readonly secret: string }): Promise<Result<StaffView>>;
  /** Owner-only: grants or revokes one permission; asking for the current state changes nothing. */
  setStaffPermission(input: SessionRequest & { readonly userId: string; readonly permission: Permission; readonly allowed: boolean }): Promise<Result<StaffView>>;
  /** Owner-only: suspends or reinstates another member. */
  setStaffActive(input: SessionRequest & { readonly userId: string; readonly active: boolean }): Promise<Result<StaffView>>;
  /** Owner-only: replaces another member's code. */
  resetStaffSecret(input: SessionRequest & { readonly userId: string; readonly secret: string }): Promise<Result<StaffView>>;
  /** Owner: encrypts a backup with a file password and saves it through the native dialog. */
  saveBackup(input: SessionRequest & { readonly password: string; readonly includePhotos?: boolean }): Promise<Result<SavedFile>>;
  /**
   * Import screen: opens one file dialog and reports whether the file is a backup or a pairing
   * invite. The next openBackup or openInvite uses that file instead of asking again.
   */
  chooseImportFile(): Promise<Result<{ readonly kind: "backup" | "invite" }>>;
  /** Checks a backup (the file chosen for import, or a newly picked one); nothing is replaced until restoreBackup. */
  openBackup(input: { readonly password: string }): Promise<Result<BackupFileView>>;
  /**
   * Restores the checked backup after its shop name is typed back, with a new code for this computer.
   * An empty computer restores directly. The owner's session replaces the open shop. Signed out, a
   * computer that has a shop needs `replace: true`: that shop is kept on disk as a safety copy and,
   * if the restore fails, stays the active shop. The restored shop opens locked.
   */
  restoreBackup(input: { readonly sessionId?: string; readonly confirmedName: string; readonly deviceLabel: string; readonly secret: string; readonly replace?: boolean }): Promise<Result<{ readonly activated: boolean }>>;
  /** Forgets any checked file and its staged snapshot. */
  discardFile(): Promise<Result<null>>;
  /** Owner: saves a pairing invite for another till and returns the fingerprint to compare. */
  saveInvite(input: SessionRequest & { readonly authorityAllowed: boolean }): Promise<Result<SavedFile & { readonly fingerprint: string }>>;
  /** Owner: picks and checks a pairing request from a new till. */
  openPairingRequest(input: SessionRequest): Promise<Result<PairingRequestView>>;
  /** Owner: approves the checked request after the code is compared; saves the enrollment file. */
  approvePairingRequest(input: SessionRequest & { readonly confirmedCode: string; readonly password: string }): Promise<Result<SavedFile>>;
  /** Picks and checks a pairing invite from the owner's till. */
  openInvite(): Promise<Result<InviteView>>;
  /** Accepts the checked invite after the fingerprint is compared; saves the request file and returns the code to compare. */
  acceptInvite(input: { readonly sessionId?: string; readonly confirmedFingerprint: string; readonly deviceLabel: string; readonly secret: string }): Promise<Result<SavedFile & { readonly verificationCode: string }>>;
  /** Picks the owner's enrollment file and completes pairing; a new shop opens locked. */
  completePairing(input: { readonly sessionId?: string; readonly password: string; readonly confirmedCode: string }): Promise<Result<{ readonly activated: boolean }>>;
  /** Cancels an unfinished pairing on this till. */
  cancelPairing(): Promise<Result<null>>;
  /** Owner: paired destinations, received batches and diagnostics. */
  exchangeState(input: SessionRequest & { readonly language?: "fr" | "en" }): Promise<Result<ExchangeView>>;
  /** Owner: saves pending events for one destination; `saved:false` with `empty:true` when nothing is pending. */
  saveExchange(input: SessionRequest & { readonly destinationId: string; readonly password: string }): Promise<Result<SavedFile & { readonly empty: boolean }>>;
  /** Owner: picks and checks an exchange file from a paired till. */
  openExchange(input: SessionRequest & { readonly password: string }): Promise<Result<BundleView>>;
  /** Owner: imports the checked exchange file. */
  importExchange(input: SessionRequest): Promise<Result<{ readonly processed: number }>>;
  /** Owner: saves an import receipt for a received batch. */
  saveImportReceipt(input: SessionRequest & { readonly batchId: string; readonly password: string }): Promise<Result<SavedFile>>;
  /** Owner: picks a receipt from a destination and records what it acknowledged. */
  openImportReceipt(input: SessionRequest & { readonly destinationId: string; readonly password: string }): Promise<Result<{ readonly recorded: number }>>;
  /** Owner: retries deferred received events. */
  retryExchange(input: SessionRequest): Promise<Result<{ readonly applied: number }>>;
  /** Bounded account names for cash checkout, without disclosing financial balances. */
  listCashAccounts(input: SessionRequest & PageQuery): Promise<Result<Page<{ readonly id: string; readonly name: string }>>>;
  /** Atomic cash sale; identical retries return the original saved sale ID. */
  checkout(input: CheckoutRequest): Promise<Result<{ readonly saleId: string }>>;
  /** Reads the immutable persisted receipt under current sales-view authority. */
  getReceipt(input: SessionRequest & { readonly saleId: string }): Promise<Result<Receipt>>;
  /** Bounded actor-scoped saved receipt history. */
  /** Newest-first receipt history with each sale's exact total and customer, if any. */
  listReceipts(input: SessionRequest & PageQuery): Promise<Result<Page<{ readonly id: string; readonly number: string; readonly occurredAt: string; readonly totalMinor: number; readonly customerName?: string }>>>;
  /** Invalidation only: subscribers reread bounded pages; no business database mirror. */
  onChanged(listener: () => void): () => void;
}
