import { CONTAINER_PREFIX_BYTES, MAX_CONTAINER_HEADER_BYTES } from "@kolo/contracts/transfer";
import { isTransferContainer } from "./encryption.ts";
import { TransferError, type TransferCrypto } from "./types.ts";

/** What a chosen transfer file is, recognized from its structure before any password or key work. */
export type TransferFileKind = "backup" | "enrollment" | "exchange" | "receipt" | "invite" | "request";

const record = (item: unknown): Record<string, unknown> | undefined => item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
const encryptedPurpose = (header: Record<string, unknown> | undefined): TransferFileKind | undefined => {
  if (header?.["format"] !== "kolo.encrypted") return undefined;
  const purpose = header["purpose"];
  return purpose === "backup" || purpose === "enrollment" || purpose === "exchange" || purpose === "receipt" ? purpose : undefined;
};

/**
 * Recognizes a KOLO transfer file by its public structure: an encrypted container (ADR-035) or a
 * plaintext invitation/request. Anything else, including the JSON files of releases before ADR-035,
 * is `undefined`. A container of an unknown version is still recognized by purpose, so opening it
 * reports `unsupported_version`.
 */
export function transferFileKind(bytes: Uint8Array, crypto: Pick<TransferCrypto, "decodeText">): TransferFileKind | undefined {
  if (!(bytes instanceof Uint8Array)) return undefined;
  if (isTransferContainer(bytes)) {
    if (bytes.byteLength < CONTAINER_PREFIX_BYTES) return undefined;
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false);
    if (length < 1 || length > MAX_CONTAINER_HEADER_BYTES || CONTAINER_PREFIX_BYTES + length > bytes.byteLength) return undefined;
    let text = "";
    for (const byte of bytes.subarray(CONTAINER_PREFIX_BYTES, CONTAINER_PREFIX_BYTES + length)) { if (byte < 0x20 || byte > 0x7e) return undefined; text += String.fromCharCode(byte); }
    try { return encryptedPurpose(record(JSON.parse(text))); } catch { return undefined; }
  }
  let value: unknown;
  try { value = JSON.parse(crypto.decodeText(bytes)); } catch { return undefined; }
  const root = record(value);
  if (record(root?.["invite"])?.["format"] === "kolo.pairing-invite") return "invite";
  if (record(root?.["request"])?.["format"] === "kolo.pairing-request") return "request";
  return undefined;
}

/** Carries an encrypted container inside a JSON transport (join mailboxes, ADR-035) as padded base64. */
export function transferFileText(bytes: Uint8Array, crypto: Pick<TransferCrypto, "encodeBase64">): string {
  if (!(bytes instanceof Uint8Array) || !isTransferContainer(bytes)) throw new TransferError("invalid_file");
  return crypto.encodeBase64(bytes);
}

/** Reverses {@link transferFileText}: the text must be strict base64 of a container. */
export function transferFileFromText(text: string, crypto: Pick<TransferCrypto, "decodeBase64">): Uint8Array {
  if (typeof text !== "string" || text.length === 0) throw new TransferError("invalid_file");
  let bytes: Uint8Array;
  try { bytes = crypto.decodeBase64(text); } catch { throw new TransferError("invalid_file"); }
  if (!isTransferContainer(bytes)) throw new TransferError("invalid_file");
  return bytes;
}
