import { createHttpSyncTransport } from "@kolo/core/application/http-sync-transport";
import type { SyncTransport } from "@kolo/core/application/server-sync";

/** HTTP transport over React Native's `fetch`; only bytes move here, every proof and trust decision stays in the core. */
export function syncTransportOnDevice(url: string): SyncTransport { return createHttpSyncTransport(url); }
