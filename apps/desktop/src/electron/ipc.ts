import type { ShopService, UpdateService } from "../shared/service.js";

/** Legacy boot-status read retained for compatibility and diagnostics. */
export interface DesktopStatus {
  readonly schemaVersion: number;
  readonly shopName: string | null;
}

export interface DesktopBridge extends ShopService, UpdateService {
  /** Read installation status from the main process's local database. */
  getStatus(): Promise<DesktopStatus>;
}
