import { approveJoin, endJoin, pollJoin, startJoin, type JoinCandidate, type JoinStart } from "@kolo/core/application/join";
import { serverConnections } from "@kolo/core/application/server-sync";
import type { SnapshotPort } from "@kolo/core/backup/types";
import type { JoinCodeView, JoinStatusView } from "../shared/service.js";
import { boolean, object, text } from "./validation.ts";
import { CommandError } from "./host.ts";
import type { SyncHost } from "./server-sync.ts";

/** A join this computer opened: the network session and the candidate stay in the main process. */
export interface OpenJoin { readonly start: JoinStart; readonly url: string; candidate?: JoinCandidate | undefined }
/** What join commands need: sync access, the snapshot port for the shop file, and this window's open joins. */
export interface JoinHost extends SyncHost { readonly files: SnapshotPort; readonly joins: Map<string, OpenJoin> }

function opened(host: JoinHost, value: unknown): OpenJoin {
  const id = text(value, 64);
  const join = host.joins.get(id);
  if (join === undefined) throw new CommandError("join_not_found");
  return join;
}

/** Shows a code (and QR link) for one new till on the first connected server. */
export async function startJoinCode(host: JoinHost, input: unknown): Promise<JoinCodeView> {
  const data = object(input, ["sessionId", "authorityAllowed"]), context = host.actor(data, ["business.settings", "users.manage"]);
  const [server] = await serverConnections(context, host.crypto);
  if (server === undefined) throw new CommandError("no_server");
  const start = await startJoin(context, host.transport(server.url), host.crypto, { serverDeviceId: server.serverDeviceId, url: server.url, fingerprint: server.fingerprint, authorityAllowed: boolean(data["authorityAllowed"]) });
  host.joins.set(start.joinId, { start, url: server.url });
  return { joinId: start.joinId, code: start.display, link: start.link, url: server.url, expiresAt: start.expiresAt, authorityAllowed: start.authorityAllowed };
}

/** Whether the new till has asked yet; its name is shown for the owner to allow. */
export async function pollJoinCode(host: JoinHost, input: unknown): Promise<JoinStatusView> {
  const data = object(input, ["sessionId", "joinId"]); host.actor(data, ["business.settings", "users.manage"]);
  const join = opened(host, data["joinId"]);
  if (Date.parse(join.start.expiresAt) <= Date.now() && join.candidate === undefined) return { state: "expired" };
  join.candidate ??= await pollJoin(host.transport(join.url), host.crypto, join.start);
  return join.candidate === undefined ? { state: "waiting" } : { state: "requested", label: join.candidate.label, platform: join.candidate.platform };
}

/** The owner allows the named till: its shop file is built, encrypted to it and handed over through the server. */
export async function approveJoinCode(host: JoinHost, input: unknown): Promise<null> {
  const data = object(input, ["sessionId", "joinId"]), context = host.actor(data, ["business.settings", "users.manage"]);
  const join = opened(host, data["joinId"]);
  if (join.candidate === undefined) throw new CommandError("invalid_input");
  await approveJoin(context, host.transport(join.url), host.crypto, host.files, join.start, join.candidate);
  host.joins.delete(join.start.joinId);
  await endJoin(context, host.transport(join.url), join.start, false);
  return null;
}

/** Refuses or abandons a join; the code stops working at once. */
export async function cancelJoinCode(host: JoinHost, input: unknown): Promise<null> {
  const data = object(input, ["sessionId", "joinId"]), context = host.actor(data, ["business.settings", "users.manage"]);
  const join = opened(host, data["joinId"]);
  host.joins.delete(join.start.joinId);
  await endJoin(context, host.transport(join.url), join.start, true).catch(() => undefined);
  return null;
}
