import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUIDv7, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { KEY_FINGERPRINT_PREFIX } from "@kolo/contracts/sync";

/** The server's own device identity: one Ed25519 key for every shop it serves. */
export interface ServerKey {
  readonly deviceId: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  /** Signs domain-separated UTF-8 bytes; returns lowercase hex. */
  sign(message: string): string;
}

/** Lowercase hex SHA-256 of UTF-8 text. */
export function sha256(message: string): string { return createHash("sha256").update(message, "utf8").digest("hex"); }

/** Verifies a detached Ed25519 signature under an SPKI PEM key; malformed keys or signatures are simply invalid. */
export function verifySignature(publicKey: string, message: string, signatureHex: string): boolean {
  try { return verify(null, Buffer.from(message, "utf8"), publicKey, Buffer.from(signatureHex, "hex")); } catch { return false; }
}

/** Short key fingerprint, identical to the one a device computes before pinning the server. */
export function fingerprintOf(publicKey: string): string { return sha256(`${KEY_FINGERPRINT_PREFIX}${publicKey}`).slice(0, 32); }

function fromPrivateKey(deviceId: string, privateKey: KeyObject): ServerKey {
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  return Object.freeze({ deviceId, publicKey, fingerprint: fingerprintOf(publicKey),
    sign: (message: string) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex") });
}

/** A fresh in-memory identity, for tests and first start. */
export function generateServerKey(): { key: ServerKey; privateKeyPem: string } {
  const pair = generateKeyPairSync("ed25519");
  return { key: fromPrivateKey(randomUUIDv7(), pair.privateKey), privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/**
 * Loads the identity file, or creates it exclusively with owner-only permissions on first start.
 * Losing this file changes the server's identity: every device must then confirm it again.
 */
export function loadServerKey(path: string): ServerKey {
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { device_id?: unknown; private_key?: unknown };
    if (typeof stored.device_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(stored.device_id) || typeof stored.private_key !== "string") throw new Error("invalid");
    const privateKey = createPrivateKey(stored.private_key);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("invalid");
    return fromPrivateKey(stored.device_id, privateKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("KOLO_SERVER_KEY_FILE is unreadable or invalid");
  }
  const { key, privateKeyPem } = generateServerKey();
  writeFileSync(path, `${JSON.stringify({ device_id: key.deviceId, private_key: privateKeyPem })}\n`, { flag: "wx", mode: 0o600 });
  return key;
}
