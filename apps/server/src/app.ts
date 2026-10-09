import "reflect-metadata";
import { Controller, Get, Module, ServiceUnavailableException, type INestApplication, type OnApplicationShutdown } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { EXCHANGE_VERSION } from "@kolo/contracts";
import type { ServerConfig } from "./config.js";

/** Build the app without listening, so HTTP behavior can be tested on an ephemeral port. */
export async function createApplication(config: ServerConfig): Promise<INestApplication> {
  const pool = config.databaseUrl === undefined ? undefined : new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 2000, max: 5 });
  // An idle PostgreSQL connection can fail between requests. Never log credentials.
  pool?.on("error", () => { process.stderr.write("PostgreSQL connection unavailable\n"); });

  @Controller()
  class HealthController implements OnApplicationShutdown {
    /** Liveness is independent of whether a deployment's database is available. */
    @Get("healthz")
    health(): { status: string } { return { status: "ok" }; }

    /** Readiness checks PostgreSQL, and never reports ready for an unconfigured server. */
    @Get("readyz")
    async ready(): Promise<{ status: string }> {
      if (pool === undefined) throw new ServiceUnavailableException({ error: { code: "database_unavailable" } });
      try { await pool.query("SELECT 1"); } catch { throw new ServiceUnavailableException({ error: { code: "database_unavailable" } }); }
      return { status: "ready" };
    }

    /** Advertise only implemented capabilities; business endpoints are not scaffolded as successes. */
    @Get("api/v2/capabilities")
    capabilities(): object {
      return { api_version: 2, exchange_format_version: EXCHANGE_VERSION, sync: false, enrollment: false };
    }

    async onApplicationShutdown(): Promise<void> { await pool?.end(); }
  }

  @Module({ controllers: [HealthController] })
  class AppModule {}

  const application = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  application.enableShutdownHooks();
  return application;
}
