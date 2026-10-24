import { KEY_FINGERPRINT_PREFIX, enrollmentSigningMessage, sessionSigningMessage, type BootstrapResponse, type Challenge, type ChallengeRequest,
  type EnrollmentRequest, type PullResponse, type PushResponse, type ServerIdentity, type Session, type SessionRequest, type SyncStatus } from "@kolo/contracts/sync";
import type { SignedPeerReceipt } from "@kolo/contracts/delivery";
import type { Entitlement, Plan, JoinEnrollment, JoinOffer, JoinRequestBody, SignedSyncBatch } from "@kolo/contracts/sync";
import type { OperationContext } from "../identity/types.ts";
import { authorizedOperation, appendLocalAudit, nextId, timestamp } from "../identity/internal-authority.ts";
import { ExchangeError, type ExchangeCrypto } from "../exchange/types.ts";
import { pinnedDevice, publishDeviceRoster, registerExchangeDestination, requireOwner, verifyEvent } from "./exchange.ts";
import { applyEvent } from "./event-application.ts";
import { acknowledgeDelivery, createPeerReceipt, exchangeStatus, signMessage } from "./event-delivery.ts";
import { createSyncBatch, ensureEncryptionKey, importSyncBatch, maintainShopKeys, shopKeys, type SealingCrypto } from "./sealed-sync.ts";

/**
 * Network port for the optional sync server. Implementations only move bytes; every proof, trust and
 * authority decision stays in the shared operations below. A failure never affects local trading.
 */
export interface SyncTransport {
  identity(): Promise<ServerIdentity>;
  challenge(input: ChallengeRequest): Promise<Challenge>;
  enroll(input: EnrollmentRequest): Promise<void>;
  session(input: SessionRequest): Promise<Session>;
  endSession(token: string): Promise<void>;
  bootstrap(token: string): Promise<BootstrapResponse>;
  push(token: string, batch: SignedSyncBatch): Promise<PushResponse>;
  pull(token: string, cursor: string | null, limit: number): Promise<PullResponse>;
  receipt(token: string, receipt: SignedPeerReceipt): Promise<number>;
  status(token: string): Promise<SyncStatus>;
  /** Hosted service status for this shop; servers without billing answer `unlimited`. */
  entitlements(token: string): Promise<Entitlement>;
  /** The shop's till limit and use (ADR-039); servers before it answer 404, which the pass ignores. */
  plan?(token: string): Promise<Plan>;
  /** Join-by-code mailbox (ADR-032): the owner's calls carry a session token, the new till's do not. */
  joinCreate(token: string, offer: JoinOffer): Promise<{ expires_at: string }>;
  joinRead(joinId: string): Promise<JoinOffer>;
  joinRequest(joinId: string, body: JoinRequestBody): Promise<void>;
  joinPollRequest(token: string, joinId: string): Promise<JoinRequestBody | null>;
  joinEnroll(token: string, joinId: string, body: JoinEnrollment): Promise<void>;
  joinPollEnrollment(joinId: string): Promise<JoinEnrollment | null>;
  joinCancel(token: string, joinId: string): Promise<void>;
}

/** Stable network failure; `retry` distinguishes backoff from a condition the owner must resolve. */
export class SyncTransportError extends Error {
  readonly code: string; readonly status: number; readonly retry: boolean;
  constructor(code: string, status: number, retry: boolean) { super(code); this.name = "SyncTransportError"; this.code = code; this.status = status; this.retry = retry; }
}

/** Connected server, read from local SQLite; counts are this device's own delivery progress. */
export interface ServerConnection {
  readonly destinationId: string; readonly serverDeviceId: string; readonly url: string; readonly fingerprint: string;
  readonly connectedAt: string; readonly lastAttemptAt: string | null; readonly lastSuccessAt: string | null; readonly lastError: string | null;
  readonly pending: number; readonly unsigned: number;
  /** `code` when a person connected with a connection code; `shop` when the device followed the owner's shared server address. */
  readonly source: "code" | "shop";
  /** What the server last said about hosted service (ADR-031); null before the first pass. Local trading never depends on it. */
  readonly service: Entitlement["status"] | null; readonly paidUntil: string | null; readonly graceUntil: string | null;
  /** The shop's till limit as last reported (ADR-039): `tills` null when unknown; `maxTills` null with a count is unlimited. */
  readonly maxTills: number | null; readonly tills: number | null;
}

