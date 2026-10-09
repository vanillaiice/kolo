import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { EXCHANGE_VERSION } from "@kolo/contracts";
import type { ServerConfig } from "./config.js";

/** The error body every failed request returns; codes are stable, messages are never echoed. */
export interface ErrorBody { readonly error: { readonly code: string } }

/** Build the app without listening, so HTTP behavior can be tested on an ephemeral port or with `inject`. */
export async function createApplication(config: ServerConfig): Promise<FastifyInstance> {
  const pool = config.databaseUrl === undefined ? undefined : new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 2000, max: 5 });
  // An idle PostgreSQL connection can fail between requests. Never log credentials.
  pool?.on("error", () => { process.stderr.write("PostgreSQL connection unavailable\n"); });

  const application = Fastify({ logger: false });
  application.addHook("onClose", async () => { await pool?.end(); });

  // Unknown routes and unexpected failures share one shape and never leak internals.
  application.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: "not_found" } } satisfies ErrorBody));
  application.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
    const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(status).send({ error: { code: status === 500 ? "internal" : "bad_request" } } satisfies ErrorBody);
  });

  // Liveness is independent of whether a deployment's database is available.
  application.get("/healthz", async () => ({ status: "ok" }));

  // Readiness checks PostgreSQL, and never reports ready for an unconfigured server.
  application.get("/readyz", async (_request, reply) => {
    const unavailable = { error: { code: "database_unavailable" } } satisfies ErrorBody;
    if (pool === undefined) return reply.code(503).send(unavailable);
    try { await pool.query("SELECT 1"); } catch { return reply.code(503).send(unavailable); }
    return { status: "ready" };
  });

  // Advertise only implemented capabilities; business endpoints are not scaffolded as successes.
  application.get("/api/v2/capabilities", async () => ({ api_version: 2, exchange_format_version: EXCHANGE_VERSION, sync: false, enrollment: false }));

  return application;
}
