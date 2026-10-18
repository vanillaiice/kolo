import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { argon2, argon2Sync, randomBytes, pbkdf2, createHash, createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomUUIDv7 } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { canonicalJson } from "@kolo/contracts/canonical";
import { CONTAINER_CHUNK_BYTES, RECIPIENT_SUITE, TRANSFER_LIMITS, type TransferPurpose } from "@kolo/contracts/transfer";
import { nativeTransferCrypto } from "./native-crypto.ts";
import { decryptTransfer, encryptTransfer, inspectContainer, isTransferContainer, readContainerHeader, sealContainer, type SealKeys } from "./encryption.ts";
import { transferFileFromText, transferFileKind, transferFileText } from "./file-kind.ts";
import { X25519_PKCS8_PREFIX, X25519_SPKI_PREFIX, openBase, sealBase } from "./hpke.ts";
import { deriveRecoveryKey, type RecoveryKeyPair } from "./recovery-key.ts";
import { TransferError, type TransferCrypto } from "./types.ts";

const password="a portable backup password",purposes=["backup","enrollment","exchange","receipt"] as const;
/** Real OpenSSL through the production shared framing, with a test-only Node codec backend. */
const crypto=nativeTransferCrypto({
 randomHex:n=>randomBytes(n).toString("hex"),derive:(p,s,n)=>new Promise<string>((resolve,reject)=>pbkdf2(p,Buffer.from(s,"hex"),n,32,"sha256",(e,k)=>e===null?resolve(k.toString("hex")):reject(e))),
 sha256:async s=>createHash("sha256").update(s).digest("hex"),sha256Bytes:async b=>createHash("sha256").update(b).digest("hex"),verify:async()=>false,
 encodeText:s=>new Uint8Array(Buffer.from(s,"utf8")),decodeText:b=>Buffer.from(b).toString("utf8"),encodeBase64:b=>Buffer.from(b).toString("base64"),decodeBase64:s=>new Uint8Array(Buffer.from(s,"base64")),fromHex:s=>new Uint8Array(Buffer.from(s,"hex")),toHex:b=>Buffer.from(b).toString("hex"),
 createSha256:()=>{const hash=createHash("sha256");return {update:(bytes:Uint8Array)=>{hash.update(bytes);},digest:()=>hash.digest("hex")};},
 hmacSha256:(key,data)=>new Uint8Array(createHmac("sha256",key).update(data).digest()),
 x25519:(privateKey,publicKey)=>new Uint8Array(diffieHellman({privateKey:createPrivateKey({key:Buffer.from([...X25519_PKCS8_PREFIX,...privateKey]),format:"der",type:"pkcs8"}),publicKey:createPublicKey({key:Buffer.from([...X25519_SPKI_PREFIX,...publicKey]),format:"der",type:"spki"})})),
 argon2id:(message,salt,params)=>new Promise<Uint8Array>((resolve,reject)=>argon2("argon2id",{message,nonce:salt,memory:params.memoryKiB,passes:params.passes,parallelism:params.parallelism,tagLength:params.length,...(params.secret===undefined?{}:{secret:params.secret}),...(params.associatedData===undefined?{}:{associatedData:params.associatedData})},(error,key)=>error===null?resolve(new Uint8Array(key)):reject(new Error("native derivation failed")))),
 cipher:(k,n)=>createCipheriv("aes-256-gcm",Buffer.from(k,"hex"),Buffer.from(n,"hex"),{authTagLength:16}),decipher:(k,n)=>createDecipheriv("aes-256-gcm",Buffer.from(k,"hex"),Buffer.from(n,"hex"),{authTagLength:16}),
});
/** Same primitives, but each Argon2id input is derived once and key work is counted, so thousands of mutated files stay fast. */
function cachedCrypto():TransferCrypto&{work:()=>number}{
 const keys=new Map<string,Promise<Uint8Array>>();let count=0;
 return {...crypto,argon2id:(message,salt,params)=>{count++;const id=`${Buffer.from(message).toString("hex")}:${Buffer.from(salt).toString("hex")}:${params.memoryKiB}:${params.passes}:${params.parallelism}`;
  if(!keys.has(id))keys.set(id,crypto.argon2id(message,salt,params));return keys.get(id)!.then(key=>key.slice());},
  x25519:(privateKey,publicKey)=>{count++;return crypto.x25519(privateKey,publicKey);},work:()=>count};
}
const random=(length:number):Uint8Array=>{const bytes=new Uint8Array(length);for(let at=0;at<length;at+=65_536)bytes.set(randomBytes(Math.min(65_536,length-at)),at);return bytes;};
const code=(expected:TransferError["code"])=>(error:unknown)=>error instanceof TransferError&&error.code===expected;
const anyTransferError=(error:unknown)=>error instanceof TransferError;
/** Deterministic xorshift generator so fuzz failures reproduce from the printed seed. */
function generator(seed:number):(limit:number)=>number{let x=seed>>>0||1;return limit=>{x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;return x%limit;};}
/** A recovery key pair from fixed input, as ADR-036 derives it from the owner's secret. */
const recovery=async(fill:number):Promise<RecoveryKeyPair>=>deriveRecoveryKey(new Uint8Array(32).fill(fill),crypto);
const recipientOf=(pair:RecoveryKeyPair)=>({keyId:pair.keyId,publicKey:pair.publicKey});

