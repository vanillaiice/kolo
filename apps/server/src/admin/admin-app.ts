import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import QRCode from "qrcode";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Kysely } from "kysely";
import type { ServerDatabase } from "../database.js";
import type { ServerKey } from "../identity.js";
import { AdminError, ADMIN_IDLE_MINUTES, sessionAdmin, signIn, signOut, type Admin } from "./accounts.js";
import { cancelCode, issueCode, listAudit, listCodes, listShops, recordShopPayment, serverHealth, setShopStatus, shopDetail, type Actor, type Metrics } from "./operations.js";
import { PAYMENT_METHODS, type Edition, type PaymentMethod } from "../billing.js";

/** Everything the operator dashboard needs; it shares the sync server's database, identity and counters. */
export interface AdminOptions {
  readonly db: Kysely<ServerDatabase>;
  readonly key: ServerKey;
  /** Address printed into connection codes; codes cannot be issued without it. */
  readonly publicUrl: string | undefined;
  readonly metrics: Metrics;
  readonly version: string;
  /** Built dashboard files (`apps/admin/dist`); the API works without them. */
  readonly uiDir: string | undefined;
  readonly trustProxy?: boolean;
  readonly rateLimitMax?: number;
  readonly now?: () => Date;
  /** Self-hosted by default; hosted shows paid-until dates and payments (ADR-031). */
  readonly edition?: Edition;
  /** False only when the operator turned the second factor off for a loopback-only dashboard. */
  readonly totp?: boolean;
}

const COOKIE = "kolo_admin";
const TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json" };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cookieOf(request: FastifyRequest): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return undefined;
}

/**
 * The operator dashboard: a JSON API under `/admin/api` and the static dashboard under `/admin/`, served on its own
 * listener so the public sync port never exposes it. Sessions use an HttpOnly, SameSite=Strict cookie; every change
 * also requires a matching `Origin`. Viewers can read only. Every change is audited in its own transaction.
 */
