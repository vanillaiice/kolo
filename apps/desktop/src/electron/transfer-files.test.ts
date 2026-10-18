import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "node:crypto";
import { MAX_TRANSFER_FILE_BYTES } from "@kolo/core/backup/types";
import { encryptTransfer, decryptTransfer } from "@kolo/core/backup/encryption";
import { clearOutgoing, openTransferFile, readBoundedTransferFile, pickDesktopTransferFile, saveDesktopExportFile, saveDesktopTransferFile, saveDesktopTransferStream } from "./transfer-files.ts";
import { desktopTransferCrypto as crypto } from "./local-credentials.ts";
it("real desktop AES-GCM and bounded selected files preserve container bytes, reject corruption, and never overwrite existing files",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"kolo-transfer-")),path=join(directory,"batch.kolo-exchange"),id=randomUUIDv7(),password="desktop portable password";
 try{
  const plain=crypto.encodeText('{"business":"private"}'),bytes=await encryptTransfer(plain,"exchange",id,password,crypto);assert.equal(Buffer.from(bytes).includes("private"),false);
  let filters:unknown;
  const result=await saveDesktopTransferFile({filename:`${id}.kolo-exchange`,bytes},{showSaveDialog:async options=>{filters=options.filters;return {canceled:false,filePath:path};}});
  assert.equal(result,true);assert.deepEqual(filters,[{name:"KOLO",extensions:["kolo-exchange"]}]);assert.deepEqual(readBoundedTransferFile(path),bytes);
  let offered:unknown;
  const picked=(await pickDesktopTransferFile({showOpenDialog:async options=>{offered=options.filters;return {canceled:false,filePaths:[path]};}}))!;
  assert.equal(picked.size,bytes.byteLength);const read=await picked.read(0,picked.size);await picked.close();
  assert.deepEqual(read,bytes);assert.deepEqual(await decryptTransfer(read,"exchange",password,crypto),plain);
  assert.deepEqual(offered,[{name:"KOLO",extensions:["kolo-backup","kolo-enrollment","kolo-exchange","kolo-receipt","json"]}],"invitations and requests stay .json");
  await assert.rejects(saveDesktopTransferFile({filename:`${id}.kolo-exchange`,bytes:crypto.encodeText("changed")},{showSaveDialog:async()=>({canceled:false,filePath:path})}));assert.deepEqual(new Uint8Array(readFileSync(path)),bytes);
  const bad=bytes.slice();bad[bad.length-1]=bad[bad.length-1]!^1;await assert.rejects(decryptTransfer(bad,"exchange",password,crypto));
  assert.equal(await pickDesktopTransferFile({showOpenDialog:async()=>({canceled:true,filePaths:[]})}),undefined);
  // Invitations keep their plaintext .json name and filter.
  const invite=join(directory,"invite.json");
  await saveDesktopTransferFile({filename:`${id}.kolo-invite.json`,bytes:crypto.encodeText("{}")},{showSaveDialog:async options=>{filters=options.filters;return {canceled:false,filePath:invite};}});
  assert.deepEqual(filters,[{name:"KOLO",extensions:["json"]}]);
  for(const filename of [`${id}.kolo-exchange.json`,`${id}.kolo-backup.bin`,`../${id}.kolo-backup`,`${id}.kolo-invite`,"x.kolo-backup"])
   await assert.rejects(saveDesktopTransferFile({filename,bytes},{showSaveDialog:async()=>{throw new Error("no dialog for refused names");}}),(error:Error)=>"code" in error&&error.code==="invalid_file",filename);
  await assert.rejects(saveDesktopTransferFile({filename:`${id}.kolo-backup`,bytes:new Uint8Array(0)},{showSaveDialog:async()=>{throw new Error("no dialog for empty files");}}),(error:Error)=>"code" in error&&error.code==="too_large");
  writeFileSync(path,Buffer.from([0xff]));assert.deepEqual(readBoundedTransferFile(path),new Uint8Array([0xff]),"binary files are read as they are");
  writeFileSync(path,"");assert.throws(()=>readBoundedTransferFile(path),(error:Error)=>"code" in error&&error.code==="too_large");
  truncateSync(path,MAX_TRANSFER_FILE_BYTES+1);assert.throws(()=>readBoundedTransferFile(path));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it("files are capped at the transfer limit before reading, and exactly at a caller-supplied cap",()=>{
 const directory=mkdtempSync(join(tmpdir(),"kolo-transfer-")),path=join(directory,"big.kolo-backup");
 try{
  // A sparse file one byte past the limit is refused from its size alone, without reading a gibibyte.
  writeFileSync(path,"x");truncateSync(path,MAX_TRANSFER_FILE_BYTES+1);
  assert.throws(()=>readBoundedTransferFile(path),(error:Error)=>"code" in error&&error.code==="too_large");
  truncateSync(path,1010);
  assert.equal(readBoundedTransferFile(path,1010).length,1010);
  assert.throws(()=>readBoundedTransferFile(path,1009),(error:Error)=>"code" in error&&error.code==="too_large");
 }finally{rmSync(directory,{recursive:true,force:true});}
});

it("a picked file is read in pieces within its size at open time, and refused when empty or too large",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"kolo-transfer-")),path=join(directory,"file.kolo-backup");
 try{
  writeFileSync(path,Buffer.from([1,2,3,4,5,6,7,8]));const file=await openTransferFile(path);
  assert.equal(file.size,8);assert.deepEqual(await file.read(2,3),new Uint8Array([3,4,5]));assert.deepEqual(await file.read(6,100),new Uint8Array([7,8]));
  // Growth after opening is not read: the size checked at open is the limit.
  writeFileSync(path,Buffer.from([1,2,3,4,5,6,7,8,9,10]));assert.deepEqual(await file.read(6,100),new Uint8Array([7,8]));
  await assert.rejects(file.read(-1,2));await file.close();await assert.rejects(file.read(0,1));
  writeFileSync(path,"");await assert.rejects(openTransferFile(path),(error:Error)=>"code" in error&&error.code==="too_large");
  writeFileSync(path,"0123456789");await assert.rejects(openTransferFile(path,9),(error:Error)=>"code" in error&&error.code==="too_large");
 }finally{rmSync(directory,{recursive:true,force:true});}
});

