import type { SecretStore } from "../data/auth/secure-store.ts";
import { WorkspaceError, type CredentialPort, type ProvisionedIdentity } from "./types.ts";

/** Native/OpenSSL PBKDF2-HMAC-SHA256 policy; never implemented with a JS digest. */
export const CREDENTIAL_ITERATIONS = 600_000;

/** Platform crypto primitives. Derivation is asynchronous; private keys never enter SQLite. */
export interface CredentialCrypto {
  randomHex(bytes: number): string;
  derive(secret: string, saltHex: string, iterations: number): Promise<string>;
  equalHex(left: string, right: string): boolean;
  sign?(privateKey: string, message: string): Promise<string>;
  deviceKey(): Promise<{ readonly publicKey: string; readonly privateKey: string }>;
  /** Fresh X25519 key pair as SPKI/PKCS#8 PEM, for end-to-end encrypted sync. */
  encryptionKeyPair?(): Promise<{ readonly publicKey: string; readonly privateKey: string }>;
  /** Native X25519 agreement; returns the 32-byte shared secret as hex. */
  agree?(privateKey: string, peerPublicKey: string): Promise<string>;
}

interface Record {
  version: 1;
  installationId: string;
  businessId: string;
  userId: string;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  salt: string;
  verifier: string;
  recoverySalt: string;
  recoveryVerifier: string;
  recoveryCode: string;
}

/** Accepts 6–8 digit PINs or passwords of 12–256 characters; native storage is mandatory. */
export function validateLocalSecret(secret: string): void {
  if (typeof secret !== "string" || !(/^\d{6,8}$/.test(secret) || (secret.length >= 12 && secret.length <= 256 && !/^\d+$/.test(secret)))) {
    throw new WorkspaceError("invalid_input");
  }
}

/**
 * Salted expensive verifier + Ed25519 private key, held entirely in a protected
 * platform SecretStore. SQLite receives only public key and opaque references.
 * Native writes are serialized; provision retries never replace an existing
 * identity/credential. A 256-bit recovery code independently resets the owner PIN.
 * Adapter instances own no database/network and expose no private-key read API.
 */
