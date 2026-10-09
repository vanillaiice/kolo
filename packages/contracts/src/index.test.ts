import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ContractError, decodeExchangeBundle, encodeExchangeBundle, MAX_BUNDLE_BYTES, parseExchangeBundle, type ExchangeBundle } from "./index.ts";

const SHOP = "11111111-1111-7111-8111-111111111111";
const DEVICE = "22222222-2222-7222-8222-222222222222";
const OTHER = "33333333-3333-7333-8333-333333333333";
function bundle(): ExchangeBundle {
  return {
    format: "kolo.exchange", format_version: 1, bundle_id: OTHER, business_id: SHOP,
    sender_device_id: DEVICE, created_at: "2026-10-05T10:00:00.000Z",
    events: [{ event_id: OTHER, business_id: SHOP, origin_device_id: DEVICE, actor_id: OTHER,
      origin_sequence: 1, event_type: "PRODUCT_SAVED", event_version: 1,
      occurred_at: "2026-10-04T10:00:00.000Z", payload: { name: "Riz" } }],
  };
}
function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ContractError && error.code === code;
}
describe("exchange envelopes", () => {
  it("round-trips while preserving the original device when another device forwards", () => {
    const value = bundle(); value.sender_device_id = OTHER;
    assert.deepEqual(decodeExchangeBundle(encodeExchangeBundle(value), SHOP), value);
  });
  it("rejects mixed tenants and importing into a different shop", () => {
    assert.throws(() => parseExchangeBundle(bundle(), OTHER), hasCode("another_business"));
    const value = bundle(); value.events[0]!.business_id = OTHER;
    assert.throws(() => parseExchangeBundle(value, SHOP), hasCode("invalid_bundle"));
  });
  it("rejects duplicate IDs and reused origin positions", () => {
    const value = bundle(); value.events.push({ ...value.events[0]! });
    assert.throws(() => parseExchangeBundle(value, SHOP), hasCode("invalid_bundle"));
    value.events[1]!.event_id = SHOP;
    assert.throws(() => parseExchangeBundle(value, SHOP), hasCode("invalid_bundle"));
  });
  it("fails closed on future versions, unsafe sequences, and unknown fields", () => {
    assert.throws(() => parseExchangeBundle({ ...bundle(), format_version: 2 }, SHOP), hasCode("unsupported_version"));
    assert.throws(() => parseExchangeBundle({ ...bundle(), secret: "private" }, SHOP), hasCode("invalid_bundle"));
    const value = bundle(); value.events[0]!.origin_sequence = Number.MAX_SAFE_INTEGER + 1;
    assert.throws(() => parseExchangeBundle(value, SHOP), hasCode("invalid_bundle"));
  });
  it("bounds actual UTF-8 size, handles invalid JSON, and keeps error text free of payloads", () => {
    assert.throws(() => decodeExchangeBundle("private-invalid-json", SHOP), hasCode("invalid_bundle"));
    const value = bundle(); value.events[0]!.payload = { name: "é".repeat(MAX_BUNDLE_BYTES / 2) };
    assert.throws(() => encodeExchangeBundle(value), hasCode("too_large"));
    assert.throws(() => decodeExchangeBundle(JSON.stringify(value), SHOP), hasCode("too_large"));
  });
});
