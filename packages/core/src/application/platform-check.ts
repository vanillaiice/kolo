import { decryptTransfer, encryptTransfer, normalizeTransferPassword } from "../backup/encryption.ts";
import { GOLDEN_CONTAINER_BASE64, GOLDEN_PASSWORD } from "../backup/golden-container.ts";
import { deriveRecoveryKey } from "../backup/recovery-key.ts";
import type { TransferCrypto } from "../backup/types.ts";
import type { SealingCrypto } from "./sealed-sync.ts";

/** One named check: whether the runtime's adapter gave the known answer, how long it took, and why not. */
export interface PlatformCheckResult { readonly name: string; readonly ok: boolean; readonly ms: number; readonly detail?: string }
/** Every check of one runtime; `ok` only when all passed. */
export interface PlatformCheck { readonly ok: boolean; readonly checks: readonly PlatformCheckResult[] }

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const unhex = (text: string): Uint8Array => new Uint8Array(text.match(/../g)!.map(pair => parseInt(pair, 16)));
const same = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);
function expect(condition: boolean, what: string): void { if (!condition) throw new Error(what); }
async function refuses(work: () => Promise<unknown>): Promise<boolean> { try { await work(); return false; } catch { return true; } }
const pem = (spki: Uint8Array, crypto: TransferCrypto): string => `-----BEGIN PUBLIC KEY-----\n${crypto.encodeBase64(spki)}\n-----END PUBLIC KEY-----\n`;
const rawOfPem = (text: string, crypto: TransferCrypto): Uint8Array => crypto.decodeBase64(text.replace(/-----[A-Z ]+-----|\s/g, "")).slice(-32);