/**
 * One synchronization pass. `untrusted` facts were not stored and are offered again later. `locked` counts facts
 * waiting for a shop key: this device's own facts it cannot seal yet and received facts it cannot open yet.
 */
export interface SyncSummary { readonly pushed: number; readonly rejected: number; readonly pulled: number; readonly untrusted: number; readonly locked: number; }

/**
 * Normalizes a server address. HTTPS is required except on loopback and private LAN addresses,
 * where a self-hosted server may run without a certificate; payloads are signed either way.
 */
export function normalizeServerUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new ExchangeError("invalid_destination"); }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || !["https:", "http:"].includes(url.protocol)) throw new ExchangeError("invalid_destination");
  if (url.protocol === "http:" && !privateHost(url.hostname)) throw new ExchangeError("invalid_destination");
  const text = url.toString().replace(/\/+$/, "");
  if (text.length > 2048) throw new ExchangeError("invalid_destination");
  return text;
}

function privateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local") || host === "[::1]") return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The short fingerprint the owner compares with the one printed by the server before trusting it. */
export async function keyFingerprint(publicKey: string, crypto: ExchangeCrypto): Promise<string> {
  return (await crypto.sha256(`${KEY_FINGERPRINT_PREFIX}${publicKey}`)).slice(0, 32);
}

/** Reads and checks the server's public identity without changing anything locally. */
export async function previewServer(transport: SyncTransport, crypto: ExchangeCrypto): Promise<ServerIdentity> {
  const identity = await transport.identity();
  if (identity.fingerprint !== await keyFingerprint(identity.public_key, crypto)) throw new ExchangeError("fingerprint_mismatch");
  return identity;
}

/**
 * Connects this device to a sync server whose fingerprint came from a connection code or the owner's shared
 * address, so nobody retypes it. On the owner's authority-capable device this approves the server key (an
 * owner-signed `DEVICE_TRUSTED` fact), attaches the existing shop with its IDs using the code's single-use token,
 * publishes earlier pairings and shares the address with the shop's other tills. Any other device needs that owner
 * approval first and receives it from the server, owner-signed; it needs no token.
 */
