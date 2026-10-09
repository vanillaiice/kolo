import { createWorkspace, currentInstallation, recoverWorkspaceSetup, resumeWorkspaceProvisioning, unlockWorkspace, lockWorkspace, unlockedActor } from "@kolo/core/identity/workspace";
import { ownerRecoveryCode, recoverOwnerAccess, resumeOwnerRecovery } from "@kolo/core/identity/recovery";
import { WorkspaceError, type OperationContext, type WorkspacePorts } from "@kolo/core/identity/types";
import type { Permission } from "@kolo/core/identity/permissions";
import { capabilities, products, scannedProduct, productStock, paymentAccounts, receipt, receipts } from "@kolo/core/application/queries";
import { saveProduct, adjustStock, completeSale } from "@kolo/core/application/operations";
import { productOf, type Product } from "@kolo/core/data/products/products";
import { accountOf } from "@kolo/core/data/finance/accounts";
import { subtotalOf } from "@kolo/core/rules/pricing";
import { RuleError } from "@kolo/core/rules/amounts";
import { subscribeChanges } from "@kolo/core/data/database/changes";
import { sealPendingEvents } from "@kolo/core/application/exchange";
import type { ExchangeCrypto } from "@kolo/core/exchange/types";
import type { CheckoutRequest, FailureCode, ProductView, Result, ShopService, WorkspaceView } from "../shared/service.js";
import { object, text, uuid, whole, boolean, page } from "./validation.ts";

