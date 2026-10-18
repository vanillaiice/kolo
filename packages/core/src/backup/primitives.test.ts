import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { argon2, argon2Sync, createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, pbkdf2, randomBytes } from "node:crypto";
import { nativeTransferCrypto } from "./native-crypto.ts";
import { X25519_PKCS8_PREFIX, X25519_SPKI_PREFIX, decapsulate, deriveKeyPair, encapsulate, keySchedule, openBase, sealBase, x25519PublicKey } from "./hpke.ts";
import { PASSWORD_KDF, normalizeTransferPassword, passwordKey, validPasswordKdf } from "./encryption.ts";
import { TransferError } from "./types.ts";

/** Real OpenSSL through the production shared framing, with a test-only Node codec backend. */
const crypto=nativeTransferCrypto({
 randomHex:n=>randomBytes(n).toString("hex"),derive:(p,s,n)=>new Promise<string>((resolve,reject)=>pbkdf2(p,Buffer.from(s,"hex"),n,32,"sha256",(e,k)=>e===null?resolve(k.toString("hex")):reject(e))),
 sha256:async s=>createHash("sha256").update(s).digest("hex"),sha256Bytes:async b=>createHash("sha256").update(b).digest("hex"),verify:async()=>false,
 encodeText:s=>new Uint8Array(Buffer.from(s,"utf8")),decodeText:b=>Buffer.from(b).toString("utf8"),encodeBase64:b=>Buffer.from(b).toString("base64"),decodeBase64:s=>new Uint8Array(Buffer.from(s,"base64")),fromHex:s=>new Uint8Array(Buffer.from(s,"hex")),toHex:b=>Buffer.from(b).toString("hex"),
 createSha256:()=>{const hash=createHash("sha256");return {update:(bytes:Uint8Array)=>{hash.update(bytes);},digest:()=>hash.digest("hex")};},
 hmacSha256:(key,data)=>new Uint8Array(createHmac("sha256",key).update(data).digest()),
 x25519:(privateKey,publicKey)=>new Uint8Array(diffieHellman({privateKey:createPrivateKey({key:Buffer.from([...X25519_PKCS8_PREFIX,...privateKey]),format:"der",type:"pkcs8"}),publicKey:createPublicKey({key:Buffer.from([...X25519_SPKI_PREFIX,...publicKey]),format:"der",type:"spki"})})),
 argon2id:(password,salt,params)=>new Promise<Uint8Array>((resolve,reject)=>argon2("argon2id",{message:password,nonce:salt,memory:params.memoryKiB,passes:params.passes,parallelism:params.parallelism,tagLength:params.length,...(params.secret===undefined?{}:{secret:params.secret}),...(params.associatedData===undefined?{}:{associatedData:params.associatedData})},(error,key)=>error===null?resolve(new Uint8Array(key)):reject(new Error("native derivation failed")))),
 cipher:(k,n)=>createCipheriv("aes-256-gcm",Buffer.from(k,"hex"),Buffer.from(n,"hex"),{authTagLength:16}),decipher:(k,n)=>createDecipheriv("aes-256-gcm",Buffer.from(k,"hex"),Buffer.from(n,"hex"),{authTagLength:16}),
});
const hex=(text:string):Uint8Array=>new Uint8Array(Buffer.from(text,"hex"));
const toHex=(bytes:Uint8Array):string=>Buffer.from(bytes).toString("hex");
const code=(expected:TransferError["code"])=>(error:unknown)=>error instanceof TransferError&&error.code===expected;

interface Vector { aead_id:number; info:string; ikmE:string; ikmR:string; skEm:string; pkEm:string; skRm:string; pkRm:string; enc:string; shared_secret:string;
 key_schedule_context:string; secret:string; key:string; base_nonce:string; exporter_secret:string; encryptions:{aad:string;ct:string;nonce:string;pt:string}[] }
/** RFC 9180 base-mode vectors for DHKEM(X25519, HKDF-SHA256) and HKDF-SHA256, from the CFRG test-vector file (AEAD 1 and 2). */
const vectors=JSON.parse(readFileSync(new URL("./fixtures/hpke-rfc9180-base-x25519-sha256.json",import.meta.url),"utf8")) as Vector[];