it("streamed saves go through a private temporary file that never survives, and never overwrite an existing file",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"kolo-transfer-")),outgoing=join(directory,"outgoing"),target=join(directory,"saved.kolo-backup"),id=randomUUIDv7();
 const temporaries=()=>{try{return readdirSync(outgoing).filter(name=>name.startsWith("outgoing-"));}catch{return [];}};
 const write=(parts:readonly Uint8Array[])=>async(sink:{write(bytes:Uint8Array):Promise<void>})=>{for(const part of parts)await sink.write(part);return `${id}.kolo-backup`;};
 try{
  const parts=[new Uint8Array(3*1024*1024).fill(7),new Uint8Array([1,2,3])];let offered:unknown;
  assert.equal(await saveDesktopTransferStream(write(parts),{showSaveDialog:async options=>{offered=options;assert.equal(temporaries().length,1,"the file is complete before the dialog");return {canceled:false,filePath:target};}},outgoing),true);
  assert.deepEqual(new Uint8Array(readFileSync(target)),new Uint8Array(Buffer.concat(parts)));assert.deepEqual(temporaries(),[]);
  assert.deepEqual((offered as {defaultPath:string;filters:unknown}).filters,[{name:"KOLO",extensions:["kolo-backup"]}]);
  // Cancelled: nothing saved, nothing left behind.
  assert.equal(await saveDesktopTransferStream(write(parts),{showSaveDialog:async()=>({canceled:true,filePath:""})},outgoing),false);assert.deepEqual(temporaries(),[]);
  // An existing destination is never overwritten.
  await assert.rejects(saveDesktopTransferStream(write([new Uint8Array([9])]),{showSaveDialog:async()=>({canceled:false,filePath:target})},outgoing));
  assert.equal(readFileSync(target).byteLength,3*1024*1024+3);assert.deepEqual(temporaries(),[]);
  // A copy that fails part-way publishes nothing under the chosen name and leaves no sibling behind.
  const interrupted=join(directory,"interrupted.kolo-backup");
  await assert.rejects(saveDesktopTransferStream(write(parts),{showSaveDialog:async()=>{truncateSync(join(outgoing,temporaries()[0]!),1024);return {canceled:false,filePath:interrupted};}},outgoing),(error:Error)=>"code" in error&&error.code==="invalid_file");
  assert.deepEqual(readdirSync(directory).sort(),["outgoing","saved.kolo-backup"]);assert.deepEqual(temporaries(),[]);
  // A failing writer, a file over the limit and a bad name leave nothing either, and no dialog opens.
  const noDialog={showSaveDialog:async()=>{throw new Error("no dialog");}};
  await assert.rejects(saveDesktopTransferStream(async sink=>{await sink.write(new Uint8Array(10));throw new Error("snapshot failed");},noDialog,outgoing),/snapshot failed/);
  await assert.rejects(saveDesktopTransferStream(write([new Uint8Array(20)]),noDialog,outgoing,10),(error:Error)=>"code" in error&&error.code==="too_large");
  await assert.rejects(saveDesktopTransferStream(async sink=>{await sink.write(new Uint8Array(1));return "../escape.kolo-backup";},noDialog,outgoing),(error:Error)=>"code" in error&&error.code==="invalid_file");
  assert.deepEqual(temporaries(),[]);
  // A leftover from a crash is cleared at startup; other files are left alone.
  writeFileSync(join(outgoing,`outgoing-${randomUUIDv7()}.tmp`),"partial");writeFileSync(join(outgoing,"keep.txt"),"x");
  clearOutgoing(outgoing);assert.deepEqual(readdirSync(outgoing),["keep.txt"]);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

it("spreadsheet exports save exact bytes under a plain .csv name and never overwrite a file",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"kolo-export-")),path=join(directory,"journal.csv"),bytes=new TextEncoder().encode("\uFEFFDate;Membre\r\n2026-10-18;Awa\r\n");
 try{
  let filters:unknown,offeredName:unknown;
  assert.equal(await saveDesktopExportFile("kolo-journal-2026-10-12_2026-10-18.csv",bytes,{showSaveDialog:async options=>{filters=options.filters;offeredName=options.defaultPath;return {canceled:false,filePath:path};}}),true);
  assert.deepEqual([filters,offeredName],[[{name:"CSV",extensions:["csv"]}],"kolo-journal-2026-10-12_2026-10-18.csv"]);
  assert.deepEqual(new Uint8Array(readFileSync(path)),bytes);
  await assert.rejects(saveDesktopExportFile("journal.csv",new TextEncoder().encode("other"),{showSaveDialog:async()=>({canceled:false,filePath:path})}));
  assert.deepEqual(new Uint8Array(readFileSync(path)),bytes,"an existing file is left as it was");
  assert.equal(await saveDesktopExportFile("journal.csv",bytes,{showSaveDialog:async()=>({canceled:true,filePath:""})}),false);
  for(const filename of ["../journal.csv","a/b.csv",".csv","journal.exe","journal.csv.exe","journal",`${"x".repeat(97)}.csv`,"-x.csv","journal\u0000.csv"])
   await assert.rejects(saveDesktopExportFile(filename,bytes,{showSaveDialog:async()=>{throw new Error("no dialog for a refused name");}}),filename);
  await assert.rejects(saveDesktopExportFile("journal.csv",new Uint8Array(0),{showSaveDialog:async()=>{throw new Error("no dialog");}}));
  assert.equal(await saveDesktopExportFile("Journal été 2026.csv",bytes,{showSaveDialog:async()=>({canceled:false,filePath:join(directory,"é.csv")})}),true,"accented names are plain names");
 }finally{rmSync(directory,{recursive:true,force:true});}
});
