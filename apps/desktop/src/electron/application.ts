import { createWorkspace, currentInstallation, recoverWorkspaceSetup, resumeWorkspaceProvisioning, unlockWorkspace, lockWorkspace, unlockedActor, rememberMember, resumeWorkspace, type RememberedMember } from "@kolo/core/identity/workspace";
import { ownerRecoveryCode, recoverOwnerAccess, resumeOwnerRecovery } from "@kolo/core/identity/recovery";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "@kolo/core/identity/types";
import type { Permission } from "@kolo/core/identity/permissions";
import { capabilities, products, scannedProduct, productStock, paymentAccounts, receipt, receipts, categories, stockHistory, customers, statement } from "@kolo/core/application/queries";
import { saveProduct, adjustStock, completeSale, countStock, saveCategory, saveCustomer, receiveCustomerPayment, setProductCategories } from "@kolo/core/application/operations";
import { productCategories } from "@kolo/core/application/records";
import { customerOf, balanceOf, wouldExceedCreditLimit, type Customer } from "@kolo/core/data/customers/customers";
import type { Queryable } from "@kolo/core/data/database/driver";
import { productOf, type Product } from "@kolo/core/data/products/products";
import { categoryOf, type Category } from "@kolo/core/data/products/categories";
import { accountOf } from "@kolo/core/data/finance/accounts";
import { subtotalOf, saleTotals } from "@kolo/core/rules/pricing";
import { RuleError } from "@kolo/core/rules/amounts";
import { subscribeChanges } from "@kolo/core/data/database/changes";
import { sealPendingEvents } from "@kolo/core/application/exchange";
import type { ExchangeCrypto } from "@kolo/core/exchange/types";
import type { CategoryView, CustomerDetails, CustomerView, ProductView, Result, SessionPreferences, ShopService, WorkspaceView } from "../shared/service.js";
import { object, text, uuid, whole, boolean, page, optional } from "./validation.ts";
import { CommandError, isValidationError, nextVersion, type Host } from "./host.ts";
import * as purchasing from "./purchasing.ts";
import * as finance from "./finance.ts";
import * as reports from "./reports.ts";
import * as returns from "./returns.ts";
import * as staff from "./staff.ts";
import * as transfer from "./transfer.ts";
import type { Database } from "@kolo/core/data/database/driver";
import { migrate } from "@kolo/core/data/database/migrations";
import { createHash } from "node:crypto";
import { photoUsage, productPhoto, productPhotoDigest, removeProductPhoto, setProductPhoto } from "@kolo/core/application/photos";
import { PhotoError, PHOTO_LIMITS } from "@kolo/core/data/products/photos";
import { memoryPreferences, type DevicePreferences } from "./preferences.ts";

const customerFields = ["name", "phone", "address", "notes", "creditLimitMinor"] as const;
function customerDetails(data: Record<string, unknown>): CustomerDetails {
  const phone = optional(data["phone"], value => text(value, 40)), address = optional(data["address"], value => text(value, 200));
  const notes = optional(data["notes"], value => text(value, 500)), creditLimitMinor = optional(data["creditLimitMinor"], value => whole(value));
  return { name: text(data["name"]), ...(phone === undefined ? {} : { phone }), ...(address === undefined ? {} : { address }),
    ...(notes === undefined ? {} : { notes }), ...(creditLimitMinor === undefined ? {} : { creditLimitMinor }) };
}
function sameDetails(stored: Customer, details: CustomerDetails): boolean {
  return stored.name === details.name && stored.phone === details.phone && stored.address === details.address &&
    stored.notes === details.notes && stored.creditLimitMinor === details.creditLimitMinor;
}
/**
 * Host storage for staying signed in. The remembered member must live in OS-protected storage;
 * the enabled flag defaults to on when nothing was saved.
 */
