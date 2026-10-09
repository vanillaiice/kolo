import type { DesktopBridge } from "../electron/ipc.js";
declare global {
  interface Window { readonly kolo: DesktopBridge; }
  /** Desktop package version, injected by Vite at build time. */
  const __KOLO_VERSION__: string;
}
