/** Validated deployment configuration; importing this module has no side effects. */
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string | undefined;
  /**
   * The address tills use to reach this server, printed into connection codes (`KOLO_PUBLIC_URL`). Defaults to
   * `http://127.0.0.1:<port>` when listening on loopback; required to issue codes otherwise.
   */
  readonly publicUrl?: string | undefined;
  /**
   * The operator dashboard listener (`KOLO_ADMIN_HOST`, `KOLO_ADMIN_PORT`); loopback by default, `off` disables it.
   * `totp` is false only with `KOLO_ADMIN_TOTP=off`, which is refused unless the dashboard listens on loopback.
   */
  readonly admin?: { readonly host: string; readonly port: number; readonly totp?: boolean } | undefined;
  /** Built dashboard files (`KOLO_ADMIN_UI_DIR`). */
  readonly adminUiDir?: string | undefined;
  /** `selfhost` (default): shops never expire. `hosted`: each shop syncs while paid, plus a grace period (ADR-031). */
  readonly edition?: "selfhost" | "hosted";
  /** Days after the paid period during which a hosted shop still syncs (`KOLO_GRACE_DAYS`, default 7). */
  readonly graceDays?: number;
  /** Shared secret for signed payment webhooks (`KOLO_BILLING_WEBHOOK_SECRET`); the endpoint is off without it. */
  readonly billingWebhookSecret?: string | undefined;
  /** Where the server's Ed25519 identity is kept; created on first start. */
  readonly keyFile?: string;
  /** Network session lifetime; local trading never depends on it. */
  readonly sessionTtlSeconds?: number;
  /** Honour `X-Forwarded-For` from a reverse proxy for rate limiting. */
  readonly trustProxy?: boolean;
  /** Request log level; `silent` turns request logging off. Request bodies and headers are never logged. */
  readonly logLevel?: LogLevel;
}

/** Log levels accepted by `KOLO_LOG_LEVEL`. */
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
const logLevels: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

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
  const rawTtl = environment["KOLO_SESSION_TTL_SECONDS"] ?? "3600";
  if (!/^\d+$/.test(rawTtl) || Number(rawTtl) < 60 || Number(rawTtl) > 86_400) throw new Error("KOLO_SESSION_TTL_SECONDS must be between 60 and 86400");
  const trustProxy = environment["KOLO_TRUST_PROXY"] ?? "false";
  if (!["true", "false"].includes(trustProxy)) throw new Error("KOLO_TRUST_PROXY must be true or false");
  const logLevel = environment["KOLO_LOG_LEVEL"] || "info";
  if (!logLevels.includes(logLevel as LogLevel)) throw new Error(`KOLO_LOG_LEVEL must be one of ${logLevels.join(", ")}`);
  const host = environment["KOLO_HOST"] || "127.0.0.1";
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  const publicUrl = publicAddress(environment["KOLO_PUBLIC_URL"]) ?? (loopback ? `http://127.0.0.1:${port}` : undefined);
  const rawAdminPort = environment["KOLO_ADMIN_PORT"] ?? "8081";
  if (rawAdminPort !== "off" && (!/^\d+$/.test(rawAdminPort) || Number(rawAdminPort) > 65535)) throw new Error("KOLO_ADMIN_PORT must be an integer between 0 and 65535, or off");
  const adminHost = environment["KOLO_ADMIN_HOST"] || "127.0.0.1", rawTotp = environment["KOLO_ADMIN_TOTP"] ?? "on";
  if (rawTotp !== "on" && rawTotp !== "off") throw new Error("KOLO_ADMIN_TOTP must be on or off");
  // Without a second factor the dashboard must stay unreachable from other machines.
  if (rawTotp === "off" && !["127.0.0.1", "localhost", "::1"].includes(adminHost)) throw new Error("KOLO_ADMIN_TOTP=off is only allowed when KOLO_ADMIN_HOST is a loopback address");
  const admin = rawAdminPort === "off" ? undefined : { host: adminHost, port: Number(rawAdminPort), totp: rawTotp === "on" };
  const edition = environment["KOLO_EDITION"] || "selfhost";
  if (edition !== "selfhost" && edition !== "hosted") throw new Error("KOLO_EDITION must be selfhost or hosted");
  const rawGrace = environment["KOLO_GRACE_DAYS"] ?? "7";
  if (!/^\d{1,3}$/.test(rawGrace) || Number(rawGrace) > 90) throw new Error("KOLO_GRACE_DAYS must be between 0 and 90");
  const billingWebhookSecret = environment["KOLO_BILLING_WEBHOOK_SECRET"] || undefined;
  if (billingWebhookSecret !== undefined && billingWebhookSecret.length < 32) throw new Error("KOLO_BILLING_WEBHOOK_SECRET must contain at least 32 characters");
  return { host, port, databaseUrl, publicUrl, admin, adminUiDir: environment["KOLO_ADMIN_UI_DIR"] || undefined, edition, graceDays: Number(rawGrace), billingWebhookSecret,
    keyFile: environment["KOLO_SERVER_KEY_FILE"] || ".kolo-server-key.json", sessionTtlSeconds: Number(rawTtl), trustProxy: trustProxy === "true", logLevel: logLevel as LogLevel };
}

/** Accepts a bare http(s) origin with an optional path; anything carrying credentials, a query or a fragment is refused. */
function publicAddress(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("KOLO_PUBLIC_URL must be an http or https address"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("KOLO_PUBLIC_URL must be an http or https address");
  return url.toString().replace(/\/+$/, "");
}
