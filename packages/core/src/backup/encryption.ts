import { Deflate, Inflate } from "fflate";
import { canonicalJson } from "@kolo/contracts/canonical";
import { CONTAINER_CHUNK_BYTES, CONTAINER_MAGIC, CONTAINER_PREFIX_BYTES, CONTAINER_TAG_BYTES, MAX_CONTAINER_HEADER_BYTES, MAX_CONTAINER_SLOTS_BYTES, MAX_KEY_SLOTS,
 RECIPIENT_SUITE, TRANSFER_LIMITS, containerHeaderSchema, keySlotsSchema, type ContainerHeader, type KeySlots, type TransferLimits, type TransferPurpose } from "@kolo/contracts/transfer";
import { openBase, sealBase } from "./hpke.ts";
import type { RecoveryKeyPair, RecoveryRecipient } from "./recovery-key.ts";
import { TransferError, type TransferCrypto } from "./types.ts";

/** The bounds a container reader or writer checks: decompressed content and the file itself. */
export type ContainerLimits = Pick<TransferLimits, "contentBytes" | "fileBytes">;
/** Who can open a new container: a password, recovery keys, or both (at least one). */
export interface SealKeys { readonly password?: string; readonly recipients?: readonly RecoveryRecipient[] }
/** What opens an existing container: its password, or a recovery key pair whose `keyId` has a slot. */
export type OpenKey = { readonly password: string } | { readonly recoveryKey: RecoveryKeyPair };
/** Public facts about a container, read without any secret, for choosing how to open it. */
export interface ContainerSummary { readonly purpose: TransferPurpose; readonly fileId: string; readonly password: boolean; readonly recipients: readonly string[]; readonly sealedFor: readonly string[] }

/**
 * Backup/exchange passwords are independent of unlock PINs: after Unicode NFC normalization, 12–256
 * characters, at least 12 after trimming, not entirely digits. Returns the normalized password, so the
 * same password typed on a phone and a computer derives the same key (ADR-035).
 */
export function normalizeTransferPassword(password:string):string {
 if(typeof password!=="string")throw new TransferError("invalid_password");
 const normalized=password.normalize("NFC");
 if(normalized.length<12||normalized.length>256||normalized.trim().length<12||/^\d+$/.test(normalized))throw new TransferError("invalid_password");
 return normalized;
}
/** Checks a password without keeping it; see {@link normalizeTransferPassword}. */
export function validateTransferPassword(password:string):void { normalizeTransferPassword(password); }

/** Argon2id values new password slots use (provisional until the Android measurement, ADR-035). */
export const PASSWORD_KDF=Object.freeze({memoryKiB:65_536,passes:3,parallelism:1});
/** Readers accept only these Argon2id ranges, so a file cannot demand unbounded work. */
export function validPasswordKdf(params:{readonly memoryKiB:number;readonly passes:number;readonly parallelism:number}):boolean{
 const {memoryKiB,passes,parallelism}=params;
 return Number.isSafeInteger(memoryKiB)&&memoryKiB>=65_536&&memoryKiB<=262_144&&(memoryKiB&(memoryKiB-1))===0&&Number.isSafeInteger(passes)&&passes>=3&&passes<=10&&Number.isSafeInteger(parallelism)&&parallelism>=1&&parallelism<=4;
}
/** The 32-byte key-encryption key of a password slot: Argon2id over the NFC-normalized UTF-8 password. */
export async function passwordKey(password:string,salt:Uint8Array,params:{readonly memoryKiB:number;readonly passes:number;readonly parallelism:number},crypto:TransferCrypto):Promise<Uint8Array>{
 const normalized=normalizeTransferPassword(password);
 if(!validPasswordKdf(params)||!(salt instanceof Uint8Array)||salt.length!==16)throw new TransferError("invalid_file");
 const bytes=crypto.encodeText(normalized);
 // A derivation that fails is a broken platform, not a wrong password: it propagates instead of reading as one.
 try{const key=await crypto.argon2id(bytes,salt,{memoryKiB:params.memoryKiB,passes:params.passes,parallelism:params.parallelism,length:32});if(key.length!==32)throw new Error("derivation returned a key of the wrong length");return key;}
 finally{bytes.fill(0);}
}

