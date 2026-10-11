import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { desktopCredentialCrypto, desktopExchangeCrypto, desktopSealingCrypto, desktopSecretStore, localCredentialsOnDesktop, type NativeSafeStorage } from "./local-credentials.ts";

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
    // Sync server enrollment and session claims are signed by the same protected key.
    for (const domain of ["kolo.server-enrollment.v1", "kolo.server-session.v1"]) {
      const claim = `${domain}\u0000{"fixture":1}`;
      assert.equal(await desktopExchangeCrypto.verify(material.publicKey, claim, await reopened.sign!(material.keyReference, claim)), true);
    }
    await assert.rejects(reopened.sign!(material.keyReference, "kolo.server-other.v1\u0000{}"));
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

it("the X25519 sync key lives in the vault, survives reopening and agrees with an ephemeral sender", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-x25519-")); const os = native();
  try {
    const credentials = localCredentialsOnDesktop(directory, os);
    await assert.rejects(credentials.encryptionKey!("kolo.local.missing"), /credential_unavailable/, "no key without a provisioned identity");
    const material = await credentials.provision({ installationId: "installation", businessId: "shop", userId: "owner", deviceId: "device", secret: "123456" });
    await assert.rejects(credentials.agree!(material.keyReference, "not a key"), /credential_unavailable/);
    const [first, concurrent] = await Promise.all([credentials.encryptionKey!(material.keyReference), credentials.encryptionKey!(material.keyReference)]);
    assert.equal(first, concurrent, "concurrent first use creates one key");
    const reopened = localCredentialsOnDesktop(directory, os);
    assert.equal(await reopened.encryptionKey!(material.keyReference), first);
    assert.ok(first.includes("BEGIN PUBLIC KEY"));
    for (const file of ["kolo.local.installation.owner.x25519"]) assert.equal(readFileSync(join(directory, file)).includes(Buffer.from("PRIVATE KEY")), false, "the private key is never stored in the clear");
    const sender = await desktopSealingCrypto.ephemeralAgreement(first);
    assert.equal(await reopened.agree!(material.keyReference, sender.publicKey), sender.shared);
    assert.notEqual((await desktopSealingCrypto.ephemeralAgreement(first)).shared, sender.shared, "every sender key is fresh");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("native HKDF-SHA256 matches RFC 5869 test case 3", async () => {
  // Case 3 has empty salt and info; the port's info is UTF-8 text, so the binary-info cases do not apply.
  const okm = await desktopSealingCrypto.hkdf("0b".repeat(22), "", "", 42);
  assert.equal(okm, "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8");
});