// ---- An independent implementation of the ADR-035 layout: Node crypto and zlib, Node's own Argon2, and the RFC-vector-checked HPKE. ----
const MAGIC=Buffer.from([0x89,0x4b,0x4f,0x4c,0x4f,0x0d,0x0a,0x1a]);
const latin1=(text:string)=>Buffer.from(text,"latin1");
const argonCache=new Map<string,Buffer>();
function oracleArgon(secret:string,salt:string,memory:number,passes:number,parallelism:number):Buffer{
 const id=`${secret}:${salt}:${memory}:${passes}:${parallelism}`;
 if(!argonCache.has(id))argonCache.set(id,argon2Sync("argon2id",{message:Buffer.from(secret.normalize("NFC"),"utf8"),nonce:Buffer.from(salt,"hex"),memory,passes,parallelism,tagLength:32}));
 return argonCache.get(id)!;
}
function gcm(key:Buffer,nonce:Buffer,aad:Buffer,plain:Uint8Array):Buffer{const c=createCipheriv("aes-256-gcm",key,nonce);c.setAAD(aad);return Buffer.concat([c.update(plain),c.final(),c.getAuthTag()]);}
function ungcm(key:Buffer,nonce:Buffer,aad:Buffer,sealed:Buffer):Buffer{const d=createDecipheriv("aes-256-gcm",key,nonce);d.setAAD(aad);d.setAuthTag(sealed.subarray(sealed.length-16));return Buffer.concat([d.update(sealed.subarray(0,sealed.length-16)),d.final()]);}
const params=(slot:Record<string,unknown>)=>latin1(canonicalJson(Object.fromEntries(Object.entries(slot).filter(([k])=>k!=="nonce"&&k!=="enc"&&k!=="wrapped"))));
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest();
function chunkNonce(prefix:string,index:number,final:boolean):Buffer{const nonce=Buffer.alloc(12);Buffer.from(prefix,"hex").copy(nonce,0);nonce.writeUInt32BE(index,7);nonce[11]=final?1:0;return nonce;}
interface Layout { prefix:Buffer; header:Record<string,unknown>; slotsText:string; slots:Record<string,unknown>[]; records:Buffer }
/** Splits a container into its sections exactly as ADR-035 lays them out. */
function oracleLayout(file:Uint8Array):Layout{
 const bytes=Buffer.from(file);assert.ok(bytes.subarray(0,8).equals(MAGIC));
 const h=bytes.readUInt32BE(8),headerText=bytes.subarray(12,12+h).toString("latin1"),s=bytes.readUInt32BE(12+h),slotsText=bytes.subarray(16+h,16+h+s).toString("latin1");
 const header=JSON.parse(headerText),slots=JSON.parse(slotsText).slots;
 assert.equal(canonicalJson(header),headerText);assert.equal(canonicalJson({slots}),slotsText);
 return {prefix:bytes.subarray(0,12+h),header,slotsText,slots,records:bytes.subarray(16+h+s)};
}
type OracleKey={password:string}|{recoveryKey:RecoveryKeyPair};
/** Opens a container exactly as ADR-035 describes. */
async function oracleOpen(file:Uint8Array,key:OracleKey):Promise<{header:Record<string,unknown>;dek:Buffer;content:Buffer}>{
 const {prefix,header,slots,records}=oracleLayout(file),digest=sha(prefix);
 let dek:Buffer;
 if("password" in key){const slot=slots.find(s=>s["type"]==="password")!;const kek=oracleArgon(key.password,String(slot["salt"]),Number(slot["memory_kib"]),Number(slot["passes"]),Number(slot["parallelism"]));
  dek=ungcm(kek,Buffer.from(String(slot["nonce"]),"hex"),Buffer.concat([latin1("kolo.slot.password.v1\0"),digest,params(slot)]),Buffer.from(String(slot["wrapped"]),"hex"));}
 else{const slot=slots.find(s=>s["key_id"]===key.recoveryKey.keyId)!;
  dek=Buffer.from(await openBase(Buffer.from(String(slot["enc"]),"hex"),key.recoveryKey.privateKey,Buffer.concat([latin1("kolo.backup-slot.v1\0"),digest]),params(slot),Buffer.from(String(slot["wrapped"]),"hex"),crypto));}
 const record=Number(header["chunk_bytes"])+16,count=Math.ceil(records.length/record),parts:Buffer[]=[];
 for(let i=0;i<count;i++)parts.push(ungcm(dek,chunkNonce(String(header["nonce_prefix"]),i,i===count-1),prefix,records.subarray(i*record,Math.min((i+1)*record,records.length))));
 const content=inflateRawSync(Buffer.concat(parts));assert.equal(content.length,header["content_bytes"]);
 return {header,dek,content};
}
interface Craft {
 purpose?:string;chunkBytes?:number;prefix?:string;fileId?:string;dek?:Buffer;salt?:string;
 /** Replaces content-header fields before encoding (a malicious or future writer). */
 header?:Record<string,unknown>;
 /** Replaces the exact content-header text. */
 headerText?:string;
 /** Changes the slots after they are sealed. */
 slots?:(slots:Record<string,unknown>[])=>unknown[];
 /** Replaces the exact slot-section text. */
 slotsText?:string;
 /** Password-slot fields to use instead of the writer's values (sealed with them). */
 kdf?:Record<string,unknown>;
 /** Encrypts these bytes instead of the raw-DEFLATE of the content. */
 payload?:Uint8Array;
 /** Overrides the final-chunk flag. */
 final?:(index:number,count:number)=>boolean;
}
/** Writes a container per ADR-035, with knobs to break each rule one at a time. */
async function oracleSeal(content:Uint8Array,keys:{password?:string;recipients?:readonly RecoveryKeyPair[]},o:Craft={}):Promise<Uint8Array>{
 const chunkBytes=o.chunkBytes??4096,payload=Buffer.from(o.payload??deflateRawSync(content)),recipients=[...keys.recipients??[]].sort((a,b)=>a.keyId<b.keyId?-1:1);
 const header={format:"kolo.encrypted",format_version:3,purpose:o.purpose??"backup",file_id:o.fileId??"01a14975-26a9-763e-ae2c-82869a7fbe36",cipher:"AES-256-GCM",compression:"deflate",
  nonce_prefix:o.prefix??"01020304050607",chunk_bytes:chunkBytes,content_bytes:content.byteLength,recipients:recipients.map(r=>r.keyId),...o.header};
 const headerText=o.headerText??canonicalJson(header),prefix=Buffer.concat([MAGIC,Buffer.alloc(4),latin1(headerText)]);prefix.writeUInt32BE(Buffer.byteLength(headerText,"latin1"),8);
 const digest=sha(prefix),dek=o.dek??Buffer.alloc(32,0x5a),slots:Record<string,unknown>[]=[];
 if(keys.password!==undefined){
  const slot:Record<string,unknown>={type:"password",kdf:"argon2id",memory_kib:65_536,passes:3,parallelism:1,salt:o.salt??"0f".repeat(16),nonce:"0e".repeat(12),...o.kdf};
  const kek=oracleArgon(keys.password,String(slot["salt"]),Number(slot["memory_kib"])||65_536,Number(slot["passes"])||3,Number(slot["parallelism"])||1);
  slot["wrapped"]=gcm(kek,Buffer.from(String(slot["nonce"]),"hex"),Buffer.concat([latin1("kolo.slot.password.v1\0"),digest,params(slot)]),dek).toString("hex");slots.push(slot);
 }
 for(const recipient of recipients){
  const slot:Record<string,unknown>={type:"recipient",suite:RECIPIENT_SUITE,key_id:recipient.keyId};
  const sealed=await sealBase(recipient.publicKey,Buffer.concat([latin1("kolo.backup-slot.v1\0"),digest]),params(slot),dek,crypto);
  slots.push({...slot,enc:Buffer.from(sealed.enc).toString("hex"),wrapped:Buffer.from(sealed.ciphertext).toString("hex")});
 }
 const slotsText=o.slotsText??canonicalJson({slots:o.slots?o.slots(slots):slots}),slotBytes=latin1(slotsText),length=Buffer.alloc(4);length.writeUInt32BE(slotBytes.length);
 const count=Math.ceil(payload.length/chunkBytes),parts:Buffer[]=[prefix,length,slotBytes];
 for(let i=0;i<count;i++)parts.push(gcm(dek,chunkNonce(String(header.nonce_prefix),i,(o.final??((index,total)=>index===total-1))(i,count)),prefix,payload.subarray(i*chunkBytes,Math.min((i+1)*chunkBytes,payload.length))));
 return new Uint8Array(Buffer.concat(parts));
}
const recordsAt=(file:Uint8Array):number=>{const b=Buffer.from(file),h=b.readUInt32BE(8);return 16+h+b.readUInt32BE(12+h);};

