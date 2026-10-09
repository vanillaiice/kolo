import { nativeTransferCrypto } from "@kolo/core/backup/native-crypto";
import type { SafeStorage } from "electron";
import { pbkdf2, randomBytes, timingSafeEqual, generateKeyPair, randomUUIDv7, sign, verify, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { protectedCredentials, type CredentialCrypto } from "@kolo/core/identity/credentials";
import type { ExchangeCrypto } from "@kolo/core/exchange/types";
import type { CredentialPort } from "@kolo/core/identity/types";
import type { SecretStore } from "@kolo/core/data/auth/secure-store";

/** Actual Node/OpenSSL implementation of the same native credential policy. */
export const desktopCredentialCrypto: CredentialCrypto = {
  randomHex: bytes => randomBytes(bytes).toString("hex"),
  derive: (secret, salt, iterations) => new Promise((resolve, reject) => {
    pbkdf2(secret, Buffer.from(salt, "hex"), iterations, 32, "sha256", (error, result) => {
      if (error !== null) reject(new Error("native derivation unavailable")); else resolve(result.toString("hex"));
    });
  }),
  equalHex: (left, right) => /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")),
  sign: (privateKey, message) => new Promise((resolve, reject) => {
    sign(null, Buffer.from(message, "utf8"), privateKey, (error, signature) => {
      if (error !== null) reject(new Error("native signing unavailable")); else resolve(signature.toString("hex"));
    });
  }),
  deviceKey: () => new Promise((resolve, reject) => {
    generateKeyPair("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } },
      (error, publicKey, privateKey) => { if (error !== null) reject(new Error("native key generation unavailable")); else resolve({ publicKey, privateKey }); });
  }),
};

/** The narrow Electron safeStorage dependency, injected so Node tests need no Electron process. */
export type NativeSafeStorage = Pick<SafeStorage,
  "isAsyncEncryptionAvailable" | "getSelectedStorageBackend" | "encryptStringAsync" | "decryptStringAsync">;

/**
 * OS-encrypted vault with atomic file replacement. Windows uses Electron/DPAPI;
 * unavailable encryption and Linux basic_text fail closed. Never writes plaintext
 * fallback or accepts a renderer path/key. Call after Electron readiness.
 */
export function desktopSecretStore(directory: string, native: NativeSafeStorage, platform: string = process.platform): SecretStore {
  async function ready(): Promise<void> {
    if (!await native.isAsyncEncryptionAvailable() || (platform === "linux" && ["basic_text", "unknown"].includes(native.getSelectedStorageBackend()))) {
      throw new Error("protected credential storage unavailable");
    }
  }
  function path(key: string): string {
    if (!/^kolo\.[a-zA-Z0-9_.-]{1,200}$/.test(key)) throw new Error("invalid vault reference");
    return join(directory, key);
  }
  const store: SecretStore = {
    async read(key) {
      await ready();
      try {
        const decrypted = await native.decryptStringAsync(await readFile(path(key)));
        if (typeof decrypted.result !== "string") throw new Error("invalid native decrypted record");
        if (decrypted.shouldReEncrypt) await store.write(key, decrypted.result);
        return decrypted.result;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("protected credential read failed"); }
    },
    async write(key, secret) {
      await ready(); await mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = path(key), temporary = `${destination}.${randomUUIDv7()}.pending`;
      const encrypted = await native.encryptStringAsync(secret);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(encrypted); await handle.sync(); }
      finally { await handle.close(); }
      try { await rename(temporary, destination); }
      catch { await unlink(temporary).catch(() => undefined); throw new Error("protected credential write failed"); }
    },
    async forget(key) {
      await ready();
      try { await unlink(path(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("protected credential removal failed"); }
    },
  };
  return store;
}

/** Builds the desktop credential port using protected OS storage and async OpenSSL operations. */
export function localCredentialsOnDesktop(directory: string, native: NativeSafeStorage): CredentialPort {
  return protectedCredentials(desktopSecretStore(directory, native), desktopCredentialCrypto);
}

/** Native SHA-256 and Ed25519 verification, using the same canonical bytes as mobile/server. */
export const desktopExchangeCrypto: ExchangeCrypto = {
  sha256: async message => createHash("sha256").update(message, "utf8").digest("hex"),
  verify: (publicKey, message, signatureHex) => new Promise((resolve, reject) => {
    verify(null, Buffer.from(message, "utf8"), publicKey, Buffer.from(signatureHex, "hex"), (error, valid) => {
      if (error !== null) reject(new Error("native verification unavailable")); else resolve(valid);
    });
  }),
};

/** Native authenticated file encryption; uses the measured credential KDF with independent per-file salt/nonce. */
export const desktopTransferCrypto = nativeTransferCrypto({
 ...desktopExchangeCrypto,randomHex:desktopCredentialCrypto.randomHex,derive:desktopCredentialCrypto.derive,
 sha256Bytes:async bytes=>createHash("sha256").update(bytes).digest("hex"),
 encodeText:text=>new Uint8Array(Buffer.from(text,"utf8")),decodeText:bytes=>Buffer.from(bytes).toString("utf8"),
 encodeBase64:bytes=>Buffer.from(bytes).toString("base64"),decodeBase64:text=>new Uint8Array(Buffer.from(text,"base64")),
 fromHex:hex=>new Uint8Array(Buffer.from(hex,"hex")),toHex:bytes=>Buffer.from(bytes).toString("hex"),
 cipher:(key,nonce)=>createCipheriv("aes-256-gcm",Buffer.from(key,"hex"),Buffer.from(nonce,"hex"),{authTagLength:16}),
 decipher:(key,nonce)=>createDecipheriv("aes-256-gcm",Buffer.from(key,"hex"),Buffer.from(nonce,"hex"),{authTagLength:16}),
});
