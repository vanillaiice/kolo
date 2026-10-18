import assert from "node:assert/strict";
import { it } from "node:test";
import { argon2, createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, pbkdf2, randomBytes, randomUUIDv7 } from "node:crypto";
import { JOIN_CODE_ALPHABET } from "@kolo/contracts/sync";
import { nativeTransferCrypto } from "./native-crypto.ts";
import { X25519_PKCS8_PREFIX, X25519_SPKI_PREFIX, deriveKeyPair } from "./hpke.ts";
import { deriveRecoveryKey, formatRecoveryKey, generateRecoverySecret, parseRecoveryKey, recoveryKeyId } from "./recovery-key.ts";
import { decryptTransfer, encryptTransfer } from "./encryption.ts";
import { TransferError } from "./types.ts";

const crypto=nativeTransferCrypto({
 randomHex:n=>randomBytes(n).toString("hex"),derive:(p,s,n)=>new Promise<string>((resolve,reject)=>pbkdf2(p,Buffer.from(s,"hex"),n,32,"sha256",(e,k)=>e===null?resolve(k.toString("hex")):reject(e))),
 sha256:async s=>createHash("sha256").update(s).digest("hex"),sha256Bytes:async b=>createHash("sha256").update(b).digest("hex"),verify:async()=>false,
 encodeText:s=>new Uint8Array(Buffer.from(s,"utf8")),decodeText:b=>Buffer.from(b).toString("utf8"),encodeBase64:b=>Buffer.from(b).toString("base64"),decodeBase64:s=>new Uint8Array(Buffer.from(s,"base64")),fromHex:s=>new Uint8Array(Buffer.from(s,"hex")),toHex:b=>Buffer.from(b).toString("hex"),
 createSha256:()=>{const hash=createHash("sha256");return {update:(bytes:Uint8Array)=>{hash.update(bytes);},digest:()=>hash.digest("hex")};},
 hmacSha256:(key,data)=>new Uint8Array(createHmac("sha256",key).update(data).digest()),
 x25519:(privateKey,publicKey)=>new Uint8Array(diffieHellman({privateKey:createPrivateKey({key:Buffer.from([...X25519_PKCS8_PREFIX,...privateKey]),format:"der",type:"pkcs8"}),publicKey:createPublicKey({key:Buffer.from([...X25519_SPKI_PREFIX,...publicKey]),format:"der",type:"spki"})})),
 argon2id:(message,salt,params)=>new Promise<Uint8Array>((resolve,reject)=>argon2("argon2id",{message,nonce:salt,memory:params.memoryKiB,passes:params.passes,parallelism:params.parallelism,tagLength:params.length},(error,key)=>error===null?resolve(new Uint8Array(key)):reject(new Error("native derivation failed")))),
 cipher:(k,n)=>createCipheriv("aes-256-gcm",Buffer.from(k,"hex"),Buffer.from(n,"hex"),{authTagLength:16}),decipher:(k,n)=>createDecipheriv("aes-256-gcm",Buffer.from(k,"hex"),Buffer.from(n,"hex"),{authTagLength:16}),
});
const code=(expected:TransferError["code"])=>(error:unknown)=>error instanceof TransferError&&error.code===expected;

it("a recovery key is 56 Crockford symbols in 14 groups of four and reads back exactly",async()=>{
 for(let round=0;round<50;round++){
  const secret=generateRecoverySecret(crypto),text=await formatRecoveryKey(secret,crypto);
  assert.match(text,/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){13}$/);
  assert.deepEqual(await parseRecoveryKey(text,crypto),secret);
 }
 for(const secret of [new Uint8Array(32),new Uint8Array(32).fill(255)])assert.deepEqual(await parseRecoveryKey(await formatRecoveryKey(secret,crypto),crypto),secret);
 assert.notDeepEqual(generateRecoverySecret(crypto),generateRecoverySecret(crypto));
});

it("typing is forgiving: case, spaces, hyphens and O/I/L lookalikes",async()=>{
 const secret=new Uint8Array(32).map((_,i)=>i*7+1),text=await formatRecoveryKey(secret,crypto),plain=text.replace(/-/g,"");
 for(const variant of [text.toLowerCase(),plain,plain.match(/.{4}/g)!.join(" "),` ${text} `,text.replace(/-/g," - "),text.replace(/0/g,"O").replace(/1/g,"l")])
  assert.deepEqual(await parseRecoveryKey(variant,crypto),secret,variant);
});

