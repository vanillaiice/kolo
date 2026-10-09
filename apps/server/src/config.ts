/** Validated deployment configuration; importing this module has no side effects. */
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string | undefined;
}

/** Refuse invalid ports and non-PostgreSQL URLs before starting a listener. */
export function readConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawPort = environment["PORT"] ?? "8080";
  if (!/^\d+$/.test(rawPort)) throw new Error("PORT must be an integer between 0 and 65535");
  const port = Number(rawPort);
  if (port > 65535) throw new Error("PORT must be an integer between 0 and 65535");
  const databaseUrl = environment["DATABASE_URL"] || undefined;
  if (databaseUrl !== undefined) {
    let parsed: URL;
    try { parsed = new URL(databaseUrl); } catch { throw new Error("DATABASE_URL must be a PostgreSQL URL"); }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  return { host: environment["HOST"] || "127.0.0.1", port, databaseUrl };
}
