import type { OperationContext } from "../identity/types.ts";
import { connectServer, pendingShopServer, serverConnections, synchronizeServer, type SyncTransport } from "./server-sync.ts";
import type { SealingCrypto } from "./sealed-sync.ts";

/**
 * Background sync for any platform, driven by the app's own timer or lifecycle events. Each `tick` first follows the
 * owner's shared server address if this device is not connected to it yet, then syncs every connected server. Success
 * waits a minute; failure backs off up to fifteen minutes. `soon` brings the next pass forward after a local change or
 * when the app returns to the foreground. Passes never overlap and never run without a signed-in context.
 */
export class ServerSyncScheduler {
  #due = 0; #failures = 0; #running = false;
  readonly #crypto: SealingCrypto; readonly #transport: (url: string) => SyncTransport; readonly #now: () => number;
  constructor(crypto: SealingCrypto, transport: (url: string) => SyncTransport, now: () => number = Date.now) { this.#crypto = crypto; this.#transport = transport; this.#now = now; }
  /** Something changed locally, or the app came back: sync soon rather than at the next regular pass. */
  soon(): void { this.#due = Math.min(this.#due, this.#now() + 5_000); }
  /** Runs a pass if one is due. Failures are recorded on each server's status and never thrown. */
  async tick(context: OperationContext | undefined): Promise<void> {
    if (context === undefined || this.#running || this.#now() < this.#due) return;
    this.#running = true;
    try {
      let failed = false;
      const shared = pendingShopServer(context);
      if (shared !== undefined) {
        try { await connectServer(context, this.#transport(shared.url), { url: shared.url, fingerprint: shared.fingerprint, source: "shop" }, this.#crypto); }
        catch { failed = true; } // Usually the owner has not approved this till on the server yet; try again later.
      }
      for (const server of await serverConnections(context, this.#crypto)) {
        try { await synchronizeServer(context, server.destinationId, this.#transport(server.url), this.#crypto); } catch { failed = true; }
      }
      this.#failures = failed ? Math.min(this.#failures + 1, 5) : 0;
      this.#due = this.#now() + (failed ? Math.min(15 * 60_000, 30_000 * 2 ** this.#failures) : 60_000);
    } catch { this.#due = this.#now() + 60_000; } // No settings access or locked: try again later.
    finally { this.#running = false; }
  }
}
