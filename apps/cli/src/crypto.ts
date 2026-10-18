import { createHash, createCipheriv, createDecipheriv, randomBytes, pbkdf2, verify, sign, generateKeyPairSync, timingSafeEqual, diffieHellman, createPrivateKey, createPublicKey, hkdf, createHmac, argon2 } from "node:crypto";
import { nativeTransferCrypto } from "@kolo/core/backup/native-crypto";
import type { CredentialCrypto } from "@kolo/core/identity/credentials";
import type { SealingCrypto } from "@kolo/core/application/sealed-sync";
import { X25519_PKCS8_PREFIX, X25519_SPKI_PREFIX } from "@kolo/core/backup/hpke";

const derive: CredentialCrypto["derive"] = (password, salt, iterations) => new Promise((resolve, reject) => {
  pbkdf2(password, Buffer.from(salt, "hex"), iterations, 32, "sha256", (error, bytes) => {
    if (error) reject(new Error("native derivation failed")); else resolve(bytes.toString("hex"));
  });
});
const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");
export const transferCrypto = nativeTransferCrypto({
  randomHex, derive,
  sha256: async message => createHash("sha256").update(message, "utf8").digest("hex"),
  sha256Bytes: async bytes => createHash("sha256").update(bytes).digest("hex"),
  verify: async (publicKey, message, signature) => verify(null, Buffer.from(message, "utf8"), publicKey, Buffer.from(signature, "hex")),
  encodeText: text => new Uint8Array(Buffer.from(text, "utf8")),
  decodeText: bytes => Buffer.from(bytes).toString("utf8"),
  encodeBase64: bytes => Buffer.from(bytes).toString("base64"),
  decodeBase64: text => new Uint8Array(Buffer.from(text, "base64")),
  fromHex: hex => new Uint8Array(Buffer.from(hex, "hex")),
  toHex: bytes => Buffer.from(bytes).toString("hex"),
createSha256:()=>{const hash=createHash("sha256");return {update:(bytes:Uint8Array)=>{hash.update(bytes);},digest:()=>hash.digest("hex")};},
hmacSha256:(key,data)=>new Uint8Array(createHmac("sha256",key).update(data).digest()),
 x25519:(privateKey,publicKey)=>new Uint8Array(diffieHellman({privateKey:createPrivateKey({key:Buffer.from([...X25519_PKCS8_PREFIX,...privateKey]),format:"der",type:"pkcs8"}),publicKey:createPublicKey({key:Buffer.from([...X25519_SPKI_PREFIX,...publicKey]),format:"der",type:"spki"})})),
 argon2id:(password,salt,params)=>new Promise<Uint8Array>((resolve,reject)=>argon2("argon2id",{message:password,nonce:salt,memory:params.memoryKiB,passes:params.passes,parallelism:params.parallelism,tagLength:params.length,...(params.secret===undefined?{}:{secret:params.secret}),...(params.associatedData===undefined?{}:{associatedData:params.associatedData})},(error,key)=>error===null?resolve(new Uint8Array(key)):reject(new Error("native derivation failed")))),
  cipher: (key, nonce) => createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(nonce, "hex"), { authTagLength: 16 }),
  decipher: (key, nonce) => createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(nonce, "hex"), { authTagLength: 16 }),
});

/** Node/OpenSSL primitives; credential persistence is supplied separately. */
export const credentialCrypto: CredentialCrypto = {
  randomHex, derive,
  equalHex: (a, b) => /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
  sign: async (key, message) => sign(null, Buffer.from(message, "utf8"), key).toString("hex"),
  deviceKey: async () => {
    const pair = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    return pair;
  },
  encryptionKeyPair: async () => generateKeyPairSync("x25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }),
  agree: async (privateKey, publicKey) => diffieHellman({ privateKey: createPrivateKey(privateKey), publicKey: createPublicKey(publicKey) }).toString("hex"),
};
export const fixtureCrypto = credentialCrypto;

export const sealingCrypto: SealingCrypto = {
  ...transferCrypto,
  ephemeralAgreement: async publicKey => {
    const pair = generateKeyPairSync("x25519");
    return { publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), shared: diffieHellman({ privateKey: pair.privateKey, publicKey: createPublicKey(publicKey) }).toString("hex") };
  },
  hkdf: (ikm, salt, info, bytes) => new Promise((resolve, reject) => {
    hkdf("sha256", Buffer.from(ikm, "hex"), Buffer.from(salt, "hex"), info, bytes, (error, key) => {
      if (error) reject(new Error("native derivation failed")); else resolve(Buffer.from(key).toString("hex"));
    });
  }),
  hmac: async (key, message) => createHmac("sha256", Buffer.from(key, "hex")).update(message, "utf8").digest("hex"),
};