export async function connectServer(context: OperationContext, transport: SyncTransport, input: { readonly url: string; readonly fingerprint: string; readonly token?: string; readonly source?: "code" | "shop" }, crypto: ExchangeCrypto): Promise<string> {
  const url = normalizeServerUrl(input.url), identity = await previewServer(transport, crypto), source = input.source ?? "code";
  if (input.fingerprint.replace(/\s+/g, "").toLowerCase() !== identity.fingerprint) throw new ExchangeError("fingerprint_mismatch");
  const local = authorizedOperation(context, ["business.settings"], (_database, tx) => {
    const install = tx.get(`SELECT owner_id,public_key FROM local_installation WHERE id=1`)!;
    const own = pinnedDevice(tx, context.businessId, context.deviceId);
    const pin = tx.get(`SELECT public_key,active FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`, [context.businessId, identity.server_device_id]);
    if (pin !== undefined && pin["public_key"] !== identity.public_key) throw new ExchangeError("fingerprint_mismatch");
    const business = tx.get(`SELECT name FROM businesses WHERE id=?`, [context.businessId])!;
    const device = tx.get(`SELECT label,platform FROM devices WHERE id=? AND business_id=?`, [context.deviceId, context.businessId])!;
    // This device began as a restored backup (not a pairing an authority till approved): the server cannot know it yet.
    const restored = tx.get(`SELECT 1 FROM local_audit WHERE business_id=? AND device_id=? AND action='WORKSPACE_RESTORED'`, [context.businessId, context.deviceId]) !== undefined;
    return { authority: install["owner_id"] === context.userId && own["authority_allowed"] === 1, pinned: pin?.["active"] === 1, ownerId: String(install["owner_id"]), restored,
      publicKey: String(install["public_key"]), businessName: String(business["name"]), label: String(device["label"]), platform: String(device["platform"]) };
  });
  let destinationId: string;
  if (local.authority) {
    destinationId = registerExchangeDestination(context, { deviceId: identity.server_device_id, publicKey: identity.public_key, label: new URL(url).host, platform: "SERVER", kind: "server" });
    const challenge = await transport.challenge({ purpose: "enrollment", business_id: context.businessId, device_id: context.deviceId });
    const claim = { format: "kolo.server-enrollment" as const, format_version: 1 as const, challenge_id: challenge.challenge_id, nonce: challenge.nonce,
      server_device_id: identity.server_device_id, business: { id: context.businessId, name: local.businessName }, owner_id: local.ownerId,
      device: { id: context.deviceId, label: local.label, platform: local.platform as "ANDROID" | "IOS" | "DESKTOP", public_key: local.publicKey } };
    const { signature } = await signMessage(context, crypto, enrollmentSigningMessage(claim));
    let enrolled = true, conflict: SyncTransportError | undefined;
    try { await transport.enroll({ claim, signature, ...(input.token === undefined ? {} : { connection_code: input.token }) }); }
    catch (error) {
      // Another authority till of this shop attached it already: join like any till, through the owner's signed trust.
      if (!(error instanceof SyncTransportError) || error.code !== "enrollment_conflict") throw error;
      enrolled = false; conflict = error;
    }
    if (enrolled) {
      publishDeviceRoster(context);
      shareServerEndpoint(context, { serverDeviceId: identity.server_device_id, url, fingerprint: identity.fingerprint });
    } else {
      // A restored device the server has never seen (a shop restored after losing every till) cannot join through trust no
      // till has vouched for: report the enrollment conflict, whose remedy is an owner-recovery code (ADR-036). An approved
      // till keeps `invalid_session`: it waits until the till that approved it syncs.
      try { await bootstrapTrust(context, transport, identity.server_device_id, crypto); }
      catch (error) { if (local.restored && error instanceof SyncTransportError && error.code === "invalid_session") throw conflict!; throw error; }
    }
  } else {
    if (!local.pinned) await bootstrapTrust(context, transport, identity.server_device_id, crypto);
    destinationId = adoptServerDestination(context, identity.server_device_id, new URL(url).host);
  }
  authorizedOperation(context, ["business.settings"], (_database, tx, ports, revision) => {
    tx.run(`INSERT INTO server_endpoints(destination_id,business_id,url,connected_at,source) VALUES (?,?,?,?,?)
      ON CONFLICT(destination_id) DO UPDATE SET url=excluded.url,last_error=NULL,source=excluded.source`, [destinationId, context.businessId, url, timestamp(ports), source]);
    tx.run(`UPDATE exchange_destinations SET active=1 WHERE id=? AND business_id=?`, [destinationId, context.businessId]);
    tx.run(`DELETE FROM server_endpoint_declined WHERE business_id=? AND server_device_id=?`, [context.businessId, identity.server_device_id]);
    appendLocalAudit(tx, context, ports, revision, "SYNC_SERVER_CONNECTED", destinationId, { serverDeviceId: identity.server_device_id, source });
  });
  return destinationId;
}

/**
 * Owner-signed `SERVER_ENDPOINT_SET`, so the shop's other trusted tills connect to the same server on their own.
 * Only the owner's authority device shares; repeating the same address records nothing.
 */
