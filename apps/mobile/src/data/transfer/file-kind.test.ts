import assert from "node:assert/strict";
import { test } from "node:test";
import { transferFileKind } from "./file-kind.ts";

test("transfer files are recognized from their public structure only", () => {
  for (const purpose of ["backup", "enrollment", "exchange", "receipt"] as const)
    assert.equal(transferFileKind(JSON.stringify({ header: { format: "kolo.encrypted", purpose }, payload: "x" })), purpose);
  assert.equal(transferFileKind(JSON.stringify({ invite: { format: "kolo.pairing-invite" }, signature: "s" })), "invite");
  assert.equal(transferFileKind(JSON.stringify({ request: { format: "kolo.pairing-request" } })), "request");
});

test("unknown, malformed and hostile inputs are not recognized", () => {
  for (const text of ["", "not json", "null", "[]", "42", JSON.stringify({ header: { format: "kolo.encrypted", purpose: "other" } }),
    JSON.stringify({ header: { format: "other", purpose: "backup" } }), JSON.stringify({ header: [] }), JSON.stringify({ invite: "kolo.pairing-invite" }),
    JSON.stringify({ __proto__: { header: { format: "kolo.encrypted", purpose: "backup" } } }), JSON.stringify({ request: { format: "kolo.pairing-invite" } })])
    assert.equal(transferFileKind(text), undefined, text);
});