it("every single-symbol substitution and every adjacent swap is caught by the checksum or the padding",async()=>{
 const secret=new Uint8Array(32).map((_,i)=>(i*37+11)&255),symbols=(await formatRecoveryKey(secret,crypto)).replace(/-/g,"");
 let caught=0,total=0;
 for(let at=0;at<symbols.length;at++)for(const replacement of JOIN_CODE_ALPHABET){
  if(replacement===symbols[at])continue;total++;
  try{await parseRecoveryKey(symbols.slice(0,at)+replacement+symbols.slice(at+1),crypto);}catch(error){assert.ok(code("invalid_recovery_key")(error));caught++;}
 }
 // A 20-bit checksum lets a substitution through with probability about 2^-20; none of these 1 736 may pass.
 assert.equal(caught,total);
 for(let at=0;at+1<symbols.length;at++){
  if(symbols[at]===symbols[at+1])continue;
  const swapped=symbols.slice(0,at)+symbols[at+1]+symbols[at]+symbols.slice(at+2);
  await assert.rejects(parseRecoveryKey(swapped,crypto),code("invalid_recovery_key"),`swap at ${at}`);
 }
});

it("wrong lengths, foreign symbols, non-zero padding and non-strings are refused before any key work",async()=>{
 const secret=new Uint8Array(32).fill(9),symbols=(await formatRecoveryKey(secret,crypto)).replace(/-/g,"");
 const padding=symbols.slice(0,51)+JOIN_CODE_ALPHABET[(JOIN_CODE_ALPHABET.indexOf(symbols[51]!)|1)]+symbols.slice(52);
 for(const bad of ["",symbols.slice(1),symbols+"0",symbols.slice(0,55)+"U",symbols.replace(/./,"#"),"x".repeat(201),padding])
  await assert.rejects(parseRecoveryKey(bad,crypto),code("invalid_recovery_key"),bad.slice(0,20));
 await assert.rejects(parseRecoveryKey(42 as unknown as string,crypto),code("invalid_recovery_key"));
 await assert.rejects(formatRecoveryKey(new Uint8Array(31),crypto),code("invalid_recovery_key"));
 await assert.rejects(deriveRecoveryKey(new Uint8Array(33),crypto),code("invalid_recovery_key"));
});

it("the key pair is RFC 9180 DeriveKeyPair of the secret, and its ID is pinned",async()=>{
 const secret=new Uint8Array(32).fill(0x42),pair=await deriveRecoveryKey(secret,crypto),expected=deriveKeyPair(secret,crypto);
 assert.deepEqual(pair.publicKey,expected.publicKey);assert.deepEqual(pair.privateKey,expected.privateKey);
 const id=createHash("sha256").update(Buffer.concat([Buffer.from("kolo.backup-recovery-key.v1\0","latin1"),pair.publicKey])).digest("hex").slice(0,32);
 assert.equal(pair.keyId,id);assert.equal(await recoveryKeyId(pair.publicKey,crypto),id);
 assert.equal(pair.keyId,PINNED_KEY_ID,"a change here would orphan every backup sealed to this key");
 assert.notEqual((await deriveRecoveryKey(new Uint8Array(32).fill(0x43),crypto)).keyId,pair.keyId);
 await assert.rejects(recoveryKeyId(new Uint8Array(31),crypto),code("invalid_file"));
});
const PINNED_KEY_ID="effdbf4f193d317f7da723ede48997b9";

it("a backup sealed to the public half opens with the typed key and nothing else",async()=>{
 const secret=generateRecoverySecret(crypto),pair=await deriveRecoveryKey(secret,crypto),typed=(await formatRecoveryKey(secret,crypto)).toLowerCase();
 const content=crypto.encodeText('{"shop":"Boutique Awa"}'),file=await encryptTransfer(content,"backup",randomUUIDv7(),{recipients:[{keyId:pair.keyId,publicKey:pair.publicKey}]},crypto);
 const reopened=await deriveRecoveryKey(await parseRecoveryKey(typed,crypto),crypto);
 assert.deepEqual(await decryptTransfer(file,"backup",{recoveryKey:reopened},crypto),content);
 const other=await deriveRecoveryKey(generateRecoverySecret(crypto),crypto);
 await assert.rejects(decryptTransfer(file,"backup",{recoveryKey:other},crypto),code("authentication_failed"));
 // A pair claiming the right ID with the wrong private key fails authentication, never decrypts.
 await assert.rejects(decryptTransfer(file,"backup",{recoveryKey:{...other,keyId:pair.keyId}},crypto),code("authentication_failed"));
});
