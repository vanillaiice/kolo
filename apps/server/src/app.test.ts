import assert from "node:assert/strict";
import { it } from "node:test";
import { createApplication } from "./app.js";
import { readConfig } from "./config.js";

it("serves liveness, honest capabilities, and unavailable readiness without a database", async () => {
  const application = await createApplication({ host: "127.0.0.1", port: 0, databaseUrl: undefined });
  try {
    await application.listen(0, "127.0.0.1");
    const base = await application.getUrl();
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: "ok" });
    const readiness = await fetch(`${base}/readyz`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), { error: { code: "database_unavailable" } });
    assert.deepEqual(await (await fetch(`${base}/api/v2/capabilities`)).json(), {
      api_version: 2, exchange_format_version: 1, sync: false, enrollment: false,
    });
    assert.equal((await fetch(`${base}/api/v2/sync/push`, { method: "POST" })).status, 404);
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
    await application.listen(0, "127.0.0.1");
    const response = await fetch(`${await application.getUrl()}/readyz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ready" });
  } finally { await application.close(); }
});