it("writes a container: magic, canonical ASCII sections, a password slot, exact length, fresh keys and no plaintext",async()=>{
 const marker=crypto.encodeText(`{"sale":"marker-${"x".repeat(5000)}"}`),id=randomUUIDv7(),fast=cachedCrypto();
 const one=await encryptTransfer(marker,"exchange",id,password,fast),two=await encryptTransfer(marker,"exchange",id,password,fast);
 assert.ok(isTransferContainer(one));assert.deepEqual([...one.subarray(0,8)],[...MAGIC]);
 const a=oracleLayout(one),b=oracleLayout(two);
 assert.deepEqual({...a.header,nonce_prefix:undefined},{format:"kolo.encrypted",format_version:3,purpose:"exchange",file_id:id,cipher:"AES-256-GCM",compression:"deflate",
  chunk_bytes:CONTAINER_CHUNK_BYTES,content_bytes:marker.byteLength,recipients:[],nonce_prefix:undefined});
 assert.equal(a.slots.length,1);assert.deepEqual({...a.slots[0],salt:undefined,nonce:undefined,wrapped:undefined},{type:"password",kdf:"argon2id",memory_kib:65_536,passes:3,parallelism:1,salt:undefined,nonce:undefined,wrapped:undefined});
 assert.notEqual(a.header["nonce_prefix"],b.header["nonce_prefix"]);assert.notEqual(a.slots[0]!["salt"],b.slots[0]!["salt"]);
 assert.notDeepEqual((await oracleOpen(one,{password})).dek,(await oracleOpen(two,{password})).dek,"every file has its own key");
 for(const byte of [...a.prefix.subarray(12),...latin1(a.slotsText)])assert.ok(byte>=0x20&&byte<=0x7e);
 const body=one.byteLength-recordsAt(one),chunks=Math.ceil(body/(CONTAINER_CHUNK_BYTES+16));
 assert.ok(body-16*chunks>0&&body-16*chunks<marker.byteLength,"compressed records follow the slots");
 assert.equal(Buffer.from(one).includes("marker"),false);assert.equal(Buffer.from(one).includes("sale"),false);
 assert.deepEqual(await decryptTransfer(one,"exchange",password,fast),marker);
});

it("the writer's sections are pinned field for field",async()=>{
 let call=0;const values=["11","22","33","44"],fixed={...cachedCrypto(),randomHex:(n:number)=>values[call++]!.repeat(n)};
 const file=await encryptTransfer(new Uint8Array([7,7,7]),"receipt","01a14975-26a9-763e-ae2c-82869a7fbe36",password,fixed),layout=oracleLayout(file);
 assert.equal(layout.prefix.subarray(12).toString("latin1"),`{"chunk_bytes":1048576,"cipher":"AES-256-GCM","compression":"deflate","content_bytes":3,"file_id":"01a14975-26a9-763e-ae2c-82869a7fbe36","format":"kolo.encrypted","format_version":3,"nonce_prefix":"11111111111111","purpose":"receipt","recipients":[]}`);
 assert.equal(canonicalJson({...layout.slots[0],wrapped:"w"}),`{"kdf":"argon2id","memory_kib":65536,"nonce":"${"44".repeat(12)}","parallelism":1,"passes":3,"salt":"${"33".repeat(16)}","type":"password","wrapped":"w"}`);
 assert.deepEqual((await oracleOpen(file,{password})).dek,Buffer.alloc(32,0x22),"the file key is the second random draw");
});

it("an independent implementation opens what KOLO writes, for password and recovery-key slots, across chunk sizes and boundaries",async()=>{
 const owner=await recovery(1),second=await recovery(2),fast=cachedCrypto();let boundaryHit=false;
 for(const chunk of [4096,65_536]){
  for(const size of [1,2,100,chunk-6,chunk-5,chunk-4,chunk,chunk+1,2*chunk-5,2*chunk,3*chunk+17]){
   for(const content of [random(size),crypto.encodeText("SQLite page ".repeat(Math.max(1,Math.ceil(size/12)))).subarray(0,size)]){
    const file=await sealContainer(content,"backup",randomUUIDv7(),{recipients:[recipientOf(owner),recipientOf(second)]},fast,TRANSFER_LIMITS,chunk);
    const opened=await oracleOpen(file,{recoveryKey:owner});assert.equal(opened.header["chunk_bytes"],chunk);assert.deepEqual(new Uint8Array(opened.content),content);
    assert.deepEqual((await oracleOpen(file,{recoveryKey:second})).content,opened.content);
    const body=file.byteLength-recordsAt(file),count=Math.ceil(body/(chunk+16));if((body-16*count)%chunk===0)boundaryHit=true;
   }
  }
 }
 // Search sizes around one chunk until a payload fills its last record exactly, so that boundary is always covered. The
 // compressed size of random bytes varies with the bytes, so each size gets a few draws and the range is wide.
 for(let size=4096-400,draw=0;!boundaryHit&&size<4096+400;draw=(draw+1)%4,size+=draw===0?1:0){
  const content=random(size),file=await sealContainer(content,"backup",randomUUIDv7(),{recipients:[recipientOf(owner)]},fast,TRANSFER_LIMITS,4096);
  const body=file.byteLength-recordsAt(file),count=Math.ceil(body/4112);
  if((body-16*count)%4096===0){boundaryHit=true;assert.deepEqual(new Uint8Array((await oracleOpen(file,{recoveryKey:owner})).content),content);}
 }
 assert.ok(boundaryHit,"at least one payload filled its last chunk exactly");
 const both=await encryptTransfer(random(2*CONTAINER_CHUNK_BYTES+12_345),"backup",randomUUIDv7(),{password,recipients:[recipientOf(owner)]},fast);
 assert.equal(Math.ceil((both.byteLength-recordsAt(both))/(CONTAINER_CHUNK_BYTES+16)),3);
 assert.deepEqual((await oracleOpen(both,{password})).content,(await oracleOpen(both,{recoveryKey:owner})).content);
});

