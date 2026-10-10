import { constants, openSync, fstatSync, readSync, writeSync, fsyncSync, closeSync } from "node:fs";
import type { Dialog } from "electron";
import { MAX_TRANSFER_FILE_BYTES, TransferError, type TransferDocument } from "@kolo/core/backup/types";
import { desktopTransferCrypto } from "./local-credentials.ts";
/** Reads a selected regular file through one descriptor, capped (standard profile by default) even if it grows after the initial stat. */
export function readBoundedTransferFile(path:string,maximum:number=MAX_TRANSFER_FILE_BYTES):string {
 const fd=openSync(path,constants.O_RDONLY);
 // Sized by the file, not the cap: a large-files cap is hundreds of MiB.
 try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>maximum)throw new TransferError("too_large");const buffer=Buffer.alloc(stat.size+1);let count=0;
  while(count<buffer.length){const n=readSync(fd,buffer,count,buffer.length-count,null);if(n===0)break;count+=n;}
  if(count>stat.size||count>maximum)throw new TransferError("too_large");return desktopTransferCrypto.decodeText(buffer.subarray(0,count));
 }finally{closeSync(fd);}
}
/** Main-process native picker. Renderer IPC must authenticate its caller before invoking this adapter (F5). */
export async function pickDesktopTransferFile(native:Pick<Dialog,"showOpenDialog">,maximum:number=MAX_TRANSFER_FILE_BYTES):Promise<string|undefined>{const result=await native.showOpenDialog({title:"KOLO — ouvrir un fichier",properties:["openFile"],filters:[{name:"KOLO",extensions:["json"]}]});if(result.canceled||result.filePaths.length!==1)return undefined;return readBoundedTransferFile(result.filePaths[0]!,maximum);}
/** Main-process save dialog; writes only a newly created selected file, never overwrites an existing business database. */
export async function saveDesktopTransferFile(document:TransferDocument,native:Pick<Dialog,"showSaveDialog">,maximum:number=MAX_TRANSFER_FILE_BYTES):Promise<boolean>{
 if(!/^[0-9a-f-]+\.kolo-(backup|invite|request|enrollment|exchange|receipt)\.json$/.test(document.filename))throw new TransferError("invalid_file");const bytes=desktopTransferCrypto.encodeText(document.text);if(bytes.length>maximum)throw new TransferError("too_large");
 const result=await native.showSaveDialog({title:"KOLO — enregistrer le fichier",defaultPath:document.filename,filters:[{name:"KOLO",extensions:["json"]}]});if(result.canceled||result.filePath===undefined)return false;
 const fd=openSync(result.filePath,"wx",0o600);try{let at=0;while(at<bytes.length)at+=writeSync(fd,bytes,at,bytes.length-at);fsyncSync(fd);}finally{closeSync(fd);}return true;
}
