import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { sql, type Kysely } from "kysely";
import { EXCHANGE_VERSION } from "@kolo/contracts";
import { MAX_JOURNAL_BATCH_BYTES, signedPeerReceiptSchema } from "@kolo/contracts/delivery";
import { challengeRequestSchema, enrollmentRequestSchema, joinEnrollmentSchema, joinOfferSchema, joinRequestSchema, sessionRequestSchema, signedSyncBatchSchema, PULL_DEFAULT_LIMIT, SYNC_API_VERSION } from "@kolo/contracts/sync";
import { MAX_ENCRYPTED_FILE_BYTES } from "@kolo/contracts/transfer";
import { cancelJoin, createJoin, enrollJoin, joinEnrollmentOf, joinRequestOf, readJoin, requestJoin } from "./sync/join.js";
import type { ServerConfig } from "./config.js";
import { openDatabase, schemaCurrent, type ServerDatabase } from "./database.js";
import { loadServerKey, type ServerKey } from "./identity.js";
import { createMetrics, type Metrics } from "./admin/operations.js";
import { RelayError, acceptReceipt, authenticate, bootstrap, createChallenge, endSession, enroll, entitlement, openSession, pull, push, requireService, status, type Relay } from "./sync/relay.js";
import { BillingError, genericWebhookAdapter, recordPayment } from "./billing.js";
import { audit } from "./admin/accounts.js";

/** The error body every failed request returns; codes are stable, messages are never echoed. */
export interface ErrorBody { readonly error: { readonly code: string; readonly retry?: boolean } }

/** Optional collaborators, injected by tests; production loads the key file named in the configuration. */
export interface ApplicationOptions { readonly key?: ServerKey; readonly now?: () => Date; readonly rateLimitMax?: number; readonly metrics?: Metrics }

const CODES: Readonly<Record<number, string>> = { 404: "not_found", 413: "batch_too_large", 415: "bad_request", 429: "rate_limited" };