it("KOLO opens what an independent implementation writes, for every accepted chunk size and both slot kinds",async()=>{
 const owner=await recovery(3),fast=cachedCrypto();
 for(const chunkBytes of [4096,8192,65_536,1024*1024,4*1024*1024])for(const size of [1,4095,4096,4097,20_000]){
  const content=random(size),file=await oracleSeal(content,{password,recipients:[owner]},{chunkBytes});
  assert.deepEqual(await decryptTransfer(file,"backup",password,fast),content);assert.deepEqual(await decryptTransfer(file,"backup",{recoveryKey:owner},fast),content);
 }
 // Stored DEFLATE blocks make the payload length exact (content + 5 bytes), so these hit chunk boundaries precisely.
 for(const payloadBytes of [4095,4096,4097,8191,8192,8193,12_288]){
  const content=random(payloadBytes-5),payload=deflateRawSync(content,{level:0});assert.equal(payload.length,payloadBytes);
  const file=await oracleSeal(content,{recipients:[owner]},{payload});assert.equal(file.byteLength,recordsAt(file)+payloadBytes+16*Math.ceil(payloadBytes/4096));
  assert.deepEqual(await decryptTransfer(file,"backup",{recoveryKey:owner},fast),content);
 }
});

it("a fixed container written to the specification stays readable with its password and its recovery key",async()=>{
 const file=new Uint8Array(readFileSync(new URL("./fixtures/golden-v3.kolo-backup",import.meta.url)));
 assert.equal(createHash("sha256").update(file).digest("hex"),GOLDEN_SHA256);
 const expected=Buffer.alloc(4200);for(let i=0;i<expected.length;i+=32)createHash("sha256").update(`kolo golden ${i}`).digest().copy(expected,i);
 assert.equal(transferFileKind(file,crypto),"backup");assert.equal(readContainerHeader(file).header.chunk_bytes,4096);
 assert.deepEqual(await decryptTransfer(file,"backup","golden vector password",crypto),new Uint8Array(expected));
 assert.deepEqual(await decryptTransfer(file,"backup",{recoveryKey:await recovery(0x42)},crypto),new Uint8Array(expected));
 await assert.rejects(decryptTransfer(file,"backup",password,crypto),code("authentication_failed"));
});
const GOLDEN_SHA256="86ca1de22eada46d2c06b2565f372e2dece9d7342666b96ede8e936c0028c635";

it("only a matching password or recovery key and the declared purpose open a file; a wrong purpose costs no key work",async()=>{
 const fast=cachedCrypto(),owner=await recovery(4),stranger=await recovery(5),content=crypto.encodeText('{"sale":100}');
 for(const written of purposes){
  const file=await encryptTransfer(content,written,randomUUIDv7(),{password,recipients:[recipientOf(owner)]},fast);
  for(const read of purposes){
   const before=fast.work();
   if(read===written){assert.deepEqual(await decryptTransfer(file,read,password,fast),content);assert.deepEqual(await decryptTransfer(file,read,{recoveryKey:owner},fast),content);}
   else{await assert.rejects(decryptTransfer(file,read,password,fast),code("invalid_file"));assert.equal(fast.work(),before);}
  }
  await assert.rejects(decryptTransfer(file,written,"another long password",fast),code("authentication_failed"));
  const before=fast.work();await assert.rejects(decryptTransfer(file,written,{recoveryKey:stranger},fast),code("authentication_failed"));assert.equal(fast.work(),before,"no slot for that key: no work");
  for(const weak of ["short","123456789012345","            x"])await assert.rejects(decryptTransfer(file,written,weak,fast),code("invalid_password"));
 }
 const recoveryOnly=await encryptTransfer(content,"backup",randomUUIDv7(),{recipients:[recipientOf(owner)]},fast);
 await assert.rejects(decryptTransfer(recoveryOnly,"backup",password,fast),code("authentication_failed"),"no password slot");
});

it("single-byte changes: the prefix, the records and the slot in use are always refused; another slot never changes the content",async()=>{
 const fast=cachedCrypto(),owner=await recovery(6),content=random(9000);
 const file=await sealContainer(content,"backup",randomUUIDv7(),{password,recipients:[recipientOf(owner)]},fast,TRANSFER_LIMITS,4096),start=recordsAt(file);
 assert.equal(Math.ceil((file.byteLength-start)/4112),3);
 const h=Buffer.from(file).readUInt32BE(8),slotsAt=16+h,passwordSlot=[Buffer.from(file).indexOf("{\"kdf\"",slotsAt),Buffer.from(file).indexOf("},{",slotsAt)+1] as const;
 assert.ok(passwordSlot[0]>slotsAt&&passwordSlot[1]>passwordSlot[0]);
 const inPassword=(at:number)=>at>=passwordSlot[0]&&at<passwordSlot[1],inRecipient=(at:number)=>at>=slotsAt&&at<start&&!inPassword(at);
 /** A change outside the slot being used may be accepted (slots are independent), but must never alter what is decrypted. */
 const refusedOrSame=async(bytes:Uint8Array,key:string|{recoveryKey:RecoveryKeyPair},name:string)=>{
  try{assert.deepEqual(await decryptTransfer(bytes,"backup",key,fast),content,name);}catch(error){assert.ok(anyTransferError(error),`${name}: ${String(error)}`);}
 };
 for(let at=0;at<file.byteLength;at++){
  const bad=file.slice();bad[at]=bad[at]!^(at%2===0?0x01:0x80);
  if(at>=start)await assert.rejects(decryptTransfer(bad,"backup",{recoveryKey:owner},fast),code("authentication_failed"),`record byte ${at}`);
  else if(inPassword(at))await refusedOrSame(bad,{recoveryKey:owner},`password-slot byte ${at} opened with the recovery key`);
  else await assert.rejects(decryptTransfer(bad,"backup",{recoveryKey:owner},fast),anyTransferError,`byte ${at}`);
 }
 // The same from the password's side: its own slot is always refused, the recipient slot never alters the content.
 for(let at=slotsAt;at<start;at++){
  const bad=file.slice();bad[at]=bad[at]!^0x01;
  if(inRecipient(at))await refusedOrSame(bad,password,`recipient-slot byte ${at} opened with the password`);
  else await assert.rejects(decryptTransfer(bad,"backup",password,fast),anyTransferError,`password-slot byte ${at}`);
 }
});