it("RFC 9180 vectors: DeriveKeyPair, Encap/Decap and the key schedule match for both AES-GCM sizes",()=>{
 assert.deepEqual(vectors.map(v=>v.aead_id).sort(),[1,2]);
 for(const v of vectors){
  const ephemeral=deriveKeyPair(hex(v.ikmE),crypto),recipient=deriveKeyPair(hex(v.ikmR),crypto);
  assert.equal(toHex(ephemeral.privateKey),v.skEm);assert.equal(toHex(ephemeral.publicKey),v.pkEm);
  assert.equal(toHex(recipient.privateKey),v.skRm);assert.equal(toHex(recipient.publicKey),v.pkRm);
  assert.equal(toHex(x25519PublicKey(hex(v.skRm),crypto)),v.pkRm,"public keys come from the native agreement with the base point");
  const encapsulated=encapsulate(hex(v.pkRm),crypto,hex(v.ikmE));
  assert.equal(toHex(encapsulated.enc),v.enc);assert.equal(toHex(encapsulated.sharedSecret),v.shared_secret);
  assert.equal(toHex(decapsulate(hex(v.enc),hex(v.skRm),crypto)),v.shared_secret);
  const schedule=keySchedule(hex(v.shared_secret),hex(v.info),crypto,v.aead_id,v.aead_id===1?16:32);
  assert.equal(toHex(schedule.keyScheduleContext),v.key_schedule_context);assert.equal(toHex(schedule.secret),v.secret);
  assert.equal(toHex(schedule.key),v.key);assert.equal(toHex(schedule.baseNonce),v.base_nonce);assert.equal(toHex(schedule.exporterSecret),v.exporter_secret);
 }
});

it("RFC 9180 vectors: single-shot SealBase/OpenBase reproduce the AES-256-GCM ciphertext",async()=>{
 const v=vectors.find(item=>item.aead_id===2)!,first=v.encryptions[0]!;
 assert.equal(first.nonce,v.base_nonce,"single-shot uses sequence number 0");
 const sealed=await sealBase(hex(v.pkRm),hex(v.info),hex(first.aad),hex(first.pt),crypto,hex(v.ikmE));
 assert.equal(toHex(sealed.enc),v.enc);assert.equal(toHex(sealed.ciphertext),first.ct);
 assert.deepEqual(await openBase(hex(v.enc),hex(v.skRm),hex(v.info),hex(first.aad),hex(first.ct),crypto),hex(first.pt));
 // The second vector encryption (sequence 1) checks the nonce arithmetic the vectors expect, even though single-shot never uses it.
 const second=v.encryptions[1]!,nonce=hex(v.base_nonce);nonce[11]=nonce[11]!^1;assert.equal(toHex(nonce),second.nonce);
});

it("HPKE round trips with fresh keys and refuses every wrong input",async()=>{
 const recipient=deriveKeyPair(randomBytes(32),crypto),other=deriveKeyPair(randomBytes(32),crypto),info=crypto.encodeText("kolo.backup-slot.v1\0header"),aad=crypto.encodeText("params"),pt=new Uint8Array(randomBytes(32));
 const one=await sealBase(recipient.publicKey,info,aad,pt,crypto),two=await sealBase(recipient.publicKey,info,aad,pt,crypto);
 assert.notDeepEqual(one.enc,two.enc,"every seal uses a fresh ephemeral key");assert.notDeepEqual(one.ciphertext,two.ciphertext);
 assert.deepEqual(await openBase(one.enc,recipient.privateKey,info,aad,one.ciphertext,crypto),pt);
 const rejects=(promise:Promise<unknown>,name:string)=>assert.rejects(promise,code("authentication_failed"),name);
 await rejects(openBase(one.enc,other.privateKey,info,aad,one.ciphertext,crypto),"wrong private key");
 await rejects(openBase(two.enc,recipient.privateKey,info,aad,one.ciphertext,crypto),"another encapsulation");
 await rejects(openBase(one.enc,recipient.privateKey,crypto.encodeText("other info"),aad,one.ciphertext,crypto),"info binds the header");
 await rejects(openBase(one.enc,recipient.privateKey,info,crypto.encodeText("other"),one.ciphertext,crypto),"aad binds the slot");
 for(const at of [0,31,32,47]){const bad=one.ciphertext.slice();bad[at]=bad[at]!^1;await rejects(openBase(one.enc,recipient.privateKey,info,aad,bad,crypto),`ciphertext byte ${at}`);}
 const badEnc=one.enc.slice();badEnc[5]=badEnc[5]!^1;await rejects(openBase(badEnc,recipient.privateKey,info,aad,one.ciphertext,crypto),"altered enc");
 await rejects(openBase(one.enc.subarray(0,31),recipient.privateKey,info,aad,one.ciphertext,crypto),"short enc");
 // A small-order public key gives an all-zero agreement, which RFC 9180 requires aborting.
 await rejects(openBase(new Uint8Array(32),recipient.privateKey,info,aad,one.ciphertext,crypto),"all-zero agreement");
 assert.throws(()=>encapsulate(new Uint8Array(32),crypto),code("authentication_failed"),"sealing to a small-order key is refused");
 assert.throws(()=>deriveKeyPair(new Uint8Array(31),crypto),code("invalid_file"));
});

