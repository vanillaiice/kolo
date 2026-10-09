/**
 * Exchange-format foundation. Parsing proves envelope shape and tenant identity;
 * it does not establish trust, authorize an actor, or validate a business payload.
 * Importers must perform those checks before applying an event.
 */
import { z } from "zod";

export const EXCHANGE_FORMAT = "kolo.exchange";
export const EXCHANGE_VERSION = 1;
export const MAX_BUNDLE_EVENTS = 1000;
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** Origin identity survives forwarding; server cursors are not event identity. */
export const eventEnvelopeSchema = z.strictObject({
  event_id: z.uuid(),
  business_id: z.uuid(),
  origin_device_id: z.uuid(),
  actor_id: z.uuid(),
  origin_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  event_type: z.string().min(1).max(80),
  event_version: z.literal(1),
  occurred_at: z.iso.datetime(),
  payload: z.record(z.string(), z.json()),
});

/** Legacy unsigned structural codec; conveys no authority. Use signed delivery and encrypted transfer formats for configured workspaces. */
export const exchangeBundleSchema = z.strictObject({
  format: z.literal(EXCHANGE_FORMAT),
  format_version: z.literal(EXCHANGE_VERSION),
  bundle_id: z.uuid(),
  business_id: z.uuid(),
  sender_device_id: z.uuid(),
  created_at: z.iso.datetime(),
  events: z.array(eventEnvelopeSchema).max(MAX_BUNDLE_EVENTS),
}).superRefine((bundle, context) => {
  const identifiers = new Set<string>();
  const positions = new Set<string>();
  for (const [index, event] of bundle.events.entries()) {
    if (event.business_id !== bundle.business_id) {
      context.addIssue({ code: "custom", path: ["events", index, "business_id"], message: "event belongs to another shop" });
    }
    const position = `${event.origin_device_id}:${event.origin_sequence}`;
    if (identifiers.has(event.event_id) || positions.has(position)) {
      context.addIssue({ code: "custom", path: ["events", index], message: "duplicate event identity or origin position" });
    }
    identifiers.add(event.event_id);
    positions.add(position);
  }
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type ExchangeBundle = z.infer<typeof exchangeBundleSchema>;
export type ContractProblem = "invalid_bundle" | "unsupported_version" | "another_business" | "too_large";

/** Stable boundary error. Messages contain no payloads, credentials, or customer data. */
export class ContractError extends Error {
  readonly code: ContractProblem;

  constructor(code: ContractProblem) {
    super(code);
    this.name = "ContractError";
    this.code = code;
  }
}

/** Validate an untrusted decoded bundle against the receiving installation's shop. */
export function parseExchangeBundle(input: unknown, expectedBusinessId: string): ExchangeBundle {
  if (typeof input === "object" && input !== null && "format_version" in input && input.format_version !== EXCHANGE_VERSION) {
    throw new ContractError("unsupported_version");
  }
  const result = exchangeBundleSchema.safeParse(input);
  if (!result.success) throw new ContractError("invalid_bundle");
  if (result.data.business_id !== expectedBusinessId) throw new ContractError("another_business");
  return result.data;
}

/** Decode bounded UTF-8 JSON. Native file readers must also bound bytes before loading. */
export function decodeExchangeBundle(source: string, expectedBusinessId: string): ExchangeBundle {
  // UTF-8 has at least one byte per UTF-16 code unit for valid JSON strings.
  if (source.length > MAX_BUNDLE_BYTES || utf8Bytes(source) > MAX_BUNDLE_BYTES) throw new ContractError("too_large");
  let decoded: unknown;
  try { decoded = JSON.parse(source); } catch { throw new ContractError("invalid_bundle"); }
  return parseExchangeBundle(decoded, expectedBusinessId);
}

/** Encode a structurally validated bundle. This does not sign it or acknowledge delivery. */
export function encodeExchangeBundle(bundle: ExchangeBundle): string {
  const validated = parseExchangeBundle(bundle, bundle.business_id);
  const encoded = JSON.stringify(validated);
  if (utf8Bytes(encoded) > MAX_BUNDLE_BYTES) throw new ContractError("too_large");
  return encoded;
}

// Avoid Buffer and platform-specific encoding globals in React Native.
function utf8Bytes(source: string): number {
  let count = 0;
  for (const character of source) {
    const point = character.codePointAt(0)!;
    count += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return count;
}