it("truncation at every length, at chunk boundaries and appended data are refused",async()=>{
 const fast=cachedCrypto(),owner=await recovery(7),file=await sealContainer(random(9000),"backup",randomUUIDv7(),{recipients:[recipientOf(owner)]},fast,TRANSFER_LIMITS,4096),start=recordsAt(file);
 for(let length=0;length<file.byteLength;length++)await assert.rejects(decryptTransfer(file.subarray(0,length),"backup",{recoveryKey:owner},fast),anyTransferError,`length ${length}`);
 // Dropping whole final records leaves a well-formed shorter file whose new last chunk was not sealed as final.
 for(const records of [1,2])await assert.rejects(decryptTransfer(file.subarray(0,start+(3-records)*4112),"backup",{recoveryKey:owner},fast),code("authentication_failed"));
 const last=file.subarray(start+2*4112);
 for(const extra of [new Uint8Array(1),new Uint8Array(16),new Uint8Array(17),last,file.subarray(start,start+4112)])
  await assert.rejects(decryptTransfer(Buffer.concat([file,extra]),"backup",{recoveryKey:owner},fast),anyTransferError);
});

it("reordered, duplicated and spliced chunks and transplanted or swapped slots are refused",async()=>{
 const fast=cachedCrypto(),owner=await recovery(8),keys:SealKeys={recipients:[recipientOf(owner)]},content=random(13_000);
 const file=await sealContainer(content,"backup",randomUUIDv7(),keys,fast,TRANSFER_LIMITS,4096);
 const record=(source:Uint8Array,index:number)=>source.subarray(recordsAt(source)+index*4112,recordsAt(source)+(index+1)*4112);
 const replace=(source:Uint8Array,index:number,value:Uint8Array)=>{const copy=source.slice();copy.set(value,recordsAt(source)+index*4112);return copy;};
 const open=(bytes:Uint8Array)=>decryptTransfer(bytes,"backup",{recoveryKey:owner},fast);
 await assert.rejects(open(replace(replace(file,0,record(file,1)),1,record(file,0))),code("authentication_failed"));
 await assert.rejects(open(replace(file,1,record(file,0))),code("authentication_failed"));
 const sibling=await sealContainer(random(13_000),"backup",randomUUIDv7(),keys,fast,TRANSFER_LIMITS,4096);
 await assert.rejects(open(replace(file,1,record(sibling,1))),code("authentication_failed"));
 // Even with the same file key and nonce prefix, the content header (here only the file ID differs) binds every chunk.
 const a=await oracleSeal(content,{recipients:[owner]},{fileId:"01a14975-26a9-763e-ae2c-82869a7fbe36"}),b=await oracleSeal(random(13_000),{recipients:[owner]},{fileId:"01a14975-26a9-763e-ae2c-82869a7fbe37"});
 assert.deepEqual(await open(a),content);
 await assert.rejects(open(replace(a,1,record(b,1))),code("authentication_failed"));
 // A slot from another file (same recovery key) is bound to that file's prefix.
 const withSlotsOf=(target:Uint8Array,source:Uint8Array)=>{const t=oracleLayout(target),s=oracleLayout(source),length=Buffer.alloc(4);length.writeUInt32BE(s.slotsText.length);return new Uint8Array(Buffer.concat([t.prefix,length,latin1(s.slotsText),t.records]));};
 await assert.rejects(open(withSlotsOf(a,b)),code("authentication_failed"));
 await assert.rejects(open(withSlotsOf(file,sibling)),code("authentication_failed"));
 // Swapping the encapsulation between two recipient slots breaks both.
 const two=await recovery(9),slots=oracleLayout(await oracleSeal(content,{recipients:[owner,two]})).slots;
 const swapped=await oracleSeal(content,{recipients:[owner,two]},{slots:list=>list.map((slot,i)=>({...slot,enc:slots[1-i]!["enc"]}))});
 await assert.rejects(open(swapped),code("authentication_failed"));await assert.rejects(decryptTransfer(swapped,"backup",{recoveryKey:two},fast),code("authentication_failed"));
});

it("the final-chunk flag must be set on the last chunk and nowhere else",async()=>{
 const fast=cachedCrypto(),owner=await recovery(10),content=random(10_000),open=(file:Uint8Array)=>decryptTransfer(file,"backup",{recoveryKey:owner},fast);
 assert.deepEqual(await open(await oracleSeal(content,{recipients:[owner]})),content);
 for(const final of [()=>false,()=>true,(index:number)=>index===0,(index:number,count:number)=>index===count-2])
  await assert.rejects(open(await oracleSeal(content,{recipients:[owner]},{final})),code("authentication_failed"));
 await assert.rejects(open(await oracleSeal(new Uint8Array([1]),{recipients:[owner]},{final:()=>false})),code("authentication_failed"));
});

it("content headers must be canonical, strict, ASCII and bounded, all before any key work",async()=>{
 const fast=cachedCrypto(),owner=await recovery(11),content=new Uint8Array([1,2,3,4]),seal=(o:Craft)=>oracleSeal(content,{password,recipients:[owner]},o);
 const canonical=oracleLayout(await seal({})).header,text=canonicalJson(canonical);
 const reordered="{"+Object.keys(canonical).reverse().map(key=>`${JSON.stringify(key)}:${JSON.stringify(canonical[key])}`).join(",")+"}";
 const invalid:[string,Craft][]=[
  ["whitespace",{headerText:JSON.stringify(canonical,null,1)}],["reordered keys",{headerText:reordered}],["duplicate key",{headerText:text.replace("{",'{"chunk_bytes":4096,')}],
  ["unknown field",{header:{extra:1}}],["missing field",{headerText:canonicalJson(Object.fromEntries(Object.entries(canonical).filter(([key])=>key!=="file_id")))}],
  ["old key field",{header:{salt:"ab".repeat(32)}}],["array",{headerText:"[]"}],["not JSON",{headerText:"kolo"}],
  ["chunk not a power of two",{header:{chunk_bytes:5000}}],["chunk too small",{header:{chunk_bytes:2048}}],["chunk too large",{header:{chunk_bytes:8*1024*1024}}],
  ["empty content",{header:{content_bytes:0}}],["fractional content",{headerText:text.replace(/"content_bytes":4,/,'"content_bytes":4.5,')}],["short prefix",{prefix:"010203"}],
  ["cipher",{header:{cipher:"AES-128-GCM"}}],["compression",{header:{compression:"none"}}],["purpose",{purpose:"other"}],["format",{header:{format:"other"}}],
  ["uppercase file ID",{fileId:"01A14975-26A9-763E-AE2C-82869A7FBE36"}],["unsorted recipients",{header:{recipients:["f".repeat(32),"0".repeat(32)]}}],
  ["duplicate recipients",{header:{recipients:["0".repeat(32),"0".repeat(32)]}}],["control character",{headerText:text.replace("kolo.encrypted","kolo.encrypted\t")}],
  ["non-ASCII",{headerText:canonicalJson({...canonical,file_id:"é"})}],
 ];
 for(const [name,options] of invalid){const before=fast.work();await assert.rejects(decryptTransfer(await seal(options),"backup",password,fast),code("invalid_file"),name);assert.equal(fast.work(),before,name);}
 for(const version of [1,2,4,"3"])await assert.rejects(decryptTransfer(await seal({header:{format_version:version}}),"backup",password,fast),code("unsupported_version"),String(version));
 const file=await seal({});
 for(const length of [0,4097,file.byteLength,0xffffffff]){const bad=file.slice();new DataView(bad.buffer).setUint32(8,length,false);await assert.rejects(decryptTransfer(bad,"backup",password,fast),code("invalid_file"),String(length));}
 assert.equal(fast.work(),0);
});