export function shareServerEndpoint(context: OperationContext, input: { readonly serverDeviceId: string; readonly url: string; readonly fingerprint: string }): void {
  authorizedOperation(context, ["business.settings", "users.manage"], (_database, tx, ports, revision) => {
    requireOwner(tx, context);
    if (pinnedDevice(tx, context.businessId, context.deviceId)["authority_allowed"] !== 1) throw new ExchangeError("permission_denied");
    const old = tx.get(`SELECT server_device_id,url,fingerprint,revision FROM shop_server_endpoint WHERE business_id=?`, [context.businessId]);
    if (old !== undefined && old["server_device_id"] === input.serverDeviceId && old["url"] === input.url && old["fingerprint"] === input.fingerprint) return;
    const revisionNext = Number(old?.["revision"] ?? 0) + 1;
    appendLocalAudit(tx, context, ports, revision, "SERVER_ENDPOINT_SET", input.serverDeviceId, { server_device_id: input.serverDeviceId, url: input.url, fingerprint: input.fingerprint, revision: revisionNext });
    tx.run(`INSERT INTO shop_server_endpoint(business_id,server_device_id,url,fingerprint,revision) VALUES (?,?,?,?,?)
      ON CONFLICT(business_id) DO UPDATE SET server_device_id=excluded.server_device_id,url=excluded.url,fingerprint=excluded.fingerprint,revision=excluded.revision`,
      [context.businessId, input.serverDeviceId, input.url, input.fingerprint, revisionNext]);
  });
}

/** The owner's shared server address when this device should connect to it on its own: set, not declined here and not already connected. */
export function pendingShopServer(context: OperationContext): { readonly url: string; readonly fingerprint: string; readonly serverDeviceId: string } | undefined {
  return authorizedOperation(context, ["business.settings"], (_database, tx) => {
    const row = tx.get(`SELECT e.server_device_id,e.url,e.fingerprint FROM shop_server_endpoint e WHERE e.business_id=? AND e.url IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM server_endpoint_declined d WHERE d.business_id=e.business_id AND d.server_device_id=e.server_device_id)
      AND NOT EXISTS (SELECT 1 FROM exchange_destinations x JOIN server_endpoints s ON s.destination_id=x.id WHERE x.business_id=e.business_id AND x.receiver_device_id=e.server_device_id AND x.kind='server' AND x.active=1)`, [context.businessId]);
    return row === undefined ? undefined : { url: String(row["url"]), fingerprint: String(row["fingerprint"]), serverDeviceId: String(row["server_device_id"]) };
  });
}

// A device without owner authority learns the server key only from owner-signed facts the server relays.
async function bootstrapTrust(context: OperationContext, transport: SyncTransport, serverDeviceId: string, crypto: ExchangeCrypto): Promise<void> {
  const token = await openSession(context, transport, serverDeviceId, crypto);
  try {
    const { events } = await transport.bootstrap(token);
    for (const event of events) {
      try { applyEvent(context, await verifyEvent(context, event, crypto)); }
      catch (error) { if (!(error instanceof ExchangeError) || error.code !== "untrusted_device") throw error; }
    }
  } finally { await transport.endSession(token).catch(() => undefined); }
  const trusted = authorizedOperation(context, ["business.settings"], (_database, tx) => tx.get(`SELECT active FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`, [context.businessId, serverDeviceId])?.["active"] === 1);
  if (!trusted) throw new ExchangeError("untrusted_device");
}

function adoptServerDestination(context: OperationContext, serverDeviceId: string, label: string): string {
  return authorizedOperation(context, ["business.settings"], (_database, tx, ports, revision) => {
    pinnedDevice(tx, context.businessId, serverDeviceId);
    if (tx.get(`SELECT platform FROM devices WHERE id=? AND business_id=?`, [serverDeviceId, context.businessId])?.["platform"] !== "SERVER") throw new ExchangeError("invalid_destination");
    const existing = tx.get(`SELECT id FROM exchange_destinations WHERE business_id=? AND receiver_device_id=? AND kind='server'`, [context.businessId, serverDeviceId]);
    if (existing !== undefined) return String(existing["id"]);
    const id = nextId(ports);
    tx.run(`INSERT INTO exchange_destinations(id,business_id,receiver_device_id,kind,label) VALUES (?,?,?,'server',?)`, [id, context.businessId, serverDeviceId, label]);
    appendLocalAudit(tx, context, ports, revision, "EXCHANGE_DESTINATION_REGISTERED", id, { deviceId: serverDeviceId, kind: "server", authorityAllowed: false });
    return id;
  });
}