/** True when `bytes` begin with the container magic (ADR-035). */
export function isTransferContainer(bytes:Uint8Array):boolean{
 return bytes.byteLength>=CONTAINER_MAGIC.length&&CONTAINER_MAGIC.every((value,index)=>bytes[index]===value);
}
/** Sections are printable ASCII: every schema value is ASCII, so no text decoder is needed. */
function asciiBytes(text:string):Uint8Array{const bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);if(code<0x20||code>0x7e)throw new TransferError("invalid_file");bytes[i]=code;}return bytes;}
function asciiText(bytes:Uint8Array):string{let text="";for(const byte of bytes){if(byte<0x20||byte>0x7e)throw new TransferError("invalid_file");text+=String.fromCharCode(byte);}return text;}
const label=(text:string):Uint8Array=>{const bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);return bytes;};
function concat(...parts:readonly Uint8Array[]):Uint8Array{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;}
function hex(bytes:Uint8Array):string{let text="";for(const byte of bytes)text+=byte.toString(16).padStart(2,"0");return text;}
function hexBytes(text:string):Uint8Array{const bytes=new Uint8Array(text.length/2);for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(text.slice(2*i,2*i+2),16);return bytes;}
/** Chunk i's nonce: the file's 7-byte prefix, a 32-bit big-endian counter and the final-chunk flag. */
function chunkNonce(prefix:string,index:number,final:boolean):string{return `${prefix}${index.toString(16).padStart(8,"0")}${final?"01":"00"}`;}
/** Canonical JSON of a slot without its per-seal values: the parameters its wrapping authenticates. */
function slotParams(slot:Record<string,unknown>):Uint8Array{const params:Record<string,unknown>={};for(const [key,value] of Object.entries(slot))if(key!=="nonce"&&key!=="enc"&&key!=="wrapped")params[key]=value;return asciiBytes(canonicalJson(params));}
const PASSWORD_LABEL="kolo.slot.password.v1\0",RECIPIENT_LABEL="kolo.backup-slot.v1\0";

/** Reads one length-prefixed canonical ASCII JSON section at `offset`. */
function section(file:Uint8Array,offset:number,maximum:number):{text:string;value:unknown;end:number}{
 if(file.byteLength<offset+4)throw new TransferError("invalid_file");
 const length=new DataView(file.buffer,file.byteOffset,file.byteLength).getUint32(offset,false);
 if(length<1||length>maximum||offset+4+length>file.byteLength)throw new TransferError("invalid_file");
 const text=asciiText(file.subarray(offset+4,offset+4+length));
 let value:unknown;try{value=JSON.parse(text);}catch{throw new TransferError("invalid_file");}
 return {text,value,end:offset+4+length};
}
/** The parsed public structure of a container: content header, prefix, key slots and where records start. */
interface Parsed { header:ContainerHeader; prefix:Uint8Array; slots:KeySlots; records:number }
function parse(file:Uint8Array):Parsed{
 if(!(file instanceof Uint8Array)||!isTransferContainer(file))throw new TransferError("invalid_file");
 const head=section(file,CONTAINER_MAGIC.length,MAX_CONTAINER_HEADER_BYTES),value=head.value;
 if(value!==null&&typeof value==="object"&&!Array.isArray(value)&&"format" in value&&value.format==="kolo.encrypted"&&"format_version" in value&&value.format_version!==3)throw new TransferError("unsupported_version");
 const header=containerHeaderSchema.safeParse(value);
 // One file has one valid encoding: each section must be the canonical form of its parsed value.
 if(!header.success||canonicalJson(header.data)!==head.text)throw new TransferError("invalid_file");
 const tail=section(file,head.end,MAX_CONTAINER_SLOTS_BYTES),slots=keySlotsSchema.safeParse(tail.value);
 if(!slots.success||canonicalJson(slots.data)!==tail.text)throw new TransferError("invalid_file");
 return {header:header.data,prefix:file.subarray(0,head.end),slots:slots.data,records:tail.end};
}