/** Build the app without listening, so HTTP behavior can be tested on an ephemeral port or with `inject`. */
export async function createApplication(config: ServerConfig, options: ApplicationOptions = {}): Promise<FastifyInstance> {
  const db: Kysely<ServerDatabase> | undefined = config.databaseUrl === undefined ? undefined : openDatabase(config.databaseUrl);
  const key = db === undefined ? undefined : options.key ?? loadServerKey(config.keyFile ?? ".kolo-server-key.json");
  const relay: Relay | undefined = db === undefined || key === undefined ? undefined : { db, key, edition: { edition: config.edition ?? "selfhost", graceDays: config.graceDays ?? 7 },
    sessionTtlSeconds: config.sessionTtlSeconds ?? 3600, now: options.now ?? (() => new Date()) };
  let current = false;
  // Sync stays unavailable until PostgreSQL is reachable and fully migrated; the check is cached once true.
  async function ready(): Promise<Relay> {
    if (relay === undefined) throw new RelayError(503, "database_unavailable", true);
    if (current) return relay;
    try { current = await schemaCurrent(relay.db); } catch { throw new RelayError(503, "database_unavailable", true); }
    if (!current) throw new RelayError(503, "schema_outdated", true);
    return relay;
  }

  const application = Fastify({ logger: config.logLevel === undefined || config.logLevel === "silent" ? false : { level: config.logLevel }, bodyLimit: 64 * 1024, trustProxy: config.trustProxy ?? false });
  application.addHook("onClose", async () => { await db?.destroy(); });
  // Counters for the operator dashboard: totals only, never paths, bodies or addresses.
  const metrics = options.metrics ?? createMetrics();
  application.addHook("onResponse", async (_request, reply) => {
    metrics.requests++;
    if (reply.statusCode === 429) metrics.rateLimited++;
    else if (reply.statusCode >= 500) metrics.serverErrors++;
    else if (reply.statusCode >= 400) metrics.clientErrors++;
  });

  // Unknown routes and unexpected failures share one shape and never leak internals.
  application.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: "not_found" } } satisfies ErrorBody));
  application.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
    if (error instanceof BillingError) return reply.code(error.status).send({ error: { code: error.code, retry: error.status >= 500 } } satisfies ErrorBody);
    if (error instanceof RelayError) return reply.code(error.status).send({ error: { code: error.code, ...(error.retry === undefined ? {} : { retry: error.retry }) } } satisfies ErrorBody);
    const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    const body: ErrorBody = { error: { code: status === 500 ? "internal" : CODES[status] ?? "bad_request", ...(status === 429 || status === 500 ? { retry: true } : {}) } };
    return reply.code(status).send(body);
  });

  await application.register(rateLimit, { max: options.rateLimitMax ?? 600, timeWindow: "1 minute",
    errorResponseBuilder: () => ({ statusCode: 429, error: { code: "rate_limited", retry: true } }) });
  const strict = { rateLimit: { max: Math.max(1, Math.floor((options.rateLimitMax ?? 600) / 20)), timeWindow: "1 minute" } };

  /** Validates a body with a shared contract schema; failures name no field and echo no value. */
  function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new RelayError(400, "invalid_request", false);
    return result.data;
  }
  const scope = async (request: FastifyRequest) => { const active = await ready(); return { relay: active, scope: await authenticate(active, request.headers.authorization) }; };
  // Data transfer additionally needs hosted service; identity, status and entitlement reads do not.
  const transfer = async (request: FastifyRequest) => { const current = await scope(request); await requireService(current.relay, current.scope); return current; };

  // Liveness is independent of whether a deployment's database is available.
  application.get("/healthz", async () => ({ status: "ok" }));

  // Readiness checks PostgreSQL and the schema, and never reports ready for an unconfigured server.
  application.get("/readyz", async (_request, reply) => {
    if (db === undefined) return reply.code(503).send({ error: { code: "database_unavailable" } } satisfies ErrorBody);
    try { await sql`SELECT 1`.execute(db); } catch { return reply.code(503).send({ error: { code: "database_unavailable" } } satisfies ErrorBody); }
    try { if (!await schemaCurrent(db)) return reply.code(503).send({ error: { code: "schema_outdated" } } satisfies ErrorBody); } catch { return reply.code(503).send({ error: { code: "database_unavailable" } } satisfies ErrorBody); }
    return { status: "ready" };
  });

  // Advertise only what this deployment can actually do right now.
  application.get("/api/v2/capabilities", async () => {
    let sync = false;
    try { await ready(); sync = true; } catch { sync = false; }
    return { api_version: SYNC_API_VERSION, exchange_format_version: EXCHANGE_VERSION, sync, enrollment: sync };
  });

  application.get("/api/v2/server", async () => {
    const active = await ready();
    return { api_version: SYNC_API_VERSION, server_device_id: active.key.deviceId, public_key: active.key.publicKey, fingerprint: active.key.fingerprint, enrollment_open: true };
  });

  application.post("/api/v2/enrollment/challenges", { config: strict }, async request => {
    const input = parse(challengeRequestSchema, request.body);
    if (input.purpose !== "enrollment") throw new RelayError(400, "invalid_request", false);
    return createChallenge(await ready(), input);
  });
  application.post("/api/v2/enrollment/complete", { config: strict }, async (request, reply) => {
    await enroll(await ready(), parse(enrollmentRequestSchema, request.body));
    return reply.code(204).send();
  });
  application.post("/api/v2/auth/challenges", { config: strict }, async request => {
    const input = parse(challengeRequestSchema, request.body);
    if (input.purpose !== "session") throw new RelayError(400, "invalid_request", false);
    return createChallenge(await ready(), input);
  });
  application.post("/api/v2/auth/sessions", { config: strict }, async request => openSession(await ready(), parse(sessionRequestSchema, request.body)));
  application.delete("/api/v2/auth/session", async (request, reply) => { await endSession(await ready(), request.headers.authorization); return reply.code(204).send(); });
  application.get("/api/v2/auth/me", async request => {
    const { relay: active, scope: current } = await scope(request);
    return { business_id: current.businessId, device_id: current.deviceId, server_device_id: active.key.deviceId };
  });

  application.post("/api/v2/sync/push", { bodyLimit: MAX_JOURNAL_BATCH_BYTES + 64 * 1024 }, async request => {
    const { relay: active, scope: current } = await transfer(request);
    return push(active, current, parse(signedSyncBatchSchema, request.body));
  });
  application.get("/api/v2/sync/pull", async request => {
    const { relay: active, scope: current } = await transfer(request);
    const query = request.query as Record<string, unknown>;
    const limit = query["limit"] === undefined ? PULL_DEFAULT_LIMIT : /^\d{1,4}$/.test(String(query["limit"])) ? Number(query["limit"]) : NaN;
    const cursor = query["cursor"];
    if (cursor !== undefined && typeof cursor !== "string") throw new RelayError(400, "invalid_cursor", false);
    return pull(active, current, cursor, limit);
  });
  application.post("/api/v2/sync/receipts", async request => {
    const { relay: active, scope: current } = await transfer(request);
    return { acknowledged: await acceptReceipt(active, current, parse(signedPeerReceiptSchema, request.body)) };
  });
  application.get("/api/v2/sync/bootstrap", async request => { const { relay: active, scope: current } = await transfer(request); return bootstrap(active, current); });
  // Join by code (ADR-032). The id is a hash of the code; reads are rate-limited and reveal only signed or encrypted blobs.
  const joinId = (request: FastifyRequest): string => { const id = (request.params as { id?: string }).id ?? ""; if (!/^[a-f0-9]{64}$/.test(id)) throw new RelayError(404, "join_not_found", false); return id; };
  const polling = { rateLimit: { max: Math.max(6, Math.floor((options.rateLimitMax ?? 600) / 10)), timeWindow: "1 minute" } };
  application.post("/api/v2/join", { config: strict }, async (request, reply) => { const { relay: active, scope: current } = await transfer(request); return reply.code(201).send(await createJoin(active, current, parse(joinOfferSchema, request.body))); });
  application.get("/api/v2/join/:id", { config: strict }, async request => readJoin(await ready(), joinId(request)));
  application.post("/api/v2/join/:id/request", { config: strict }, async (request, reply) => { await requestJoin(await ready(), joinId(request), parse(joinRequestSchema, request.body)); return reply.code(204).send(); });
  application.get("/api/v2/join/:id/request", { config: polling }, async (request, reply) => { const { relay: active, scope: current } = await scope(request); const value = await joinRequestOf(active, current, joinId(request)); return value === null ? reply.code(204).send() : value; });
  application.post("/api/v2/join/:id/enrollment", { bodyLimit: MAX_ENCRYPTED_FILE_BYTES + 64 * 1024 }, async (request, reply) => { const { relay: active, scope: current } = await transfer(request); await enrollJoin(active, current, joinId(request), parse(joinEnrollmentSchema, request.body)); return reply.code(204).send(); });
  application.get("/api/v2/join/:id/enrollment", { config: polling }, async (request, reply) => { const value = await joinEnrollmentOf(await ready(), joinId(request)); return value === null ? reply.code(204).send() : value; });
  application.delete("/api/v2/join/:id", async (request, reply) => { const { relay: active, scope: current } = await scope(request); await cancelJoin(active, current, joinId(request)); return reply.code(204).send(); });

  application.get("/api/v2/entitlements", async request => { const { relay: active, scope: current } = await scope(request); return entitlement(active, current); });

  // Provider-neutral signed payment webhook (ADR-031); absent unless hosted with a configured secret.
  if (config.edition === "hosted" && config.billingWebhookSecret !== undefined && db !== undefined) {
    const adapter = genericWebhookAdapter(config.billingWebhookSecret);
    await application.register(async scoped => {
      scoped.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 16 * 1024 }, (_request, body, done) => done(null, body));
      scoped.post("/internal/billing/webhooks/generic", { config: strict }, async (request, reply) => {
        const active = await ready(), payment = adapter.verify(String(request.body ?? ""), request.headers, active.now());
        const result = await active.db.transaction().execute(async tx => {
          const recorded = await recordPayment(tx, { ...payment, source: "webhook", recordedBy: `webhook:${adapter.name}` }, active.now());
          if (!recorded.duplicate) await audit(tx, { adminId: null, username: `webhook:${adapter.name}` }, "payment.record", payment.shopId, null, { months: payment.months, amount_minor: payment.amountMinor, method: payment.method });
          return recorded;
        });
        return reply.code(result.duplicate ? 200 : 201).send({ payment_id: result.paymentId, paid_until: result.paidUntilAfter, duplicate: result.duplicate });
      });
    });
  }
  application.get("/api/v2/sync/status", async request => { const { relay: active, scope: current } = await scope(request); return status(active, current); });

  return application;
}
