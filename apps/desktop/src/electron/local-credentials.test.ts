import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { desktopCredentialCrypto, desktopExchangeCrypto, desktopSecretStore, localCredentialsOnDesktop, type NativeSafeStorage } from "./local-credentials.ts";

// Real AES-GCM simulates only the unavailable OS API, not credential derivation.
// This verifies the native-storage contract; Windows DPAPI needs an installed test.
function native(available = true, backend: ReturnType<NativeSafeStorage["getSelectedStorageBackend"]> = "gnome_libsecret"): NativeSafeStorage {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async value => {
      const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptStringAsync: async value => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16));
      return { result: Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8"), shouldReEncrypt: false };
    },
  };
}
it("never writes plaintext or falls back when OS encryption is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-vault-"));
  try {
    const vault = desktopSecretStore(directory, native());
    await vault.write("kolo.local.test", "sensitive-value");
    assert.equal(readFileSync(join(directory, "kolo.local.test")).includes(Buffer.from("sensitive-value")), false);
    assert.equal(await vault.read("kolo.local.test"), "sensitive-value");
    await vault.write("kolo.local.test", "replacement"); assert.equal(await vault.read("kolo.local.test"), "replacement");
    await assert.rejects(vault.write("../outside", "secret"), /invalid vault/);
    for (const os of [native(false), native(true, "basic_text"), native(true, "unknown")]) {
      await assert.rejects(desktopSecretStore(directory, os, "linux").write("kolo.local.other", "secret"), /unavailable/);
    }
    await vault.forget("kolo.local.test"); assert.equal(await vault.read("kolo.local.test"), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it("real desktop OpenSSL credentials persist and verify after rebuilding the vault port", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-credential-")); const os = native();
  try {
    const credentials = localCredentialsOnDesktop(directory, os);
    const material = await credentials.provision({ installationId: "installation", businessId: "shop", userId: "owner", deviceId: "device", secret: "123456" });
    const reopened = localCredentialsOnDesktop(directory, os);
    assert.equal(await reopened.verify(material.credentialReference, "123456"), true);
    assert.equal(await reopened.verify(material.credentialReference, "654321"), false);
    assert.match(material.publicKey, /BEGIN PUBLIC KEY/);
    const message = "kolo.event.v2\u0000{\"fixture\":1}";
    const signature = await reopened.sign!(material.keyReference, message);
    assert.equal(await desktopExchangeCrypto.verify(material.publicKey, message, signature), true);
    assert.equal(await desktopExchangeCrypto.verify(material.publicKey, message + "changed", signature), false);
    assert.match(await desktopExchangeCrypto.sha256(message), /^[a-f0-9]{64}$/);
    await assert.rejects(reopened.sign!(material.keyReference, "unscoped-message"));
    assert.equal(desktopCredentialCrypto.equalHex("00".repeat(32), "00".repeat(32)), true);
    assert.equal(desktopCredentialCrypto.equalHex("invalid", "invalid"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("rewrites a decrypted record when the native provider reports key rotation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-rotation-"));
  try {
    const os = native(); let writes = 0; let rotated = false;
    const vault = desktopSecretStore(directory, { ...os,
      encryptStringAsync: async value => { writes++; return await os.encryptStringAsync(value); },
      decryptStringAsync: async value => ({ ...await os.decryptStringAsync(value), shouldReEncrypt: !rotated && (rotated = true) }),
    });
    await vault.write("kolo.local.rotation", "same protected value");
    assert.equal(await vault.read("kolo.local.rotation"), "same protected value");
    assert.equal(writes, 2);
    assert.equal(await vault.read("kolo.local.rotation"), "same protected value"); assert.equal(writes, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
