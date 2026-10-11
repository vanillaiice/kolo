import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import { signedJournalEventSchema } from "./events.ts";
import { MAX_ENCRYPTED_FILE_BYTES, signedPairingInviteSchema, signedPairingRequestSchema } from "./transfer.ts";
import { MAX_JOURNAL_BATCH_BYTES, signedPeerReceiptSchema } from "./delivery.ts";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const timestamp = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const name = z.string().min(1).max(120).refine(value => value.trim().length > 0);
const publicKey = z.string().min(1).max(8192).refine(value => value.includes("BEGIN PUBLIC KEY"));
const signature = z.string().regex(/^[a-f0-9]{128}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hex = (length: number) => z.string().regex(new RegExp(`^[a-f0-9]{${length}}$`));
/** Largest base64 ciphertext of one sealed fact: a 1 MiB signed event plus framing, base64-encoded. */
export const MAX_SEALED_CIPHERTEXT = 1_500_000;

/** HTTP sync API version served under `/api/v2`. */
export const SYNC_API_VERSION = 2;
/** Pull page size when the client does not ask for one, and the most a page may hold. */
export const PULL_DEFAULT_LIMIT = 100;
export const PULL_MAX_LIMIT = 1000;

/** Public server identity; clients pin `public_key` only after the owner confirms `fingerprint`. */
export const serverIdentitySchema = z.strictObject({ api_version: z.literal(SYNC_API_VERSION), server_device_id: uuid,
  public_key: publicKey, fingerprint: z.string().regex(/^[a-f0-9]{32}$/), enrollment_open: z.boolean() });

/** A single-use nonce the device signs to enroll its shop or open a network session. */
export const challengeRequestSchema = z.strictObject({ purpose: z.enum(["enrollment", "session"]), business_id: uuid, device_id: uuid });
export const challengeSchema = z.strictObject({ challenge_id: uuid, nonce: z.string().regex(/^[a-f0-9]{64}$/), expires_at: timestamp });

/** What an owner's authority-capable device signs to attach an existing local shop, keeping its IDs. */
export const enrollmentClaimSchema = z.strictObject({ format: z.literal("kolo.server-enrollment"), format_version: z.literal(1),
  challenge_id: uuid, nonce: z.string().regex(/^[a-f0-9]{64}$/), server_device_id: uuid,
  business: z.strictObject({ id: uuid, name }), owner_id: uuid,
  device: z.strictObject({ id: uuid, label: name, platform: z.enum(["ANDROID", "IOS", "DESKTOP"]), public_key: publicKey }) });
/** The single-use connection token travels beside the signed claim; the server stores only its hash. Re-attaching an already attached shop from its enrolling device needs none. */
export const enrollmentRequestSchema = z.strictObject({ claim: enrollmentClaimSchema, signature, connection_code: hex(32).optional() });

/** What a device the shop trusts signs to obtain a short network session; local unlock is unrelated. */
export const sessionClaimSchema = z.strictObject({ format: z.literal("kolo.server-session"), format_version: z.literal(1),
  challenge_id: uuid, nonce: z.string().regex(/^[a-f0-9]{64}$/), server_device_id: uuid, business_id: uuid, device_id: uuid });
export const sessionRequestSchema = z.strictObject({ claim: sessionClaimSchema, signature });
export const sessionSchema = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expires_at: timestamp,
  business_id: uuid, device_id: uuid, server_device_id: uuid });

/**
 * Facts the server stores and reads in the clear: device trust, device encryption keys, sealed shop-key grants
 * and the shop's server address. Every other fact crosses the server sealed with the shop key (ADR-030).
 */
export const CLEAR_EVENT_TYPES = ["DEVICE_TRUSTED", "DEVICE_REVOKED", "DEVICE_ENCRYPTION_KEY", "SHOP_KEY_GRANTED", "SERVER_ENDPOINT_SET", "SERVER_ENDPOINT_CLEARED"] as const;
/** True when a fact of this type may cross the server unsealed. */
export function isClearEventType(type: string): boolean { return (CLEAR_EVENT_TYPES as readonly string[]).includes(type); }

/**
 * A signed fact encrypted with a shop key. The header is what the server sees: identity, origin position, the
 * digest of the inner signed fact (for duplicate detection) and which key sealed it. The header is the
 * AES-GCM additional data, so a changed header fails decryption on the till.
 */
export const sealedEventSchema = z.strictObject({ event_id: uuid, origin_device_id: uuid, origin_sequence: positive, digest: hex(64),
  key_id: uuid, epoch: positive, nonce: hex(24), ciphertext: z.string().min(1).max(MAX_SEALED_CIPHERTEXT).regex(/^[A-Za-z0-9+/]+={0,2}$/), tag: hex(32) });