/** @internal A network session for this device, for callers that make several server calls (join by code). */
export async function openServerSession(context: OperationContext, transport: SyncTransport, serverDeviceId: string, crypto: ExchangeCrypto): Promise<string> { return openSession(context, transport, serverDeviceId, crypto); }

async function openSession(context: OperationContext, transport: SyncTransport, serverDeviceId: string, crypto: ExchangeCrypto): Promise<string> {
  const challenge = await transport.challenge({ purpose: "session", business_id: context.businessId, device_id: context.deviceId });
  const claim = { format: "kolo.server-session" as const, format_version: 1 as const, challenge_id: challenge.challenge_id, nonce: challenge.nonce,
    server_device_id: serverDeviceId, business_id: context.businessId, device_id: context.deviceId };
  const { signature } = await signMessage(context, crypto, sessionSigningMessage(claim));
  const session = await transport.session({ claim, signature });
  if (session.business_id !== context.businessId || session.device_id !== context.deviceId || session.server_device_id !== serverDeviceId) throw new ExchangeError("scope_mismatch");
  return session.token;
}

/**
 * One bounded pass: announce this device's encryption key, push this device's pending facts (sealed), pull everything
 * others sent, then let the owner's devices create or grant shop keys. Each page is durable before its receipt is sent,
 * so a lost response only causes a harmless resend. A second round runs when keys changed during the first, so a
 * newly granted till does not wait a whole interval. Outcome and error code are recorded locally; errors are rethrown.
 */
export async function synchronizeServer(context: OperationContext, destinationId: string, transport: SyncTransport, crypto: SealingCrypto, options: { readonly batchSize?: number; readonly maxPages?: number } = {}): Promise<SyncSummary> {
  const batchSize = options.batchSize ?? 200, maxPages = options.maxPages ?? 50;
  const serverDeviceId = authorizedOperation(context, ["business.settings"], (_database, tx, ports) => {
    const row = tx.get(`SELECT x.receiver_device_id FROM exchange_destinations x JOIN server_endpoints s ON s.destination_id=x.id WHERE x.id=? AND x.business_id=? AND x.kind='server' AND x.active=1`, [destinationId, context.businessId]);
    if (row === undefined) throw new ExchangeError("invalid_destination");
    tx.run(`UPDATE server_endpoints SET last_attempt_at=? WHERE destination_id=?`, [timestamp(ports), destinationId]);
    return String(row["receiver_device_id"]);
  });
  let pushed = 0, rejected = 0, pulled = 0, untrusted = 0, locked = 0;
  try {
    await ensureEncryptionKey(context);
    const token = await openSession(context, transport, serverDeviceId, crypto);
    try {
      // Read before transfer, so a paused hosted shop still learns why and until when.
      recordEntitlement(context, destinationId, await transport.entitlements(token));
      if (transport.plan !== undefined) recordPlan(context, destinationId, await transport.plan(token).catch(() => undefined));
      // Keys are managed after pulling, so a till sees the shop's existing keys before it could create one.
      let known = -1, granted = 0;
      for (let round = 0; round < 2; round++) {
        const keys = await shopKeys(context, crypto);
        if (round === 1 && granted === 0 && keys.length === known) break;
        known = keys.length; locked = 0;
        for (let page = 0; page < maxPages; page++) {
          const { signed, waiting } = await createSyncBatch(context, destinationId, crypto, keys, batchSize);
          if (page === 0) locked += waiting;
          if (signed === undefined) break;
          const response = await transport.push(token, signed);
          rejected += response.results.filter(result => result.status === "rejected").length;
          const acknowledged = response.receipt === null ? 0 : await acknowledgeDelivery(context, destinationId, response.receipt, crypto);
          pushed += acknowledged;
          if (acknowledged === 0) break; // Only refused facts remain at the head of the queue; retry on a later pass.
        }
        let cursor: string | null = null;
        for (let page = 0; page < maxPages; page++) {
          const response = await transport.pull(token, cursor, batchSize);
          if (response.batch !== null) {
            const outcomes = await importSyncBatch(context, response.batch, crypto, keys);
            const waiting = outcomes.filter(outcome => outcome.outcome === "untrusted").length, unreadable = outcomes.filter(outcome => outcome.outcome === "locked").length;
            untrusted += waiting; locked += unreadable; pulled += outcomes.length - waiting - unreadable;
            const receipt = await createPeerReceipt(context, response.batch.batch.batch_id, crypto);
            if (receipt !== undefined) await transport.receipt(token, receipt);
          }
          cursor = response.cursor;
          if (!response.has_more) break;
        }
        granted = await maintainShopKeys(context, crypto);
      }
    } finally { await transport.endSession(token).catch(() => undefined); }
  } catch (error) {
    const code = error instanceof SyncTransportError || error instanceof ExchangeError ? error.code : "network_unavailable";
    recordOutcome(context, destinationId, code.slice(0, 64));
    throw error;
  }
  recordOutcome(context, destinationId, null);
  return { pushed, rejected, pulled, untrusted, locked };
}

