import assert from "node:assert/strict";
import { it } from "node:test";
import { createApplication } from "./app.js";
import { readConfig } from "./config.js";

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
    const missing = await fetch(`${base}/api/v2/sync/push`, { method: "POST" });
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
    assert.deepEqual(crash.json(), { error: { code: "internal" } });
  } finally { await application.close(); }
});

it("rejects invalid deployment configuration without echoing credentials", () => {
  for (const port of ["-1", "65536", "8080oops", "2.5"]) assert.throws(() => readConfig({ PORT: port }), /PORT/);
  assert.throws(() => readConfig({ DATABASE_URL: "https://secret@host" }), /^Error: DATABASE_URL must be a PostgreSQL URL$/);
  assert.equal(readConfig({ PORT: "0" }).port, 0);
});

it("reports ready against real PostgreSQL", { skip: !process.env["KOLO_TEST_DATABASE_URL"] }, async () => {
  const application = await createApplication({ host: "127.0.0.1", port: 0, databaseUrl: process.env["KOLO_TEST_DATABASE_URL"] });
  try {
    const response = await application.inject({ method: "GET", url: "/readyz" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ready" });
  } finally { await application.close(); }
});
