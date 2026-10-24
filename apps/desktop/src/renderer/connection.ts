import type { ServerView } from "../shared/service.ts";

/** The server this till is connected to (one it reached on its last attempt), by host; undefined when there is none. */
export function connectedServer(servers: readonly Pick<ServerView, "url" | "lastSuccessAt" | "lastError">[]): string | undefined {
  const server = servers.find(item => item.lastSuccessAt !== null && item.lastError === null);
  if (server === undefined) return undefined;
  try { return new URL(server.url).host; } catch { return server.url; }
}