function recordEntitlement(context: OperationContext, destinationId: string, value: Entitlement): void {
  try {
    authorizedOperation(context, ["business.settings"], (_database, tx) => {
      tx.run(`UPDATE server_endpoints SET service_status=?,paid_until=?,grace_until=? WHERE destination_id=?`, [value.status, value.paid_until, value.grace_until, destinationId]);
    });
  } catch { /* Display only; the pass continues. */ }
}

function recordPlan(context: OperationContext, destinationId: string, value: Plan | undefined): void {
  if (value === undefined) return; // An older server, or a read that failed: the last known plan stays.
  try {
    authorizedOperation(context, ["business.settings"], (_database, tx) => {
      tx.run(`UPDATE server_endpoints SET plan_max_tills=?,plan_tills=? WHERE destination_id=?`, [value.max_tills, value.tills, destinationId]);
    });
  } catch { /* Display only; the pass continues. */ }
}

function recordOutcome(context: OperationContext, destinationId: string, error: string | null): void {
  try {
    authorizedOperation(context, ["business.settings"], (_database, tx, ports) => {
      if (error === null) tx.run(`UPDATE server_endpoints SET last_success_at=?,last_error=NULL WHERE destination_id=?`, [timestamp(ports), destinationId]);
      else tx.run(`UPDATE server_endpoints SET last_error=? WHERE destination_id=?`, [error, destinationId]);
    });
  } catch { /* A lock during the network pass leaves the previous status; nothing else depends on it. */ }
}

/** Connected servers with local delivery counts, for status display. */
export async function serverConnections(context: OperationContext, crypto: ExchangeCrypto): Promise<readonly ServerConnection[]> {
  const rows = authorizedOperation(context, ["business.settings"], (_database, tx) => tx.all(`SELECT s.*,x.receiver_device_id,t.public_key FROM server_endpoints s
    JOIN exchange_destinations x ON x.id=s.destination_id AND x.business_id=s.business_id
    JOIN trusted_exchange_devices t ON t.device_id=x.receiver_device_id AND t.business_id=x.business_id
    WHERE s.business_id=? AND x.active=1 ORDER BY s.connected_at`, [context.businessId]));
  const result: ServerConnection[] = [];
  for (const row of rows) {
    const counts = exchangeStatus(context, String(row["destination_id"]));
    result.push(Object.freeze({ destinationId: String(row["destination_id"]), serverDeviceId: String(row["receiver_device_id"]), url: String(row["url"]),
      fingerprint: await keyFingerprint(String(row["public_key"]), crypto), connectedAt: String(row["connected_at"]),
      lastAttemptAt: row["last_attempt_at"] as string | null, lastSuccessAt: row["last_success_at"] as string | null, lastError: row["last_error"] as string | null,
      pending: counts["pending"] ?? 0, unsigned: counts["unsigned"] ?? 0, source: row["source"] === "shop" ? "shop" : "code",
      service: (row["service_status"] ?? null) as ServerConnection["service"], paidUntil: (row["paid_until"] ?? null) as string | null, graceUntil: (row["grace_until"] ?? null) as string | null,
      maxTills: (row["plan_max_tills"] ?? null) as number | null, tills: (row["plan_tills"] ?? null) as number | null }));
  }
  return result;
}