it("key-slot sections must be canonical, ordered, bounded and within Argon2id ranges, all before any key work",async()=>{
 const fast=cachedCrypto(),owner=await recovery(12),other=await recovery(13),content=new Uint8Array([1,2,3,4]);
 const seal=(o:Craft)=>oracleSeal(content,{password,recipients:[owner,other]},o);
 const reference=oracleLayout(await seal({})).slots;
 const invalid:[string,Craft][]=[
  ["whitespace",{slotsText:JSON.stringify({slots:reference},null,1)}],["no slots",{slotsText:canonicalJson({slots:[]})}],["not an object",{slotsText:"[]"}],
  ["password not first",{slots:list=>[list[1],list[0],list[2]]}],["recipients unsorted",{slots:list=>[list[0],list[2],list[1]]}],
  ["duplicate recipient",{slots:list=>[list[0],list[1],list[1]]}],["two password slots",{slots:list=>[list[0],list[0]]}],
  ["nine slots",{slots:list=>[list[0],...Array.from({length:8},(_,i)=>({...list[1],key_id:i.toString(16).padStart(32,"0")}))]}],
  ["unknown slot type",{slots:list=>[...list,{type:"other"}]}],["unknown field",{slots:list=>[{...list[0],extra:1},list[1],list[2]]}],
  ["memory too small",{kdf:{memory_kib:32_768}}],["memory too large",{kdf:{memory_kib:524_288}}],["memory not a power of two",{kdf:{memory_kib:100_000}}],
  ["too few passes",{kdf:{passes:2}}],["too many passes",{kdf:{passes:11}}],["no lanes",{kdf:{parallelism:0}}],["too many lanes",{kdf:{parallelism:5}}],
  ["short salt",{kdf:{salt:"0f".repeat(8)}}],["other kdf",{kdf:{kdf:"pbkdf2"}}],["other suite",{slots:list=>[list[0],{...list[1],suite:"HPKE-base-X25519-SHA256-AES128GCM"},list[2]]}],
  ["short enc",{slots:list=>[list[0],{...list[1],enc:"ab".repeat(31)},list[2]]}],["short wrapped key",{slots:list=>[{...list[0],wrapped:"ab".repeat(40)},list[1],list[2]]}],
  ["uppercase hex",{slots:list=>[{...list[0],salt:"0F".repeat(16)},list[1],list[2]]}],["control character",{slotsText:canonicalJson({slots:reference}).replace("argon2id","argon2id\t")}],
 ];
 for(const [name,options] of invalid){const before=fast.work();await assert.rejects(decryptTransfer(await seal(options),"backup",password,fast),code("invalid_file"),name);assert.equal(fast.work(),before,name);}
 const file=await seal({}),h=Buffer.from(file).readUInt32BE(8);
 for(const length of [0,16_385,file.byteLength,0xffffffff]){const bad=file.slice();new DataView(bad.buffer).setUint32(12+h,length,false);await assert.rejects(decryptTransfer(bad,"backup",password,fast),code("invalid_file"),String(length));}
 assert.equal(fast.work(),0);
 // Stronger parameters within the ranges are honoured, so later files can be strengthened without breaking earlier ones.
 assert.deepEqual(await decryptTransfer(await seal({kdf:{memory_kib:131_072,passes:4,parallelism:2}}),"backup",password,fast),content);
});

it("slots can be added or removed without re-encrypting, and a removed slot the file was sealed for reads as damage",async()=>{
 const fast=cachedCrypto(),owner=await recovery(14),later=await recovery(15),content=random(9000);
 const file=await sealContainer(content,"backup",randomUUIDv7(),{password,recipients:[recipientOf(owner)]},fast,TRANSFER_LIMITS,4096),layout=oracleLayout(file),{dek}=await oracleOpen(file,{password});
 const rewrite=(slots:unknown[])=>{const text=latin1(canonicalJson({slots})),length=Buffer.alloc(4);length.writeUInt32BE(text.length);return new Uint8Array(Buffer.concat([layout.prefix,length,text,layout.records]));};
 // The owner, holding the file key, adds a recipient: same prefix and records.
 const sealed=await sealBase(later.publicKey,Buffer.concat([latin1("kolo.backup-slot.v1\0"),sha(layout.prefix)]),params({type:"recipient",suite:RECIPIENT_SUITE,key_id:later.keyId}),dek,crypto);
 const extra={type:"recipient",suite:RECIPIENT_SUITE,key_id:later.keyId,enc:Buffer.from(sealed.enc).toString("hex"),wrapped:Buffer.from(sealed.ciphertext).toString("hex")};
 const [first,...rest]=layout.slots,added=rewrite([first,...[...rest,extra].sort((x,y)=>String(x["key_id"])<String(y["key_id"])?-1:1)]);
 for(const key of [{password},{recoveryKey:owner},{recoveryKey:later}])assert.deepEqual(await decryptTransfer(added,"backup",key,fast),content);
 assert.equal(inspectContainer(added).recipients.length,2);assert.deepEqual(inspectContainer(added).sealedFor,[owner.keyId]);
 // Removing the password slot leaves the recovery key working; removing the sealed-for recipient is reported as damage.
 const noPassword=rewrite(layout.slots.filter(slot=>slot["type"]!=="password"));
 await assert.rejects(decryptTransfer(noPassword,"backup",password,fast),code("authentication_failed"));assert.deepEqual(await decryptTransfer(noPassword,"backup",{recoveryKey:owner},fast),content);
 const noRecipient=rewrite(layout.slots.filter(slot=>slot["type"]!=="recipient"));
 await assert.rejects(decryptTransfer(noRecipient,"backup",{recoveryKey:owner},fast),code("invalid_file"));assert.deepEqual(await decryptTransfer(noRecipient,"backup",password,fast),content);
 // Changing a slot's parameters breaks it even when the new values are valid.
 const retuned=rewrite(layout.slots.map(slot=>slot["type"]==="password"?{...slot,passes:4}:slot));
 await assert.rejects(decryptTransfer(retuned,"backup",password,fast),code("authentication_failed"));
});

