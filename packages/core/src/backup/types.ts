import type { Database } from "../data/database/driver.ts";
import type { ExchangeCrypto } from "../exchange/types.ts";

/** Bounded portable snapshot; native readers enforce this before allocating file contents. */
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
/** Maximum encoded encrypted file, including base64 and manifest overhead. No decompression is used. */
export const MAX_TRANSFER_FILE_BYTES = 24 * 1024 * 1024;
/** Same measured candidate policy as local credentials; Android/Windows acceptance remains a native gate. */
export const TRANSFER_KDF_ITERATIONS = 600_000;

/** Stable recovery/transfer failures without customer data, passwords or native exception text. */
export class TransferError extends Error {
  readonly code: "invalid_file" | "too_large" | "invalid_password" | "authentication_failed" | "unsupported_version" | "invalid_snapshot" | "scope_mismatch" | "confirmation_required" | "not_empty" | "pairing_pending" | "pairing_expired" | "pairing_conflict" | "invalid_pairing" | "activation_failed" | "cancelled";
  constructor(code: TransferError["code"]) { super(code); this.name="TransferError"; this.code=code; }
}

/** Native PBKDF2/AES-256-GCM/SHA-256 and byte codecs. Private installation keys stay in CredentialPort. */
export interface TransferCrypto extends ExchangeCrypto {
  randomHex(bytes:number):string;
  derive(password:string,saltHex:string,iterations:number):Promise<string>;
  sha256Bytes(bytes:Uint8Array):Promise<string>;
  encrypt(keyHex:string,nonceHex:string,bytes:Uint8Array,aad:string):Promise<{ ciphertext:string; tag:string }>;
  decrypt(keyHex:string,nonceHex:string,ciphertext:string,tagHex:string,aad:string):Promise<Uint8Array>;
  encodeText(text:string):Uint8Array;
  decodeText(bytes:Uint8Array):string;
  encodeBase64(bytes:Uint8Array):string;
  decodeBase64(text:string):Uint8Array;
}

/** Isolated private staging database; activation must durably compare-and-switch the target's current slot. */
export interface SnapshotHandle {
  readonly database:Database;
  /** Reads a compact, WAL-consistent image after all sanitization/validation writes. */
  bytes():Promise<Uint8Array>;
  /** Removes only this owned staging database; activated business files must never be discarded. */
  discard():Promise<void>;
  /** Checkpoint/close the candidate, install a fresh file, then atomically switch the active slot. */
  activate(expectedTarget:Database):Promise<Database>;
}
/** Platform boundary for SQLite-consistent copies and bounded private staging/activation. */
export interface SnapshotPort {
  capture(source:Database):Promise<SnapshotHandle>;
  open(bytes:Uint8Array):Promise<SnapshotHandle>;
  empty():Promise<SnapshotHandle>;
}
/** Encrypted UTF-8 document ready for a user-selected file destination. */
export interface TransferDocument { readonly filename:string; readonly text:string; }