it("HPKE public keys match native X25519 key generation",()=>{
 for(let round=0;round<8;round++){
  const pair=generateKeyPairSync("x25519"),privateKey=pair.privateKey.export({format:"der",type:"pkcs8"}).subarray(16),publicKey=pair.publicKey.export({format:"der",type:"spki"}).subarray(12);
  assert.deepEqual(x25519PublicKey(new Uint8Array(privateKey),crypto),new Uint8Array(publicKey));
 }
});

it("native Argon2id reproduces the RFC 9106 test vector",async()=>{
 const tag=await crypto.argon2id(new Uint8Array(32).fill(1),new Uint8Array(16).fill(2),{memoryKiB:32,passes:3,parallelism:4,length:32,secret:new Uint8Array(8).fill(3),associatedData:new Uint8Array(12).fill(4)});
 assert.equal(toHex(tag),"0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
});

it("password keys use Argon2id over the NFC-normalized UTF-8 password",async()=>{
 const salt=new Uint8Array(16).fill(7),key=await passwordKey("correct horse battery",salt,PASSWORD_KDF,crypto);
 const expected=argon2Sync("argon2id",{message:Buffer.from("correct horse battery","utf8"),nonce:Buffer.from(salt),memory:65_536,passes:3,parallelism:1,tagLength:32});
 assert.deepEqual(key,new Uint8Array(expected));
 // Composed and decomposed forms of the same text derive the same key.
 const pairs:[string,string][]=[["Crème brûlée 2026!","Crème brûlée 2026!"],["Ñandú del Perú x","Ñandú del Perú x"],["한국어 비밀번호 열두자","한국어 비밀번호 열두자"]];
 for(const [composed,decomposed] of pairs){
  assert.notEqual(composed,decomposed);assert.equal(normalizeTransferPassword(decomposed),composed);
  assert.deepEqual(await passwordKey(decomposed,salt,PASSWORD_KDF,crypto),await passwordKey(composed,salt,PASSWORD_KDF,crypto),composed);
 }
 // Non-Latin scripts and emoji are passwords like any other; length counts UTF-16 units after normalization.
 for(const password of ["пароль-для-кассы","كلمة المرور للمحل","密码密码密码密码密码密码","🔐🏪💰🧾🔐🏪"])assert.equal(normalizeTransferPassword(password),password.normalize("NFC"));
 assert.notDeepEqual(await passwordKey("correct horse batterz",salt,PASSWORD_KDF,crypto),key);
 for(const bad of ["short","123456789012345","            x","x".repeat(257)])assert.throws(()=>normalizeTransferPassword(bad),code("invalid_password"),bad.slice(0,20));
 await assert.rejects(passwordKey("correct horse battery",new Uint8Array(8),PASSWORD_KDF,crypto),code("invalid_file"));
});

it("Argon2id parameters from a file are bounded before any work",async()=>{
 assert.equal(validPasswordKdf(PASSWORD_KDF),true);
 for(const params of [{memoryKiB:262_144,passes:10,parallelism:4},{memoryKiB:131_072,passes:3,parallelism:1}])assert.equal(validPasswordKdf(params),true,JSON.stringify(params));
 let derived=0;const counting={...crypto,argon2id:(...args:Parameters<typeof crypto.argon2id>)=>{derived++;return crypto.argon2id(...args);}};
 for(const params of [{memoryKiB:32_768,passes:3,parallelism:1},{memoryKiB:524_288,passes:3,parallelism:1},{memoryKiB:100_000,passes:3,parallelism:1},
  {memoryKiB:65_536,passes:2,parallelism:1},{memoryKiB:65_536,passes:11,parallelism:1},{memoryKiB:65_536,passes:3,parallelism:0},{memoryKiB:65_536,passes:3,parallelism:5},{memoryKiB:65_536,passes:3.5,parallelism:1}]){
  assert.equal(validPasswordKdf(params),false,JSON.stringify(params));
  await assert.rejects(passwordKey("correct horse battery",new Uint8Array(16),params,counting),code("invalid_file"),JSON.stringify(params));
 }
 assert.equal(derived,0);
});