/**
 * Reads a container's public structure without any secret: purpose, file ID, whether it has a password
 * slot, the recovery keys it was sealed for when written (`sealedFor`) and those that still have a slot
 * (`recipients`). A `kolo.encrypted` header of another version is `unsupported_version`.
 */
export function inspectContainer(file:Uint8Array):ContainerSummary{
 const {header,slots}=parse(file);
 return Object.freeze({purpose:header.purpose,fileId:header.file_id,password:slots.slots.some(slot=>slot.type==="password"),
  recipients:Object.freeze(slots.slots.flatMap(slot=>slot.type==="recipient"?[slot.key_id]:[])),sealedFor:Object.freeze([...header.recipients])});
}
/** The immutable content header of a container and the prefix bytes every chunk authenticates (public). */
export function readContainerHeader(file:Uint8Array):{header:ContainerHeader;prefix:Uint8Array}{const {header,prefix}=parse(file);return {header,prefix};}

/** Random-access bytes of a file whose size is known: a selected file on disk, or an array in memory. */
export interface ByteReader { readonly size:number; read(offset:number,length:number):Promise<Uint8Array> }
/** A reader over bytes already in memory. */
export function memoryReader(bytes:Uint8Array):ByteReader{return {size:bytes.byteLength,read:async(offset,length)=>bytes.subarray(offset,Math.min(offset+length,bytes.byteLength))};}
/** Lets the event loop run between chunks, so a till keeps serving its screens during a long backup or restore. */
const breathe=():Promise<void>=>new Promise(resolve=>setTimeout(resolve,0));
/** Compressed input is fed to inflate in slices this size, so one slice can expand to at most about 16 MiB before the bound is checked. */
const INFLATE_SLICE=16*1024;

/**
 * Writes a container (ADR-035) as a stream: the prefix and key slots first, then each 1 MiB record as soon as its
 * compressed bytes exist. `content` must yield exactly `contentBytes` bytes. Memory stays a few chunks whatever the size.
 */
