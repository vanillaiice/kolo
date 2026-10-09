import { canonicalJson, utf8Length } from "@kolo/contracts/canonical";
import { encryptedFileSchema, type EncryptedHeader } from "@kolo/contracts/transfer";
import { MAX_TRANSFER_FILE_BYTES, TRANSFER_KDF_ITERATIONS, TransferError, type TransferCrypto } from "./types.ts";

/** Backup/exchange passwords are independent of unlock PINs: 12–256 characters, not entirely digits. */
export function validateTransferPassword(password:string):void {
 if(typeof password!=="string"||password.length<12||password.length>256||password.trim().length<12||/^\d+$/.test(password))throw new TransferError("invalid_password");
}
/** Encrypts a bounded payload with fresh salt/nonce, fixed expensive KDF and authenticated purpose/length. */
export async function encryptTransfer(bytes:Uint8Array,purpose:EncryptedHeader["purpose"],fileId:string,password:string,crypto:TransferCrypto):Promise<string>{
 validateTransferPassword(password);
 if(bytes.byteLength<1||bytes.byteLength>18*1024*1024)throw new TransferError("too_large");
 const header:EncryptedHeader={format:"kolo.encrypted",format_version:1,purpose,file_id:fileId,cipher:"AES-256-GCM",kdf:"PBKDF2-SHA256",iterations:TRANSFER_KDF_ITERATIONS,salt:crypto.randomHex(32),nonce:crypto.randomHex(12),plaintext_bytes:bytes.byteLength};
 let key:string;try{key=await crypto.derive(password,header.salt,TRANSFER_KDF_ITERATIONS);}catch{throw new TransferError("authentication_failed");}
 let result:{ciphertext:string;tag:string};try{result=await crypto.encrypt(key,header.nonce,bytes,canonicalJson(header));}catch{throw new TransferError("authentication_failed");}
 const encoded=canonicalJson(encryptedFileSchema.parse({header,...result}),MAX_TRANSFER_FILE_BYTES);
 return encoded;
}
/** Bounds raw UTF-8 and KDF parameters before work; authenticates all bytes before returning plaintext. */
export async function decryptTransfer(text:string,purpose:EncryptedHeader["purpose"],password:string,crypto:TransferCrypto):Promise<Uint8Array>{
 validateTransferPassword(password);
 if(typeof text!=="string"||text.length>MAX_TRANSFER_FILE_BYTES||utf8Length(text)>MAX_TRANSFER_FILE_BYTES)throw new TransferError("too_large");
 let input:unknown;try{input=JSON.parse(text);canonicalJson(input,MAX_TRANSFER_FILE_BYTES);}catch{throw new TransferError("invalid_file");}
 if(input!==null&&typeof input==="object"&&"header" in input&&input.header!==null&&typeof input.header==="object"&&"format" in input.header&&input.header.format==="kolo.encrypted"&&"format_version" in input.header&&input.header.format_version!==1)throw new TransferError("unsupported_version");
 const parsed=encryptedFileSchema.safeParse(input);if(!parsed.success||parsed.data.header.purpose!==purpose)throw new TransferError("invalid_file");
 const {header,ciphertext,tag}=parsed.data;
 if(ciphertext.length!==4*Math.ceil(header.plaintext_bytes/3))throw new TransferError("invalid_file");
 let key:string;try{key=await crypto.derive(password,header.salt,TRANSFER_KDF_ITERATIONS);}catch{throw new TransferError("authentication_failed");}
 let bytes:Uint8Array;try{bytes=await crypto.decrypt(key,header.nonce,ciphertext,tag,canonicalJson(header));}catch{throw new TransferError("authentication_failed");}
 if(bytes.byteLength!==header.plaintext_bytes)throw new TransferError("invalid_file");
 return bytes;
}
