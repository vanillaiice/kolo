import type { TransferCrypto } from "./types.ts";
/** Narrow native AES implementation; adapters must use platform/OpenSSL APIs, never JS cryptographic substitutes. */
export interface NativeTransferBackend extends Omit<TransferCrypto,"encrypt"|"decrypt"> {
 cipher(keyHex:string,nonceHex:string):{setAAD(bytes:Uint8Array):unknown;update(bytes:Uint8Array):Uint8Array;final():Uint8Array;getAuthTag():Uint8Array};
 decipher(keyHex:string,nonceHex:string):{setAAD(bytes:Uint8Array):unknown;setAuthTag(bytes:Uint8Array):unknown;update(bytes:Uint8Array):Uint8Array;final():Uint8Array};
 fromHex(hex:string):Uint8Array;toHex(bytes:Uint8Array):string;
}
function concat(left:Uint8Array,right:Uint8Array):Uint8Array{const result=new Uint8Array(left.length+right.length);result.set(left);result.set(right,left.length);return result;}
/** Consistent native AES-GCM framing and byte validation across desktop/mobile, with no dependency on either SDK. */
export function nativeTransferCrypto(native:NativeTransferBackend):TransferCrypto{
 return {...native,
  decodeBase64(text){const bytes=native.decodeBase64(text);if(native.encodeBase64(bytes)!==text)throw new Error("invalid base64");return bytes;},
  decodeText(bytes){const text=native.decodeText(bytes),encoded=native.encodeText(text);if(encoded.length!==bytes.length||encoded.some((value,index)=>value!==bytes[index]))throw new Error("invalid UTF-8");return text;},
  async encrypt(key,nonce,bytes,aad){const cipher=native.cipher(key,nonce);cipher.setAAD(native.encodeText(aad));const ciphertext=concat(cipher.update(bytes),cipher.final());return {ciphertext:native.encodeBase64(ciphertext),tag:native.toHex(cipher.getAuthTag())};},
  async decrypt(key,nonce,ciphertext,tag,aad){const cipher=native.decipher(key,nonce);cipher.setAAD(native.encodeText(aad));cipher.setAuthTag(native.fromHex(tag));const bytes=native.decodeBase64(ciphertext);if(native.encodeBase64(bytes)!==ciphertext)throw new Error("invalid base64");const partial=cipher.update(bytes);try{return concat(partial,cipher.final());}finally{partial.fill(0);}},
 };
}