export async function* sealStream(content:AsyncIterable<Uint8Array>,contentBytes:number,purpose:TransferPurpose,fileId:string,keys:string|SealKeys,crypto:TransferCrypto,limits:ContainerLimits=TRANSFER_LIMITS,chunkBytes:number=CONTAINER_CHUNK_BYTES):AsyncGenerator<Uint8Array>{
 const {password,recipients=[]}=typeof keys==="string"?{password:keys}:keys;
 if(password!==undefined)normalizeTransferPassword(password);
 if(password===undefined&&recipients.length===0)throw new TransferError("invalid_password");
 const sorted=[...recipients].sort((a,b)=>a.keyId<b.keyId?-1:a.keyId>b.keyId?1:0);
 if(sorted.length+(password===undefined?0:1)>MAX_KEY_SLOTS||sorted.some((r,i)=>!/^[a-f0-9]{32}$/.test(r.keyId)||!(r.publicKey instanceof Uint8Array)||r.publicKey.length!==32||(i>0&&sorted[i-1]!.keyId===r.keyId)))throw new TransferError("invalid_file");
 if(!Number.isSafeInteger(contentBytes)||contentBytes<1||contentBytes>limits.contentBytes)throw new TransferError("too_large");
 const parsed=containerHeaderSchema.safeParse({format:"kolo.encrypted",format_version:3,purpose,file_id:fileId,cipher:"AES-256-GCM",compression:"deflate",
  nonce_prefix:crypto.randomHex(7),chunk_bytes:chunkBytes,content_bytes:contentBytes,recipients:sorted.map(r=>r.keyId)});
 if(!parsed.success)throw new TransferError("invalid_file");
 const header=parsed.data,headerBytes=asciiBytes(canonicalJson(header)),prefix=new Uint8Array(CONTAINER_PREFIX_BYTES+headerBytes.byteLength);
 prefix.set(CONTAINER_MAGIC,0);new DataView(prefix.buffer).setUint32(8,headerBytes.byteLength,false);prefix.set(headerBytes,CONTAINER_PREFIX_BYTES);
 const digest=hexBytes(await crypto.sha256Bytes(prefix)),dek=hexBytes(crypto.randomHex(32));
 try{
  const slots:Record<string,unknown>[]=[];
  if(password!==undefined){
   const slot:Record<string,unknown>={type:"password",kdf:"argon2id",memory_kib:PASSWORD_KDF.memoryKiB,passes:PASSWORD_KDF.passes,parallelism:PASSWORD_KDF.parallelism,salt:crypto.randomHex(16),nonce:crypto.randomHex(12)};
   const kek=await passwordKey(password,hexBytes(String(slot["salt"])),PASSWORD_KDF,crypto);
   try{slot["wrapped"]=hex(await crypto.sealBytes(hex(kek),String(slot["nonce"]),dek,concat(label(PASSWORD_LABEL),digest,slotParams(slot))));}
   catch{throw new TransferError("authentication_failed");}finally{kek.fill(0);}
   slots.push(slot);
  }
  for(const recipient of sorted){
   const slot:Record<string,unknown>={type:"recipient",suite:RECIPIENT_SUITE,key_id:recipient.keyId};
   const sealed=await sealBase(recipient.publicKey,concat(label(RECIPIENT_LABEL),digest),slotParams(slot),dek,crypto);
   slots.push({...slot,enc:hex(sealed.enc),wrapped:hex(sealed.ciphertext)});
  }
  const slotBytes=asciiBytes(canonicalJson(keySlotsSchema.parse({slots})));
  if(slotBytes.byteLength>MAX_CONTAINER_SLOTS_BYTES)throw new TransferError("invalid_file");
  const lead=new Uint8Array(prefix.byteLength+4+slotBytes.byteLength);lead.set(prefix,0);new DataView(lead.buffer).setUint32(prefix.byteLength,slotBytes.byteLength,false);lead.set(slotBytes,prefix.byteLength+4);
  let written=lead.byteLength;
  yield lead;
  // Compressed bytes wait here until a whole record can be sealed. A full record is sealed only when more bytes follow it,
  // so the record that ends the stream is always the one marked final.
  const queue:Uint8Array[]=[];let queued=0,index=0,finished=false,received=0;
  const deflate=new Deflate({level:6},(data,final)=>{if(data.byteLength>0){queue.push(data);queued+=data.byteLength;}if(final)finished=true;});
  const take=(length:number):Uint8Array=>{const out=new Uint8Array(length);let at=0;while(at<length){const head=queue[0]!,part=Math.min(head.byteLength,length-at);out.set(head.subarray(0,part),at);at+=part;if(part===head.byteLength)queue.shift();else queue[0]=head.subarray(part);}queued-=length;return out;};
  const key=hex(dek);
  async function seal(final:boolean):Promise<Uint8Array>{
   const chunk=take(final?queued:chunkBytes);
   try{
    let sealed:Uint8Array;try{sealed=await crypto.sealBytes(key,chunkNonce(header.nonce_prefix,index,final),chunk,prefix);}catch{throw new TransferError("authentication_failed");}
    if(sealed.byteLength!==chunk.byteLength+CONTAINER_TAG_BYTES)throw new TransferError("authentication_failed");
    index++;written+=sealed.byteLength;
    if(written>limits.fileBytes||index>0xffffffff)throw new TransferError("too_large");
    return sealed;
   }finally{chunk.fill(0);}
  }
  for await (const piece of content){
   if(!(piece instanceof Uint8Array))throw new TransferError("invalid_file");
   received+=piece.byteLength;
   if(received>contentBytes)throw new TransferError("too_large");
   deflate.push(piece,false);
   while(queued>chunkBytes){yield await seal(false);await breathe();}
  }
  if(received!==contentBytes)throw new TransferError("invalid_file");
  deflate.push(new Uint8Array(0),true);
  if(!finished)throw new TransferError("invalid_file");
  while(queued>chunkBytes)yield await seal(false);
  yield await seal(true);
 }finally{dek.fill(0);}
}

