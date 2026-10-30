import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import QRCode from "qrcode";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Kysely } from "kysely";
import type { ServerDatabase } from "../database.js";
import type { ServerKey } from "../identity.js";
import { AdminError, ADMIN_IDLE_MINUTES, STEP_UP_MINUTES, changeOperator, changePassword, confirmSession, createAdmin, generatePassword, listOperators, listSessions, requireConfirmed,
  resetTotp, resolveSession, revokeSessions, signIn, signOut, type AdminSession } from "./accounts.js";
import { billingReport, cancelCode, integrityReport, issueCode, listAudit, listCodes, listShops, overview, recordShopPayment, serverHealth, setShopStatus, setTillLimit, shopDetail,
  type Actor, type AuditQuery, type CodeState, type Metrics, type ShopQuery } from "./operations.js";
import { PAYMENT_METHODS, type Edition, type PaymentMethod } from "../billing.js";
import * as schema from "./schemas.js";

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

/** Who may call a route: anyone (`public`), any signed-in operator, or admins; `stepUp` also needs a recent confirmation. */
type Access = "public" | "any" | "admin";
declare module "fastify" {
  interface FastifyContextConfig { access?: Access; stepUp?: boolean }
  interface FastifyRequest { operator: AdminSession | null }
}

const COOKIE = "kolo_admin";
const TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json" };

function cookieOf(request: FastifyRequest): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return undefined;
}

/** A CSV document; a cell that a spreadsheet would read as a formula is prefixed with a quote. */
function csv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const quote = (value: unknown): string => { const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value); return `"${text.replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1")}"`; };
  return [header.join(","), ...rows.map(row => row.map(quote).join(","))].join("\n");
}

const svg = (text: string): Promise<string> => QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
const integer = (value: string | undefined): number | undefined => value === undefined ? undefined : Number(value);
const instant = (value: string | undefined): Date | undefined => {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AdminError(400, "invalid_request");
  return date;
};

/**
 * The operator dashboard: a JSON API under `/admin/api` and the static dashboard under `/admin/`, served on its own
 * listener so the public sync port never exposes it. Sessions use an HttpOnly, SameSite=Strict cookie; every change
 * also requires a matching `Origin`. Viewers can read only. Every change is audited in its own transaction. Requests
 * are checked against strict schemas after the session is (ADR-045), and the most sensitive changes need a step-up
 * confirmation from the last `STEP_UP_MINUTES`.
 */
