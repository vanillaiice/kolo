import assert from "node:assert/strict";
import { it } from "node:test";
import { randomBytes } from "node:crypto";
import { formatConnectionCode, isClearEventType, parseConnectionCode, sealedEventSchema, syncBatchSchema } from "./sync.ts";
import { EVENT_PAYLOAD_SCHEMAS } from "./events.ts";

it("connection codes round-trip, are found inside pasted text and refuse anything malformed", () => {
  const code = { url: "https://sync.example.com", fingerprint: "a".repeat(32), token: "b".repeat(32) };
  const text = formatConnectionCode(code);
  assert.match(text, /^kolo:\/\/connect\?/);
  assert.deepEqual(parseConnectionCode(text), code);
  assert.deepEqual(parseConnectionCode(`Your code:\n  ${text}\nValid for 7 days.`), code, "messaging apps add text around it");
  assert.deepEqual(parseConnectionCode(`kolo://connect?u=https%3A%2F%2Fsync.example.com&f=${"A".repeat(32)}&t=${"B".repeat(32)}`), code, "hex is case-insensitive");
  const shared = formatConnectionCode({ url: code.url, fingerprint: code.fingerprint });
  assert.deepEqual(parseConnectionCode(shared), { url: code.url, fingerprint: code.fingerprint }, "a share code has no token");
  for (const bad of ["", "https://sync.example.com", "kolo://connect?u=https%3A%2F%2Fx&f=abc", `kolo://connect?f=${"a".repeat(32)}`, `kolo://connect?u=https%3A%2F%2Fsync.example.com&f=${"g".repeat(32)}`,
    `kolo://connect?u=https%3A%2F%2Fsync.example.com&f=${"a".repeat(32)}&t=short`, "x".repeat(9000)]) assert.equal(parseConnectionCode(bad), undefined, bad.slice(0, 60));
  // Fuzz: random bytes never throw, and anything accepted has the documented shape.
  for (let index = 0; index < 500; index++) {
    const noise = randomBytes(64).toString("latin1"), parsed = parseConnectionCode(`kolo://connect?${noise}`);
    if (parsed !== undefined) { assert.match(parsed.fingerprint, /^[a-f0-9]{32}$/); assert.ok(parsed.token === undefined || /^[a-f0-9]{32}$/.test(parsed.token)); }
  }
});

it("only trust, key and address facts may travel clear, and every one of them has a payload schema", () => {
  for (const type of ["DEVICE_TRUSTED", "DEVICE_REVOKED", "DEVICE_ENCRYPTION_KEY", "SHOP_KEY_GRANTED", "SERVER_ENDPOINT_SET", "SERVER_ENDPOINT_CLEARED"]) {
    assert.ok(isClearEventType(type), type); assert.ok(Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, type), type);
  }
  for (const type of ["SALE_COMPLETED", "PRODUCT_SAVED", "WORKSPACE_CREATED", "MEMBER_CREATED", "CUSTOMER_SAVED", "unknown"]) assert.equal(isClearEventType(type), false, type);
});

it("sealed facts and sync batches are strict about shape and size", () => {
  const sealed = { event_id: "01900000-0000-7000-8000-000000000001", origin_device_id: "01900000-0000-7000-8000-000000000002", origin_sequence: 1, digest: "a".repeat(64),
    key_id: "01900000-0000-7000-8000-000000000003", epoch: 1, nonce: "b".repeat(24), ciphertext: "AAAA", tag: "c".repeat(32) };
  assert.ok(sealedEventSchema.safeParse(sealed).success);
  for (const change of [{ epoch: 0 }, { nonce: "b".repeat(23) }, { ciphertext: "not base64!" }, { ciphertext: "A".repeat(1_500_004) }, { extra: 1 }, { digest: "A".repeat(64) }])
    assert.equal(sealedEventSchema.safeParse({ ...sealed, ...change }).success, false, JSON.stringify(change).slice(0, 40));
  const batch = { format: "kolo.sync-batch", format_version: 1, batch_id: sealed.event_id, business_id: sealed.key_id, sender_device_id: sealed.origin_device_id,
    receiver_device_id: sealed.key_id, created_at: "2026-10-11T06:00:00.000Z", events: [{ sealed }] };
  assert.ok(syncBatchSchema.safeParse(batch).success);
  assert.equal(syncBatchSchema.safeParse({ ...batch, events: [] }).success, false, "an empty batch is never sent");
  assert.equal(syncBatchSchema.safeParse({ ...batch, events: [{ sealed, clear: {} }] }).success, false, "a fact is clear or sealed, never both");
});
