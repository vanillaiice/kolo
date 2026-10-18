import { JOIN_CODE_ALPHABET } from "@kolo/contracts/sync";
import { deriveKeyPair } from "./hpke.ts";
import { TransferError, type TransferCrypto } from "./types.ts";

/**
 * The shop backup recovery key (ADR-036): 32 random bytes, written once for the owner as 56 Crockford
 * base32 symbols (52 for the secret, 4 checksum) in 14 groups of four. Its HPKE key pair opens the
 * recipient slots of backups; tills keep only the public half.
 */
export interface RecoveryKeyPair { readonly keyId: string; readonly publicKey: Uint8Array; readonly privateKey: Uint8Array }
/** A recipient a backup is sealed to: the pinned public half of a recovery key. */
export interface RecoveryRecipient { readonly keyId: string; readonly publicKey: Uint8Array }

const SECRET_BYTES = 32, SECRET_SYMBOLS = 52, CHECK_SYMBOLS = 4;
/** The labels here are ASCII; encoding them by hand avoids depending on TextEncoder in every JavaScript engine. */
const ascii = (text: string): Uint8Array => { const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; };

/** A fresh recovery secret from the native random generator. */
export function generateRecoverySecret(crypto: Pick<TransferCrypto, "randomHex">): Uint8Array { return hexBytes(crypto.randomHex(SECRET_BYTES)); }

/** The recovery key's stable ID: the first 16 bytes, in hex, of SHA-256("kolo.backup-recovery-key.v1\0" ‖ public key). */
export async function recoveryKeyId(publicKey: Uint8Array, crypto: Pick<TransferCrypto, "sha256Bytes">): Promise<string> {
  if (publicKey.length !== 32) throw new TransferError("invalid_file");
  return (await crypto.sha256Bytes(concat(ascii("kolo.backup-recovery-key.v1\0"), publicKey))).slice(0, 32);
}

/** The recovery key pair of a secret: RFC 9180 DeriveKeyPair, so S is used for nothing else. */
export async function deriveRecoveryKey(secret: Uint8Array, crypto: TransferCrypto): Promise<RecoveryKeyPair> {
  if (!(secret instanceof Uint8Array) || secret.length !== SECRET_BYTES) throw new TransferError("invalid_recovery_key");
  const pair = deriveKeyPair(secret, crypto);
  return { keyId: await recoveryKeyId(pair.publicKey, crypto), publicKey: pair.publicKey, privateKey: pair.privateKey };
}

async function checksum(secret: Uint8Array, crypto: Pick<TransferCrypto, "sha256Bytes">): Promise<string> {
  const digest = await crypto.sha256Bytes(concat(ascii("kolo.backup-recovery-checksum.v1\0"), secret));
  // The first 20 bits of the digest, as four symbols.
  const bits = parseInt(digest.slice(0, 5), 16);
  let text = ""; for (let shift = 15; shift >= 0; shift -= 5) text += JOIN_CODE_ALPHABET[(bits >> shift) & 31]; return text;
}

/** Writes a secret for the owner: `XXXX-XXXX-…`, 14 groups of four Crockford base32 symbols. */
export async function formatRecoveryKey(secret: Uint8Array, crypto: Pick<TransferCrypto, "sha256Bytes">): Promise<string> {
  if (!(secret instanceof Uint8Array) || secret.length !== SECRET_BYTES) throw new TransferError("invalid_recovery_key");
  let symbols = "", buffer = 0, bits = 0;
  for (const byte of secret) { buffer = (buffer << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; symbols += JOIN_CODE_ALPHABET[(buffer >> bits) & 31]; buffer &= (1 << bits) - 1; } }
  symbols += JOIN_CODE_ALPHABET[(buffer << (5 - bits)) & 31];
  symbols += await checksum(secret, crypto);
  return symbols.match(/.{4}/g)!.join("-");
}

/**
 * Reads a typed recovery key: case, spaces and hyphens are ignored and O, I and L read as 0, 1 and 1.
 * A wrong length, a non-zero padding bit or a checksum mismatch is `invalid_recovery_key`, before any
 * decryption is attempted.
 */
export async function parseRecoveryKey(text: string, crypto: Pick<TransferCrypto, "sha256Bytes">): Promise<Uint8Array> {
  if (typeof text !== "string" || text.length > 200) throw new TransferError("invalid_recovery_key");
  const symbols = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (symbols.length !== SECRET_SYMBOLS + CHECK_SYMBOLS || [...symbols].some(symbol => !JOIN_CODE_ALPHABET.includes(symbol))) throw new TransferError("invalid_recovery_key");
  const secret = new Uint8Array(SECRET_BYTES);
  let buffer = 0, bits = 0, at = 0;
  for (const symbol of symbols.slice(0, SECRET_SYMBOLS)) {
    buffer = (buffer << 5) | JOIN_CODE_ALPHABET.indexOf(symbol); bits += 5;
    if (bits >= 8) { bits -= 8; if (at < SECRET_BYTES) secret[at++] = (buffer >> bits) & 255; buffer &= (1 << bits) - 1; }
  }
  // 52 symbols carry 260 bits: the last four must be zero, so each secret has exactly one spelling.
  if (buffer !== 0 || at !== SECRET_BYTES) throw new TransferError("invalid_recovery_key");
  if (await checksum(secret, crypto) !== symbols.slice(SECRET_SYMBOLS)) { secret.fill(0); throw new TransferError("invalid_recovery_key"); }
  return secret;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array { const out = new Uint8Array(left.length + right.length); out.set(left); out.set(right, left.length); return out; }
function hexBytes(text: string): Uint8Array { const bytes = new Uint8Array(text.length / 2); for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16); return bytes; }