export async function createAdminApplication(options: AdminOptions): Promise<FastifyInstance> {
  const { db } = options, now = options.now ?? (() => new Date()), edition: Edition = options.edition ?? { edition: "selfhost", graceDays: 0 };
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: options.trustProxy ?? false });
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff").header("x-frame-options", "DENY").header("referrer-policy", "no-referrer")
      .header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.url.startsWith("/admin/api")) reply.header("cache-control", "no-store");
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: "not_found" } }));
  app.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
    if (error instanceof AdminError) return reply.code(error.status).send({ error: { code: error.code } });
    const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(status).send({ error: { code: status === 429 ? "rate_limited" : status === 500 ? "internal" : "bad_request" } });
  });
  await app.register(rateLimit, { max: options.rateLimitMax ?? 300, timeWindow: "1 minute", errorResponseBuilder: () => ({ statusCode: 429, error: { code: "rate_limited" } }) });

  const address = (request: FastifyRequest): string => request.ip.slice(0, 64);
  // Browsers always send Origin on state-changing requests; a missing or foreign one is refused.
  const sameOrigin = (request: FastifyRequest): void => {
    if (request.method === "GET" || request.method === "HEAD") return;
    if (request.headers.origin !== `${request.protocol}://${request.headers.host}`) throw new AdminError(403, "bad_origin");
  };
  async function signedIn(request: FastifyRequest, role?: "admin"): Promise<{ admin: Admin; actor: Actor }> {
    sameOrigin(request);
    const admin = await sessionAdmin(db, cookieOf(request), now());
    if (role === "admin" && admin.role !== "admin") throw new AdminError(403, "read_only");
    return { admin, actor: { adminId: admin.adminId, username: admin.username, address: address(request) } };
  }
  const body = (request: FastifyRequest): Record<string, unknown> => (request.body !== null && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
  const idParam = (request: FastifyRequest): string => { const id = (request.params as { id?: string }).id ?? ""; if (!ID.test(id)) throw new AdminError(404, "not_found"); return id; };

  // Sign-in is limited far below other requests (10 a minute by default); lockout covers slower guessing.
  app.post("/admin/api/session", { config: { rateLimit: { max: Math.max(1, Math.floor((options.rateLimitMax ?? 300) / 30)), timeWindow: "1 minute" } } }, async (request, reply) => {
    sameOrigin(request);
    const input = body(request);
    const { token, admin } = await signIn(db, { username: String(input["username"] ?? ""), password: String(input["password"] ?? ""), code: String(input["code"] ?? ""), address: address(request), now: now(), totp: options.totp ?? true });
    reply.header("set-cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${12 * 3600}${request.protocol === "https" ? "; Secure" : ""}`);
    return { username: admin.username, role: admin.role, idleMinutes: ADMIN_IDLE_MINUTES };
  });
  app.delete("/admin/api/session", async (request, reply) => {
    sameOrigin(request);
    try { const { admin } = await signedIn(request); await signOut(db, cookieOf(request), admin, address(request)); } catch (error) { if (!(error instanceof AdminError)) throw error; }
    reply.header("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
    return reply.code(204).send();
  });
  // What the sign-in form needs to know before anyone signs in.
  app.get("/admin/api/config", async () => ({ totp: options.totp ?? true }));
  app.get("/admin/api/me", async request => { const { admin } = await signedIn(request); return { username: admin.username, role: admin.role, idleMinutes: ADMIN_IDLE_MINUTES }; });
  app.get("/admin/api/health", async request => { await signedIn(request); return serverHealth(db, options.metrics, options.version, now(), edition); });

  app.get("/admin/api/codes", async request => { await signedIn(request); return { codes: await listCodes(db, now()), canIssue: options.publicUrl !== undefined, publicUrl: options.publicUrl ?? null }; });
  app.post("/admin/api/codes", async request => {
    const { actor } = await signedIn(request, "admin");
    if (options.publicUrl === undefined) throw new AdminError(409, "public_url_missing");
    const input = body(request), issued = await issueCode(db, options.key, options.publicUrl, actor, { label: String(input["label"] ?? ""), days: Number(input["days"] ?? 7), now: now(),
      includedMonths: edition.edition === "hosted" ? Number(input["includedMonths"] ?? 0) : 0 });
    return { ...issued, qr: await QRCode.toString(issued.code, { type: "svg", errorCorrectionLevel: "M", margin: 1 }) };
  });
  app.post("/admin/api/codes/:id/cancel", async (request, reply) => { const { actor } = await signedIn(request, "admin"); await cancelCode(db, actor, idParam(request), now()); return reply.code(204).send(); });

  app.get("/admin/api/shops", async request => { await signedIn(request); return { shops: await listShops(db, String((request.query as { search?: unknown }).search ?? ""), 200, edition, now()), edition: edition.edition }; });
  app.get("/admin/api/shops/:id", async request => { await signedIn(request); return { ...await shopDetail(db, idParam(request), edition, now()), edition: edition.edition }; });
  app.post("/admin/api/shops/:id/payments", async request => {
    const { actor } = await signedIn(request, "admin");
    if (edition.edition !== "hosted") throw new AdminError(409, "not_hosted");
    const input = body(request), method = String(input["method"] ?? "") as PaymentMethod;
    if (!PAYMENT_METHODS.includes(method)) throw new AdminError(400, "invalid_method");
    const reference = typeof input["reference"] === "string" ? input["reference"] : undefined;
    return recordShopPayment(db, actor, { shopId: idParam(request), months: Number(input["months"]), amountMinor: Number(input["amountMinor"]), method, ...(reference === undefined ? {} : { reference }) }, now());
  });
  app.post("/admin/api/shops/:id/:action", async (request, reply) => {
    const { actor } = await signedIn(request, "admin"), action = (request.params as { action?: string }).action;
    if (action !== "suspend" && action !== "resume" && action !== "remove" && action !== "restore") throw new AdminError(404, "not_found");
    // Removal names the shop being removed, so a mistyped click cannot remove another one.
    if (action === "remove" && body(request)["confirm"] !== idParam(request)) throw new AdminError(400, "confirmation_required");
    await setShopStatus(db, actor, idParam(request), action, now());
    return reply.code(204).send();
  });

  app.get("/admin/api/audit", async request => { await signedIn(request); const before = (request.query as { before?: unknown }).before; return { entries: await listAudit(db, typeof before === "string" ? before : undefined) }; });
  app.get("/admin/api/audit.csv", async (request, reply) => {
    await signedIn(request);
    const quote = (value: unknown): string => { const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value); return `"${text.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`; };
    const rows = await listAudit(db, undefined, 500);
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="kolo-admin-audit.csv"');
    return ["id,at,username,action,target,address,detail", ...rows.map(row => [row.id, row.at, row.username, row.action, row.target, row.address, row.detail].map(quote).join(","))].join("\n");
  });

  // The dashboard: static files under /admin/, with index.html for client-side routes.
  const root = options.uiDir === undefined ? undefined : resolve(options.uiDir);
  async function serve(reply: FastifyReply, path: string): Promise<FastifyReply> {
    if (root === undefined) return reply.code(404).type("text/plain").send("The admin dashboard is not built. Run: npm run build -w @kolo/admin");
    const target = resolve(join(root, path));
    if (target !== root && !target.startsWith(root + sep)) return reply.code(404).send({ error: { code: "not_found" } });
    try {
      const real = await realpath(target);
      if (!real.startsWith(await realpath(root) + sep)) throw new Error("outside");
      const type = TYPES[extname(real)];
      if (type === undefined) throw new Error("type");
      reply.header("cache-control", path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      return reply.type(type).send(await readFile(real));
    } catch {
      if (extname(path) !== "") return reply.code(404).send({ error: { code: "not_found" } });
      return serve(reply, "index.html");
    }
  }
  app.get("/", async (_request, reply) => reply.redirect("/admin/"));
  app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));
  app.get("/admin/", async (_request, reply) => serve(reply, "index.html"));
  app.get("/admin/*", async (request, reply) => {
    const path = (request.params as { "*": string })["*"];
    if (path.startsWith("api/")) return reply.code(404).send({ error: { code: "not_found" } });
    return serve(reply, path);
  });
  return app;
}
