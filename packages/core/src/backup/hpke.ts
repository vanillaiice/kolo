import { TransferError } from "./types.ts";

/**
 * RFC 9180 HPKE, base mode, single-shot, for DHKEM(X25519, HKDF-SHA256) with HKDF-SHA256 and
 * AES-256-GCM (KEM 0x0020, KDF 0x0001, AEAD 0x0002), built only from native primitives (ADR-035).
 * Key derivation is generic over the AEAD key length so the RFC's AES-128-GCM vectors also check it.
 */
export interface HpkePrimitives {
  /** HMAC-SHA256 over raw bytes. */
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  /** X25519 shared secret of a raw 32-byte private key and a raw 32-byte public key. */
  x25519(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** Random bytes as lowercase hex. */
  randomHex(bytes: number): string;
  /** AES-256-GCM; returns ciphertext followed by the 16-byte tag. */
  sealBytes(keyHex: string, nonceHex: string, bytes: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  /** Opens `ciphertext ‖ tag`; plaintext only after the tag authenticates. */
  openBytes(keyHex: string, nonceHex: string, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}

/** DER prefixes that wrap a raw 32-byte X25519 key for native key import (PKCS #8 private, SPKI public). */
export const X25519_PKCS8_PREFIX: readonly number[] = Object.freeze([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
/** DER prefix of an X25519 SubjectPublicKeyInfo. */
export const X25519_SPKI_PREFIX: readonly number[] = Object.freeze([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);

const AEAD_AES_256_GCM = 0x0002, NH = 32, NN = 12;

function ascii(text: string): Uint8Array { const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }
function i2osp(value: number, length: number): Uint8Array { const bytes = new Uint8Array(length); for (let i = length - 1, v = value; i >= 0; i--, v = Math.floor(v / 256)) bytes[i] = v % 256; return bytes; }
function concat(...parts: readonly Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; }
function hex(bytes: Uint8Array): string { let text = ""; for (const byte of bytes) text += byte.toString(16).padStart(2, "0"); return text; }

const KEM_SUITE = concat(ascii("KEM"), i2osp(0x0020, 2));
/** The X25519 base point (u = 9): a public key is X25519(private key, base point), so only the native agreement is needed. */
const BASE_POINT = (() => { const point = new Uint8Array(32); point[0] = 9; return point; })();
/** Raw X25519 public key of a raw private key. */
export function x25519PublicKey(privateKey: Uint8Array, p: Pick<HpkePrimitives, "x25519">): Uint8Array { return agree(p, privateKey, BASE_POINT); }
const hpkeSuite = (aead: number): Uint8Array => concat(ascii("HPKE"), i2osp(0x0020, 2), i2osp(0x0001, 2), i2osp(aead, 2));

function extract(p: HpkePrimitives, salt: Uint8Array, ikm: Uint8Array): Uint8Array { return p.hmacSha256(salt.length === 0 ? new Uint8Array(NH) : salt, ikm); }
function expand(p: HpkePrimitives, prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  if (length > 255 * NH) throw new TransferError("invalid_file");
  const out = new Uint8Array(length);
  for (let block: Uint8Array = new Uint8Array(0), i = 1, at = 0; at < length; i++) { block = p.hmacSha256(prk, concat(block, info, new Uint8Array([i]))); out.set(block.subarray(0, Math.min(NH, length - at)), at); at += NH; }
  return out;
}
function labeledExtract(p: HpkePrimitives, suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(p, salt, concat(ascii("HPKE-v1"), suite, ascii(label), ikm));
}
function labeledExpand(p: HpkePrimitives, suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array {
  return expand(p, prk, concat(i2osp(length, 2), ascii("HPKE-v1"), suite, ascii(label), info), length);
}

/** RFC 9180 §7.1.3 DeriveKeyPair for X25519: a deterministic key pair from at least 32 bytes of input keying material. */
export function deriveKeyPair(ikm: Uint8Array, p: HpkePrimitives): { readonly privateKey: Uint8Array; readonly publicKey: Uint8Array } {
  if (ikm.length < 32) throw new TransferError("invalid_file");
  const privateKey = labeledExpand(p, KEM_SUITE, labeledExtract(p, KEM_SUITE, new Uint8Array(0), "dkp_prk", ikm), "sk", new Uint8Array(0), 32);
  return { privateKey, publicKey: x25519PublicKey(privateKey, p) };
}

/** Native agreement; OpenSSL already refuses small-order points, and any native failure becomes a stable code. */
function agree(p: Pick<HpkePrimitives, "x25519">, privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  let dh: Uint8Array;
  try { dh = p.x25519(privateKey, publicKey); } catch { throw new TransferError("authentication_failed"); }
  // RFC 9180 §7.1.4: an all-zero X25519 output (a small-order public key) aborts, whatever the native layer did.
  if (dh.length !== 32 || dh.every(byte => byte === 0)) throw new TransferError("authentication_failed");
  return dh;
}

function sharedSecret(p: HpkePrimitives, dh: Uint8Array, enc: Uint8Array, recipient: Uint8Array): Uint8Array {
  const prk = labeledExtract(p, KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(p, KEM_SUITE, prk, "shared_secret", concat(enc, recipient), NH);
}

/** @internal Encap with a chosen ephemeral input (test vectors); production uses fresh randomness. */
export function encapsulate(recipient: Uint8Array, p: HpkePrimitives, ephemeralIkm?: Uint8Array): { readonly sharedSecret: Uint8Array; readonly enc: Uint8Array } {
  if (recipient.length !== 32) throw new TransferError("invalid_file");
  const ephemeral = deriveKeyPair(ephemeralIkm ?? hexBytes(p.randomHex(32)), p);
  try { return { sharedSecret: sharedSecret(p, agree(p, ephemeral.privateKey, recipient), ephemeral.publicKey, recipient), enc: ephemeral.publicKey }; }
  finally { ephemeral.privateKey.fill(0); }
}

/** @internal Decap with the recipient's raw private key. */
export function decapsulate(enc: Uint8Array, privateKey: Uint8Array, p: HpkePrimitives): Uint8Array {
  if (enc.length !== 32 || privateKey.length !== 32) throw new TransferError("authentication_failed");
  return sharedSecret(p, agree(p, privateKey, enc), enc, x25519PublicKey(privateKey, p));
}

/** @internal RFC 9180 §5.1 KeySchedule in base mode (no PSK); `keyBytes` is the AEAD's Nk. */
export function keySchedule(secretInput: Uint8Array, info: Uint8Array, p: HpkePrimitives, aead = AEAD_AES_256_GCM, keyBytes = 32): {
  readonly keyScheduleContext: Uint8Array; readonly secret: Uint8Array; readonly key: Uint8Array; readonly baseNonce: Uint8Array; readonly exporterSecret: Uint8Array } {
  const suite = hpkeSuite(aead), empty = new Uint8Array(0);
  const keyScheduleContext = concat(new Uint8Array([0]), labeledExtract(p, suite, empty, "psk_id_hash", empty), labeledExtract(p, suite, empty, "info_hash", info));
  const secret = labeledExtract(p, suite, secretInput, "secret", empty);
  return { keyScheduleContext, secret, key: labeledExpand(p, suite, secret, "key", keyScheduleContext, keyBytes),
    baseNonce: labeledExpand(p, suite, secret, "base_nonce", keyScheduleContext, NN), exporterSecret: labeledExpand(p, suite, secret, "exp", keyScheduleContext, NH) };
}

/** Single-shot `SealBase` (sequence number 0): encrypts `plaintext` to a raw X25519 public key. */
export async function sealBase(recipient: Uint8Array, info: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, p: HpkePrimitives, ephemeralIkm?: Uint8Array): Promise<{ readonly enc: Uint8Array; readonly ciphertext: Uint8Array }> {
  const { sharedSecret: shared, enc } = encapsulate(recipient, p, ephemeralIkm), schedule = keySchedule(shared, info, p);
  try { return { enc, ciphertext: await p.sealBytes(hex(schedule.key), hex(schedule.baseNonce), plaintext, aad) }; }
  finally { shared.fill(0); schedule.key.fill(0); schedule.secret.fill(0); schedule.exporterSecret.fill(0); }
}

/** Single-shot `OpenBase`; any failure is `authentication_failed`. */
export async function openBase(enc: Uint8Array, privateKey: Uint8Array, info: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array, p: HpkePrimitives): Promise<Uint8Array> {
  let shared: Uint8Array;
  try { shared = decapsulate(enc, privateKey, p); } catch { throw new TransferError("authentication_failed"); }
  const schedule = keySchedule(shared, info, p);
  try { return await p.openBytes(hex(schedule.key), hex(schedule.baseNonce), ciphertext, aad); }
  catch { throw new TransferError("authentication_failed"); }
  finally { shared.fill(0); schedule.key.fill(0); schedule.secret.fill(0); schedule.exporterSecret.fill(0); }
}

function hexBytes(text: string): Uint8Array { const bytes = new Uint8Array(text.length / 2); for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16); return bytes; }