/**
 * @internal Writes a whole container in memory with a chosen chunk size. Production writers use {@link encryptTransfer}
 * (1 MiB chunks) or {@link sealStream}; tests use small chunks to exercise many of them cheaply.
 */
export async function sealContainer(content:Uint8Array,purpose:TransferPurpose,fileId:string,keys:string|SealKeys,crypto:TransferCrypto,limits:ContainerLimits=TRANSFER_LIMITS,chunkBytes:number=CONTAINER_CHUNK_BYTES):Promise<Uint8Array>{
 if(!(content instanceof Uint8Array)||content.byteLength<1||content.byteLength>limits.contentBytes)throw new TransferError("too_large");
 const parts:Uint8Array[]=[];let total=0;
 async function* source():AsyncGenerator<Uint8Array>{for(let at=0;at<content.byteLength;at+=chunkBytes)yield content.subarray(at,Math.min(at+chunkBytes,content.byteLength));}
 for await (const part of sealStream(source(),content.byteLength,purpose,fileId,keys,crypto,limits,chunkBytes)){parts.push(part);total+=part.byteLength;}
 const file=new Uint8Array(total);let at=0;for(const part of parts){file.set(part,at);at+=part.byteLength;}
 return file;
}

/** Deflates, then encrypts into a container (ADR-035) under a fresh file key wrapped for a password and/or recovery keys. */
export async function encryptTransfer(bytes:Uint8Array,purpose:TransferPurpose,fileId:string,keys:string|SealKeys,crypto:TransferCrypto,limits:ContainerLimits=TRANSFER_LIMITS):Promise<Uint8Array>{
 return sealContainer(bytes,purpose,fileId,keys,crypto,limits);
}

/** Unwraps the file key from the slot `key` opens; any mismatch is `authentication_failed`. */
async function fileKey(parsed:Parsed,key:OpenKey,crypto:TransferCrypto):Promise<Uint8Array>{
 const digest=hexBytes(await crypto.sha256Bytes(parsed.prefix));
 let dek:Uint8Array;
 if("password" in key){
  const slot=parsed.slots.slots.find(item=>item.type==="password");
  if(slot===undefined||slot.type!=="password")throw new TransferError("authentication_failed");
  const kek=await passwordKey(key.password,hexBytes(slot.salt),{memoryKiB:slot.memory_kib,passes:slot.passes,parallelism:slot.parallelism},crypto);
  try{dek=await crypto.openBytes(hex(kek),slot.nonce,hexBytes(slot.wrapped),concat(label(PASSWORD_LABEL),digest,slotParams(slot)));}
  catch{throw new TransferError("authentication_failed");}finally{kek.fill(0);}
 }else{
  const pair=key.recoveryKey,slot=parsed.slots.slots.find(item=>item.type==="recipient"&&item.key_id===pair.keyId);
  // A key the file was sealed for whose slot is gone means a damaged file, not a wrong key.
  if(slot===undefined||slot.type!=="recipient")throw new TransferError(parsed.header.recipients.includes(pair.keyId)?"invalid_file":"authentication_failed");
  dek=await openBase(hexBytes(slot.enc),pair.privateKey,concat(label(RECIPIENT_LABEL),digest),slotParams(slot),hexBytes(slot.wrapped),crypto);
 }
 if(dek.length!==32){dek.fill(0);throw new TransferError("authentication_failed");}
 return dek;
}

/**
 * Opens a container as a stream of content chunks. Size, both sections, purpose, declared content length, slot parameters
 * and record shape are checked before any key derivation. **Chunks are provisional:** the final record, the exact content
 * length and the end of the deflate stream are only known at the end, and any failure then throws. A caller may only
 * write yielded chunks somewhere private (a staging file) and must discard them if the stream throws.
 */
