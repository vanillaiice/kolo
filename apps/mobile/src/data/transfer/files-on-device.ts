import { Directory, File, FileMode } from "expo-file-system";
import { transferCryptoOnDevice } from "../auth/local-credentials-on-device.ts";
import { utf8Length } from "@kolo/contracts/canonical";
import { MAX_TRANSFER_FILE_BYTES, TransferError, type TransferDocument } from "@kolo/core/backup/types";
/** Uses the native picker, bounds reported bytes before reading contents, then rechecks UTF-8 size. */
export async function pickTransferFile():Promise<string|undefined>{
 const picked=await File.pickFileAsync({mimeTypes:["application/json","text/plain","application/octet-stream"]});if(picked.canceled)return undefined;
 const file=picked.result;if(!file.exists||file.size<=0||file.size>MAX_TRANSFER_FILE_BYTES)throw new TransferError("too_large");
 const handle=file.open(FileMode.ReadOnly);
 try{
  const bytes=new Uint8Array(file.size+1);let count=0;
  while(count<bytes.length){const chunk=handle.readBytes(Math.min(64*1024,bytes.length-count));if(chunk.length===0)break;bytes.set(chunk,count);count+=chunk.length;}
  if(count===bytes.length)throw new TransferError("too_large");return transferCryptoOnDevice.decodeText(bytes.subarray(0,count));
 }finally{handle.close();}
}
/**
 * Saves only bounded encrypted documents or identity-only pairing proofs to a user-selected directory.
 * Returns false when the user closes the folder picker; the document stays prepared for another try.
 */
export async function saveTransferFile(document:TransferDocument):Promise<boolean>{
 if(!/^[0-9a-f-]+\.kolo-(backup|invite|request|enrollment|exchange|receipt)\.json$/.test(document.filename)||utf8Length(document.text)>MAX_TRANSFER_FILE_BYTES)throw new TransferError("invalid_file");
 let directory:Directory;
 try{directory=await Directory.pickDirectoryAsync();}catch{return false;}
 const file=directory.createFile(document.filename,"application/json");file.write(document.text);return true;
}