class CommandError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(code); this.code = code; }
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
  private readonly crypto: ExchangeCrypto | undefined;
  constructor(ports: WorkspacePorts, crypto?: ExchangeCrypto) {
    this.ports = ports; this.crypto = crypto;
    lockWorkspace(ports.database);
    this.#unsubscribe = subscribeChanges(ports.database, ["products", "inventory", "sales", "accounts", "authority"], () => this.#notify());
  }
  /** Completes durable secret/SQLite crash gaps before exposing the locked installation. */
  async initialize(): Promise<void> {
    await this.#track(this.#identity(async () => { await recoverWorkspaceSetup(this.ports); await resumeOwnerRecovery(this.ports); }));
  }
  /** Invalidates authority immediately, then waits for native work before the caller closes SQLite. */
  async dispose(): Promise<void> {
    this.#closed = true; this.#invalidate(); this.#unsubscribe(); this.#listeners.clear();
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
      return this.#view();
    }));
  }
  /** Immediately invalidates authority and in-flight proofs while retaining all saved facts. */
  lock(): Promise<Result<WorkspaceView>> {
    return this.#run(() => { this.#invalidate(); this.#notify(); return this.#view(); });
  }
  /** Owner recovery uses the separate protected key and leaves the installation locked. */
  recoverAccess(input: unknown): Promise<Result<WorkspaceView>> {
    return this.#run(() => this.#identity(async () => {
      const data = object(input, ["recoveryCode", "newSecret"]), epoch = this.#epoch;
      this.#invalidate(false);
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
      const data = object(input, ["sessionId", "term", "after", "limit"]), context = this.#actor(data);
      const result = products(context, page(data)); return { ...result, items: result.items.map(item => this.#product(context, item)) };
    });
  }
  /** Exact active/unambiguous barcode lookup; no prefix/name substitution. */
  scanProduct(input: unknown): ReturnType<ShopService["scanProduct"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "barcode"]), context = this.#actor(data);
      const item = scannedProduct(context, text(data["barcode"], 256)); return item === undefined ? null : this.#product(context, item);
    });
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
  /** Bounded cash-account names only; balances are never exposed to payment-only readers. */
  listCashAccounts(input: unknown): ReturnType<ShopService["listCashAccounts"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "term", "after", "limit"]), context = this.#actor(data);
      const result = paymentAccounts(context, page(data));
      return { ...result, items: result.items.filter(account => account.kind === "CASH").map(({ id, name }) => ({ id, name })) };
    });
  }
  /** Host-bound atomic cash sale; scoped matching retries return the original ID and differing content is refused. */
  checkout(input: unknown): ReturnType<ShopService["checkout"]> {
    return this.#run(() => {
      const data = object(input, ["sessionId", "requestId", "accountId", "lines"]), context = this.#actor(data, ["sales.create", "products.view"]);
      const id = uuid(data["requestId"]), accountId = uuid(data["accountId"]);
      if (!Array.isArray(data["lines"]) || data["lines"].length < 1 || data["lines"].length > 200) throw new WorkspaceError("invalid_input");
      const lines = data["lines"].map(value => { const item = object(value, ["productId", "quantity", "unitPriceMinor"]);
        return { productId: uuid(item["productId"]), quantity: whole(item["quantity"], 1), unitPriceMinor: whole(item["unitPriceMinor"]) }; });
      if (new Set(lines.map(line => line.productId)).size !== lines.length) throw new WorkspaceError("invalid_input");
      const request: CheckoutRequest = { sessionId: String(data["sessionId"]), requestId: id, accountId, lines };
      return this.ports.database.transaction(tx => {
        const saved = tx.get(`SELECT business_id,user_id,device_id,discount_minor,customer_id FROM sales WHERE id=?`, [id]);
        if (saved !== undefined) {
          if (saved["business_id"] !== context.businessId || saved["user_id"] !== context.userId || saved["device_id"] !== context.deviceId) throw new CommandError("request_conflict");
          // Creation authority is enough to retry one's own command even after
          // receipt-view permission is revoked. No receipt facts are returned here.
          const originalLines = tx.all(`SELECT product_id,quantity,unit_price_minor,discount_minor FROM sale_items WHERE business_id=? AND sale_id=?`, [context.businessId,id]);
          const originalPayments = tx.all(`SELECT account_id,amount_minor FROM sale_payments WHERE business_id=? AND sale_id=?`, [context.businessId,id]);
          const original = originalLines.map(line=>({productId:String(line["product_id"]),quantity:Number(line["quantity"]),unitPriceMinor:Number(line["unit_price_minor"])}));
          const sorted = (items: readonly { productId: string; quantity: number; unitPriceMinor: number }[]): string => JSON.stringify([...items].sort((a,b)=>a.productId.localeCompare(b.productId)).map(({productId,quantity,unitPriceMinor})=>({productId,quantity,unitPriceMinor})));
          const total = subtotalOf(lines);
          if (saved["discount_minor"] !== 0 || saved["customer_id"] !== null || originalLines.some(line=>line["discount_minor"]!==0) || sorted(original) !== sorted(request.lines) ||
            originalPayments.length !== (total > 0 ? 1 : 0) || total > 0 && (originalPayments[0]?.["account_id"] !== accountId || originalPayments[0]?.["amount_minor"] !== total)) throw new CommandError("request_conflict");
          return { saleId: id };
        }
        const account = accountOf(tx, context.businessId, accountId);
        if (account?.active !== true || account.kind !== "CASH") throw new WorkspaceError("scope_mismatch");
        const at = this.ports.now(), recordedLines = lines.map(line => {
          const product = productOf(tx, context.businessId, line.productId);
          if (product?.active !== true) throw new WorkspaceError("scope_mismatch");
          if (product.sellingPriceMinor !== line.unitPriceMinor) throw new CommandError("price_changed");
          return { ...line, id: this.ports.newId(), movementId: this.ports.newId(), name: product.name,
            unitCostMinor: product.purchasePriceMinor, taxRateBasisPoints: product.taxRateBasisPoints };
        });
        const total = subtotalOf(recordedLines);
        completeSale(context, { id, number: `V-${id}`, occurredAt: at, branchId: unlockedActor(context).branchId,
          eventId: this.ports.newId(), lines: recordedLines, payments: total > 0 ? [{ id: this.ports.newId(), accountId, amountMinor: total }] : [] });
        return { saleId: id };
      });
    });
  }
  /** Rereads immutable saved receipt facts under current actor/own-receipt authority. */
  getReceipt(input: unknown): ReturnType<ShopService["getReceipt"]> {
    return this.#run(() => { const data = object(input, ["sessionId", "saleId"]); return receipt(this.#actor(data), uuid(data["saleId"])); });
  }
  /** Bounded saved receipt history scoped to the current actor and sales-view capability. */
  listReceipts(input: unknown): ReturnType<ShopService["listReceipts"]> {
    return this.#run(() => { const data = object(input, ["sessionId", "term", "after", "limit"]); return receipts(this.#actor(data), page(data)); });
  }
  #product(context: OperationContext, product: Product): ProductView {
    return { id: product.id, name: product.name, unit: product.unit, divisible: product.divisible, sellingPriceMinor: product.sellingPriceMinor,
      ...(product.barcode === undefined ? {} : { barcode: product.barcode }), ...(product.purchasePriceMinor === undefined ? {} : { purchasePriceMinor: product.purchasePriceMinor }),
      ...(capabilities(context).includes("inventory.view") ? { onHandThousandths: productStock(context, product.id).onHandThousandths } : {}) };
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
      WHERE u.business_id=? AND u.active=1 AND m.active=1 ORDER BY u.name,u.id LIMIT 100`, [state.installation.businessId]).map(row=>({id:String(row["id"]),name:String(row["name"])})) : [];
    return { state: configured ? actor === null ? "locked" : "unlocked" : state.state, shopName: configured ? state.installation.businessName : null,
      members, actor, sessionId: actor === null ? null : this.#sessionId ?? null };
  }
  #invalidate(advance = true): void {
    if (advance) this.#epoch++;
    lockWorkspace(this.ports.database); this.#context = undefined; this.#sessionId = undefined;
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
      return { ok: false, error: { code: error instanceof RuleError ? "invalid_input" : "storage_failed" } };
    }
  }
}