export async function* openStream(reader:ByteReader,purpose:TransferPurpose,key:string|OpenKey,crypto:TransferCrypto,limits:ContainerLimits=TRANSFER_LIMITS):AsyncGenerator<Uint8Array>{
 const open:OpenKey=typeof key==="string"?{password:key}:key;
 if("password" in open)normalizeTransferPassword(open.password);
 if(reader===null||typeof reader!=="object"||!Number.isSafeInteger(reader.size)||reader.size<0)throw new TransferError("invalid_file");
 if(reader.size>limits.fileBytes)throw new TransferError("too_large");
 const head=await reader.read(0,Math.min(reader.size,CONTAINER_PREFIX_BYTES+MAX_CONTAINER_HEADER_BYTES+4+MAX_CONTAINER_SLOTS_BYTES));
 const parsed=parse(head),{header}=parsed;
 if(header.purpose!==purpose)throw new TransferError("invalid_file");
 if(header.content_bytes>limits.contentBytes)throw new TransferError("too_large");
 const record=header.chunk_bytes+CONTAINER_TAG_BYTES,body=reader.size-parsed.records,chunks=Math.ceil(body/record);
 if(chunks<1||body-(chunks-1)*record<=CONTAINER_TAG_BYTES||chunks>0x100000000)throw new TransferError("invalid_file");
 const prefix=parsed.prefix.slice(),dek=await fileKey(parsed,open,crypto);
 try{
  const keyHex=hex(dek),out:Uint8Array[]=[];let produced=0,ended=false;
  const inflate=new Inflate((data,final)=>{if(data.byteLength>0){produced+=data.byteLength;if(produced>header.content_bytes)throw new TransferError("invalid_file");out.push(data);}if(final)ended=true;});
  for(let index=0;index<chunks;index++){
   const start=parsed.records+index*record,sealed=await reader.read(start,Math.min(record,reader.size-start)),last=index===chunks-1;
   if(sealed.byteLength!==Math.min(record,reader.size-start))throw new TransferError("invalid_file");
   let chunk:Uint8Array;try{chunk=await crypto.openBytes(keyHex,chunkNonce(header.nonce_prefix,index,last),sealed,prefix);}catch{throw new TransferError("authentication_failed");}
   try{
    if(chunk.byteLength!==sealed.byteLength-CONTAINER_TAG_BYTES)throw new TransferError("authentication_failed");
    for(let at=0;at<chunk.byteLength;at+=INFLATE_SLICE){
     // Bytes after the end of the deflate stream are refused, not ignored.
     if(ended)throw new TransferError("invalid_file");
     try{inflate.push(chunk.subarray(at,Math.min(at+INFLATE_SLICE,chunk.byteLength)),last&&at+INFLATE_SLICE>=chunk.byteLength);}
     catch(error){if(error instanceof TransferError)throw error;throw new TransferError("invalid_file");}
     while(out.length>0)yield out.shift()!;
    }
   }finally{chunk.fill(0);}
   await breathe();
  }
  if(!ended||produced!==header.content_bytes)throw new TransferError("invalid_file");
 }finally{dek.fill(0);}
}

/**
 * Decrypts a whole container in memory. Size, both sections, purpose, declared content length, slot parameters and
 * record shape are checked before any key derivation; one slot is unwrapped, then every chunk authenticates before any
 * content is returned, and content beyond its authenticated length is refused. Anything that is not a container,
 * including the JSON files of releases before ADR-035, is `invalid_file`. A password string is shorthand for `{ password }`.
 */
export async function decryptTransfer(file:Uint8Array,purpose:TransferPurpose,key:string|OpenKey,crypto:TransferCrypto,limits:ContainerLimits=TRANSFER_LIMITS):Promise<Uint8Array>{
 if(!(file instanceof Uint8Array))throw new TransferError("invalid_file");
 const parts:Uint8Array[]=[];let total=0;
 try{
  for await (const part of openStream(memoryReader(file),purpose,key,crypto,limits)){parts.push(part);total+=part.byteLength;}
  const content=new Uint8Array(total);let at=0;for(const part of parts){content.set(part,at);at+=part.byteLength;}
  return content;
 }finally{for(const part of parts)part.fill(0);}
}