export function protectedCredentials(store: SecretStore, crypto: CredentialCrypto): CredentialPort {
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const task = queue.then(work, work);
    queue = task.catch(() => undefined);
    return task;
  }
  async function read(reference: string): Promise<Record | undefined> {
    const encoded = await store.read(reference);
    if (encoded === undefined) return undefined;
    const record = JSON.parse(encoded) as Record;
    if (record.version !== 1 || typeof record.privateKey !== "string" || typeof record.publicKey !== "string" ||
      ![record.salt, record.recoverySalt].every(value => /^[a-f0-9]{32}$/.test(value)) ||
      ![record.verifier, record.recoveryVerifier, record.recoveryCode].every(value => /^[a-f0-9]{64}$/.test(value))) {
      throw new WorkspaceError("credential_unavailable");
    }
    return record;
  }
  async function matches(record: Record, secret: string): Promise<boolean> {
    const derived = await crypto.derive(secret, record.salt, CREDENTIAL_ITERATIONS);
    return crypto.equalHex(derived, record.verifier);
  }
  async function verifier(secret: string): Promise<{ salt: string; verifier: string }> {
    const salt = crypto.randomHex(16);
    return { salt, verifier: await crypto.derive(secret, salt, CREDENTIAL_ITERATIONS) };
  }
  // The X25519 key lives beside, never inside, the signing record, so existing records stay valid.
  async function encryption(reference: string, create: boolean): Promise<{ publicKey: string; privateKey: string } | undefined> {
    if (await read(reference) === undefined) throw new WorkspaceError("credential_unavailable");
    const key = `${reference}.x25519`, stored = await store.read(key);
    if (stored !== undefined) {
      const record = JSON.parse(stored) as { version?: unknown; publicKey?: unknown; privateKey?: unknown };
      if (record.version !== 1 || typeof record.publicKey !== "string" || typeof record.privateKey !== "string") throw new WorkspaceError("credential_unavailable");
      return { publicKey: record.publicKey, privateKey: record.privateKey };
    }
    if (!create) return undefined;
    if (crypto.encryptionKeyPair === undefined) throw new WorkspaceError("credential_unavailable");
    const pair = await crypto.encryptionKeyPair();
    await store.write(key, JSON.stringify({ version: 1, publicKey: pair.publicKey, privateKey: pair.privateKey }));
    return pair;
  }
  function material(reference: string, record: Record): ProvisionedIdentity {
    return { publicKey: record.publicKey, credentialReference: reference, keyReference: reference };
  }
  return {
    provision: request => serialize(async () => {
      validateLocalSecret(request.secret);
      const reference = `kolo.local.${request.installationId}.${request.userId}`;
      let record = await read(reference);
      if (record !== undefined) {
        if (record.installationId !== request.installationId || record.businessId !== request.businessId ||
          record.userId !== request.userId || record.deviceId !== request.deviceId || !await matches(record, request.secret)) {
          throw new WorkspaceError("invalid_credential");
        }
      } else {
        const credential = await verifier(request.secret);
        const recoveryCode = crypto.randomHex(32);
        const recovery = await verifier(recoveryCode);
        const key = await crypto.deviceKey();
        record = { version: 1, installationId: request.installationId, businessId: request.businessId,
          userId: request.userId, deviceId: request.deviceId, ...credential, ...key,
          recoveryCode, recoverySalt: recovery.salt, recoveryVerifier: recovery.verifier };
        await store.write(reference, JSON.stringify(record));
      }
      // Manifest is written last: inspect never declares a partial key/verifier ready.
      const manifest = `kolo.local.${request.installationId}.manifest`;
      if (await store.read(manifest) === undefined) await store.write(manifest, reference);
      return material(reference, record);
    }),
    async inspect(installationId) {
      const reference = await store.read(`kolo.local.${installationId}.manifest`);
      if (reference === undefined) return undefined;
      const record = await read(reference);
      return record === undefined || record.installationId !== installationId ? undefined : material(reference, record);
    },
    async sign(reference, message) {
      if (crypto.sign === undefined || typeof message !== "string" || message.length > 8 * 1024 * 1024 + 100 ||
        !/^kolo\.(event\.v2|receipt\.v1|batch\.v2|snapshot\.v1|pairing-invite\.v1|pairing-request\.v1|server-enrollment\.v1|server-session\.v1|sync-batch\.v1)\u0000/.test(message)) throw new WorkspaceError("credential_unavailable");
      const record = await read(reference);
      if (record === undefined) throw new WorkspaceError("credential_unavailable");
      const signature = await crypto.sign(record.privateKey, message);
      if (!/^[a-f0-9]{128}$/.test(signature)) throw new WorkspaceError("credential_unavailable");
      return signature;
    },
    encryptionKey: reference => serialize(async () => (await encryption(reference, true))!.publicKey),
    async agree(reference, peerPublicKey) {
      const record = await encryption(reference, false);
      if (record === undefined || crypto.agree === undefined || typeof peerPublicKey !== "string" || peerPublicKey.length > 1024 || !peerPublicKey.includes("BEGIN PUBLIC KEY")) throw new WorkspaceError("credential_unavailable");
      const shared = await crypto.agree(record.privateKey, peerPublicKey);
      if (!/^[a-f0-9]{64}$/.test(shared) || /^0+$/.test(shared)) throw new WorkspaceError("credential_unavailable");
      return shared;
    },
    async verify(reference, secret) {
      const record = await read(reference);
      if (record === undefined) throw new WorkspaceError("credential_unavailable");
      return await matches(record, secret);
    },
    async hasCredential(reference) { return await read(reference) !== undefined; },
    async recoveryCode(reference, secret) {
      const record = await read(reference);
      if (record === undefined || !await matches(record, secret)) throw new WorkspaceError("invalid_credential");
      return record.recoveryCode;
    },
    recover: (oldReference, newReference, recoveryCode, newSecret) => serialize(async () => {
      validateLocalSecret(newSecret);
      const original = await read(oldReference);
      if (original === undefined) throw new WorkspaceError("credential_unavailable");
      const normalized = recoveryCode.replace(/[\s-]/g, "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(normalized) || !crypto.equalHex(await crypto.derive(normalized, original.recoverySalt, CREDENTIAL_ITERATIONS), original.recoveryVerifier)) {
        throw new WorkspaceError("invalid_credential");
      }
      const existing = await read(newReference);
      if (existing !== undefined) {
        if (existing.installationId !== original.installationId || existing.userId !== original.userId || !await matches(existing, newSecret)) {
          throw new WorkspaceError("invalid_credential");
        }
        return;
      }
      const credential = await verifier(newSecret);
      const replacementCode = crypto.randomHex(32);
      const recovery = await verifier(replacementCode);
      await store.write(newReference, JSON.stringify({ ...original, ...credential, recoveryCode: replacementCode,
        recoverySalt: recovery.salt, recoveryVerifier: recovery.verifier }));
    }),
  };
}