export interface SessionMemory {
  enabled(): Promise<boolean>;
  setEnabled(value: boolean): Promise<void>;
  read(): Promise<RememberedMember | undefined>;
  write(value: RememberedMember | undefined): Promise<void>;
}
/** Desktop authority and operations. The opaque core context never leaves this host object. */
export class DesktopApplication implements ShopService {
  #context: OperationContext | undefined;
  #sessionId: string | undefined;
  #identityBusy = false;
  #closed = false;
  #epoch = 0;
  #pending = new Set<Promise<unknown>>();
  #listeners = new Set<() => void>();
  #unsubscribe: () => void;
  #sealing = false;
  private readonly ports: WorkspacePorts;
  readonly #host: Host;
  readonly #transfer: (transfer.TransferPorts & { readonly onActivated: (database: Database) => Promise<void>; readonly onReset?: () => void }) | undefined;
  #staged: transfer.StagedFile | undefined;
  private readonly crypto: ExchangeCrypto | undefined;
  readonly #memory: SessionMemory | undefined;
  readonly #preferences: DevicePreferences;
  #remember = false;
  constructor(ports: WorkspacePorts, crypto?: ExchangeCrypto, files?: transfer.TransferPorts & { readonly onActivated: (database: Database) => Promise<void>; readonly onReset?: () => void }, memory?: SessionMemory, preferences: DevicePreferences = memoryPreferences()) {
    this.#transfer = files; this.#memory = memory; this.#preferences = preferences;
    this.ports = ports; this.crypto = crypto; this.#host = { ports, actor: (data, required) => this.#actor(data, required) };
    lockWorkspace(ports.database);
    this.#unsubscribe = subscribeChanges(ports.database, ["products", "inventory", "sales", "customers", "suppliers", "purchases", "accounts", "expenses", "authority"], () => this.#notify());
  }
  /** Completes durable secret/SQLite crash gaps before exposing the locked installation. */
  async initialize(): Promise<void> {
    await this.#track(this.#identity(async () => { await recoverWorkspaceSetup(this.ports); await resumeOwnerRecovery(this.ports); await this.#resume(); }));
  }
  /**
   * Automatic lock from the host. "away" (minimize, suspend, OS lock) is skipped while the user
   * chose to stay signed in; "integrity" (renderer loss/navigation) always locks but keeps the
   * remembered user for the next start.
   */
  async autoLock(reason: "away" | "integrity"): Promise<void> {
    if (reason === "away" && this.#remember && this.#context !== undefined) return;
    await this.#run(() => { this.#invalidate(); this.#notify(); });
  }
  /** Invalidates authority immediately, then waits for native work before the caller closes SQLite. */
  async dispose(): Promise<void> {
    this.#closed = true; this.#invalidate(); this.#unsubscribe(); this.#listeners.clear();
    await transfer.release(this.#staged); this.#staged = undefined;
    await Promise.allSettled([...this.#pending]);
  }
  /** Retries signing asynchronously; financial success never depends on signing or delivery. */
  async seal(): Promise<void> {
    if (this.crypto === undefined || this.#context === undefined || this.#closed || this.#sealing) return;
    this.#sealing = true;
    try { await this.#track(sealPendingEvents(this.#context, this.crypto)); }
    catch { /* Unsigned committed events remain durable and retry on the next unlocked tick. */ }
    finally { this.#sealing = false; }
  }
  /** Invalidation-only subscription; observer errors cannot change command success. */
  onChanged(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  /** Public boot metadata and current session; invalid/suspended contexts return locked views. */
  getWorkspace(): Promise<Result<WorkspaceView>> { return this.#run(() => this.#view()); }
  /**
   * Confirms the displayed locked/pending/legacy shop and switches to a migrated empty slot.
   * No credential proof is required to start a separate shop; old data/credentials are retained
   * and remain protected. Single-flight identity work and the slot CAS prevent overlapping swaps.
   * Failed staging/activation keeps the previous active slot; a successful switch returns activated.
   */
  startNewShop(input: unknown): ReturnType<ShopService["startNewShop"]> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["confirmedName"]), view = this.#view();
      if (!["locked", "pending", "legacy"].includes(view.state)) throw new CommandError("permission_denied");
      if (text(data["confirmedName"]) !== (view.shopName ?? "KOLO")) throw new CommandError("confirmation_required");
      const files = this.#transfer;
      if (files === undefined) throw new CommandError("unavailable");
      const epoch = this.#epoch;
      return transfer.translated(async () => {
        const candidate = await files.files.empty();
        try {
          migrate(candidate.database); this.#checkEpoch(epoch);
          const next = await candidate.activate(this.ports.database);
          this.#invalidate(); await transfer.release(this.#staged); this.#staged = undefined;
          await files.onActivated(next);
          return { activated: true } as const;
        } finally { await candidate.discard(); }
      });
    }));
  }
  savedShops(): ReturnType<ShopService["savedShops"]> {
    return this.#run(async () => {
      if (this.#view().state === "unlocked") throw new CommandError("permission_denied");
      return this.#transfer?.files.saved?.() ?? [];
    });
  }
  openSavedShop(input: unknown): ReturnType<ShopService["openSavedShop"]> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["id"]);
      if (this.#view().state === "unlocked") throw new CommandError("permission_denied");
      const files = this.#transfer, epoch = this.#epoch;
      if (files?.files.selectSaved === undefined) throw new CommandError("unavailable");
      return transfer.translated(async () => {
        this.#checkEpoch(epoch);
        const next = await files.files.selectSaved!(text(data["id"]), this.ports.database);
        this.#invalidate(); await transfer.release(this.#staged); this.#staged = undefined;
        await files.onActivated(next);
        return { activated: true } as const;
      });
    }));
  }
  /** Strict fresh setup bound to host identity/platform, with protected native provisioning. */
  createShop(input: unknown): Promise<Result<WorkspaceView>> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["businessName", "ownerName", "deviceLabel", "cashAccountName", "secret"]);
      const epoch = this.#epoch;
      await createWorkspace({ businessName: text(data["businessName"]), ownerName: text(data["ownerName"]),
        deviceLabel: text(data["deviceLabel"]), secret: text(data["secret"], 256, false), currency: "XAF", platform: "DESKTOP",
        accounts: [{ name: text(data["cashAccountName"]), kind: "CASH" }] }, this.ports);
      this.#checkEpoch(epoch); this.#notify(); return this.#view();
    }));
  }
  /** Retries the existing durable setup intent with the supplied secret and no replacement identities. */
  finishSetup(input: unknown): Promise<Result<WorkspaceView>> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["secret"]), epoch = this.#epoch;
      await resumeWorkspaceProvisioning(text(data["secret"], 256, false), this.ports);
      this.#checkEpoch(epoch); this.#notify(); return this.#view();
    }));
  }
  /** Single-flight local proof issues an opaque display session; lock cancels a pending proof. */
  unlock(input: unknown): Promise<Result<WorkspaceView>> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["userId", "secret"]), epoch = this.#epoch;
      this.#invalidate(false);
      const context = await unlockWorkspace({ userId: uuid(data["userId"]), secret: text(data["secret"], 256, false) }, this.ports);
      this.#checkEpoch(epoch); this.#context = context; this.#sessionId = this.ports.newId(); this.#notify();
      if (this.#remember) await this.#store(rememberMember(context), epoch);
      return this.#view();
    }));
  }
  /** Immediately invalidates authority and in-flight proofs, and forgets a remembered user. */
  lock(): Promise<Result<WorkspaceView>> {
    return this.#run(async () => { this.#invalidate(); this.#notify(); await this.#store(undefined); return this.#view(); });
  }
  sessionPreferences(input: unknown): Promise<Result<SessionPreferences>> {
    return this.#run(() => { this.#actor(object(input, ["sessionId"])); return { rememberSession: this.#remember, largeFiles: this.#preferences.largeFiles() }; });
  }
  setRememberSession(input: unknown): Promise<Result<SessionPreferences>> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["sessionId", "enabled"]), context = this.#actor(data), enabled = boolean(data["enabled"]), epoch = this.#epoch;
      const memory = this.#memory;
      if (memory === undefined) throw new CommandError("unavailable");
      await memory.setEnabled(enabled); this.#remember = enabled;
      await this.#store(enabled ? rememberMember(context) : undefined, epoch);
      return { rememberSession: enabled, largeFiles: this.#preferences.largeFiles() };
    }));
  }
  /** Owner switch for this computer's transfer-file and photo-storage limits. */
  setLargeFiles(input: unknown): Promise<Result<SessionPreferences>> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "enabled"]); this.#actor(data, ["business.settings"]);
      this.#preferences.setLargeFiles(boolean(data["enabled"]));
      return { rememberSession: this.#remember, largeFiles: this.#preferences.largeFiles() };
    });
  }
  /**
   * Erases this computer's shops after the typed shop name and the owner's code. The session is locked
   * and the remembered user forgotten before the host deletes files, after this command has answered.
   */
  resetComputer(input: unknown): Promise<Result<null>> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["sessionId", "confirmedName", "secret"]), context = this.#actor(data, ["business.settings"]);
      if (!unlockedActor(context).isOwner) throw new WorkspaceError("permission_denied");
      const reset = this.#transfer?.onReset;
      if (reset === undefined) throw new CommandError("unavailable");
      const shop = this.ports.database.get(`SELECT name FROM businesses WHERE id=?`, [context.businessId]);
      if (text(data["confirmedName"], 120, false).trim() !== String(shop?.["name"] ?? "")) throw new CommandError("confirmation_required");
      const member = this.ports.database.get(`SELECT credential_reference FROM local_memberships WHERE business_id=? AND user_id=?`, [context.businessId, context.userId]);
      if (member === undefined || !await this.ports.credentials.verify(String(member["credential_reference"]), text(data["secret"], 256, false))) throw new WorkspaceError("invalid_credential");
      this.#invalidate(); await this.#store(undefined);
      reset();
      return null;
    }));
  }
  /** Owner recovery uses the separate protected key and leaves the installation locked. */
  recoverAccess(input: unknown): Promise<Result<WorkspaceView>> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["recoveryCode", "newSecret"]), epoch = this.#epoch;
      this.#invalidate(false);
      await this.#store(undefined);
      await recoverOwnerAccess({ recoveryCode: text(data["recoveryCode"], 256), newSecret: text(data["newSecret"], 256, false) }, this.ports);
      this.#checkEpoch(epoch); this.#notify(); return this.#view();
    }));
  }
  /** Returns a protected owner recovery key only after current authority and fresh secret proof. */
  recoveryKey(input: unknown): Promise<Result<string | null>> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["sessionId", "secret"]), context = this.#actor(data), epoch = this.#epoch;
      const value = await ownerRecoveryCode(context, text(data["secret"], 256, false));
      this.#checkEpoch(epoch); this.#actor(data); return value ?? null;
    }));
  }
  /** Bounded catalogue with optional stock according to current view capabilities. */
  listProducts(input: unknown): ReturnType<ShopService["listProducts"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "term", "after", "limit", "includeInactive", "categoryId"]), context = this.#actor(data);
      const result = products(context, page(data)); return { ...result, items: result.items.map(item => this.#product(context, item)) };
    });
  }
  /** One scoped product under products.view, archived or not. */
  getProduct(input: unknown): ReturnType<ShopService["getProduct"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "productId"]), context = this.#actor(data, ["products.view"]);
      const product = productOf(this.ports.database, context.businessId, uuid(data["productId"]));
      if (product === undefined) throw new WorkspaceError("scope_mismatch");
      return { ...this.#product(context, product), otherCategoryIds: productCategories(context, product.id).categories.map(item => item.id) };
    });
  }
  /** Exact active/unambiguous barcode lookup; no prefix/name substitution. */
  scanProduct(input: unknown): ReturnType<ShopService["scanProduct"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "barcode"]), context = this.#actor(data);
      const item = scannedProduct(context, text(data["barcode"], 256)); return item === undefined ? null : this.#product(context, item);
    });
  }
  /** A product's photo as a data URL under products.view; null when this computer holds none. */
  productPhoto(input: unknown): ReturnType<ShopService["productPhoto"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "productId"]), photo = productPhoto(this.#actor(data, ["products.view"]), uuid(data["productId"]));
      return photo === undefined ? null : { digest: photo.digest, dataUrl: `data:${photo.mediaType};base64,${Buffer.from(photo.bytes).toString("base64")}` };
    });
  }
  /** Stores or replaces a product's photo under products.edit; the bytes are checked in core before anything is written. */
  setProductPhoto(input: unknown): ReturnType<ShopService["setProductPhoto"]> {
    return this.#run(async () => {
      const data = object(input, ["sessionId", "productId", "bytes"]), context = this.#actor(data, ["products.edit"]), id = uuid(data["productId"]), bytes = data["bytes"];
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > PHOTO_LIMITS.maxBytes) throw new CommandError("invalid_photo");
      try { await setProductPhoto(context, { productId: id, bytes: new Uint8Array(bytes) }, { sha256Bytes: async value => createHash("sha256").update(value).digest("hex") }, { large: this.#preferences.largeFiles() }); }
      catch (error) { if (error instanceof PhotoError) throw new CommandError(error.code); throw error; }
      return this.#stored(context, id);
    });
  }
  /** Removes a product's photo under products.edit. */
  removeProductPhoto(input: unknown): ReturnType<ShopService["removeProductPhoto"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "productId"]), context = this.#actor(data, ["products.edit"]), id = uuid(data["productId"]);
      removeProductPhoto(context, id); return this.#stored(context, id);
    });
  }
  /** Photo storage against this computer's limit. */
  photoUsage(input: unknown): ReturnType<ShopService["photoUsage"]> {
    return this.#run(() => photoUsage(this.#actor(object(input, ["sessionId"]), ["products.view"]), { large: this.#preferences.largeFiles() }));
  }
  #stored(context: OperationContext, id: string): ProductView {
    const product = productOf(this.ports.database, context.businessId, id);
    if (product === undefined) throw new WorkspaceError("scope_mismatch");
    return this.#product(context, product);
  }
  /** Creates product and optional opening stock in one transaction; safe matching retries reuse the product ID. */
  createProduct(input: unknown): ReturnType<ShopService["createProduct"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "requestId", "name", "unit", "divisible", "barcode", "sellingPriceMinor", "purchasePriceMinor", "openingThousandths"]);
      const context = this.#actor(data, ["products.create"]), id = uuid(data["requestId"]), at = this.ports.now();
      const product = { id, name: text(data["name"]), unit: text(data["unit"]), divisible: boolean(data["divisible"]),
        sellingPriceMinor: whole(data["sellingPriceMinor"]), ...(data["purchasePriceMinor"] === undefined ? {} : { purchasePriceMinor: whole(data["purchasePriceMinor"]) }),
        ...(data["barcode"] === undefined ? {} : { barcode: text(data["barcode"], 256) }), currency: "XAF", taxRateBasisPoints: 0,
        minimumStock: 0, active: true, createdAt: at, updatedAt: at };
      const opening = whole(data["openingThousandths"]);
      if (!product.divisible && opening % 1000 !== 0) throw new WorkspaceError("invalid_input");
      if (opening > 0) this.#actor(data, ["inventory.adjust"]);
      return this.ports.database.transaction(tx => {
        const existing = tx.get(`SELECT * FROM products WHERE id=?`, [id]);
        if (existing !== undefined) {
          const original = productOf(tx, context.businessId, id);
          const actor = tx.get(`SELECT user_id FROM local_audit WHERE business_id=? AND device_id=? AND action='PRODUCT_SAVED' AND entity_id=? ORDER BY occurred_at LIMIT 1`, [context.businessId, context.deviceId, id]);
          const stock = tx.get(`SELECT coalesce(sum(quantity),0) AS n FROM inventory_movements WHERE business_id=? AND product_id=? AND type='OPENING_BALANCE'`, [context.businessId, id]);
          if (original === undefined || actor?.["user_id"] !== context.userId || original.updatedByDevice !== context.deviceId ||
            original.name !== product.name || original.unit !== product.unit || original.divisible !== product.divisible || original.barcode !== product.barcode ||
            original.sellingPriceMinor !== product.sellingPriceMinor || original.purchasePriceMinor !== product.purchasePriceMinor || Number(stock?.["n"]) !== opening) throw new CommandError("request_conflict");
          return this.#product(context, original);
        }
        saveProduct(context, product);
        if (opening > 0) adjustStock(context, { id: this.ports.newId(), productId: id, type: "OPENING_BALANCE", quantity: opening,
          reason: "Initial stock", occurredAt: at, branchId: unlockedActor(context).branchId }, this.ports.newId());
        return this.#product(context, productOf(tx, context.businessId, id)!);
      });
    });
  }
  /**
   * Edits an active product's details from the displayed version. Unchanged requests (including
   * a retry after success) return the stored product; a newer stored version is never overwritten.
   */
  updateProduct(input: unknown): ReturnType<ShopService["updateProduct"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "productId", "version", "name", "unit", "barcode", "sellingPriceMinor", "purchasePriceMinor", "categoryId", "minimumStockThousandths", "otherCategoryIds"]);
      const context = this.#actor(data, ["products.edit"]), id = uuid(data["productId"]), version = text(data["version"], 64);
      const details = { name: text(data["name"]), unit: text(data["unit"]), barcode: optional(data["barcode"], value => text(value, 256)),
        sellingPriceMinor: whole(data["sellingPriceMinor"]), purchasePriceMinor: optional(data["purchasePriceMinor"], value => whole(value)),
        categoryId: optional(data["categoryId"], uuid), minimumStock: whole(data["minimumStockThousandths"]) };
      const others = optional(data["otherCategoryIds"], value => {
        if (!Array.isArray(value) || value.length > 20) throw new WorkspaceError("invalid_input");
        return [...new Set(value.map(uuid))].filter(item => item !== details.categoryId).sort();
      });
      return this.ports.database.transaction(tx => {
        const stored = productOf(tx, context.businessId, id);
        if (stored?.active !== true) throw new WorkspaceError("scope_mismatch");
        if (!stored.divisible && details.minimumStock % 1000 !== 0) throw new WorkspaceError("invalid_input");
        const set = productCategories(context, id), current = set.categories.map(item => item.id).sort();
        const sameDetails = (Object.keys(details) as (keyof typeof details)[]).every(key => stored[key] === details[key]);
        const sameOthers = others === undefined || others.join() === current.filter(item => item !== details.categoryId).join();
        const view = (): ProductView => ({ ...this.#product(context, productOf(tx, context.businessId, id)!), otherCategoryIds: productCategories(context, id).categories.map(item => item.id) });
        if (sameDetails && sameOthers) return view();
        if (stored.updatedAt !== version) throw new CommandError("request_conflict");
        if (!sameDetails && !saveProduct(context, { ...stored, ...details, updatedAt: this.#nextVersion(stored.updatedAt) })) throw new CommandError("request_conflict");
        // Additional categories have their own last-write-wins version; a new main category drops out of them.
        const wanted = others ?? current.filter(item => item !== details.categoryId);
        if (wanted.join() !== current.join() && !setProductCategories(context, { productId: id, categoryIds: wanted, updatedAt: set.updatedAt === undefined ? this.ports.now() : this.#nextVersion(set.updatedAt) }))
          throw new CommandError("request_conflict");
        return view();
      });
    });
  }
  /** Archives or restores a product; repeating the same target state is a no-op. */
  setProductActive(input: unknown): ReturnType<ShopService["setProductActive"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "productId", "version", "active"]), context = this.#actor(data, ["products.edit", "products.archive"]);
      const id = uuid(data["productId"]), version = text(data["version"], 64), active = boolean(data["active"]);
      return this.ports.database.transaction(tx => {
        const stored = productOf(tx, context.businessId, id);
        if (stored === undefined) throw new WorkspaceError("scope_mismatch");
        if (stored.active === active) return this.#product(context, stored);
        if (stored.updatedAt !== version) throw new CommandError("request_conflict");
        if (!saveProduct(context, { ...stored, active, updatedAt: this.#nextVersion(stored.updatedAt) })) throw new CommandError("request_conflict");
        return this.#product(context, productOf(tx, context.businessId, id)!);
      });
    });
  }
  /** Bounded categories under products.view, optionally with archived ones. */
  listCategories(input: unknown): ReturnType<ShopService["listCategories"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "term", "after", "limit", "includeInactive"]), context = this.#actor(data);
      const result = categories(context, page(data)); return { ...result, items: result.items.map(item => this.#category(item)) };
    });
  }
  /** Creates a category named by its request ID; only this actor's identical creation counts as a retry. */
  createCategory(input: unknown): ReturnType<ShopService["createCategory"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "requestId", "name"]), context = this.#actor(data, ["products.create"]);
      const id = uuid(data["requestId"]), name = text(data["name"]), at = this.ports.now();
      return this.ports.database.transaction(tx => {
        if (tx.get(`SELECT 1 FROM categories WHERE id=?`, [id]) !== undefined) {
          const original = categoryOf(tx, context.businessId, id);
          const actor = tx.get(`SELECT user_id FROM local_audit WHERE business_id=? AND device_id=? AND action='CATEGORY_SAVED' AND entity_id=? ORDER BY occurred_at LIMIT 1`, [context.businessId, context.deviceId, id]);
          if (original === undefined || actor?.["user_id"] !== context.userId || original.createdAt !== original.updatedAt || original.name !== name) throw new CommandError("request_conflict");
          return this.#category(original);
        }
        saveCategory(context, { id, name, active: true, createdAt: at, updatedAt: at });
        return this.#category(categoryOf(tx, context.businessId, id)!);
      });
    });
  }
  /** Renames, archives or restores a category from its displayed version. */
  updateCategory(input: unknown): ReturnType<ShopService["updateCategory"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "categoryId", "version", "name", "active"]), context = this.#actor(data, ["products.edit"]);
      const id = uuid(data["categoryId"]), version = text(data["version"], 64), name = text(data["name"]), active = boolean(data["active"]);
      return this.ports.database.transaction(tx => {
        const stored = categoryOf(tx, context.businessId, id);
        if (stored === undefined) throw new WorkspaceError("scope_mismatch");
        if (stored.active !== active) this.#actor(data, ["products.archive"]);
        if (stored.name === name && stored.active === active) return this.#category(stored);
        if (stored.updatedAt !== version) throw new CommandError("request_conflict");
        if (!saveCategory(context, { id, name, active, createdAt: stored.createdAt, updatedAt: this.#nextVersion(stored.updatedAt) })) throw new CommandError("request_conflict");
        return this.#category(categoryOf(tx, context.businessId, id)!);
      });
    });
  }
  /** Adds stock or records damage on an active product; the request ID is the movement ID. */
  moveStock(input: unknown): ReturnType<ShopService["moveStock"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "requestId", "productId", "kind", "quantityThousandths", "reason"]), context = this.#actor(data, ["inventory.adjust"]);
      if (data["kind"] !== "add" && data["kind"] !== "damage") throw new WorkspaceError("invalid_input");
      const id = uuid(data["requestId"]), productId = uuid(data["productId"]), type = data["kind"] === "add" ? "ADJUSTMENT" : "DAMAGE";
      const amount = whole(data["quantityThousandths"], 1), quantity = type === "DAMAGE" ? -amount : amount, reason = text(data["reason"]);
      return this.ports.database.transaction(tx => {
        const saved = tx.get(`SELECT * FROM inventory_movements WHERE id=?`, [id]);
        if (saved !== undefined) {
          if (saved["business_id"] !== context.businessId || saved["user_id"] !== context.userId || saved["device_id"] !== context.deviceId || saved["product_id"] !== productId ||
            saved["type"] !== type || saved["quantity"] !== quantity || saved["reason"] !== reason) throw new CommandError("request_conflict");
        } else adjustStock(context, { id, productId, type, quantity, reason, occurredAt: this.ports.now(), branchId: unlockedActor(context).branchId }, this.ports.newId());
        const product = productOf(tx, context.businessId, productId);
        if (product === undefined) throw new WorkspaceError("scope_mismatch");
        return this.#product(context, product);
      });
    });
  }
  /** Records a shelf count; a retry returns the original difference instead of recounting. */
  countStock(input: unknown): ReturnType<ShopService["countStock"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "requestId", "productId", "countedThousandths", "reason"]), context = this.#actor(data, ["inventory.count"]);
      const id = uuid(data["requestId"]), productId = uuid(data["productId"]), counted = whole(data["countedThousandths"]), reason = text(data["reason"]);
      return this.ports.database.transaction(tx => {
        const prior = tx.get(`SELECT user_id,device_id,entity_id,payload FROM local_audit WHERE business_id=? AND action='STOCK_COUNTED' AND json_extract(payload,'$.requestId')=?`, [context.businessId, id]);
        let delta: number;
        if (prior !== undefined) {
          const facts = JSON.parse(String(prior["payload"])) as { countedThousandths: number; delta: number; reason: string };
          if (prior["user_id"] !== context.userId || prior["device_id"] !== context.deviceId || prior["entity_id"] !== productId ||
            facts.countedThousandths !== counted || facts.reason !== reason) throw new CommandError("request_conflict");
          delta = facts.delta;
        } else {
          if (tx.get(`SELECT 1 FROM inventory_movements WHERE id=?`, [id]) !== undefined) throw new CommandError("request_conflict");
          delta = countStock(context, { productId, countedThousandths: counted, reason, branchId: unlockedActor(context).branchId, requestId: id });
        }
        const product = productOf(tx, context.businessId, productId);
        if (product === undefined) throw new WorkspaceError("scope_mismatch");
        return { deltaThousandths: delta, product: this.#product(context, product) };
      });
    });
  }
  /** Newest-first bounded stock movements of one product. */
  stockHistory(input: unknown): ReturnType<ShopService["stockHistory"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "productId", "after", "limit"]), context = this.#actor(data);
      const result = stockHistory(context, uuid(data["productId"]), page(data));
      return { ...result, items: result.items.map(row => ({ id: String(row["id"]), occurredAt: String(row["occurred_at"]), type: String(row["type"]),
        quantityThousandths: Number(row["quantity"]), ...(typeof row["reason"] === "string" && row["reason"] !== "" ? { reason: row["reason"] } : {}) })) };
    });
  }
  /** Bounded cash-account names only; balances are never exposed to payment-only readers. */
  listCashAccounts(input: unknown): ReturnType<ShopService["listCashAccounts"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "term", "after", "limit"]), context = this.#actor(data);
      const result = paymentAccounts(context, page(data));
      return { ...result, items: result.items.filter(account => account.kind === "CASH").map(({ id, name }) => ({ id, name })) };
    });
  }
  /** Account names and kinds for payments; balances stay behind finance authority. */
  listPaymentAccounts(input: unknown): ReturnType<ShopService["listPaymentAccounts"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "term", "after", "limit"]), context = this.#actor(data);
      const result = paymentAccounts(context, page(data));
      return { ...result, items: result.items.map(({ id, name, kind }) => ({ id, name, kind })) };
    });
  }
  /**
   * Host-bound atomic sale with split payments and optional customer credit. Matching retries
   * (same actor, lines, payments and customer) return the original ID; differing content is refused.
   * The legacy `accountId` form records the exact total in one active cash account.
   */
  checkout(input: unknown): ReturnType<ShopService["checkout"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "requestId", "accountId", "payments", "customerId", "discountMinor", "lines"]), context = this.#actor(data, ["sales.create", "products.view"]);
      const id = uuid(data["requestId"]), customerId = optional(data["customerId"], uuid), discountMinor = whole(data["discountMinor"] ?? 0);
      if (!Array.isArray(data["lines"]) || data["lines"].length < 1 || data["lines"].length > 200) throw new WorkspaceError("invalid_input");
      const lines = data["lines"].map(value => { const item = object(value, ["productId", "quantity", "unitPriceMinor"]);
        return { productId: uuid(item["productId"]), quantity: whole(item["quantity"], 1), unitPriceMinor: whole(item["unitPriceMinor"]) }; });
      if (new Set(lines.map(line => line.productId)).size !== lines.length) throw new WorkspaceError("invalid_input");
      const total = subtotalOf(lines), legacy = data["payments"] === undefined;
      if (legacy === (data["accountId"] === undefined) || legacy && discountMinor > 0) throw new WorkspaceError("invalid_input");
      let payments: { accountId: string; amountMinor: number }[];
      if (legacy) payments = total > 0 ? [{ accountId: uuid(data["accountId"]), amountMinor: total }] : [];
      else {
        if (!Array.isArray(data["payments"]) || data["payments"].length > 8) throw new WorkspaceError("invalid_input");
        payments = data["payments"].map(value => { const item = object(value, ["accountId", "amountMinor"]); return { accountId: uuid(item["accountId"]), amountMinor: whole(item["amountMinor"], 1) }; });
        if (new Set(payments.map(payment => payment.accountId)).size !== payments.length) throw new WorkspaceError("invalid_input");
      }
      const settled = saleTotals({ lines, payments, customerId, discountMinor });
      return this.ports.database.transaction(tx => {
        const saved = tx.get(`SELECT business_id,user_id,device_id,discount_minor,customer_id FROM sales WHERE id=?`, [id]);
        if (saved !== undefined) {
          if (saved["business_id"] !== context.businessId || saved["user_id"] !== context.userId || saved["device_id"] !== context.deviceId) throw new CommandError("request_conflict");
          // Creation authority is enough to retry one's own command even after
          // receipt-view permission is revoked. No receipt facts are returned here.
          const originalLines = tx.all(`SELECT product_id,quantity,unit_price_minor,discount_minor FROM sale_items WHERE business_id=? AND sale_id=?`, [context.businessId,id]);
          const originalPayments = tx.all(`SELECT account_id,amount_minor FROM sale_payments WHERE business_id=? AND sale_id=?`, [context.businessId,id]);
          const sorted = (items: readonly Record<string, unknown>[]): string => JSON.stringify(items.map(item => JSON.stringify(item)).sort());
          if (saved["discount_minor"] !== discountMinor || saved["customer_id"] !== (customerId ?? null) || originalLines.some(line=>line["discount_minor"]!==0) ||
            sorted(originalLines.map(line=>({productId:line["product_id"],quantity:line["quantity"],unitPriceMinor:line["unit_price_minor"]}))) !== sorted(lines) ||
            sorted(originalPayments.map(payment=>({accountId:payment["account_id"],amountMinor:payment["amount_minor"]}))) !== sorted(payments)) throw new CommandError("request_conflict");
          return { saleId: id };
        }
        if (legacy) { const account = accountOf(tx, context.businessId, uuid(data["accountId"])); if (account?.active !== true || account.kind !== "CASH") throw new WorkspaceError("scope_mismatch"); }
        if (settled.outstandingMinor > 0) {
          const permissions = capabilities(context), customer = customerOf(tx, context.businessId, customerId!);
          if (!permissions.includes("customers.credit")) throw new WorkspaceError("permission_denied");
          if (customer?.active === true && !permissions.includes("customers.credit_override") && wouldExceedCreditLimit(tx, context.businessId, customer, settled.outstandingMinor)) throw new CommandError("credit_limit");
        }
        const at = this.ports.now(), recordedLines = lines.map(line => {
          const product = productOf(tx, context.businessId, line.productId);
          if (product?.active !== true) throw new WorkspaceError("scope_mismatch");
          if (product.sellingPriceMinor !== line.unitPriceMinor) throw new CommandError("price_changed");
          return { ...line, id: this.ports.newId(), movementId: this.ports.newId(), name: product.name,
            unitCostMinor: product.purchasePriceMinor, taxRateBasisPoints: product.taxRateBasisPoints };
        });
        completeSale(context, { id, number: `V-${id}`, occurredAt: at, branchId: unlockedActor(context).branchId, customerId, discountMinor,
          eventId: this.ports.newId(), lines: recordedLines, payments: payments.map(payment => ({ id: this.ports.newId(), ...payment })),
          ...(settled.outstandingMinor > 0 ? { creditTransactionId: this.ports.newId() } : {}) });
        return { saleId: id };
      });
    });
  }
  /** Bounded customers with balances under customers.view. */
  listCustomers(input: unknown): ReturnType<ShopService["listCustomers"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "term", "after", "limit", "includeInactive"]), context = this.#actor(data);
      const result = customers(context, page(data)); return { ...result, items: result.items.map(item => this.#customer(item, item.outstandingMinor)) };
    });
  }
  /** One scoped customer under customers.view, archived or not. */
  getCustomer(input: unknown): ReturnType<ShopService["getCustomer"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "customerId"]), context = this.#actor(data, ["customers.view"]);
      return this.#storedCustomer(this.ports.database, context, uuid(data["customerId"]));
    });
  }
  /** Creates a customer named by its request ID; only this actor's identical creation counts as a retry. */
  createCustomer(input: unknown): ReturnType<ShopService["createCustomer"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "requestId", ...customerFields]), context = this.#actor(data, ["customers.manage", "customers.view"]);
      const id = uuid(data["requestId"]), details = customerDetails(data), at = this.ports.now();
      return this.ports.database.transaction(tx => {
        if (tx.get(`SELECT 1 FROM customers WHERE id=?`, [id]) !== undefined) {
          const original = customerOf(tx, context.businessId, id);
          const actor = tx.get(`SELECT user_id FROM local_audit WHERE business_id=? AND device_id=? AND action='CUSTOMER_SAVED' AND entity_id=? ORDER BY occurred_at LIMIT 1`, [context.businessId, context.deviceId, id]);
          if (original === undefined || actor?.["user_id"] !== context.userId || original.createdAt !== original.updatedAt || !sameDetails(original, details)) throw new CommandError("request_conflict");
          return this.#storedCustomer(tx, context, id);
        }
        saveCustomer(context, { id, ...details, active: true, createdAt: at, updatedAt: at });
        return this.#storedCustomer(tx, context, id);
      });
    });
  }
  /** Edits, archives or restores a customer from the displayed version; identical requests write nothing. */
  updateCustomer(input: unknown): ReturnType<ShopService["updateCustomer"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "customerId", "version", "active", ...customerFields]), context = this.#actor(data, ["customers.manage", "customers.view"]);
      const id = uuid(data["customerId"]), version = text(data["version"], 64), active = boolean(data["active"]), details = customerDetails(data);
      return this.ports.database.transaction(tx => {
        const stored = customerOf(tx, context.businessId, id);
        if (stored === undefined) throw new WorkspaceError("scope_mismatch");
        if (sameDetails(stored, details) && stored.active === active) return this.#storedCustomer(tx, context, id);
        if (stored.updatedAt !== version) throw new CommandError("request_conflict");
        if (!saveCustomer(context, { id, ...details, active, createdAt: stored.createdAt, updatedAt: this.#nextVersion(stored.updatedAt) })) throw new CommandError("request_conflict");
        return this.#storedCustomer(tx, context, id);
      });
    });
  }
  /** Takes a payment against an active customer's account; the request ID is the ledger entry ID. */
  receiveCustomerPayment(input: unknown): ReturnType<ShopService["receiveCustomerPayment"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "requestId", "customerId", "accountId", "amountMinor", "note"]), context = this.#actor(data, ["customers.pay", "customers.view"]);
      const id = uuid(data["requestId"]), customerId = uuid(data["customerId"]), accountId = uuid(data["accountId"]), amountMinor = whole(data["amountMinor"], 1);
      const note = optional(data["note"], value => text(value, 200));
      return this.ports.database.transaction(tx => {
        const saved = tx.get(`SELECT * FROM customer_transactions WHERE id=?`, [id]);
        if (saved !== undefined) {
          if (saved["business_id"] !== context.businessId || saved["user_id"] !== context.userId || saved["device_id"] !== context.deviceId || saved["customer_id"] !== customerId ||
            saved["account_id"] !== accountId || saved["amount_minor"] !== -amountMinor || (saved["reason"] ?? undefined) !== note) throw new CommandError("request_conflict");
        } else receiveCustomerPayment(context, { id, customerId, accountId, amountMinor, ...(note === undefined ? {} : { note }),
          occurredAt: this.ports.now(), eventId: this.ports.newId(), branchId: unlockedActor(context).branchId });
        return this.#storedCustomer(tx, context, customerId);
      });
    });
  }
  /** Newest-first bounded customer ledger with signed amounts. */
  customerStatement(input: unknown): ReturnType<ShopService["customerStatement"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "customerId", "after", "limit"]), context = this.#actor(data);
      const result = statement(context, "customer", uuid(data["customerId"]), page(data));
      return { ...result, items: result.items.map(row => ({ id: String(row["id"]), occurredAt: String(row["occurred_at"]), type: String(row["type"]), amountMinor: Number(row["amount_minor"]), balanceMinor: Number(row["balance_minor"]),
        ...(row["reference_kind"] === "SALE" && typeof row["reference_id"] === "string" ? { saleId: row["reference_id"] } : {}),
        ...(typeof row["reason"] === "string" && row["reason"] !== "" ? { note: row["reason"] } : {}) })) };
    });
  }
  /** Supplier and purchase commands; see purchasing.ts. */
  listSuppliers(input: unknown): ReturnType<ShopService["listSuppliers"]> { return this.#run(() => purchasing.listSuppliers(this.#host, input)); }
  getSupplier(input: unknown): ReturnType<ShopService["getSupplier"]> { return this.#run(() => purchasing.getSupplier(this.#host, input)); }
  createSupplier(input: unknown): ReturnType<ShopService["createSupplier"]> { return this.#run(() => purchasing.createSupplier(this.#host, input)); }
  updateSupplier(input: unknown): ReturnType<ShopService["updateSupplier"]> { return this.#run(() => purchasing.updateSupplier(this.#host, input)); }
  paySupplier(input: unknown): ReturnType<ShopService["paySupplier"]> { return this.#run(() => purchasing.paySupplier(this.#host, input)); }
  supplierStatement(input: unknown): ReturnType<ShopService["supplierStatement"]> { return this.#run(() => purchasing.supplierStatement(this.#host, input)); }
  recordPurchase(input: unknown): ReturnType<ShopService["recordPurchase"]> { return this.#run(() => purchasing.recordPurchase(this.#host, input)); }
  listPurchases(input: unknown): ReturnType<ShopService["listPurchases"]> { return this.#run(() => purchasing.listPurchases(this.#host, input)); }
  getPurchase(input: unknown): ReturnType<ShopService["getPurchase"]> { return this.#run(() => purchasing.getPurchase(this.#host, input)); }
  /** Account, cash and expense commands; see finance.ts. */
  listAccounts(input: unknown): ReturnType<ShopService["listAccounts"]> { return this.#run(() => finance.listAccounts(this.#host, input)); }
  createAccount(input: unknown): ReturnType<ShopService["createAccount"]> { return this.#run(() => finance.createAccount(this.#host, input)); }
  updateAccount(input: unknown): ReturnType<ShopService["updateAccount"]> { return this.#run(() => finance.updateAccount(this.#host, input)); }
  moveMoney(input: unknown): ReturnType<ShopService["moveMoney"]> { return this.#run(() => finance.moveMoney(this.#host, input)); }
  transferMoney(input: unknown): ReturnType<ShopService["transferMoney"]> { return this.#run(() => finance.transferMoney(this.#host, input)); }
  countCash(input: unknown): ReturnType<ShopService["countCash"]> { return this.#run(() => finance.countCash(this.#host, input)); }
  correctCash(input: unknown): ReturnType<ShopService["correctCash"]> { return this.#run(() => finance.correctCash(this.#host, input)); }
  listExpenses(input: unknown): ReturnType<ShopService["listExpenses"]> { return this.#run(() => finance.listExpenses(this.#host, input)); }
  recordExpense(input: unknown): ReturnType<ShopService["recordExpense"]> { return this.#run(() => finance.recordExpense(this.#host, input)); }
  reverseExpense(input: unknown): ReturnType<ShopService["reverseExpense"]> { return this.#run(() => finance.reverseExpense(this.#host, input)); }
  /** Period and snapshot reports; see reports.ts. */
  report(input: unknown): ReturnType<ShopService["report"]> { return this.#run(() => reports.report(this.#host, input)); }
  /** Period analytics with permission-scoped sections; see reports.ts. */
  analytics(input: unknown): ReturnType<ShopService["analytics"]> { return this.#run(() => reports.analytics(this.#host, input)); }
  /** Sale and purchase returns; see returns.ts. */
  returnSource(input: unknown): ReturnType<ShopService["returnSource"]> { return this.#run(() => returns.returnSource(this.#host, input)); }
  previewReturn(input: unknown): ReturnType<ShopService["previewReturn"]> { return this.#run(() => returns.previewReturn(this.#host, input)); }
  recordReturn(input: unknown): ReturnType<ShopService["recordReturn"]> { return this.#run(() => returns.recordReturn(this.#host, input)); }
  /** Staff commands; see staff.ts. Credential work is single-flight with setup/unlock. */
  listStaff(input: unknown): ReturnType<ShopService["listStaff"]> { return this.#run(() => staff.listStaff(this.#host, input)); }
  createStaff(input: unknown): ReturnType<ShopService["createStaff"]> { return this.#run(() => this.#identity(() => staff.createStaff(this.#host, input))); }
  setStaffPermission(input: unknown): ReturnType<ShopService["setStaffPermission"]> { return this.#run(() => staff.setStaffPermission(this.#host, input)); }
  setStaffActive(input: unknown): ReturnType<ShopService["setStaffActive"]> { return this.#run(() => staff.setStaffActive(this.#host, input)); }
  resetStaffSecret(input: unknown): ReturnType<ShopService["resetStaffSecret"]> { return this.#run(() => this.#identity(() => staff.resetStaffSecret(this.#host, input))); }
  /** Backup, pairing and exchange through native dialogs; see transfer.ts. File work is single-flight. */
  discardFile(): ReturnType<ShopService["discardFile"]> { return this.#run(async () => { await transfer.release(this.#staged); this.#staged = undefined; return null; }); }
  saveBackup(input?: unknown): ReturnType<ShopService["saveBackup"]> { return this.#file(host => transfer.saveBackup(host, input)); }
  chooseImportFile(input?: unknown): ReturnType<ShopService["chooseImportFile"]> { return this.#file(host => transfer.chooseImportFile(host, input)); }
  openBackup(input?: unknown): ReturnType<ShopService["openBackup"]> { return this.#file(host => transfer.openBackup(host, input)); }
  restoreBackup(input?: unknown): ReturnType<ShopService["restoreBackup"]> { return this.#file(host => transfer.restoreBackup(host, input)); }
  saveInvite(input?: unknown): ReturnType<ShopService["saveInvite"]> { return this.#file(host => transfer.saveInvite(host, input)); }
  openPairingRequest(input?: unknown): ReturnType<ShopService["openPairingRequest"]> { return this.#file(host => transfer.openPairingRequest(host, input)); }
  approvePairingRequest(input?: unknown): ReturnType<ShopService["approvePairingRequest"]> { return this.#file(host => transfer.approvePairingRequest(host, input)); }
  openInvite(input?: unknown): ReturnType<ShopService["openInvite"]> { return this.#file(host => transfer.openInvite(host, input)); }
  acceptInvite(input?: unknown): ReturnType<ShopService["acceptInvite"]> { return this.#file(host => transfer.acceptInvite(host, input)); }
  completePairing(input?: unknown): ReturnType<ShopService["completePairing"]> { return this.#file(host => transfer.completePairing(host, input)); }
  cancelPairing(input?: unknown): ReturnType<ShopService["cancelPairing"]> { return this.#file(host => transfer.cancelPairing(host, input)); }
  exchangeState(input?: unknown): ReturnType<ShopService["exchangeState"]> { return this.#file(host => transfer.exchangeState(host, input), false); }
  saveExchange(input?: unknown): ReturnType<ShopService["saveExchange"]> { return this.#file(host => transfer.saveExchange(host, input)); }
  openExchange(input?: unknown): ReturnType<ShopService["openExchange"]> { return this.#file(host => transfer.openExchange(host, input)); }
  importExchange(input?: unknown): ReturnType<ShopService["importExchange"]> { return this.#file(host => transfer.importExchange(host, input)); }
  saveImportReceipt(input?: unknown): ReturnType<ShopService["saveImportReceipt"]> { return this.#file(host => transfer.saveImportReceipt(host, input)); }
  openImportReceipt(input?: unknown): ReturnType<ShopService["openImportReceipt"]> { return this.#file(host => transfer.openImportReceipt(host, input)); }
  retryExchange(input?: unknown): ReturnType<ShopService["retryExchange"]> { return this.#file(host => transfer.retryExchange(host, input)); }
  /** Rereads immutable saved receipt facts under current actor/own-receipt authority. */
  getReceipt(input: unknown): ReturnType<ShopService["getReceipt"]> {
    return this.#run(() => { const data = object(input, ["sessionId", "saleId"]); return receipt(this.#actor(data), uuid(data["saleId"])); });
  }
  /** Bounded saved receipt history scoped to the current actor and sales-view capability. */
  listReceipts(input: unknown): ReturnType<ShopService["listReceipts"]> {
    return this.#run(() => { const data = object(input, ["sessionId", "term", "after", "limit"]); return receipts(this.#actor(data), page(data)); });
  }
  /** Runs a transfer command against the file host; credential/file work excludes setup, unlock and other file work. */
  #file<T>(work: (host: transfer.TransferHost) => Promise<T>, exclusive = true): Promise<Result<T>> {
    return this.#run(() => {
      const ports = this.#transfer;
      if (ports === undefined) throw new CommandError("unavailable");
      const host: transfer.TransferHost = { ...this.#host, transfer: ports,
        optionalActor: data => data["sessionId"] === undefined ? undefined : this.#actor(data, ["business.settings"]),
        staged: () => this.#staged,
        stage: async file => { if (this.#staged !== file) await transfer.release(this.#staged); this.#staged = file; },
        activate: async database => { this.#invalidate(); await ports.onActivated(database); } };
      const run = (): Promise<T> => transfer.translated(() => work(host));
      return exclusive ? this.#identity(run) : run();
    });
  }
  #storedCustomer(tx: Queryable, context: OperationContext, id: string): CustomerView {
    const customer = customerOf(tx, context.businessId, id);
    if (customer === undefined) throw new WorkspaceError("scope_mismatch");
    return this.#customer(customer, balanceOf(tx, context.businessId, id).outstandingMinor);
  }
  #customer(customer: Customer, outstandingMinor: number): CustomerView {
    return { id: customer.id, name: customer.name, outstandingMinor, active: customer.active, version: customer.updatedAt,
      ...(customer.phone === undefined ? {} : { phone: customer.phone }), ...(customer.address === undefined ? {} : { address: customer.address }),
      ...(customer.notes === undefined ? {} : { notes: customer.notes }), ...(customer.creditLimitMinor === undefined ? {} : { creditLimitMinor: customer.creditLimitMinor }) };
  }
  #category(category: Category): CategoryView {
    return { id: category.id, name: category.name, active: category.active, version: category.updatedAt };
  }
  /** Local edits of the displayed version win locally even when this clock is behind the stored edit. */
  #nextVersion(stored: string): string { return nextVersion(this.#host, stored); }
  #product(context: OperationContext, product: Product): ProductView {
    return { id: product.id, name: product.name, unit: product.unit, divisible: product.divisible, sellingPriceMinor: product.sellingPriceMinor,
      minimumStockThousandths: product.minimumStock, active: product.active, version: product.updatedAt, ...(product.categoryId === undefined ? {} : { categoryId: product.categoryId }),
      ...(product.barcode === undefined ? {} : { barcode: product.barcode }), ...(product.purchasePriceMinor === undefined ? {} : { purchasePriceMinor: product.purchasePriceMinor }),
      ...(capabilities(context).includes("inventory.view") ? { onHandThousandths: productStock(context, product.id).onHandThousandths } : {}),
      ...((photo => photo === undefined ? {} : { photo })(capabilities(context).includes("products.view") ? productPhotoDigest(context, product.id) : undefined)) };
  }
  #actor(data: Record<string, unknown>, required: readonly Permission[] = []): OperationContext {
    uuid(data["sessionId"]);
    if (this.#context === undefined || data["sessionId"] !== this.#sessionId) throw new WorkspaceError("locked");
    const permissions = capabilities(this.#context);
    if (required.some(permission => !permissions.includes(permission))) throw new WorkspaceError("permission_denied");
    return this.#context;
  }
  #view(): WorkspaceView {
    const state = currentInstallation(this.ports.database);
    let actor: WorkspaceView["actor"] = null;
    if (this.#context !== undefined) {
      try { const current = unlockedActor(this.#context); actor = { name: current.userName, isOwner: current.isOwner, permissions: capabilities(this.#context) }; }
      catch { this.#invalidate(); }
    }
    const configured = state.state === "locked" || state.state === "unlocked";
    const members = configured ? this.ports.database.all(`SELECT u.id,u.name FROM users u JOIN local_memberships m ON m.user_id=u.id AND m.business_id=u.business_id
      WHERE u.business_id=? AND u.active=1 AND m.active=1 AND m.credential_reference NOT LIKE 'remote.%' ORDER BY (m.role='OWNER') DESC,u.name,u.id LIMIT 100`, [state.installation.businessId]).map(row=>({id:String(row["id"]),name:String(row["name"])})) : [];
    return { state: configured ? actor === null ? "locked" : "unlocked" : state.state, shopName: configured ? state.installation.businessName : null,
      members, actor, sessionId: actor === null ? null : this.#sessionId ?? null };
  }
  #invalidate(advance = true): void {
    if (advance) this.#epoch++;
    lockWorkspace(this.ports.database); this.#context = undefined; this.#sessionId = undefined;
    // A checked file is tied to the session that checked it; locking forgets it.
    if (this.#staged !== undefined && this.#staged.kind !== "invite" && this.#staged.kind !== "backup") { this.#staged = undefined; }
  }
  /** Reopens a remembered member at start; a stale or unreadable record is forgotten and grants nothing. */
  async #resume(): Promise<void> {
    const memory = this.#memory;
    if (memory === undefined) return;
    this.#remember = await memory.enabled().catch(() => false);
    if (!this.#remember) return;
    const remembered = await memory.read().catch(() => undefined);
    if (remembered === undefined) return;
    try { this.#context = resumeWorkspace(remembered, this.ports); this.#sessionId = this.ports.newId(); }
    catch { await this.#store(undefined); }
  }
  /**
   * Saves or forgets the remembered user. Storage failure never fails the caller's command; it only
   * means the next start is locked. A save overtaken by a lock is undone.
   */
  async #store(value: RememberedMember | undefined, epoch?: number): Promise<void> {
    const memory = this.#memory;
    if (memory === undefined) return;
    try {
      await memory.write(value);
      if (value !== undefined && epoch !== undefined && epoch !== this.#epoch) await memory.write(undefined);
    } catch { /* The remembered user is a convenience; failing closed leaves the next start locked. */ }
  }
  #checkEpoch(epoch: number): void { if (this.#closed || epoch !== this.#epoch) { lockWorkspace(this.ports.database); throw new WorkspaceError("locked"); } }
  #notify(): void { for (const listener of this.#listeners) { try { listener(); } catch { /* Observer failure cannot undo a durable command. */ } } }
  async #identity<T>(work: () => Promise<T>): Promise<T> {
    if (this.#identityBusy) throw new CommandError("busy");
    this.#identityBusy = true;
    try { return await work(); } finally { this.#identityBusy = false; }
  }
  #track<T>(work: Promise<T>): Promise<T> {
    this.#pending.add(work); void work.then(()=>this.#pending.delete(work),()=>this.#pending.delete(work)); return work;
  }
  async #run<T>(work: () => T | Promise<T>): Promise<Result<T>> {
    if (this.#closed) return { ok: false, error: { code: "unavailable" } };
    try { return { ok: true, value: await this.#track(Promise.resolve().then(() => {
      if (this.#closed) throw new CommandError("unavailable");
      return work();
    })) }; }
    catch (error) {
      if (error instanceof WorkspaceError) return { ok: false, error: { code: error.code, ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }) } };
      if (error instanceof CommandError) return { ok: false, error: { code: error.code } };
      return { ok: false, error: { code: error instanceof RuleError || isValidationError(error) ? "invalid_input" : "storage_failed" } };
    }
  }
}