/** One fact in a server batch: clear only for `CLEAR_EVENT_TYPES`, sealed otherwise. */
export const syncEventSchema = z.union([z.strictObject({ clear: signedJournalEventSchema }), z.strictObject({ sealed: sealedEventSchema })]);
/** Server sync container, signed by its sender (a till on push, the server on pull). */
export const syncBatchSchema = z.strictObject({ format: z.literal("kolo.sync-batch"), format_version: z.literal(1), batch_id: uuid, business_id: uuid,
  sender_device_id: uuid, receiver_device_id: uuid, created_at: timestamp, events: z.array(syncEventSchema).min(1).max(1000) });
export const signedSyncBatchSchema = z.strictObject({ batch: syncBatchSchema, digest: hex(64), signature });

/** Per-event push outcome. `stored` is durable relay storage, never a claim of business application. */
export const pushResultSchema = z.strictObject({ event_id: uuid, status: z.enum(["stored", "duplicate", "rejected"]),
  code: z.enum(["untrusted_device", "invalid_signature", "invalid_event", "event_identity_conflict", "scope_mismatch", "plaintext_refused"]).optional(), retry: z.boolean().optional() });
export const pushResponseSchema = z.strictObject({ results: z.array(pushResultSchema).max(1000), receipt: signedPeerReceiptSchema.nullable() });
export const pullResponseSchema = z.strictObject({ batch: signedSyncBatchSchema.nullable(), cursor: z.string().max(200).nullable(), has_more: z.boolean() });
/** Owner-signed trust facts a device needs before it can authenticate server-signed batches. */
export const bootstrapResponseSchema = z.strictObject({ events: z.array(signedJournalEventSchema).max(1000) });
export const receiptResponseSchema = z.strictObject({ acknowledged: count });
export const syncStatusSchema = z.strictObject({ pending: count, delivered: count, conflicts: count, devices: count });
/**
 * Hosted service eligibility for the session's shop (ADR-031). `unlimited` on self-hosted servers; `grace` after the
 * paid period while sync still runs; `inactive` when sync is paused. Never a condition for local trading.
 */
export const entitlementSchema = z.strictObject({ edition: z.enum(["selfhost", "hosted"]), status: z.enum(["unlimited", "active", "grace", "inactive"]),
  paid_until: timestamp.nullable(), grace_until: timestamp.nullable() });
/** Stable failure body; never contains payloads, credentials or internals. */
export const syncErrorSchema = z.strictObject({ error: z.strictObject({ code: z.string().max(64), retry: z.boolean().optional() }) });

export type ServerIdentity = z.infer<typeof serverIdentitySchema>;
export type ChallengeRequest = z.infer<typeof challengeRequestSchema>;
export type Challenge = z.infer<typeof challengeSchema>;
export type EnrollmentClaim = z.infer<typeof enrollmentClaimSchema>;
export type EnrollmentRequest = z.infer<typeof enrollmentRequestSchema>;
export type SessionClaim = z.infer<typeof sessionClaimSchema>;
export type SessionRequest = z.infer<typeof sessionRequestSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type PushResult = z.infer<typeof pushResultSchema>;
export type PushResponse = z.infer<typeof pushResponseSchema>;
export type PullResponse = z.infer<typeof pullResponseSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type Entitlement = z.infer<typeof entitlementSchema>;
export type SealedEvent = z.infer<typeof sealedEventSchema>;
export type SyncEvent = z.infer<typeof syncEventSchema>;
export type SyncBatch = z.infer<typeof syncBatchSchema>;
export type SignedSyncBatch = z.infer<typeof signedSyncBatchSchema>;

/** Domain-separated UTF-8 bytes signed for enrollment. */
export function enrollmentSigningMessage(claim: EnrollmentClaim): string { return `kolo.server-enrollment.v1\u0000${canonicalJson(enrollmentClaimSchema.parse(claim))}`; }
/** Domain-separated UTF-8 bytes signed for a network session. */
export function sessionSigningMessage(claim: SessionClaim): string { return `kolo.server-session.v1\u0000${canonicalJson(sessionClaimSchema.parse(claim))}`; }
/** Short key fingerprint shown on both the server console and the owner's device before pinning. */
export const KEY_FINGERPRINT_PREFIX = "kolo.pairing-key.v1\u0000";
/** Domain-separated UTF-8 bytes signed for a server sync batch. */
export function syncBatchSigningMessage(batch: SyncBatch): string { return `kolo.sync-batch.v1\u0000${canonicalJson(syncBatchSchema.parse(batch), MAX_JOURNAL_BATCH_BYTES)}`; }
/** AES-GCM additional data binding a sealed fact's visible header to its shop. */
export function sealedEventAad(businessId: string, sealed: Omit<SealedEvent, "nonce" | "ciphertext" | "tag">): string {
  return canonicalJson({ format: "kolo.sealed-event", format_version: 1, business_id: businessId, event_id: sealed.event_id, origin_device_id: sealed.origin_device_id,
    origin_sequence: sealed.origin_sequence, digest: sealed.digest, key_id: sealed.key_id, epoch: sealed.epoch });
}
/** AES-GCM additional data binding a sealed shop key to its shop, key and recipient. */
export function sealedKeyAad(businessId: string, keyId: string, epoch: number, deviceId: string): string {
  return canonicalJson({ format: "kolo.shop-key", format_version: 1, business_id: businessId, key_id: keyId, epoch, device_id: deviceId });
}