it("file and content limits are checked before key work, in readers and writers",async()=>{
 const fast=cachedCrypto(),owner=await recovery(16),keys={recipients:[recipientOf(owner)]},tiny={contentBytes:10_000,fileBytes:7000},open={recoveryKey:owner};
 const fits=await sealContainer(random(5000),"backup",randomUUIDv7(),keys,fast,tiny,4096);
 assert.equal((await decryptTransfer(fits,"backup",open,fast,tiny)).byteLength,5000);
 const before=fast.work();
 await assert.rejects(decryptTransfer(fits,"backup",open,fast,{...tiny,fileBytes:fits.byteLength-1}),code("too_large"));
 await assert.rejects(decryptTransfer(fits,"backup",open,fast,{...tiny,contentBytes:4999}),code("too_large"));
 await assert.rejects(decryptTransfer(await oracleSeal(new Uint8Array(10_001),{recipients:[owner]}),"backup",open,fast,tiny),code("too_large"));
 await assert.rejects(decryptTransfer(await oracleSeal(new Uint8Array([1]),{recipients:[owner]},{header:{content_bytes:TRANSFER_LIMITS.contentBytes+1}}),"backup",open,fast),code("invalid_file"),"the schema caps declared content");
 assert.equal(fast.work(),before,"no key work for an oversized file");
 await assert.rejects(sealContainer(random(10_001),"backup",randomUUIDv7(),keys,fast,tiny,4096),code("too_large"));
 await assert.rejects(sealContainer(new Uint8Array(0),"backup",randomUUIDv7(),keys,fast),code("too_large"));
 assert.equal(fast.work(),before,"refused content is never sealed");
 await assert.rejects(sealContainer(random(6800),"backup",randomUUIDv7(),keys,fast,tiny,4096),code("too_large"),"a file over the bound is refused once its size is known");
});

it("the one transfer limit leaves room for incompressible content up to its content bound",async()=>{
 // Overhead of a container for n incompressible bytes: stored DEFLATE blocks (5 bytes per 65 535), one tag per chunk, prefix, both sections.
 const overhead=(n:number)=>{const payload=n+5*Math.ceil(n/65_535);return payload-n+16*Math.ceil(payload/CONTAINER_CHUNK_BYTES)+16+4096+16_384;};
 assert.ok(TRANSFER_LIMITS.contentBytes+overhead(TRANSFER_LIMITS.contentBytes)<=TRANSFER_LIMITS.fileBytes,"a maximal incompressible snapshot fits the file bound");
 assert.ok(TRANSFER_LIMITS.contentBytes>=TRANSFER_LIMITS.snapshotBytes+1024*1024+4,"content holds the largest image and its framed manifest");
 const fast=cachedCrypto(),owner=await recovery(17);
 for(const size of [1,65_535,65_536,3*CONTAINER_CHUNK_BYTES+7]){const file=await encryptTransfer(random(size),"backup",randomUUIDv7(),{password,recipients:[recipientOf(owner)]},fast);assert.ok(file.byteLength-size<=overhead(size),`${size} bytes`);}
});

it("authenticated but lying deflate streams are refused without unbounded inflation",async()=>{
 const fast=cachedCrypto(),owner=await recovery(18),bomb=deflateRawSync(new Uint8Array(8*1024*1024),{level:9});
 const declared=(contentBytes:number,payload:Uint8Array)=>oracleSeal(new Uint8Array(contentBytes),{recipients:[owner]},{payload}),open=(file:Uint8Array)=>decryptTransfer(file,"backup",{recoveryKey:owner},fast);
 await assert.rejects(open(await declared(1024,bomb)),code("invalid_file"));
 await assert.rejects(open(await declared(8*1024*1024+1,bomb)),code("invalid_file"));
 await assert.rejects(open(await declared(10,crypto.encodeText("not a deflate stream"))),code("invalid_file"));
 assert.equal((await open(await declared(8*1024*1024,bomb))).byteLength,8*1024*1024);
});

it("random and randomly mutated inputs only ever fail with a transfer error",async()=>{
 const fast=cachedCrypto(),owner=await recovery(19),seed=Date.now()>>>0,next=generator(seed);
 const plain=random(6000),valid=await sealContainer(plain,"exchange",randomUUIDv7(),{password,recipients:[recipientOf(owner)]},fast,TRANSFER_LIMITS,4096),head=valid.subarray(0,recordsAt(valid));
 for(let round=0;round<400;round++){
  let input:Uint8Array;
  switch(round%4){
   case 0:input=random(next(3000));break;
   case 1:input=Buffer.concat([MAGIC,random(next(5000))]);break;
   case 2:input=Buffer.concat([head,random(next(9000))]);break;
   default:{input=valid.slice();for(let edits=1+next(8);edits>0;edits--)input[next(input.length)]=next(256);if(next(3)===0)input=input.subarray(0,next(input.length));else if(next(3)===0)input=Buffer.concat([input,random(1+next(40))]);}
  }
  const opening=decryptTransfer(input,"exchange",round%2===0?password:{recoveryKey:owner},fast);
  // A mutation may rewrite a byte with its own value or touch only the slot not used to open: then the original content
  // opens, and nothing else ever does.
  if(round%4===3){const opened=await opening.catch((error:unknown)=>{assert.ok(anyTransferError(error),`seed ${seed} round ${round}`);return undefined;});if(opened!==undefined)assert.deepEqual(opened,plain,`seed ${seed} round ${round}`);}
  else await assert.rejects(opening,anyTransferError,`seed ${seed} round ${round}`);
  const kind=transferFileKind(input,crypto);assert.ok(kind===undefined||kind==="exchange",`seed ${seed} round ${round}`);
 }
});

it("JSON files from releases before ADR-035 are not read and not recognized",async()=>{
 const fixture=new Uint8Array(readFileSync(new URL("./fixtures/legacy-v2.kolo-backup.json",import.meta.url))),fast=cachedCrypto();
 await assert.rejects(decryptTransfer(fixture,"backup","legacy vector password",fast),code("invalid_file"));
 assert.equal(transferFileKind(fixture,crypto),undefined);assert.equal(fast.work(),0,"refused before any key work");
 for(const purpose of purposes)assert.equal(transferFileKind(crypto.encodeText(JSON.stringify({header:{format:"kolo.encrypted",format_version:2,purpose},ciphertext:"",tag:""})),crypto),undefined);
});

