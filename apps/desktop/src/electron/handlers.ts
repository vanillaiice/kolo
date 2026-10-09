import type { DesktopStatus } from "./ipc.js";
import type { DesktopApplication } from "./application.ts";
import type { Result } from "../shared/service.js";

/** A host-owned dispatcher map; none of its channel names are supplied by the renderer API. */
export function desktopHandlers(application: DesktopApplication, status: () => DesktopStatus, trusted: (event: unknown) => boolean): Readonly<Record<string, (event: unknown, ...args: unknown[]) => unknown>> {
  const handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown> = {};
  const fail = (code: "permission_denied" | "invalid_input"): Result<never> => ({ ok: false, error: { code } });
  const query = (channel: string, operation: () => unknown): void => {
    handlers[channel] = (event, ...args) => !trusted(event) ? fail("permission_denied") : args.length !== 0 ? fail("invalid_input") : operation();
  };
  const command = (channel: string, operation: (input: unknown) => unknown): void => {
    handlers[channel] = (event, ...args) => !trusted(event) ? fail("permission_denied") : args.length !== 1 ? fail("invalid_input") : operation(args[0]);
  };
  handlers["kolo:installation-status"] = (event, ...args) => {
    if (!trusted(event) || args.length !== 0) throw new Error("invalid status caller");
    try { return status(); } catch { throw new Error("status unavailable"); }
  };
  query("kolo:workspace", () => application.getWorkspace());
  query("kolo:lock", () => application.lock());
  command("kolo:setup", input => application.createShop(input));
  command("kolo:finish-setup", input => application.finishSetup(input));
  command("kolo:unlock", input => application.unlock(input));
  command("kolo:recover", input => application.recoverAccess(input));
  command("kolo:recovery-key", input => application.recoveryKey(input));
  command("kolo:products", input => application.listProducts(input));
  command("kolo:product", input => application.getProduct(input));
  command("kolo:scan", input => application.scanProduct(input));
  command("kolo:create-product", input => application.createProduct(input));
  command("kolo:update-product", input => application.updateProduct(input));
  command("kolo:product-active", input => application.setProductActive(input));
  command("kolo:categories", input => application.listCategories(input));
  command("kolo:create-category", input => application.createCategory(input));
  command("kolo:update-category", input => application.updateCategory(input));
  command("kolo:move-stock", input => application.moveStock(input));
  command("kolo:count-stock", input => application.countStock(input));
  command("kolo:stock-history", input => application.stockHistory(input));
  command("kolo:cash-accounts", input => application.listCashAccounts(input));
  command("kolo:checkout", input => application.checkout(input));
  command("kolo:receipt", input => application.getReceipt(input));
  command("kolo:receipts", input => application.listReceipts(input));
  return Object.freeze(handlers);
}
