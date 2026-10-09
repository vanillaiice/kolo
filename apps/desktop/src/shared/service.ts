import type { Permission } from "@kolo/core/identity/permissions";
import type { Receipt, Page, PageQuery } from "@kolo/core/application/queries";

/** Stable application failures; native exception text, credentials and paths never cross the bridge. */
export type FailureCode = "invalid_input" | "invalid_credential" | "retry_later" | "recovery_required" |
  "credential_unavailable" | "actor_inactive" | "permission_denied" | "scope_mismatch" | "setup_pending" |
  "locked" | "legacy_installation" | "already_configured" | "not_configured" | "busy" | "unavailable" |
  "request_conflict" | "price_changed" | "storage_failed" | "credit_limit";
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
/** Report kinds, each under its own core report permission. */
export type ReportKind = "dashboard" | "sales" | "salesByProduct" | "salesByCategory" | "salesByAccount" | "salesByUser" | "cashFlow" | "valuation" |
  "fastMoving" | "stockAlerts" | "customerDebt" | "supplierDebt" | "purchases";
/** A labelled total; `count` is lines, transactions or entries depending on the report. */
export interface ReportLine { readonly key: string; readonly label: string; readonly totalMinor: number; readonly count: number; }
/** Serializable report results. Row lists are capped; `truncated` says more rows exist. */
export type ReportResult =
  | { readonly kind: "dashboard"; readonly salesMinor: number; readonly transactions: number; readonly grossProfitMinor: number; readonly costMinor: number; readonly linesWithoutCost: number;
      readonly expensesMinor: number; readonly netResultMinor: number; readonly customerDebtMinor: number; readonly supplierDebtMinor: number; readonly lowStock: number }
  | { readonly kind: "sales"; readonly totalMinor: number; readonly transactions: number; readonly itemsSoldThousandths: number }
  | { readonly kind: "salesByProduct" | "salesByCategory" | "salesByAccount" | "salesByUser" | "customerDebt" | "supplierDebt"; readonly lines: readonly ReportLine[]; readonly truncated: boolean }
  | { readonly kind: "cashFlow"; readonly accounts: readonly { readonly accountId: string; readonly name: string; readonly inMinor: number; readonly outMinor: number; readonly netMinor: number; readonly closingMinor: number }[] }
  | { readonly kind: "valuation"; readonly totalMinor: number; readonly uncosted: number; readonly truncated: boolean;
      readonly products: readonly { readonly productId: string; readonly name: string; readonly onHandThousandths: number; readonly unitCostMinor?: number; readonly valueMinor?: number }[] }
  | { readonly kind: "fastMoving"; readonly products: readonly { readonly productId: string; readonly name: string; readonly soldThousandths: number; readonly revenueMinor: number; readonly onHandThousandths: number }[] }
  | { readonly kind: "stockAlerts"; readonly products: readonly { readonly productId: string; readonly name: string; readonly onHandThousandths: number }[]; readonly truncated: boolean }
  | { readonly kind: "purchases"; readonly totalMinor: number; readonly deliveries: number; readonly bySupplier: readonly ReportLine[]; readonly truncated: boolean };
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
