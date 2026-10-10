import { deflateSync, inflateSync } from "fflate";
import { canonicalJson, utf8Length } from "@kolo/contracts/canonical";
import { encryptedFileSchema, STANDARD_TRANSFER_LIMITS, type EncryptedHeader, type TransferLimits } from "@kolo/contracts/transfer";
import { TRANSFER_KDF_ITERATIONS, TransferError, type TransferCrypto } from "./types.ts";

/** Backup/exchange passwords are independent of unlock PINs: 12–256 characters, not entirely digits. */
export function validateTransferPassword(password:string):void {
 if(typeof password!=="string"||password.length<12||password.length>256||password.trim().length<12||/^\d+$/.test(password))throw new TransferError("invalid_password");
}
/** Deflates, then encrypts with fresh salt/nonce, fixed expensive KDF and authenticated purpose/lengths, within one size profile. */
export async function encryptTransfer(bytes:Uint8Array,purpose:EncryptedHeader["purpose"],fileId:string,password:string,crypto:TransferCrypto,limits:TransferLimits=STANDARD_TRANSFER_LIMITS):Promise<string>{
 validateTransferPassword(password);
 if(bytes.byteLength<1||bytes.byteLength>limits.contentBytes)throw new TransferError("too_large");
 // Compress before encrypting: ciphertext does not compress, and SQLite pages shrink about fivefold.
 const compressed=deflateSync(bytes,{level:6});
 try{
  if(compressed.byteLength>limits.payloadBytes)throw new TransferError("too_large");
  const header:EncryptedHeader={format:"kolo.encrypted",format_version:2,purpose,file_id:fileId,cipher:"AES-256-GCM",kdf:"PBKDF2-SHA256",iterations:TRANSFER_KDF_ITERATIONS,
   salt:crypto.randomHex(32),nonce:crypto.randomHex(12),compression:"deflate",plaintext_bytes:compressed.byteLength,content_bytes:bytes.byteLength};
  let key:string;try{key=await crypto.derive(password,header.salt,TRANSFER_KDF_ITERATIONS);}catch{throw new TransferError("authentication_failed");}
  let result:{ciphertext:string;tag:string};try{result=await crypto.encrypt(key,header.nonce,compressed,canonicalJson(header));}catch{throw new TransferError("authentication_failed");}
  return canonicalJson(encryptedFileSchema.parse({header,...result}),limits.fileBytes);
 }finally{compressed.fill(0);}
}
/**
 * Bounds raw UTF-8 and KDF parameters before work; authenticates all bytes before returning plaintext.
 * Version 2 content is inflated into a buffer one byte larger than its authenticated length, so a
 * stream that expands further is refused without unbounded allocation. Declared lengths are checked
 * against the size profile before any key derivation or allocation.
 */
export async function decryptTransfer(text:string,purpose:EncryptedHeader["purpose"],password:string,crypto:TransferCrypto,limits:TransferLimits=STANDARD_TRANSFER_LIMITS):Promise<Uint8Array>{
 validateTransferPassword(password);
 if(typeof text!=="string"||text.length>limits.fileBytes||utf8Length(text)>limits.fileBytes)throw new TransferError("too_large");
 let input:unknown;try{input=JSON.parse(text);canonicalJson(input,limits.fileBytes);}catch{throw new TransferError("invalid_file");}
 if(input!==null&&typeof input==="object"&&"header" in input&&input.header!==null&&typeof input.header==="object"&&"format" in input.header&&input.header.format==="kolo.encrypted"&&"format_version" in input.header&&input.header.format_version!==1&&input.header.format_version!==2)throw new TransferError("unsupported_version");
 const parsed=encryptedFileSchema.safeParse(input);if(!parsed.success||parsed.data.header.purpose!==purpose)throw new TransferError("invalid_file");
 const {header,ciphertext,tag}=parsed.data;
 if(header.plaintext_bytes>limits.payloadBytes||header.format_version===2&&header.content_bytes>limits.contentBytes)throw new TransferError("too_large");
 if(ciphertext.length!==4*Math.ceil(header.plaintext_bytes/3))throw new TransferError("invalid_file");
 let key:string;try{key=await crypto.derive(password,header.salt,TRANSFER_KDF_ITERATIONS);}catch{throw new TransferError("authentication_failed");}
 let bytes:Uint8Array;try{bytes=await crypto.decrypt(key,header.nonce,ciphertext,tag,canonicalJson(header));}catch{throw new TransferError("authentication_failed");}
 if(bytes.byteLength!==header.plaintext_bytes)throw new TransferError("invalid_file");
 if(header.format_version===1)return bytes;
 try{
  let content:Uint8Array;try{content=inflateSync(bytes,{out:new Uint8Array(header.content_bytes+1)});}catch{throw new TransferError("invalid_file");}
  if(content.byteLength!==header.content_bytes){content.fill(0);throw new TransferError("invalid_file");}
  return content;
 }finally{bytes.fill(0);}
}
