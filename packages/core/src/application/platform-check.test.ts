import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, argon2, generateKeyPairSync, hkdfSync, pbkdf2Sync, randomBytes, verify } from "node:crypto";
import { nativeTransferCrypto } from "../backup/native-crypto.ts";
import { X25519_PKCS8_PREFIX, X25519_SPKI_PREFIX } from "../backup/hpke.ts";
import { GOLDEN_CONTAINER_BASE64 } from "../backup/golden-container.ts";
import { runPlatformCheck } from "./platform-check.ts";
import type { SealingCrypto } from "./sealed-sync.ts";

const crypto: SealingCrypto = {
  ...nativeTransferCrypto({
    sha256: async message => createHash("sha256").update(message).digest("hex"),
    verify: async (key, message, signature) => verify(null, Buffer.from(message), key, Buffer.from(signature, "hex")),
    randomHex: bytes => randomBytes(bytes).toString("hex"), derive: async (password, salt, iterations) => pbkdf2Sync(password, Buffer.from(salt, "hex"), iterations, 32, "sha256").toString("hex"),
    sha256Bytes: async bytes => createHash("sha256").update(bytes).digest("hex"),
    encodeText: text => new Uint8Array(Buffer.from(text, "utf8")), decodeText: bytes => Buffer.from(bytes).toString("utf8"),
    encodeBase64: bytes => Buffer.from(bytes).toString("base64"), decodeBase64: text => new Uint8Array(Buffer.from(text, "base64")),
    fromHex: hex => new Uint8Array(Buffer.from(hex, "hex")), toHex: bytes => Buffer.from(bytes).toString("hex"),
createSha256:()=>{const hash=createHash("sha256");return {update:(bytes:Uint8Array)=>{hash.update(bytes);},digest:()=>hash.digest("hex")};},
hmacSha256:(key,data)=>new Uint8Array(createHmac("sha256",key).update(data).digest()),
 x25519:(privateKey,publicKey)=>new Uint8Array(diffieHellman({privateKey:createPrivateKey({key:Buffer.from([...X25519_PKCS8_PREFIX,...privateKey]),format:"der",type:"pkcs8"}),publicKey:createPublicKey({key:Buffer.from([...X25519_SPKI_PREFIX,...publicKey]),format:"der",type:"spki"})})),
 argon2id:(password,salt,params)=>new Promise<Uint8Array>((resolve,reject)=>argon2("argon2id",{message:password,nonce:salt,memory:params.memoryKiB,passes:params.passes,parallelism:params.parallelism,tagLength:params.length,...(params.secret===undefined?{}:{secret:params.secret}),...(params.associatedData===undefined?{}:{associatedData:params.associatedData})},(error,key)=>error===null?resolve(new Uint8Array(key)):reject(new Error("native derivation failed")))),
    cipher: (key, nonce) => createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(nonce, "hex"), { authTagLength: 16 }),
    decipher: (key, nonce) => createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(nonce, "hex"), { authTagLength: 16 }),
  }),
  ephemeralAgreement: async recipient => {
    const pair = generateKeyPairSync("x25519");
    return { publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), shared: diffieHellman({ privateKey: pair.privateKey, publicKey: createPublicKey(recipient) }).toString("hex") };
  },
  hkdf: async (ikm, salt, info, bytes) => Buffer.from(hkdfSync("sha256", Buffer.from(ikm, "hex"), Buffer.from(salt, "hex"), info, bytes)).toString("hex"),
  hmac: async (key, message) => createHmac("sha256", Buffer.from(key, "hex")).update(message, "utf8").digest("hex"),
};
const failed = async (broken: SealingCrypto): Promise<string[]> => (await runPlatformCheck(broken, broken)).checks.filter(item => !item.ok).map(item => item.name);

it("the embedded golden container is byte for byte the fixture file", () => {
  assert.deepEqual(Buffer.from(GOLDEN_CONTAINER_BASE64, "base64"), readFileSync(new URL("../backup/fixtures/golden-v3.kolo-backup", import.meta.url)));
});

it("a correct Node adapter passes every check, including the sealing primitives", async () => {
  const result = await runPlatformCheck(crypto, crypto);
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter(item => !item.ok)));
  assert.deepEqual(result.checks.map(item => item.name), ["utf8", "base64", "random", "nfc", "sha256", "hmac-sha256", "pbkdf2-sha256", "aes-256-gcm", "x25519",
    "ed25519-verify", "argon2id", "golden-password", "golden-recovery-key", "round-trip", "hkdf-sha256", "hmac-text", "ephemeral-agreement"]);
  assert.ok(result.checks.every(item => Number.isInteger(item.ms) && item.ms >= 0));
});

it("a runtime missing a primitive is reported by name, with the checks that depend on it, and never throws", async () => {
  // Electron's BoringSSL: Argon2 is not supported (ERR_CRYPTO_ARGON2_NOT_SUPPORTED).
  assert.deepEqual(await failed({ ...crypto, argon2id: async () => { throw new Error("Argon2 algorithm not supported"); } }), ["argon2id", "golden-password", "round-trip"]);
  assert.deepEqual(await failed({ ...crypto, x25519: () => new Uint8Array(32) }), ["x25519", "golden-recovery-key", "round-trip", "ephemeral-agreement"]);
  assert.deepEqual(await failed({ ...crypto, hmacSha256: () => new Uint8Array(32) }), ["hmac-sha256", "golden-recovery-key"], "a consistent wrong HMAC still round-trips; the golden file catches it");
  assert.deepEqual(await failed({ ...crypto, verify: async () => true }), ["ed25519-verify"]);
  assert.deepEqual(await failed({ ...crypto, derive: async () => "00".repeat(32) }), ["pbkdf2-sha256"]);
  assert.deepEqual(await failed({ ...crypto, hkdf: async () => "00".repeat(42) }), ["hkdf-sha256"]);
  assert.deepEqual(await failed({ ...crypto, encodeText: text => new Uint8Array(Buffer.from(text, "latin1")) }).then(names => names.includes("utf8")), true);
  // Hermes without full ICU: String.prototype.normalize returns its input.
  const normalize = Object.getOwnPropertyDescriptor(String.prototype, "normalize")!;
  Object.defineProperty(String.prototype, "normalize", { ...normalize, value: function (this: string) { return String(this); } });
  try { assert.deepEqual(await failed(crypto), ["nfc"]); } finally { Object.defineProperty(String.prototype, "normalize", normalize); }
  const result = await runPlatformCheck({ ...crypto, argon2id: async () => { throw new Error("Argon2 algorithm not supported"); } });
  assert.equal(result.ok, false);
  assert.match(result.checks.find(item => item.name === "argon2id")!.detail!, /Argon2 algorithm not supported/);
});