/**
 * Stops syncing with a server on this device and remembers the choice, so the shop's shared address does not
 * reconnect it. On the owner's authority device it also withdraws the shared address (`SERVER_ENDPOINT_CLEARED`);
 * tills already connected stay connected. Trust in the server key is unchanged; the owner revokes keys separately.
 */
export function disconnectServer(context: OperationContext, destinationId: string): void {
  authorizedOperation(context, ["business.settings"], (_database, tx, ports, revision) => {
    const server = tx.get(`SELECT receiver_device_id FROM exchange_destinations WHERE id=? AND business_id=? AND kind='server'`, [destinationId, context.businessId]);
    if (server === undefined || tx.run(`UPDATE exchange_destinations SET active=0 WHERE id=? AND business_id=? AND kind='server'`, [destinationId, context.businessId]).changes !== 1) throw new ExchangeError("invalid_destination");
    const serverDeviceId = String(server["receiver_device_id"]);
    tx.run(`DELETE FROM server_endpoints WHERE destination_id=? AND business_id=?`, [destinationId, context.businessId]);
    tx.run(`INSERT OR REPLACE INTO server_endpoint_declined(business_id,server_device_id,declined_at) VALUES (?,?,?)`, [context.businessId, serverDeviceId, timestamp(ports)]);
    appendLocalAudit(tx, context, ports, revision, "SYNC_SERVER_DISCONNECTED", destinationId);
    const shared = tx.get(`SELECT revision FROM shop_server_endpoint WHERE business_id=? AND server_device_id=? AND url IS NOT NULL`, [context.businessId, serverDeviceId]);
    const owner = tx.get(`SELECT owner_id FROM local_installation WHERE id=1`)?.["owner_id"] === context.userId && pinnedDevice(tx, context.businessId, context.deviceId)["authority_allowed"] === 1;
    if (shared !== undefined && owner) {
      const next = Number(shared["revision"]) + 1;
      appendLocalAudit(tx, context, ports, revision, "SERVER_ENDPOINT_CLEARED", serverDeviceId, { server_device_id: serverDeviceId, revision: next });
      tx.run(`UPDATE shop_server_endpoint SET url=NULL,fingerprint=NULL,revision=? WHERE business_id=?`, [next, context.businessId]);
    }
  });
}

/**
 * True when this shop already trusts the server's key, meaning the shop was attached before (by this till or the
 * owner's): reconnecting then needs no single-use token.
 */
export function knowsServer(context: OperationContext, serverDeviceId: string, publicKey: string): boolean {
  return authorizedOperation(context, ["business.settings"], (_database, tx) => {
    const pin = tx.get(`SELECT public_key,active FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`, [context.businessId, serverDeviceId]);
    return pin?.["active"] === 1 && pin["public_key"] === publicKey;
  });
}

/** True when this unlocked device may enroll the shop itself rather than waiting for the owner. */
export function canEnrollServer(context: OperationContext): boolean {
  try {
    return authorizedOperation(context, ["business.settings"], (_database, tx) => { requireOwner(tx, context); return pinnedDevice(tx, context.businessId, context.deviceId)["authority_allowed"] === 1; });
  } catch { return false; }
}
