import { createWorkspace, currentInstallation, recoverWorkspaceSetup, resumeWorkspaceProvisioning, unlockWorkspace, lockWorkspace, unlockedActor, rememberMember, resumeWorkspace, type RememberedMember } from "@kolo/core/identity/workspace";
import { ownerRecoveryCode, recoverOwnerAccess, resumeOwnerRecovery } from "@kolo/core/identity/recovery";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "@kolo/core/identity/types";
import type { Permission } from "@kolo/core/identity/permissions";
import { capabilities, products, scannedProduct, productStock, paymentAccounts, receipt, receipts, categories, stockHistory, customers, statement } from "@kolo/core/application/queries";
import { saveProduct, adjustStock, completeSale, countStock, saveCategory, saveCustomer, receiveCustomerPayment, setProductCategories } from "@kolo/core/application/operations";
import { productCategories } from "@kolo/core/application/records";
import { customerOf, balanceOf, changeKeptOnAccount, wouldExceedCreditLimit, type Customer } from "@kolo/core/data/customers/customers";
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
import * as exports from "./exports.ts";
import * as returns from "./returns.ts";
import * as settings from "./settings.ts";
import * as staff from "./staff.ts";
import * as transfer from "./transfer.ts";
import * as sync from "./server-sync.ts";
import type { SealingCrypto } from "@kolo/core/application/sealed-sync";
import * as join from "./join.ts";
import { normalizeServerUrl, type SyncTransport } from "@kolo/core/application/server-sync";
import type { Database } from "@kolo/core/data/database/driver";
import { migrate } from "@kolo/core/data/database/migrations";
import { createHash } from "node:crypto";
import { photoUsage, productPhoto, productPhotoDigest, removeProductPhoto, setProductPhoto } from "@kolo/core/application/photos";
import { backupRecoveryKeys, confirmBackupRecoveryKey, prepareBackupRecoveryKey, type PendingBackupKey } from "@kolo/core/application/backup-key";
import { PhotoError, PHOTO_LIMITS } from "@kolo/core/data/products/photos";
import { LocalNetwork } from "./local-network.ts";
import { LocalSyncScheduler,localPeerConnections,synchronizeLocalPeer } from "@kolo/core/application/local-sync";
import * as localJoin from "@kolo/core/application/local-join";
import { parseLocalJoinLink } from "@kolo/contracts/local-sync";
import { normalizeJoinCode, parseConnectionCode, parseJoinLink } from "@kolo/contracts/sync";
import { finishJoin, lookupJoin, requestJoin } from "@kolo/core/application/join";

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
  readonly #syncTransport: (url: string) => SyncTransport;
  readonly #autoSync: sync.AutoSync | undefined;
  readonly #sealingCrypto: SealingCrypto | undefined;
  /** Joins this window opened; their network sessions end with the signed-in session. */
  readonly #joins = new Map<string, join.OpenJoin>();
  readonly #local:LocalNetwork|undefined;
  readonly #localSync:LocalSyncScheduler|undefined;
  #remember = false;
  /** A backup recovery key shown once and not yet confirmed; only this process holds its text, and locking forgets it. */
  #pendingKey: { readonly sessionId: string; readonly key: PendingBackupKey } | undefined;
  constructor(ports: WorkspacePorts, crypto?: ExchangeCrypto, files?: transfer.TransferPorts & { readonly onActivated: (database: Database) => Promise<void>; readonly onReset?: () => void }, memory?: SessionMemory, syncTransport: (url: string) => SyncTransport = sync.httpTransport) {
    this.#transfer = files; this.#memory = memory;
    // Server sync needs the sealing primitives (X25519, HKDF); file exchange needs only signatures.
    this.#sealingCrypto = crypto !== undefined && "hkdf" in crypto && "ephemeralAgreement" in crypto ? crypto as SealingCrypto : undefined;
    this.#syncTransport = syncTransport; this.#autoSync = this.#sealingCrypto === undefined ? undefined : new sync.AutoSync(this.#sealingCrypto, syncTransport);
    this.ports = ports; this.crypto = crypto; this.#host = { ports, actor: (data, required) => this.#actor(data, required) };
    this.#local=this.#sealingCrypto===undefined||files===undefined?undefined:new LocalNetwork(ports,this.#sealingCrypto,files.files,()=>this.#context,()=>this.#notify());
    this.#localSync=this.#sealingCrypto===undefined?undefined:new LocalSyncScheduler(this.#sealingCrypto);
    lockWorkspace(ports.database);
    this.#unsubscribe = subscribeChanges(ports.database, ["products", "inventory", "sales", "customers", "suppliers", "purchases", "accounts", "expenses", "authority", "settings"], () => { this.#autoSync?.soon(); this.#localSync?.soon(); this.#notify(); });
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
    await this.#local?.close();
  }
  /** Retries signing asynchronously; financial success never depends on signing or delivery. */
  async seal(): Promise<void> {
    if (this.crypto === undefined || this.#context === undefined || this.#closed || this.#sealing) return;
    this.#sealing = true;
    try { await this.#track(sealPendingEvents(this.#context, this.crypto)); }
    catch { /* Unsigned committed events remain durable and retry on the next unlocked tick. */ }
    finally { this.#sealing = false; }
    // Connected servers sync in the background on their own schedule; trading never waits for it.
    if (!this.#closed) await this.#track(this.#autoSync?.tick(this.#context) ?? Promise.resolve()).catch(() => undefined);
    if(!this.#closed&&this.#context!==undefined){await this.#track(this.#local?.start(false)??Promise.resolve()).catch(()=>undefined);await this.#track(this.#localSync?.tick(this.#context)??Promise.resolve()).catch(()=>undefined);}
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
    return this.#run(() => { this.#actor(object(input, ["sessionId"])); return { rememberSession: this.#remember }; });
  }
  setRememberSession(input: unknown): Promise<Result<SessionPreferences>> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["sessionId", "enabled"]), context = this.#actor(data), enabled = boolean(data["enabled"]), epoch = this.#epoch;
      const memory = this.#memory;
      if (memory === undefined) throw new CommandError("unavailable");
      await memory.setEnabled(enabled); this.#remember = enabled;
      await this.#store(enabled ? rememberMember(context) : undefined, epoch);
      return { rememberSession: enabled };
    }));
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
      try { await setProductPhoto(context, { productId: id, bytes: new Uint8Array(bytes) }, { sha256Bytes: async value => createHash("sha256").update(value).digest("hex") }); }
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
  /** Photo storage against the shop's limit. */
  photoUsage(input: unknown): ReturnType<ShopService["photoUsage"]> {
    return this.#run(() => photoUsage(this.#actor(object(input, ["sessionId"]), ["products.view"])));
  }
  #stored(context: OperationContext, id: string): ProductView {
    const product = productOf(this.ports.database, context.businessId, id);
    if (product === undefined) throw new WorkspaceError("scope_mismatch");
    return this.#product(context, product);
  }
  /** Creates product and optional opening stock in one transaction; safe matching retries reuse the product ID. */
  createProduct(input: unknown): ReturnType<ShopService["createProduct"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "requestId", "name", "unit", "divisible", "barcode", "sellingPriceMinor", "purchasePriceMinor", "openingThousandths", "categoryId"]);
      const context = this.#actor(data, ["products.create"]), id = uuid(data["requestId"]), at = this.ports.now();
      const product = { id, name: text(data["name"]), unit: text(data["unit"]), divisible: boolean(data["divisible"]),
        sellingPriceMinor: whole(data["sellingPriceMinor"]), ...(data["purchasePriceMinor"] === undefined ? {} : { purchasePriceMinor: whole(data["purchasePriceMinor"]) }),
        ...(data["barcode"] === undefined ? {} : { barcode: text(data["barcode"], 256) }),
        ...(data["categoryId"] === undefined ? {} : { categoryId: uuid(data["categoryId"]) }), currency: "XAF", taxRateBasisPoints: 0,
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
            original.sellingPriceMinor !== product.sellingPriceMinor || original.purchasePriceMinor !== product.purchasePriceMinor || original.categoryId !== product.categoryId || Number(stock?.["n"]) !== opening) throw new CommandError("request_conflict");
          return this.#product(context, original);
        }
        if (product.categoryId !== undefined && categoryOf(tx, context.businessId, product.categoryId)?.active !== true) throw new WorkspaceError("invalid_input");
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
   * Host-bound atomic sale with split payments and optional customer credit. `keptChangeMinor` puts the named
   * customer's change on their account (into the sale's first cash account, under customers.pay). Matching retries
   * (same actor, lines, payments, customer and kept change) return the original ID; differing content is refused.
   * The legacy `accountId` form records the exact total in one active cash account.
   */
  checkout(input: unknown): ReturnType<ShopService["checkout"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "requestId", "accountId", "payments", "customerId", "expectedCustomerBalanceMinor", "discountMinor", "keptChangeMinor", "lines"]), context = this.#actor(data, ["sales.create", "products.view"]);
      const id = uuid(data["requestId"]), customerId = optional(data["customerId"], uuid), discountMinor = whole(data["discountMinor"] ?? 0);
      const expectedBalance = data["expectedCustomerBalanceMinor"];
      if (expectedBalance !== undefined && (customerId === undefined || typeof expectedBalance !== "number" || !Number.isSafeInteger(expectedBalance))) throw new WorkspaceError("invalid_input");
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
      const keptChangeMinor = data["keptChangeMinor"] === undefined ? 0 : whole(data["keptChangeMinor"], 1);
      if (keptChangeMinor > 0 && (customerId === undefined || legacy)) throw new WorkspaceError("invalid_input");
      return this.ports.database.transaction(tx => {
        const saved = tx.get(`SELECT business_id,user_id,device_id,discount_minor,customer_id,number,occurred_at FROM sales WHERE id=?`, [id]);
        if (saved !== undefined) {
          if (saved["business_id"] !== context.businessId || saved["user_id"] !== context.userId || saved["device_id"] !== context.deviceId) throw new CommandError("request_conflict");
          // Creation authority is enough to retry one's own command even after
          // receipt-view permission is revoked. No receipt facts are returned here.
          const originalLines = tx.all(`SELECT product_id,quantity,unit_price_minor,discount_minor FROM sale_items WHERE business_id=? AND sale_id=?`, [context.businessId,id]);
          const originalPayments = tx.all(`SELECT account_id,amount_minor FROM sale_payments WHERE business_id=? AND sale_id=?`, [context.businessId,id]);
          const sorted = (items: readonly Record<string, unknown>[]): string => JSON.stringify(items.map(item => JSON.stringify(item)).sort());
          if (saved["discount_minor"] !== discountMinor || saved["customer_id"] !== (customerId ?? null) || originalLines.some(line=>line["discount_minor"]!==0) ||
            sorted(originalLines.map(line=>({productId:line["product_id"],quantity:line["quantity"],unitPriceMinor:line["unit_price_minor"]}))) !== sorted(lines) ||
            sorted(originalPayments.map(payment=>({accountId:payment["account_id"],amountMinor:payment["amount_minor"]}))) !== sorted(payments) ||
            changeKeptOnAccount(tx, context.businessId, { customerId: (saved["customer_id"] ?? null) as string | null, number: String(saved["number"]), occurredAt: String(saved["occurred_at"]) }) !== keptChangeMinor) throw new CommandError("request_conflict");
          return { saleId: id };
        }
        if (legacy) { const account = accountOf(tx, context.businessId, uuid(data["accountId"])); if (account?.active !== true || account.kind !== "CASH") throw new WorkspaceError("scope_mismatch"); }
        if (expectedBalance !== undefined) {
          if (!capabilities(context).includes("customers.view")) throw new WorkspaceError("permission_denied");
          if (balanceOf(tx, context.businessId, customerId!).outstandingMinor !== expectedBalance) throw new CommandError("request_conflict");
        }
        if (settled.outstandingMinor > 0) {
          const permissions = capabilities(context), customer = customerOf(tx, context.businessId, customerId!);
          if (!permissions.includes("customers.credit")) throw new WorkspaceError("permission_denied");
          if (customer?.active === true && !permissions.includes("customers.credit_override") && wouldExceedCreditLimit(tx, context.businessId, customer, settled.outstandingMinor)) throw new CommandError("credit_limit");
        }
        const at = this.ports.now(), recordedLines = lines.map(line => {
          const product = productOf(tx, context.businessId, line.productId);
          if (product?.active !== true) throw new WorkspaceError("scope_mismatch");
          if (product.sellingPriceMinor !== line.unitPriceMinor) throw new CommandError("price_changed");
          // The core freezes the line's cost from the shared costing policy (§8).
          return { ...line, id: this.ports.newId(), movementId: this.ports.newId(), name: product.name, taxRateBasisPoints: product.taxRateBasisPoints };
        });
        // Kept change goes into the drawer the cash went into: the first cash account the sale was paid into.
        const drawer = keptChangeMinor > 0 ? payments.find(payment => accountOf(tx, context.businessId, payment.accountId)?.kind === "CASH") : undefined;
        if (keptChangeMinor > 0 && drawer === undefined) throw new WorkspaceError("invalid_input");
        completeSale(context, { id, number: `V-${id}`, occurredAt: at, branchId: unlockedActor(context).branchId, customerId, discountMinor,
          eventId: this.ports.newId(), lines: recordedLines, payments: payments.map(payment => ({ id: this.ports.newId(), ...payment })),
          ...(settled.outstandingMinor > 0 ? { creditTransactionId: this.ports.newId() } : {}) },
        drawer === undefined ? undefined : { id: this.ports.newId(), eventId: this.ports.newId(), accountId: drawer.accountId, amountMinor: keptChangeMinor });
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
        ...(typeof row["sale_total_minor"] === "number" ? { saleTotalMinor: row["sale_total_minor"], salePaidMinor: Number(row["sale_paid_minor"]) } : {}),
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
  /** The operation journal under audit.view; see reports.ts. */
  journal(input: unknown): ReturnType<ShopService["journal"]> { return this.#run(() => reports.journal(this.#host, input)); }
  /** Every journal entry matching the filters, for an export (audit.view and data.export); see reports.ts. */
  journalExport(input: unknown): ReturnType<ShopService["journalExport"]> { return this.#run(() => reports.journalExport(this.#host, input)); }
  /** A spreadsheet export through the save dialog (data.export); see exports.ts. */
  saveCsv(input: unknown): ReturnType<ShopService["saveCsv"]> { return this.#file(host => exports.saveCsv(host, input)); }
  /** A report saved as PDF through the save dialog, under the report's permission; see exports.ts. */
  saveReportPdf(input: unknown): ReturnType<ShopService["saveReportPdf"]> { return this.#file(host => exports.saveReportPdf(host, input)); }
  /** Tax, payment terms and notifications; see settings.ts. */
  taxSettings(input: unknown): ReturnType<ShopService["taxSettings"]> { return this.#run(() => settings.taxSettings(this.#host, input)); }
  updateTaxSettings(input: unknown): ReturnType<ShopService["updateTaxSettings"]> { return this.#run(() => settings.updateTaxSettings(this.#host, input)); }
  productTax(input: unknown): ReturnType<ShopService["productTax"]> { return this.#run(() => settings.productTax(this.#host, input)); }
  setProductTax(input: unknown): ReturnType<ShopService["setProductTax"]> { return this.#run(() => settings.setProductTax(this.#host, input)); }
  paymentTerms(input: unknown): ReturnType<ShopService["paymentTerms"]> { return this.#run(() => settings.paymentTerms(this.#host, input)); }
  setShopTerms(input: unknown): ReturnType<ShopService["setShopTerms"]> { return this.#run(() => settings.setShopTerms(this.#host, input)); }
  creditStatus(input: unknown): ReturnType<ShopService["creditStatus"]> { return this.#run(() => settings.creditStatus(this.#host, input)); }
  setPartyTerms(input: unknown): ReturnType<ShopService["setPartyTerms"]> { return this.#run(() => settings.setPartyTerms(this.#host, input)); }
  notifications(input: unknown): ReturnType<ShopService["notifications"]> { return this.#run(() => settings.notifications(this.#host, input)); }
  markNotifications(input: unknown): ReturnType<ShopService["markNotifications"]> { return this.#run(() => settings.markNotifications(this.#host, input)); }
  /** Sale and purchase returns; see returns.ts. */
  returnSource(input: unknown): ReturnType<ShopService["returnSource"]> { return this.#run(() => returns.returnSource(this.#host, input)); }
  previewReturn(input: unknown): ReturnType<ShopService["previewReturn"]> { return this.#run(() => returns.previewReturn(this.#host, input)); }
  recordReturn(input: unknown): ReturnType<ShopService["recordReturn"]> { return this.#run(() => returns.recordReturn(this.#host, input)); }
  /** Staff commands; see staff.ts. Credential work is single-flight with setup/unlock. */
  listStaff(input: unknown): ReturnType<ShopService["listStaff"]> { return this.#run(() => staff.listStaff(this.#host, input)); }
  createStaff(input: unknown): ReturnType<ShopService["createStaff"]> { return this.#run(() => this.#identity(() => staff.createStaff(this.#host, input))); }
  setStaffPermission(input: unknown): ReturnType<ShopService["setStaffPermission"]> { return this.#run(() => staff.setStaffPermission(this.#host, input)); }
  setStaffRole(input: unknown): ReturnType<ShopService["setStaffRole"]> { return this.#run(() => staff.setStaffRole(this.#host, input)); }
  listRoles(input: unknown): ReturnType<ShopService["listRoles"]> { return this.#run(() => staff.listRoles(this.#host, input)); }
  setRolePermission(input: unknown): ReturnType<ShopService["setRolePermission"]> { return this.#run(() => staff.setRolePermission(this.#host, input)); }
  resetRole(input: unknown): ReturnType<ShopService["resetRole"]> { return this.#run(() => staff.resetRole(this.#host, input)); }
  listCustomRoles(input: unknown): ReturnType<ShopService["listCustomRoles"]> { return this.#run(() => staff.listCustomRoles(this.#host, input)); }
  createCustomRole(input: unknown): ReturnType<ShopService["createCustomRole"]> { return this.#run(() => staff.createCustomRole(this.#host, input)); }
  renameCustomRole(input: unknown): ReturnType<ShopService["renameCustomRole"]> { return this.#run(() => staff.renameCustomRole(this.#host, input)); }
  setCustomRolePermission(input: unknown): ReturnType<ShopService["setCustomRolePermission"]> { return this.#run(() => staff.setCustomRolePermission(this.#host, input)); }
  deleteCustomRole(input: unknown): ReturnType<ShopService["deleteCustomRole"]> { return this.#run(() => staff.deleteCustomRole(this.#host, input)); }
  setStaffActive(input: unknown): ReturnType<ShopService["setStaffActive"]> { return this.#run(() => staff.setStaffActive(this.#host, input)); }
  resetStaffSecret(input: unknown): ReturnType<ShopService["resetStaffSecret"]> { return this.#run(() => this.#identity(() => staff.resetStaffSecret(this.#host, input))); }
  /** The shop's pinned backup recovery keys (ADR-036), newest first; owner settings access. */
  backupKeys(input: unknown): ReturnType<ShopService["backupKeys"]> {
    return this.#run(() => backupRecoveryKeys(this.#actor(object(input, ["sessionId"]), ["business.settings"])).map(key => ({ ...key })));
  }
  /** Creates a backup recovery key after a fresh owner PIN and returns it to show once; nothing is pinned yet. */
  prepareBackupKey(input: unknown): ReturnType<ShopService["prepareBackupKey"]> {
    return this.#run(async () => {
      const data = object(input, ["sessionId", "secret"]), context = this.#actor(data, ["business.settings", "users.manage"]), sessionId = String(data["sessionId"]);
      const key = await transfer.translated(() => prepareBackupRecoveryKey(context, text(data["secret"], 256, false), this.#keyCrypto()));
      this.#actor(data); this.#pendingKey = { sessionId, key };
      return { text: key.text, keyId: key.keyId, confirm: [...key.confirm] };
    });
  }
  /** Pins the prepared key once the owner typed back the requested groups, then forgets it; a mistyped group can be retried. */
  confirmBackupKey(input: unknown): ReturnType<ShopService["confirmBackupKey"]> {
    return this.#run(async () => {
      const data = object(input, ["sessionId", "groups"]), context = this.#actor(data, ["business.settings", "users.manage"]), groups = data["groups"], pending = this.#pendingKey;
      if (!Array.isArray(groups) || groups.length !== 3 || groups.some(group => typeof group !== "string" || group.length > 16)) throw new CommandError("invalid_input");
      if (pending === undefined || pending.sessionId !== data["sessionId"]) throw new CommandError("confirmation_required");
      const view = await transfer.translated(() => confirmBackupRecoveryKey(context, pending.key, groups as string[], this.#keyCrypto()));
      this.#pendingKey = undefined;
      return { ...view };
    });
  }
  #keyCrypto(): SealingCrypto {
    const crypto = this.#transfer?.crypto;
    if (crypto !== undefined && typeof (crypto as Partial<SealingCrypto>).hkdf === "function") return crypto as SealingCrypto;
    if (this.#sealingCrypto === undefined) throw new CommandError("unavailable");
    return this.#sealingCrypto;
  }
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
  /** Reads/resumes this installation’s enabled LAN listener and paired local delivery status. */
  localNetworkState(input:unknown):ReturnType<ShopService["localNetworkState"]>{return this.#run(async()=>{const data=object(input,["sessionId"]),context=this.#actor(data,["business.settings"]);await this.#local?.start(false);return {running:this.#local?.running()??false,urls:this.#local?.urls()??[],connections:localPeerConnections(context)};});}
  /** Stops inbound LAN access; local records and peer trust remain. */
  stopLocalNetwork(input:unknown):ReturnType<ShopService["stopLocalNetwork"]>{return this.#run(async()=>{this.#actor(object(input,["sessionId"]),["business.settings","users.manage"]);await this.#local?.close(true);this.#notify();return null;});}
  /** Shows a ten-minute QR for a new device on the same Wi-Fi or hotspot. */
  startLocalJoin(input:unknown):ReturnType<ShopService["startLocalJoin"]>{return this.#run(()=>sync.syncTranslated(async()=>{const data=object(input,["sessionId","authorityAllowed","url"]);this.#actor(data,["business.settings","users.manage"]);if(this.#local===undefined)throw new CommandError("unavailable");return this.#local.invite(boolean(data["authorityAllowed"]),optional(data["url"],value=>text(value,2048)));}));}
  /** Reads the candidate name for the owner’s still-live local invitation. */
  pollLocalJoin(input:unknown):ReturnType<ShopService["pollLocalJoin"]>{return this.#run(()=>{const data=object(input,["sessionId","joinId"]);this.#actor(data,["business.settings","users.manage"]);if(this.#local===undefined)throw new CommandError("unavailable");return this.#local.status(text(data["joinId"],64));});}
  /** Approves the local candidate and makes its encrypted snapshot available. */
  approveLocalJoin(input:unknown):ReturnType<ShopService["approveLocalJoin"]>{return this.#run(()=>transfer.translated(async()=>{const data=object(input,["sessionId","joinId"]);this.#actor(data,["business.settings","users.manage"]);if(this.#local===undefined)throw new CommandError("unavailable");await this.#local.approve(text(data["joinId"],64));return null;}));}
  /** Revokes the selected local invitation. */
  cancelLocalJoin(input:unknown):ReturnType<ShopService["cancelLocalJoin"]>{return this.#run(()=>{const data=object(input,["sessionId","joinId"]);this.#actor(data,["business.settings","users.manage"]);this.#local?.cancel(text(data["joinId"],64));return null;});}
  /** Immediately exchanges queued signed changes with this installation’s configured local hosts. */
  syncLocalNetwork(input:unknown):ReturnType<ShopService["syncLocalNetwork"]>{return this.#run(()=>sync.syncTranslated(async()=>{const context=this.#actor(object(input,["sessionId"]),["business.settings"]);if(this.#sealingCrypto===undefined)throw new CommandError("unavailable");let sent=0,received=0;for(const peer of localPeerConnections(context)){if(peer.url===null)continue;const outcome=await synchronizeLocalPeer(context,peer.deviceId,this.#sealingCrypto);sent+=outcome.sent;received+=outcome.received;}this.#notify();return {sent,received};}));}
  /**
   * What a new computer pasted to join: a local QR link, a server join link, or the owner's typed code with the server
   * address shown beside it. A server share code (kolo://connect) is refused with its own error: it attaches a till
   * already in the shop, it does not join one.
   */
  #joinTarget(data:Record<string,unknown>):{readonly local:true;readonly link:string;readonly url:string}|{readonly local:false;readonly code:string;readonly url:string}{
    const link=text(data["link"],4096),local=parseLocalJoinLink(link);
    if(local!==undefined)return {local:true,link,url:local.url};
    if(parseConnectionCode(link)!==undefined)throw new CommandError("not_join_code");
    const server=parseJoinLink(link),code=server?.code??normalizeJoinCode(link);
    if(code===undefined)throw new CommandError("invalid_join_code");
    const address=server?.url??optional(data["url"],value=>text(value,2048));
    if(address===undefined)throw new CommandError("join_address_needed");
    try{return {local:false,code,url:normalizeServerUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(address)?address:`https://${address}`)};}catch{throw new CommandError("invalid_address");}
  }
  /** Empty computer: verifies a pasted join link or code before displaying the shop. */
  lookupLocalJoin(input:unknown):ReturnType<ShopService["lookupLocalJoin"]>{return this.#file(()=>sync.syncTranslated(async()=>{const target=this.#joinTarget(object(input,["link","url"]));if(this.#sealingCrypto===undefined)throw new CommandError("unavailable");if(currentInstallation(this.ports.database).state!=="empty")throw new CommandError("not_empty");return target.local?localJoin.lookupLocalJoin(target.link,localJoin.localJoinTransport(target.url),this.#sealingCrypto):lookupJoin(this.#syncTransport(target.url),this.#sealingCrypto,target.code);}));}
  /** Empty computer: provisions a native identity and asks the owner, through the LAN or the server mailbox. */
  requestLocalJoin(input:unknown):ReturnType<ShopService["requestLocalJoin"]>{return this.#file(()=>sync.syncTranslated(async()=>{const data=object(input,["link","url","deviceLabel","secret"]),target=this.#joinTarget(data),crypto=this.#sealingCrypto;if(crypto===undefined)throw new CommandError("unavailable");const device={label:text(data["deviceLabel"],120),secret:text(data["secret"],256,false),platform:"DESKTOP"} as const;
    if(target.local){const transport=localJoin.localJoinTransport(target.url),invitation=await localJoin.lookupLocalJoin(target.link,transport,crypto);await localJoin.requestLocalJoin(target.link,invitation,device,this.ports,transport,crypto);}
    else{const transport=this.#syncTransport(target.url);await requestJoin(target.code,await lookupJoin(transport,crypto,target.code),device,this.ports,transport,crypto);}
    return null;}));}
  /** Empty computer: activates the exact owner-approved shop when ready; it then connects to the owner's shared server on its own. */
  finishLocalJoin(input:unknown):ReturnType<ShopService["finishLocalJoin"]>{return this.#file(host=>sync.syncTranslated(async()=>{const target=this.#joinTarget(object(input,["link","url"])),crypto=this.#sealingCrypto;if(crypto===undefined)throw new CommandError("unavailable");const result=target.local?await localJoin.finishLocalJoin(target.link,this.ports,host.transfer.files,localJoin.localJoinTransport(target.url),crypto):await finishJoin(target.code,this.ports,host.transfer.files,this.#syncTransport(target.url),crypto);if(result===undefined)return null;await host.activate(result.database);return {activated:true};}));}
  /** Optional sync server; see server-sync.ts. Network work runs in the main process only. */
  serverState(input: unknown): ReturnType<ShopService["serverState"]> { return this.#sync(host => sync.serverState(host, input)); }
  checkServer(input: unknown): ReturnType<ShopService["checkServer"]> { return this.#sync(host => sync.checkServer(host, input)); }
  connectServer(input: unknown): ReturnType<ShopService["connectServer"]> { return this.#sync(async host => { const result = await sync.connectServer(host, input); this.#notify(); return result; }); }
  syncServer(input: unknown): ReturnType<ShopService["syncServer"]> { return this.#sync(host => sync.syncServer(host, input)); }
  disconnectServer(input: unknown): ReturnType<ShopService["disconnectServer"]> { return this.#sync(async host => { const result = await sync.disconnectServer(host, input); this.#notify(); return result; }); }
  startJoinCode(input: unknown): ReturnType<ShopService["startJoinCode"]> { return this.#join(host => join.startJoinCode(host, input)); }
  pollJoinCode(input: unknown): ReturnType<ShopService["pollJoinCode"]> { return this.#join(host => join.pollJoinCode(host, input)); }
  approveJoinCode(input: unknown): ReturnType<ShopService["approveJoinCode"]> { return this.#join(host => join.approveJoinCode(host, input)); }
  cancelJoinCode(input: unknown): ReturnType<ShopService["cancelJoinCode"]> { return this.#join(host => join.cancelJoinCode(host, input)); }
  /** Rereads immutable saved receipt facts under current actor/own-receipt authority. */
  getReceipt(input: unknown): ReturnType<ShopService["getReceipt"]> {
    return this.#run(() => { const data = object(input, ["sessionId", "saleId"]); return receipt(this.#actor(data), uuid(data["saleId"])); });
  }
  /** Bounded saved receipt history scoped to the current actor and sales-view capability. */
  listReceipts(input: unknown): ReturnType<ShopService["listReceipts"]> {
    return this.#run(() => { const data = object(input, ["sessionId", "term", "after", "limit"]); return receipts(this.#actor(data), page(data)); });
  }
  #sync<T>(work: (host: sync.SyncHost) => Promise<T>): Promise<Result<T>> {
    return this.#run(() => {
      const crypto = this.#sealingCrypto;
      if (crypto === undefined) throw new CommandError("unavailable");
      return sync.syncTranslated(() => work({ ...this.#host, crypto, transport: this.#syncTransport }));
    });
  }
  #join<T>(work: (host: join.JoinHost) => Promise<T>): Promise<Result<T>> {
    return this.#run(() => {
      const crypto = this.#sealingCrypto, files = this.#transfer?.files;
      if (crypto === undefined || files === undefined) throw new CommandError("unavailable");
      return sync.syncTranslated(() => transfer.translated(() => work({ ...this.#host, crypto, transport: this.#syncTransport, files, joins: this.#joins })));
    });
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
    lockWorkspace(this.ports.database); this.#context = undefined; this.#sessionId = undefined; this.#joins.clear(); this.#pendingKey = undefined;
    if(this.#local!==undefined)void this.#track(this.#local.close()).catch(()=>undefined);
    // A checked file is tied to the session that checked it; locking forgets it.
    if (this.#staged !== undefined && this.#staged.kind !== "invite" && this.#staged.kind !== "backup") { void transfer.release(this.#staged).catch(() => undefined); this.#staged = undefined; }
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
