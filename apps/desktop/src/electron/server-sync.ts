import { connectServer as attach, disconnectServer as detach, knowsServer, previewServer, serverConnections, synchronizeServer, canEnrollServer, normalizeServerUrl,
  SyncTransportError, type ServerConnection, type SyncTransport } from "@kolo/core/application/server-sync";
import { createHttpSyncTransport } from "@kolo/core/application/http-sync-transport";
import type { SealingCrypto } from "@kolo/core/application/sealed-sync";
import { formatConnectionCode, parseConnectionCode } from "@kolo/contracts/sync";
import { ExchangeError } from "@kolo/core/exchange/types";
import { WorkspaceError } from "@kolo/core/identity/types";
import type { FailureCode, ServerPreview, ServerView, ServerSyncSummary } from "../shared/service.js";
import { object, text, uuid } from "./validation.ts";
import { CommandError, type Host } from "./host.ts";

/** What sync commands need from the desktop host. The transport factory is replaceable in tests. */
export interface SyncHost extends Host { readonly crypto: SealingCrypto; readonly transport: (url: string) => SyncTransport; }

const PASSED_THROUGH: readonly string[] = ["invalid_connection_code", "connection_code_used", "connection_code_expired", "enrollment_conflict", "shop_suspended", "shop_removed", "hosted_service_inactive", "join_not_found", "join_conflict"];

/** Network and server refusals become stable bridge codes; nothing from a response body crosses the bridge. */
export async function syncTranslated<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof SyncTransportError) {
      if (PASSED_THROUGH.includes(error.code)) throw new CommandError(error.code as FailureCode);
      throw new CommandError(error.retry || error.status === 0 ? "server_unreachable" : "server_refused");
    }
    if (error instanceof ExchangeError) {
      if (error.code === "invalid_destination") throw new CommandError("invalid_address");
      if (error.code === "untrusted_device") throw new CommandError("server_not_approved");
      if (error.code === "fingerprint_mismatch") throw new CommandError("fingerprint_mismatch");
      if (error.code === "permission_denied" || error.code === "scope_mismatch" || error.code === "locked") throw new WorkspaceError(error.code);
      throw new CommandError("server_refused");
    }
    throw error;
  }
}

function view(connection: ServerConnection, owner: boolean): ServerView {
  return { destinationId: connection.destinationId, url: connection.url, fingerprint: connection.fingerprint, connectedAt: connection.connectedAt,
    lastAttemptAt: connection.lastAttemptAt, lastSuccessAt: connection.lastSuccessAt, lastError: connection.lastError, pending: connection.pending + connection.unsigned,
    automatic: connection.source === "shop", shareCode: owner ? formatConnectionCode({ url: connection.url, fingerprint: connection.fingerprint }) : null,
    service: connection.service, paidUntil: connection.paidUntil, graceUntil: connection.graceUntil };
}
/** A pasted connection code, with its address checked against the till's own address policy. */
function code(value: unknown): { readonly url: string; readonly fingerprint: string; readonly token?: string } {
  const parsed = parseConnectionCode(text(value, 8192, false));
  if (parsed === undefined) throw new CommandError("invalid_code");
  try { return { ...parsed, url: normalizeServerUrl(parsed.url) }; } catch { throw new CommandError("invalid_address"); }
}

/** Connected servers and whether this device may attach the shop itself. */
export async function serverState(host: SyncHost, input: unknown): Promise<{ readonly servers: readonly ServerView[]; readonly canEnroll: boolean }> {
  const context = host.actor(object(input, ["sessionId"]), ["business.settings"]), owner = canEnrollServer(context);
  return { servers: (await serverConnections(context, host.crypto)).map(connection => view(connection, owner)), canEnroll: owner };
}

/** Reads the server a connection code points to and refuses one whose fingerprint differs from the code's. */
export async function checkServer(host: SyncHost, input: unknown): Promise<ServerPreview> {
  const data = object(input, ["sessionId", "code"]), context = host.actor(data, ["business.settings"]), target = code(data["code"]);
  const identity = await previewServer(host.transport(target.url), host.crypto);
  if (identity.fingerprint !== target.fingerprint) throw new CommandError("fingerprint_mismatch");
  return { url: target.url, fingerprint: identity.fingerprint, canEnroll: canEnrollServer(context), hasToken: target.token !== undefined,
    attached: knowsServer(context, identity.server_device_id, identity.public_key) };
}

/** Connects with a connection code, then runs a first pass so the result is visible immediately. */
export async function connectServer(host: SyncHost, input: unknown): Promise<ServerView> {
  const data = object(input, ["sessionId", "code"]), context = host.actor(data, ["business.settings"]), target = code(data["code"]);
  const transport = host.transport(target.url);
  const destinationId = await attach(context, transport, { ...target, source: "code" }, host.crypto);
  await synchronizeServer(context, destinationId, transport, host.crypto).catch(() => undefined); // The status shows any first-pass failure.
  const connection = (await serverConnections(context, host.crypto)).find(item => item.destinationId === destinationId);
  if (connection === undefined) throw new CommandError("server_refused");
  return view(connection, canEnrollServer(context));
}

/** One manual pass for the chosen server. */
export async function syncServer(host: SyncHost, input: unknown): Promise<ServerSyncSummary> {
  const data = object(input, ["sessionId", "destinationId"]), context = host.actor(data, ["business.settings"]), destinationId = uuid(data["destinationId"]);
  const connection = (await serverConnections(context, host.crypto)).find(item => item.destinationId === destinationId);
  if (connection === undefined) throw new CommandError("invalid_input");
  return synchronizeServer(context, destinationId, host.transport(connection.url), host.crypto);
}

/** Stops syncing on this computer and remembers it, so the shop's shared address does not reconnect it; data and trust are kept. */
export async function disconnectServer(host: SyncHost, input: unknown): Promise<null> {
  const data = object(input, ["sessionId", "destinationId"]), context = host.actor(data, ["business.settings"]);
  detach(context, uuid(data["destinationId"])); return null;
}

/** Background passes on the shared schedule (see `ServerSyncScheduler`); the desktop ticks it after each sealing run. */
export { ServerSyncScheduler as AutoSync } from "@kolo/core/application/sync-scheduler";

/** Production transport: Node's fetch from the main process; the renderer never reaches the network. */
export function httpTransport(url: string): SyncTransport { return createHttpSyncTransport(url); }