export async function createAdminApplication(options: AdminOptions): Promise<FastifyInstance> {
  const { db } = options, now = options.now ?? (() => new Date()), edition: Edition = options.edition ?? { edition: "selfhost", graceDays: 0 }, totp = options.totp ?? true;
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: options.trustProxy ?? false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } });
  app.decorateRequest("operator", null);
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff").header("x-frame-options", "DENY").header("referrer-policy", "no-referrer")
      .header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.url.startsWith("/admin/api")) reply.header("cache-control", "no-store");
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: "not_found" } }));
  app.setErrorHandler((error: { statusCode?: number; validation?: readonly { instancePath: string }[]; validationContext?: string }, _request, reply) => {
    if (error instanceof AdminError) return reply.code(error.status).send({ error: { code: error.code } });
    if (error.validation !== undefined) {
      if (error.validationContext === "params") return reply.code(404).send({ error: { code: "not_found" } });
      const field = /^\/([A-Za-z]+)/.exec(error.validation[0]?.instancePath ?? "")?.[1];
      return reply.code(400).send({ error: { code: error.validationContext === "body" && field !== undefined ? schema.FIELD_CODES[field] ?? "invalid_request" : "invalid_request" } });
    }
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
  // Origin, session, role and step-up are settled before the body is validated, so callers learn nothing first.
  app.addHook("preValidation", async request => {
    if (!request.url.startsWith("/admin/api")) return;
    sameOrigin(request);
    const { access, stepUp } = request.routeOptions.config;
    if (access === undefined || access === "public") return;
    // A background refresh says so and does not count as the operator being there.
    const session = await resolveSession(db, cookieOf(request), now(), request.headers["x-kolo-poll"] !== "1");
    if (access === "admin" && session.admin.role !== "admin") throw new AdminError(403, "read_only");
    if (stepUp === true) requireConfirmed(session, now());
    request.operator = session;
  });
  const operator = (request: FastifyRequest): AdminSession => { if (request.operator === null) throw new AdminError(401, "signed_out"); return request.operator; };
  const actor = (request: FastifyRequest): Actor & { adminId: string } => ({ adminId: operator(request).admin.adminId, username: operator(request).admin.username, address: address(request) });
  const id = (request: FastifyRequest): string => (request.params as { id: string }).id;
  const any = { config: { access: "any" as const } }, admin = { config: { access: "admin" as const } }, confirmed = (access: "any" | "admin") => ({ config: { access, stepUp: true } });
  const me = (session: AdminSession) => ({ username: session.admin.username, role: session.admin.role, idleMinutes: ADMIN_IDLE_MINUTES, expiresAt: session.expiresAt.toISOString(), edition: edition.edition, totp,
    confirmedUntil: session.confirmedAt === null ? null : new Date(session.confirmedAt.getTime() + STEP_UP_MINUTES * 60_000).toISOString() });

  // Sign-in is limited far below other requests (10 a minute by default); lockout covers slower guessing.
  app.post("/admin/api/session", { schema: { body: schema.signInBody }, config: { access: "public", rateLimit: { max: Math.max(1, Math.floor((options.rateLimitMax ?? 300) / 30)), timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = request.body as { username: string; password: string; code?: string };
    const { token, admin: signed } = await signIn(db, { username: input.username, password: input.password, code: input.code ?? "", address: address(request), now: now(), totp });
    reply.header("set-cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${12 * 3600}${request.protocol === "https" ? "; Secure" : ""}`);
    return { username: signed.username, role: signed.role, idleMinutes: ADMIN_IDLE_MINUTES };
  });
  app.delete("/admin/api/session", { config: { access: "public" } }, async (request, reply) => {
    try { const session = await resolveSession(db, cookieOf(request), now()); await signOut(db, cookieOf(request), session.admin, address(request)); } catch (error) { if (!(error instanceof AdminError)) throw error; }
    reply.header("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
    return reply.code(204).send();
  });
  // Step-up: password and a fresh code again, limited like sign-in.
  app.post("/admin/api/session/confirm", { schema: { body: schema.confirmBody }, config: { access: "any", rateLimit: { max: Math.max(1, Math.floor((options.rateLimitMax ?? 300) / 30)), timeWindow: "1 minute" } } }, async request => {
    const input = request.body as { password: string; code?: string }, session = operator(request), at = now();
    await confirmSession(db, session, { password: input.password, code: input.code ?? "", address: address(request), now: at, totp });
    return me({ ...session, confirmedAt: at });
  });
  // What the sign-in form needs to know before anyone signs in.
  app.get("/admin/api/config", { config: { access: "public" } }, async () => ({ totp }));
  app.get("/admin/api/me", any, async request => me(operator(request)));

  app.get("/admin/api/overview", any, async () => {
    const [summary, integrity] = await Promise.all([overview(db, options.metrics, edition, now()), integrityReport(db, now())]);
    const failing = integrity.checks.filter(check => !check.ok);
    return { ...summary, integrity: { ok: integrity.ok, failing: failing.map(check => check.name) },
      attention: [...failing.map(check => ({ kind: "integrity" as const, target: null, label: check.name, at: null, count: check.targets.length })), ...summary.attention] };
  });
  app.get("/admin/api/health", any, async () => serverHealth(db, options.metrics, options.version, now(), edition));
  app.get("/admin/api/integrity", any, async () => integrityReport(db, now()));

  app.get("/admin/api/codes", { ...any, schema: { querystring: schema.codesQuery } }, async request => {
    const query = request.query as { state?: CodeState; offset?: string; limit?: string };
    const page = await listCodes(db, now(), { ...(query.state === undefined ? {} : { state: query.state }), offset: integer(query.offset) ?? 0, limit: integer(query.limit) ?? 50 });
    return { ...page, canIssue: options.publicUrl !== undefined, publicUrl: options.publicUrl ?? null, edition: edition.edition };
  });
  app.post("/admin/api/codes", { ...admin, schema: { body: schema.issueBody } }, async request => {
    if (options.publicUrl === undefined) throw new AdminError(409, "public_url_missing");
    const input = request.body as { label: string; days: number; includedMonths?: number; includedDays?: number; maxTills?: number | null; recoveryShopId?: string };
    const recovery = input.recoveryShopId, hosted = edition.edition === "hosted" && recovery === undefined;
    // An owner-recovery code re-attaches a device to a shop: it needs a recent step-up (ADR-036, ADR-045).
    if (recovery !== undefined) requireConfirmed(operator(request), now());
    // A hosted code names its till limit or says unlimited: nothing picks a commercial default (ADR-039).
    if (hosted && !Object.hasOwn(input, "maxTills")) throw new AdminError(400, "till_limit_required");
    const issued = await issueCode(db, options.key, options.publicUrl, actor(request), { label: input.label, days: input.days, now: now(),
      includedMonths: hosted ? input.includedMonths ?? 0 : 0, includedDays: hosted ? input.includedDays ?? 0 : 0,
      ...(recovery === undefined ? { maxTills: input.maxTills ?? null } : { recoveryShopId: recovery }) });
    return { ...issued, qr: await svg(issued.code) };
  });
  app.post("/admin/api/codes/:id/cancel", { ...admin, schema: { params: schema.idParams } }, async (request, reply) => { await cancelCode(db, actor(request), id(request), now()); return reply.code(204).send(); });

  const shopQuery = (request: FastifyRequest, limit: number): ShopQuery => {
    const { offset, limit: size, ...filters } = request.query as Omit<ShopQuery, "offset" | "limit"> & { offset?: string; limit?: string };
    return { ...filters, offset: integer(offset) ?? 0, limit: Math.min(integer(size) ?? limit, limit) };
  };
  app.get("/admin/api/shops", { ...any, schema: { querystring: schema.shopsQuery } }, async request => ({ ...await listShops(db, shopQuery(request, 500), edition, now()), edition: edition.edition }));
  app.get("/admin/api/shops.csv", { ...any, schema: { querystring: schema.shopsQuery } }, async (request, reply) => {
    const { shops } = await listShops(db, { ...shopQuery(request, 5000), offset: 0, limit: 5000 }, edition, now());
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="kolo-shops.csv"');
    return csv(["shop_id", "name", "status", "tills", "max_tills", "held_tills", "last_seen_at", "facts", "bytes", "service", "paid_until", "enrolled_at", "remove_after"],
      shops.map(shop => [shop.shopId, shop.name, shop.status, shop.devices, shop.maxTills, shop.heldTills, shop.lastSeenAt, shop.facts, shop.bytes, shop.service, shop.paidUntil, shop.enrolledAt, shop.removeAfter]));
  });
  app.get("/admin/api/shops/:id", { ...any, schema: { params: schema.idParams } }, async request => ({ ...await shopDetail(db, id(request), edition, now()), edition: edition.edition }));
  app.post("/admin/api/shops/:id/payments", { ...admin, schema: { params: schema.idParams, body: schema.paymentBody } }, async request => {
    if (edition.edition !== "hosted") throw new AdminError(409, "not_hosted");
    const input = request.body as { months: number; amountMinor: number; method: PaymentMethod; reference?: string; requestId: string };
    if (!PAYMENT_METHODS.includes(input.method)) throw new AdminError(400, "invalid_method");
    return recordShopPayment(db, actor(request), { shopId: id(request), months: input.months, amountMinor: input.amountMinor, method: input.method, requestId: input.requestId,
      ...(input.reference === undefined ? {} : { reference: input.reference }) }, now());
  });
  app.post("/admin/api/shops/:id/till-limit", { ...admin, schema: { params: schema.idParams, body: schema.tillLimitBody } }, async request => {
    const input = request.body as { maxTills: number | null; expected?: number | null };
    return { released: (await setTillLimit(db, actor(request), id(request), input.maxTills, input.expected)).length };
  });
  app.post("/admin/api/shops/:id/:action", { ...admin, schema: { params: schema.actionParams } }, async (request, reply) => {
    const action = (request.params as { action: string }).action;
    if (action !== "suspend" && action !== "resume" && action !== "remove" && action !== "restore") throw new AdminError(404, "not_found");
    if (action === "remove") {
      // Removal names the shop being removed, so a mistyped click cannot remove another one, and needs a step-up.
      const body = request.body;
      if (body === null || typeof body !== "object" || (body as { confirm?: unknown }).confirm !== id(request) || Object.keys(body).length !== 1) throw new AdminError(400, "confirmation_required");
      requireConfirmed(operator(request), now());
    }
    await setShopStatus(db, actor(request), id(request), action, now());
    return reply.code(204).send();
  });

  const auditQuery = (request: FastifyRequest, limit: number): AuditQuery => {
    const query = request.query as { before?: string; action?: string; username?: string; target?: string; from?: string; to?: string; limit?: string };
    const from = instant(query.from), to = instant(query.to);
    return { ...(query.before === undefined ? {} : { before: query.before }), ...(query.action === undefined ? {} : { action: query.action }), ...(query.username === undefined ? {} : { username: query.username }),
      ...(query.target === undefined ? {} : { target: query.target }), ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), limit: Math.min(integer(query.limit) ?? limit, limit) };
  };
  app.get("/admin/api/audit", { ...any, schema: { querystring: schema.auditQuery } }, async request => ({ entries: await listAudit(db, auditQuery(request, 500)) }));
  app.get("/admin/api/audit.csv", { ...any, schema: { querystring: schema.auditQuery } }, async (request, reply) => {
    const rows = await listAudit(db, { ...auditQuery(request, 5000), limit: 5000 });
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="kolo-admin-audit.csv"');
    return csv(["id", "at", "username", "action", "target", "address", "detail"], rows.map(row => [row.id, row.at, row.username, row.action, row.target, row.address, row.detail]));
  });

  const period = (request: FastifyRequest, limit: number) => {
    const query = request.query as { from?: string; to?: string; offset?: string; limit?: string }, to = instant(query.to) ?? now();
    return { from: instant(query.from) ?? new Date(to.getTime() - 30 * 86_400_000), to, offset: integer(query.offset) ?? 0, limit: Math.min(integer(query.limit) ?? limit, limit) };
  };
  app.get("/admin/api/billing", { ...any, schema: { querystring: schema.billingQuery } }, async request => billingReport(db, edition, now(), period(request, 500)));
  app.get("/admin/api/billing.csv", { ...any, schema: { querystring: schema.billingQuery } }, async (request, reply) => {
    const report = await billingReport(db, edition, now(), { ...period(request, 5000), offset: 0, limit: 5000 });
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="kolo-payments.csv"');
    return csv(["payment_id", "recorded_at", "shop_id", "shop", "months", "days", "amount_xaf", "method", "reference", "source", "recorded_by", "paid_until_after"],
      report.payments.map(row => [row.paymentId, row.recordedAt, row.shopId, row.shopName, row.months, row.days, row.amountMinor, row.method, row.reference, row.source, row.recordedBy, row.paidUntilAfter]));
  });

  // The operator's own account.
  app.get("/admin/api/account/sessions", any, async request => ({ sessions: await listSessions(db, operator(request), now()) }));
  app.delete("/admin/api/account/sessions/:id", { ...any, schema: { params: schema.sessionParams } }, async (request, reply) => { await revokeSessions(db, operator(request), id(request), address(request)); return reply.code(204).send(); });
  app.post("/admin/api/account/sessions/sign-out-others", any, async request => ({ ended: await revokeSessions(db, operator(request), "others", address(request)) }));
  app.post("/admin/api/account/password", { ...confirmed("any"), schema: { body: schema.passwordBody } }, async (request, reply) => {
    await changePassword(db, operator(request), (request.body as { password: string }).password, address(request));
    return reply.code(204).send();
  });

  // Other operators (admins, with a step-up for every change).
  app.get("/admin/api/operators", admin, async () => ({ operators: await listOperators(db, now()), totp }));
  app.post("/admin/api/operators", { ...confirmed("admin"), schema: { body: schema.operatorBody } }, async request => {
    const input = request.body as { username: string; role: "admin" | "viewer" }, password = generatePassword();
    const created = await createAdmin(db, { username: input.username, password, role: input.role }, actor(request));
    return { adminId: created.adminId, username: created.username, password, uri: created.uri, qr: await svg(created.uri) };
  });
  app.post("/admin/api/operators/:id/reset-totp", { ...confirmed("admin"), schema: { params: schema.idParams } }, async request => {
    if (id(request) === operator(request).admin.adminId) throw new AdminError(409, "self_change");
    const reset = await resetTotp(db, { adminId: id(request) }, actor(request));
    return { username: reset.username, uri: reset.uri, qr: await svg(reset.uri) };
  });
  app.post("/admin/api/operators/:id/role", { ...confirmed("admin"), schema: { params: schema.idParams, body: schema.roleBody } }, async (request, reply) => {
    await changeOperator(db, actor(request), id(request), { kind: "role", role: (request.body as { role: "admin" | "viewer" }).role });
    return reply.code(204).send();
  });
  app.post("/admin/api/operators/:id/:action", { ...confirmed("admin"), schema: { params: schema.actionParams } }, async (request, reply) => {
    const action = (request.params as { action: string }).action;
    if (action !== "deactivate" && action !== "activate" && action !== "unlock") throw new AdminError(404, "not_found");
    await changeOperator(db, actor(request), id(request), { kind: action });
    return reply.code(204).send();
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
