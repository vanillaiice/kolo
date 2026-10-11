import assert from "node:assert/strict";
import { it } from "node:test";
import { createApplication } from "./app.js";
import { readConfig } from "./config.js";
import { migrateToLatest, openDatabase } from "./database.js";
import { generateServerKey } from "./identity.js";

it("serves liveness, honest capabilities, and unavailable readiness without a database", async () => {
  const application = await createApplication({ host: "127.0.0.1", port: 0, databaseUrl: undefined });
  try {
    const base = await application.listen({ port: 0, host: "127.0.0.1" });
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: "ok" });
    const readiness = await fetch(`${base}/readyz`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), { error: { code: "database_unavailable" } });
    assert.deepEqual(await (await fetch(`${base}/api/v2/capabilities`)).json(), {
      api_version: 2, exchange_format_version: 1, sync: false, enrollment: false,
    });
    const unavailable = await fetch(`${base}/api/v2/sync/status`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: { code: "database_unavailable", retry: true } });
    const missing = await fetch(`${base}/api/v2/sync/unknown`, { method: "POST" });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: { code: "not_found" } });
  } finally { await application.close(); }
});

it("answers malformed requests with the shared error shape and no internals", async () => {
  const application = await createApplication({ host: "127.0.0.1", port: 0, databaseUrl: undefined });
  try {
    application.post("/test/echo", async (request) => request.body);
    application.get("/test/crash", async () => { throw new Error("secret detail"); });
    const malformed = await application.inject({ method: "POST", url: "/test/echo", headers: { "content-type": "application/json" }, payload: "{not json" });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(malformed.json(), { error: { code: "bad_request" } });
    const crash = await application.inject({ method: "GET", url: "/test/crash" });
    assert.equal(crash.statusCode, 500);
    assert.deepEqual(crash.json(), { error: { code: "internal", retry: true } });
  } finally { await application.close(); }
});

it("rejects invalid deployment configuration without echoing credentials", () => {
  for (const port of ["-1", "65536", "8080oops", "2.5"]) assert.throws(() => readConfig({ PORT: port }), /PORT/);
  assert.throws(() => readConfig({ DATABASE_URL: "https://secret@host" }), /^Error: DATABASE_URL must be a PostgreSQL URL$/);
  assert.equal(readConfig({ PORT: "0" }).port, 0);
  assert.equal(readConfig({ HOST: "workstation" }).host, "127.0.0.1");
  assert.equal(readConfig({ KOLO_HOST: "0.0.0.0" }).host, "0.0.0.0");
  assert.equal(readConfig({}).logLevel, "info");
  assert.equal(readConfig({}).publicUrl, "http://127.0.0.1:8080", "loopback servers can issue codes for local tills");
  assert.equal(readConfig({ KOLO_HOST: "0.0.0.0" }).publicUrl, undefined, "a public listener needs an explicit address");
  assert.equal(readConfig({ KOLO_HOST: "0.0.0.0", KOLO_PUBLIC_URL: "https://sync.example.com/" }).publicUrl, "https://sync.example.com");
  for (const bad of ["ftp://host", "https://user:pass@host", "https://host/?a=1", "not a url"]) assert.throws(() => readConfig({ KOLO_PUBLIC_URL: bad }), /KOLO_PUBLIC_URL/, bad);
  assert.deepEqual(readConfig({}).admin, { host: "127.0.0.1", port: 8081, totp: true }, "the dashboard listens on loopback by default");
  assert.equal(readConfig({ KOLO_ADMIN_PORT: "off" }).admin, undefined);
  assert.throws(() => readConfig({ KOLO_ADMIN_PORT: "eighty" }), /KOLO_ADMIN_PORT/);
  assert.equal(readConfig({}).admin?.totp, true, "the second factor is on by default");
  assert.equal(readConfig({ KOLO_ADMIN_TOTP: "off" }).admin?.totp, false);
  assert.throws(() => readConfig({ KOLO_ADMIN_TOTP: "off", KOLO_ADMIN_HOST: "0.0.0.0" }), /loopback/, "never without a second factor beyond this machine");
  assert.throws(() => readConfig({ KOLO_ADMIN_TOTP: "no" }), /KOLO_ADMIN_TOTP/);
  assert.equal(readConfig({ KOLO_LOG_LEVEL: "silent" }).logLevel, "silent");
  assert.throws(() => readConfig({ KOLO_LOG_LEVEL: "verbose" }), /KOLO_LOG_LEVEL/);
});

it("reports ready against real PostgreSQL once migrated", { skip: !process.env["KOLO_TEST_DATABASE_URL"] }, async () => {
  const db = openDatabase(process.env["KOLO_TEST_DATABASE_URL"]!);
  try { await migrateToLatest(db); } finally { await db.destroy(); }
  const application = await createApplication({ host: "127.0.0.1", port: 0, databaseUrl: process.env["KOLO_TEST_DATABASE_URL"] }, { key: generateServerKey().key });
  try {
    const response = await application.inject({ method: "GET", url: "/readyz" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ready" });
  } finally { await application.close(); }
});
