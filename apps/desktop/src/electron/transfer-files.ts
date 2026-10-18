import { constants, openSync, fstatSync, readSync, closeSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { link, open as openFile, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Dialog } from "electron";
import { MAX_TRANSFER_FILE_BYTES, TransferError, type ByteSink, type TransferDocument } from "@kolo/core/backup/types";
import type { PickedFile } from "./transfer.ts";
/** Names KOLO writes: encrypted containers (ADR-035) and plaintext invitation/request JSON. */
const DOCUMENT_NAME=/^[0-9a-f-]+\.(kolo-(?:backup|enrollment|exchange|receipt)|kolo-(?:invite|request)\.json)$/;
/** Everything the open dialog offers: encrypted containers and `.json` invitations/requests. */
const OPEN_EXTENSIONS=["kolo-backup","kolo-enrollment","kolo-exchange","kolo-receipt","json"];
const COPY_CHUNK=1024*1024;
/** Hard-link failures that mean the destination filesystem has none (FAT/exFAT drives), not that the name is taken. */
const NO_HARD_LINKS=new Set(["EPERM","ENOTSUP","EOPNOTSUPP","ENOSYS","EISDIR","EINVAL"]);
/**
 * Creates `destination` without ever exposing a partial file under its name, and never replaces an existing one: `fill`
 * writes a private sibling on the same filesystem, which is synced and then published with a hard link (which fails rather
 * than overwrite). Where there are no hard links, the name is claimed empty with `wx` and the synced sibling renamed onto
 * the claim. Whatever fails, the sibling and any claim are removed, so no half-written file looks like a finished one.
 */
async function publishNewFile(destination:string,fill:(file:FileHandle)=>Promise<void>):Promise<void>{
 const directory=dirname(destination),partial=join(directory,`.${basename(destination)}.${randomUUID()}.partial`);
 const file=await openFile(partial,"wx",0o600);
 try{
  try{await fill(file);await file.sync();}finally{await file.close();}
  try{await link(partial,destination);}
  catch(error){
   if(!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code??""))throw error;
   await (await openFile(destination,"wx",0o600)).close();
   try{await rename(partial,destination);}catch(cause){await rm(destination,{force:true});throw cause;}
  }
  // The new name is durable only once its directory is; Windows cannot open a directory and syncs names itself.
  if(process.platform!=="win32"){const parent=await openFile(directory,"r");try{await parent.sync();}catch{/* Not every filesystem syncs directories. */}finally{await parent.close();}}
 }finally{await rm(partial,{force:true});}
}
/** Reads a selected regular file's bytes through one descriptor, capped even if it grows after the initial stat. */
export function readBoundedTransferFile(path:string,maximum:number=MAX_TRANSFER_FILE_BYTES):Uint8Array {
 const fd=openSync(path,constants.O_RDONLY);
 // Sized by the file, not the cap: the cap is about 1 GiB.
 try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>maximum)throw new TransferError("too_large");const buffer=new Uint8Array(stat.size+1);let count=0;
  while(count<buffer.length){const n=readSync(fd,buffer,count,buffer.length-count,null);if(n===0)break;count+=n;}
  if(count>stat.size||count>maximum)throw new TransferError("too_large");return buffer.subarray(0,count);
 }finally{closeSync(fd);}
}
/**
 * Opens a selected regular file for reading in pieces (ADR-035): a backup is never read whole. The size is fixed when the
 * file is opened; reading past it is refused, so a file that grows afterwards cannot feed more than was checked.
 */