/** Everything a till needs to reach a server: its address, pinned fingerprint and, for a first attachment, a single-use token. */
export interface ConnectionCode { readonly url: string; readonly fingerprint: string; readonly token?: string }
const CONNECTION_PATTERN = /kolo:\/\/connect\?[^\s"'<>]+/i;
/** One copyable string (also rendered as a QR code). The token is omitted when sharing the address with the shop's other tills. */
export function formatConnectionCode(code: ConnectionCode): string {
  const query = new URLSearchParams({ u: code.url, f: code.fingerprint, ...(code.token === undefined ? {} : { t: code.token }) });
  return `kolo://connect?${query.toString()}`;
}
/**
 * Finds and checks a connection code inside pasted text. Returns undefined for anything malformed;
 * the address still has to pass the client's own URL policy.
 */
export function parseConnectionCode(text: string): ConnectionCode | undefined {
  if (typeof text !== "string" || text.length > 8192) return undefined;
  const match = CONNECTION_PATTERN.exec(text);
  if (match === null) return undefined;
  const query = new URLSearchParams(match[0].slice(match[0].indexOf("?") + 1));
  const url = query.get("u"), fingerprint = query.get("f")?.toLowerCase(), token = query.get("t")?.toLowerCase();
  if (url === null || url.length < 8 || url.length > 2048 || fingerprint === undefined || !/^[a-f0-9]{32}$/.test(fingerprint)) return undefined;
  if (token !== undefined && !/^[a-f0-9]{32}$/.test(token)) return undefined;
  return token === undefined ? { url, fingerprint } : { url, fingerprint, token };
}

/**
 * Join codes (ADR-032): 10 Crockford base32 characters (50 bits) shown as `XXXX-XXXX-XX` on the owner's till. The
 * server only ever sees `joinIdOf(code)`; both tills derive a MAC key from the code itself.
 */
export const JOIN_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const JOIN_LINK = /kolo:\/\/join\?[^\s"'<>]+/i;
/** Normalizes typed input: case, spaces and dashes are ignored; O→0, I/L→1 as Crockford base32 reads them. */
export function normalizeJoinCode(text: string): string | undefined {
  if (typeof text !== "string" || text.length > 64) return undefined;
  const code = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code) ? code : undefined;
}
/** `K7F2-9QXM-4D`. */
export function formatJoinCode(code: string): string { return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`; }
/** What the QR code carries: the server address and fingerprint, so the new till needs nothing else. */
export function formatJoinLink(input: { readonly url: string; readonly fingerprint: string; readonly code: string }): string {
  return `kolo://join?${new URLSearchParams({ u: input.url, f: input.fingerprint, c: input.code }).toString()}`;
}
/** Reads a scanned or pasted join link. */
export function parseJoinLink(text: string): { readonly url: string; readonly fingerprint: string; readonly code: string } | undefined {
  if (typeof text !== "string" || text.length > 8192) return undefined;
  const match = JOIN_LINK.exec(text);
  if (match === null) return undefined;
  const query = new URLSearchParams(match[0].slice(match[0].indexOf("?") + 1));
  const url = query.get("u"), fingerprint = query.get("f")?.toLowerCase(), code = normalizeJoinCode(query.get("c") ?? "");
  if (url === null || url.length < 8 || url.length > 2048 || fingerprint === undefined || !/^[a-f0-9]{32}$/.test(fingerprint) || code === undefined) return undefined;
  return { url, fingerprint, code };
}

/** A join mailbox as created by the owner: the signed invite, tagged with the code-derived key. */
export const joinOfferSchema = z.strictObject({ join_id: hex(64), invite: signedPairingInviteSchema, mac: hex(64) });
/** The new till's signed request, its X25519 key for the sealed password, both tagged with the code-derived key. */
export const joinRequestSchema = z.strictObject({ request: signedPairingRequestSchema, encryption_public_key: z.string().min(1).max(1024).refine(value => value.includes("BEGIN PUBLIC KEY")), mac: hex(64) });
/** The owner's encrypted shop file and its password sealed to the new till's key. */
/** Joining moves the shop to a phone, so the standard file limit applies (a larger shop pairs by file). */
export const joinEnrollmentSchema = z.strictObject({ enrollment: z.string().min(1).max(MAX_ENCRYPTED_FILE_BYTES),
  sealed_password: z.strictObject({ ephemeral_public_key: z.string().min(1).max(1024), nonce: hex(24), ciphertext: z.string().min(1).max(256), tag: hex(32) }), mac: hex(64) });
export const joinStateSchema = z.strictObject({ state: z.enum(["waiting", "requested", "approved"]), expires_at: timestamp });
export type JoinOffer = z.infer<typeof joinOfferSchema>;
export type JoinRequestBody = z.infer<typeof joinRequestSchema>;
export type JoinEnrollment = z.infer<typeof joinEnrollmentSchema>;
