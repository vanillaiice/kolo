import type { Database } from "../data/database/driver.ts";
import type { ExchangeCrypto } from "../exchange/types.ts";
import { MAX_ENCRYPTED_FILE_BYTES, MAX_SNAPSHOT_IMAGE_BYTES } from "@kolo/contracts/transfer";
export { TRANSFER_LIMITS, type TransferLimits } from "@kolo/contracts/transfer";

/** Bounded portable snapshot; native readers enforce this before allocating file contents. */
export const MAX_SNAPSHOT_BYTES = MAX_SNAPSHOT_IMAGE_BYTES;
/** Maximum encrypted file on disk. Content is deflated before encryption. */
export const MAX_TRANSFER_FILE_BYTES = MAX_ENCRYPTED_FILE_BYTES;
/** Same measured candidate policy as local credentials; Android/Windows acceptance remains a native gate. */
export const TRANSFER_KDF_ITERATIONS = 600_000;

/** Stable recovery/transfer failures without customer data, passwords or native exception text. */
export class TransferError extends Error {
  readonly code: "invalid_file" | "too_large" | "invalid_password" | "authentication_failed" | "unsupported_version" | "invalid_snapshot" | "invalid_recovery_key" | "recovery_key_required" | "untrusted_backup" | "scope_mismatch" | "confirmation_required" | "not_empty" | "pairing_pending" | "pairing_expired" | "pairing_conflict" | "invalid_pairing" | "activation_failed" | "cancelled" | "sync_keys_unavailable" | "inconsistent_records";
  constructor(code: TransferError["code"]) { super(code); this.name="TransferError"; this.code=code; }
}

/** Argon2id cost and output parameters; `secret` and `associatedData` exist for the RFC 9106 test vector. */
export interface Argon2Params { readonly memoryKiB:number; readonly passes:number; readonly parallelism:number; readonly length:number; readonly secret?:Uint8Array; readonly associatedData?:Uint8Array }
/** Native PBKDF2/AES-256-GCM/SHA-256 and byte codecs. Private installation keys stay in CredentialPort. */
export interface TransferCrypto extends ExchangeCrypto {
  randomHex(bytes:number):string;
  derive(password:string,saltHex:string,iterations:number):Promise<string>;
  sha256Bytes(bytes:Uint8Array):Promise<string>;
  encrypt(keyHex:string,nonceHex:string,bytes:Uint8Array,aad:string):Promise<{ ciphertext:string; tag:string }>;
  decrypt(keyHex:string,nonceHex:string,ciphertext:string,tagHex:string,aad:string):Promise<Uint8Array>;
  /** AES-256-GCM over raw bytes with byte additional data; returns the ciphertext followed by its 16-byte tag. */
  sealBytes(keyHex:string,nonceHex:string,bytes:Uint8Array,aad:Uint8Array):Promise<Uint8Array>;
  /** Opens `ciphertext ‖ tag`; returns plaintext only after the tag authenticates. */
  openBytes(keyHex:string,nonceHex:string,sealed:Uint8Array,aad:Uint8Array):Promise<Uint8Array>;
  /** HMAC-SHA256 over raw bytes (HPKE key derivation, ADR-035). */
  hmacSha256(key:Uint8Array,data:Uint8Array):Uint8Array;
  /** X25519 shared secret of a raw 32-byte private key and a raw 32-byte public key. */
  x25519(privateKey:Uint8Array,publicKey:Uint8Array):Uint8Array;
  /** Incremental native SHA-256, for hashing a snapshot image chunk by chunk; `digest` returns lowercase hex. */
  createSha256():{update(bytes:Uint8Array):void;digest():string};
  /** Native Argon2id (RFC 9106); `memoryKiB` counts 1 KiB blocks. */
  argon2id(password:Uint8Array,salt:Uint8Array,params:Argon2Params):Promise<Uint8Array>;
  encodeText(text:string):Uint8Array;
  decodeText(bytes:Uint8Array):string;
  encodeBase64(bytes:Uint8Array):string;
  decodeBase64(text:string):Uint8Array;
}

/** A compacted snapshot image on private storage, read in chunks; `close` deletes it. */
export interface ImageReader { readonly size:number; read(offset:number,length:number):Promise<Uint8Array>; close():Promise<void> }
/** A private staging file being written chunk by chunk; `open` checks its size and opens it, `discard` deletes it. */
export interface ImageWriter { write(bytes:Uint8Array):Promise<void>; open():Promise<SnapshotHandle>; discard():Promise<void> }
/** Where a streamed transfer file goes: a private temporary file, or memory in tests. */
export interface ByteSink { write(bytes:Uint8Array):Promise<void> }
/** Isolated private staging database; activation must durably compare-and-switch the target's current slot. */
export interface SnapshotHandle {
  readonly database:Database;
  /** Reads a compact, WAL-consistent image after all sanitization/validation writes. */
  bytes():Promise<Uint8Array>;
  /**
   * Compacts the image after all sanitization writes into a private file and returns a reader over it, so a backup
   * never holds the whole image in memory. Closing the reader deletes that file.
   */
  image():Promise<ImageReader>;
  /** Removes only this owned staging database; activated business files must never be discarded. */
  discard():Promise<void>;
  /** Checkpoint/close the candidate, install a fresh file, then atomically switch the active slot. */
  activate(expectedTarget:Database):Promise<Database>;
}
/** Platform boundary for SQLite-consistent copies and bounded private staging/activation. */
export interface SnapshotPort {
  capture(source:Database):Promise<SnapshotHandle>;
  open(bytes:Uint8Array):Promise<SnapshotHandle>;
  /** A private staging file that receives a restored image chunk by chunk, then opens as a candidate. */
  receive():Promise<ImageWriter>;
  empty():Promise<SnapshotHandle>;
}
/**
 * A file ready for a user-selected destination: an encrypted container (ADR-035) or a
 * plaintext UTF-8 JSON invitation/request. Hosts write `bytes` unchanged.
 */
export interface TransferDocument { readonly filename:string; readonly bytes:Uint8Array; }