export async function openTransferFile(path:string,maximum:number=MAX_TRANSFER_FILE_BYTES):Promise<PickedFile>{
 const handle=await openFile(path,"r");
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size<1||stat.size>maximum)throw new TransferError("too_large");
  const size=stat.size;let closed=false;
  return {size,
   async read(offset,length){
    if(closed||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0)throw new TransferError("invalid_file");
    const buffer=new Uint8Array(Math.max(0,Math.min(length,size-offset)));let at=0;
    while(at<buffer.byteLength){const {bytesRead}=await handle.read(buffer,at,buffer.byteLength-at,offset+at);if(bytesRead===0)break;at+=bytesRead;}
    return at===buffer.byteLength?buffer:buffer.subarray(0,at);
   },
   async close(){if(closed)return;closed=true;await handle.close();}};
 }catch(error){await handle.close();throw error;}
}
/** Main-process native picker. Renderer IPC must authenticate its caller before invoking this adapter (F5). */
export async function pickDesktopTransferFile(native:Pick<Dialog,"showOpenDialog">,maximum:number=MAX_TRANSFER_FILE_BYTES):Promise<PickedFile|undefined>{const result=await native.showOpenDialog({title:"KOLO — ouvrir un fichier",properties:["openFile"],filters:[{name:"KOLO",extensions:OPEN_EXTENSIONS}]});if(result.canceled||result.filePaths.length!==1)return undefined;return openTransferFile(result.filePaths[0]!,maximum);}
/** Main-process save dialog; publishes only a complete new selected file, never overwrites an existing business database. */
export async function saveDesktopTransferFile(document:TransferDocument,native:Pick<Dialog,"showSaveDialog">,maximum:number=MAX_TRANSFER_FILE_BYTES):Promise<boolean>{
 const name=DOCUMENT_NAME.exec(document.filename);if(name===null||!(document.bytes instanceof Uint8Array))throw new TransferError("invalid_file");const bytes=document.bytes;if(bytes.length<1||bytes.length>maximum)throw new TransferError("too_large");
 const extension=name[1]!.endsWith(".json")?"json":name[1]!;
 const result=await native.showSaveDialog({title:"KOLO — enregistrer le fichier",defaultPath:document.filename,filters:[{name:"KOLO",extensions:[extension]}]});if(result.canceled||result.filePath===undefined)return false;
 await publishNewFile(result.filePath,async file=>{let at=0;while(at<bytes.length)at+=(await file.write(bytes,at,bytes.length-at)).bytesWritten;});return true;
}
/** Spreadsheet exports KOLO writes: a plain name ending in .csv, at most 100 characters. */
export const EXPORT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,95}\.csv$/u;
/** Main-process save dialog for a spreadsheet export; like transfer files it publishes a complete new file and never overwrites one. */
export async function saveDesktopExportFile(filename:string,bytes:Uint8Array,native:Pick<Dialog,"showSaveDialog">,maximum:number=MAX_TRANSFER_FILE_BYTES):Promise<boolean>{
 if(!EXPORT_NAME.test(filename)||!(bytes instanceof Uint8Array))throw new TransferError("invalid_file");if(bytes.length<1||bytes.length>maximum)throw new TransferError("too_large");
 const result=await native.showSaveDialog({title:"KOLO — exporter",defaultPath:filename,filters:[{name:"CSV",extensions:["csv"]}]});if(result.canceled||result.filePath===undefined)return false;
 await publishNewFile(result.filePath,async file=>{let at=0;while(at<bytes.length)at+=(await file.write(bytes,at,bytes.length-at)).bytesWritten;});return true;
}
/** Removes temporary files an interrupted streamed save left in the private outgoing directory. */
export function clearOutgoing(directory:string):void{
 mkdirSync(directory,{recursive:true,mode:0o700});
 for(const entry of readdirSync(directory))if(/^outgoing-[0-9a-f-]+\.tmp$/.test(entry))rmSync(join(directory,entry),{force:true});
}
/**
 * Streams a large file (a backup) into a new private temporary file under `directory`, synced to disk, then offers it in
 * the save dialog and copies it chunk by chunk beside the chosen destination, publishing it whole only once synced and
 * never overwriting one. Temporary files are removed whatever happens, so an interrupted or failed save never leaves a
 * half-written file under a finished backup's name where the owner keeps backups.
 */
export async function saveDesktopTransferStream(write:(sink:ByteSink)=>Promise<string>,native:Pick<Dialog,"showSaveDialog">,directory:string,maximum:number=MAX_TRANSFER_FILE_BYTES):Promise<boolean>{
 mkdirSync(directory,{recursive:true,mode:0o700});
 const temporary=join(directory,`outgoing-${randomUUID()}.tmp`),file=await openFile(temporary,"wx",0o600);
 try{
  let size=0,filename:string;
  try{
   filename=await write({write:async bytes=>{size+=bytes.byteLength;if(size>maximum)throw new TransferError("too_large");let at=0;while(at<bytes.byteLength)at+=(await file.write(bytes,at,bytes.byteLength-at)).bytesWritten;}});
   await file.sync();
  }finally{await file.close();}
  const name=DOCUMENT_NAME.exec(filename);if(name===null)throw new TransferError("invalid_file");
  const result=await native.showSaveDialog({title:"KOLO — enregistrer le fichier",defaultPath:filename,filters:[{name:"KOLO",extensions:[name[1]!.endsWith(".json")?"json":name[1]!]}]});
  if(result.canceled||result.filePath===undefined)return false;
  const source=await openFile(temporary,"r");
  try{
   await publishNewFile(result.filePath,async target=>{
    const buffer=new Uint8Array(COPY_CHUNK);
    for(let at=0;at<size;){const {bytesRead}=await source.read(buffer,0,Math.min(COPY_CHUNK,size-at),at);if(bytesRead===0)throw new TransferError("invalid_file");let written=0;while(written<bytesRead)written+=(await target.write(buffer,written,bytesRead-written)).bytesWritten;at+=bytesRead;}
   });
  }finally{await source.close();}
  return true;
 }finally{rmSync(temporary,{force:true});}
}
