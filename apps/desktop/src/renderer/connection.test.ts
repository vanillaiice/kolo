import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedServer } from "./connection.ts";

const server = (url: string, lastSuccessAt: string | null, lastError: string | null) => ({ url, lastSuccessAt, lastError });

test("the footer names a server only while its last attempt succeeded", () => {
  assert.equal(connectedServer([]), undefined, "no server: nothing is shown");
  assert.equal(connectedServer([server("https://sync.example.org", null, null)]), undefined, "never reached");
  assert.equal(connectedServer([server("https://sync.example.org", "2026-10-24T10:00:00Z", "unreachable")]), undefined, "last attempt failed");
  assert.equal(connectedServer([server("https://sync.example.org:8443/kolo", "2026-10-24T10:00:00Z", null)]), "sync.example.org:8443");
  assert.equal(connectedServer([server("https://a.example", "2026-10-24T10:00:00Z", "hosted_service_inactive"), server("https://b.example", "2026-10-24T10:00:00Z", null)]), "b.example");
  assert.equal(connectedServer([server("not a url", "2026-10-24T10:00:00Z", null)]), "not a url");
});
