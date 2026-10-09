import type { DesktopBridge } from "../electron/ipc.js";
declare global { interface Window { readonly kolo: DesktopBridge; } }