// Known answers: RFC 7748 §6.1, RFC 8032 §7.1 test 1, RFC 4231 test 2, RFC 5869 test 3, PBKDF2-HMAC-SHA256
// ("password", "salt", 2), and Argon2id 64 MiB/3/1 and AES-256-GCM values derived with OpenSSL.
const X25519 = { alice: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", bob: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  bobPrivate: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb", shared: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742" };
const ED25519 = { publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  signature: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b" };
const HMAC = { key: "Jefe", message: "what do ya want for nothing?", mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843" };
const HKDF = "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8";
const PBKDF2 = "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43";
const ARGON2ID = "5c23a8188b7e66085af0e5e12105aeb9764d82ba73a1d727921fbe7b4cce7b8b";
const GCM = "a5c82c5206be95b71bdb74a10354ad06a6f3b2b5";
const ED25519_SPKI = "302a300506032b6570032100", X25519_SPKI = "302a300506032b656e032100";

/**
 * Runs the platform adapter of the runtime that ships (Node for CLI and server, Electron's BoringSSL for desktop, Hermes
 * and quick-crypto for mobile) against known answers, then opens the golden ADR-035 container with its password and its
 * recovery key and round-trips a new one. Node tests on another runtime cannot prove these primitives exist where the
 * app runs; this does, on the device or in the packaged app. Pass `sealing` to cover end-to-end sync primitives too.
 * Never throws; inputs are public test vectors, so failure details hold no secrets.
 */
export async function runPlatformCheck(crypto: TransferCrypto, sealing?: SealingCrypto): Promise<PlatformCheck> {
  const checks: PlatformCheckResult[] = [];
  const check = async (name: string, work: () => Promise<void>): Promise<void> => {
    const started = Date.now();
    try { await work(); checks.push({ name, ok: true, ms: Date.now() - started }); }
    catch (error) { checks.push({ name, ok: false, ms: Date.now() - started, detail: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "failed" }); }
  };
  const text = (value: string): Uint8Array => crypto.encodeText(value);
  await check("utf8", async () => {
    const value = "Kolo é 漢字 🙂", bytes = text(value);
    expect(bytes.length === 19 && crypto.decodeText(bytes) === value, "UTF-8 round trip");
  });
  await check("base64", async () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    expect(crypto.encodeBase64(text("kolo")) === "a29sbw==" && same(crypto.decodeBase64(crypto.encodeBase64(bytes)), bytes), "base64");
  });
  await check("random", async () => {
    const first = crypto.randomHex(16), second = crypto.randomHex(16);
    expect(/^[0-9a-f]{32}$/.test(first) && first !== second, "random bytes");
  });
  await check("nfc", async () => { expect(normalizeTransferPassword("Cafe\u0301 cre\u0300me bru\u0302le\u0301e") === "Caf\u00e9 cr\u00e8me br\u00fbl\u00e9e", "NFC normalization"); });
  await check("sha256", async () => {
    const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", incremental = crypto.createSha256();
    incremental.update(text("a")); incremental.update(text("bc"));
    expect(await crypto.sha256Bytes(text("abc")) === abc && await crypto.sha256("abc") === abc && incremental.digest() === abc, "SHA-256");
  });
  await check("hmac-sha256", async () => { expect(hex(crypto.hmacSha256(text(HMAC.key), text(HMAC.message))) === HMAC.mac, "HMAC-SHA256"); });
  await check("pbkdf2-sha256", async () => { expect(await crypto.derive("password", "73616c74", 2) === PBKDF2, "PBKDF2-HMAC-SHA256"); });
  await check("aes-256-gcm", async () => {
    const key = "00".repeat(32), nonce = "00".repeat(12), sealed = await crypto.sealBytes(key, nonce, text("kolo"), text("aad"));
    expect(hex(sealed) === GCM, "AES-256-GCM known answer");
    expect(crypto.decodeText(await crypto.openBytes(key, nonce, sealed, text("aad"))) === "kolo", "AES-256-GCM open");
    const altered = sealed.slice(); altered[0] = altered[0]! ^ 1;
    expect(await refuses(() => crypto.openBytes(key, nonce, altered, text("aad"))), "AES-256-GCM must refuse altered bytes");
  });
  await check("x25519", async () => {
    expect(hex(crypto.x25519(unhex(X25519.alice), unhex(X25519.bob))) === X25519.shared, "X25519 known answer");
  });
  await check("ed25519-verify", async () => {
    const key = pem(unhex(ED25519_SPKI + ED25519.publicKey), crypto);
    expect(await crypto.verify(key, "", ED25519.signature) === true, "Ed25519 must accept the RFC 8032 signature");
    const forged = `${ED25519.signature.slice(0, -2)}0a`;
    expect(await crypto.verify(key, "", forged).catch(() => false) === false, "Ed25519 must refuse a changed signature");
  });
  await check("argon2id", async () => {
    const key = await crypto.argon2id(text(GOLDEN_PASSWORD), new Uint8Array(16).fill(3), { memoryKiB: 65536, passes: 3, parallelism: 1, length: 32 });
    expect(hex(key) === ARGON2ID, "Argon2id known answer");
  });
  const golden = crypto.decodeBase64(GOLDEN_CONTAINER_BASE64), expected = new Uint8Array(4200);
  for (let at = 0; at < expected.length; at += 32) expected.set(unhex(await crypto.sha256Bytes(text(`kolo golden ${at}`))).subarray(0, expected.length - at), at);
  const owner = await deriveRecoveryKey(new Uint8Array(32).fill(0x42), crypto).catch(() => undefined);
  await check("golden-password", async () => { expect(same(await decryptTransfer(golden, "backup", GOLDEN_PASSWORD, crypto), expected), "golden content"); });
  await check("golden-recovery-key", async () => {
    expect(owner !== undefined, "recovery key derivation");
    expect(same(await decryptTransfer(golden, "backup", { recoveryKey: owner! }, crypto), expected), "golden content");
  });
  await check("round-trip", async () => {
    expect(owner !== undefined, "recovery key derivation");
    const content = unhex(crypto.randomHex(70_000)), id = "01a14975-26a9-763e-ae2c-82869a7fbe36";
    const file = await encryptTransfer(content, "backup", id, { password: "platform check password", recipients: [{ keyId: owner!.keyId, publicKey: owner!.publicKey }] }, crypto);
    expect(same(await decryptTransfer(file, "backup", "platform check password", crypto), content), "password slot");
    expect(same(await decryptTransfer(file, "backup", { recoveryKey: owner! }, crypto), content), "recovery slot");
  });
  if (sealing !== undefined) {
    await check("hkdf-sha256", async () => { expect(await sealing.hkdf("0b".repeat(22), "", "", 42) === HKDF, "HKDF-SHA256 known answer"); });
    await check("hmac-text", async () => { expect(await sealing.hmac(hex(text(HMAC.key)), HMAC.message) === HMAC.mac, "HMAC of text"); });
    await check("ephemeral-agreement", async () => {
      const agreed = await sealing.ephemeralAgreement(pem(unhex(X25519_SPKI + X25519.bob), crypto));
      expect(hex(crypto.x25519(unhex(X25519.bobPrivate), rawOfPem(agreed.publicKey, crypto))) === agreed.shared, "both sides agree");
    });
  }
  return { ok: checks.every(item => item.ok), checks };
}