it("writers refuse malformed requests with stable codes",async()=>{
 const owner=await recovery(20),fast=cachedCrypto();
 await assert.rejects(encryptTransfer(new Uint8Array([1]),"backup","not-a-uuid",password,fast),code("invalid_file"));
 await assert.rejects(encryptTransfer(new Uint8Array([1]),"other" as TransferPurpose,randomUUIDv7(),password,fast),code("invalid_file"));
 await assert.rejects(encryptTransfer(new Uint8Array([1]),"backup",randomUUIDv7(),"short",fast),code("invalid_password"));
 await assert.rejects(encryptTransfer(new Uint8Array([1]),"backup",randomUUIDv7(),{},fast),code("invalid_password"),"no way to open it");
 const many=await Promise.all(Array.from({length:8},(_,i)=>recovery(100+i)));
 await assert.rejects(encryptTransfer(new Uint8Array([1]),"backup",randomUUIDv7(),{password,recipients:many.map(recipientOf)},fast),code("invalid_file"),"nine slots");
 assert.equal(inspectContainer(await encryptTransfer(new Uint8Array([1]),"backup",randomUUIDv7(),{recipients:many.map(recipientOf)},fast)).recipients.length,8);
 for(const recipients of [[recipientOf(owner),recipientOf(owner)],[{keyId:"XYZ",publicKey:owner.publicKey}],[{keyId:owner.keyId,publicKey:owner.publicKey.subarray(0,31)}]])
  await assert.rejects(encryptTransfer(new Uint8Array([1]),"backup",randomUUIDv7(),{recipients},fast),code("invalid_file"));
 for(const chunk of [1000,4095,8*1024*1024])await assert.rejects(sealContainer(new Uint8Array([1]),"backup",randomUUIDv7(),password,fast,TRANSFER_LIMITS,chunk),code("invalid_file"));
 await assert.rejects(decryptTransfer("text" as unknown as Uint8Array,"backup",password,fast),code("invalid_file"));
});

it("native byte sealing authenticates ciphertext, tag and additional data",async()=>{
 const key=crypto.randomHex(32),nonce=crypto.randomHex(12),aad=crypto.encodeText("header"),plain=random(1000),sealed=await crypto.sealBytes(key,nonce,plain,aad);
 assert.equal(sealed.byteLength,1016);assert.deepEqual(await crypto.openBytes(key,nonce,sealed,aad),plain);
 for(const at of [0,999,1000,1015]){const bad=sealed.slice();bad[at]=bad[at]!^1;await assert.rejects(crypto.openBytes(key,nonce,bad,aad));}
 await assert.rejects(crypto.openBytes(key,nonce,sealed,crypto.encodeText("Header")));await assert.rejects(crypto.openBytes(key,crypto.randomHex(12),sealed,aad));
 await assert.rejects(crypto.openBytes(key,nonce,sealed.subarray(0,15),aad));
 assert.equal((await crypto.sealBytes(key,nonce,new Uint8Array(0),aad)).byteLength,16);
});

it("public inspection reports purpose, slots and sealed-for keys without any secret",async()=>{
 const owner=await recovery(21),fast=cachedCrypto(),file=await encryptTransfer(new Uint8Array([1]),"backup","01a14975-26a9-763e-ae2c-82869a7fbe36",{password,recipients:[recipientOf(owner)]},fast);
 const before=fast.work();
 assert.deepEqual({...inspectContainer(file)},{purpose:"backup",fileId:"01a14975-26a9-763e-ae2c-82869a7fbe36",password:true,recipients:[owner.keyId],sealedFor:[owner.keyId]});
 assert.equal(fast.work(),before);
 assert.equal(inspectContainer(await encryptTransfer(new Uint8Array([1]),"exchange",randomUUIDv7(),password,fast)).recipients.length,0);
 assert.throws(()=>inspectContainer(new Uint8Array([1,2,3])),code("invalid_file"));
});

it("file kinds are recognized from public structure only, for containers and pairing proofs",async()=>{
 const fast=cachedCrypto();
 for(const purpose of purposes)assert.equal(transferFileKind(await encryptTransfer(new Uint8Array([1]),purpose,randomUUIDv7(),password,fast),crypto),purpose);
 assert.equal(transferFileKind(await oracleSeal(new Uint8Array([1]),{password},{header:{format_version:4}}),crypto),"backup","a future version is still recognized, so opening it reports the version");
 assert.equal(transferFileKind(crypto.encodeText(JSON.stringify({invite:{format:"kolo.pairing-invite"},signature:"s"})),crypto),"invite");
 assert.equal(transferFileKind(crypto.encodeText(JSON.stringify({request:{format:"kolo.pairing-request"}})),crypto),"request");
 const hostile=["","not json","null","[]","42",JSON.stringify({header:{format:"kolo.encrypted",purpose:"other"}}),JSON.stringify({header:{format:"other",purpose:"backup"}}),
  JSON.stringify({header:[]}),JSON.stringify({invite:"kolo.pairing-invite"}),JSON.stringify({__proto__:{header:{format:"kolo.encrypted",purpose:"backup"}}}),
  JSON.stringify({request:{format:"kolo.pairing-invite"}}),JSON.stringify({header:{format:"kolo.encrypted",purpose:"backup"},invite:{format:"kolo.pairing-invite"}})];
 for(const text of hostile)assert.equal(transferFileKind(crypto.encodeText(text),crypto),text===hostile.at(-1)?"invite":undefined,text);
 for(const bytes of [new Uint8Array(0),new Uint8Array(MAGIC),Buffer.concat([MAGIC,Buffer.from([0,0,0,0])]),Buffer.concat([MAGIC,Buffer.from([0,0,0,9]),Buffer.from("{\"a\":1}")]),
  Buffer.concat([MAGIC,Buffer.from([0,0,0,2]),Buffer.from([0x7b,0x80])]),Buffer.from([0x7b,0xff]),await oracleSeal(new Uint8Array([1]),{password},{purpose:"other"})])
  assert.equal(transferFileKind(bytes,crypto),undefined);
 assert.equal(transferFileKind("text" as unknown as Uint8Array,crypto),undefined);
});

it("JSON transports carry containers as strict base64 and nothing else",async()=>{
 const file=await encryptTransfer(random(3000),"enrollment",randomUUIDv7(),password,cachedCrypto()),text=transferFileText(file,crypto);
 assert.match(text,/^[A-Za-z0-9+/]+={0,2}$/);assert.deepEqual(transferFileFromText(text,crypto),file);
 for(const bad of ["",'{"header":{"format":"kolo.encrypted"}}',"not base64!",Buffer.from("plain text").toString("base64"),text.slice(1),`${text}=`])assert.throws(()=>transferFileFromText(bad,crypto),code("invalid_file"),bad.slice(0,20));
 for(const bytes of [new Uint8Array([0xff,0xfe]),crypto.encodeText("{}"),"text" as unknown as Uint8Array])assert.throws(()=>transferFileText(bytes,crypto),code("invalid_file"));
});
