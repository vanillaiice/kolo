import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "node:crypto";
import { MAX_TRANSFER_FILE_BYTES } from "@kolo/core/backup/types";
import { encryptTransfer, decryptTransfer } from "@kolo/core/backup/encryption";
import { readBoundedTransferFile, pickDesktopTransferFile, saveDesktopTransferFile } from "./transfer-files.ts";
import { desktopTransferCrypto as crypto } from "./local-credentials.ts";
it("real desktop AES-GCM and bounded selected files preserve ciphertext, reject corruption, and never overwrite existing files",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"kolo-transfer-")),path=join(directory,"file.json"),id=randomUUIDv7(),password="desktop portable password";
 try{
  const plain=crypto.encodeText('{"business":"private"}'),text=await encryptTransfer(plain,"exchange",id,password,crypto);assert.equal(text.includes("private"),false);
  const result=await saveDesktopTransferFile({filename:`${id}.kolo-exchange.json`,text},{showSaveDialog:async()=>({canceled:false,filePath:path})});assert.equal(result,true);assert.equal(readBoundedTransferFile(path),text);
  const picked=await pickDesktopTransferFile({showOpenDialog:async()=>({canceled:false,filePaths:[path]})});assert.equal(picked,text);assert.deepEqual(await decryptTransfer(picked!,"exchange",password,crypto),plain);
  await assert.rejects(saveDesktopTransferFile({filename:`${id}.kolo-exchange.json`,text:"changed"},{showSaveDialog:async()=>({canceled:false,filePath:path})}));assert.equal(readFileSync(path,"utf8"),text);
  const bad=JSON.parse(text);bad.tag="0".repeat(32);await assert.rejects(decryptTransfer(JSON.stringify(bad),"exchange",password,crypto));
  assert.equal(await pickDesktopTransferFile({showOpenDialog:async()=>({canceled:true,filePaths:[]})}),undefined);
  writeFileSync(path,Buffer.from([0xff]));assert.throws(()=>readBoundedTransferFile(path));truncateSync(path,MAX_TRANSFER_FILE_BYTES+1);assert.throws(()=>readBoundedTransferFile(path));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it("a larger cap from the large-files setting admits a file past the standard cap; the standard reader still refuses it",()=>{
 const directory=mkdtempSync(join(tmpdir(),"kolo-transfer-")),path=join(directory,"big.json");
 try{
  writeFileSync(path,"x");truncateSync(path,MAX_TRANSFER_FILE_BYTES+10);
  assert.throws(()=>readBoundedTransferFile(path),(error:Error)=>"code" in error&&error.code==="too_large");
  assert.equal(readBoundedTransferFile(path,MAX_TRANSFER_FILE_BYTES+10).length,MAX_TRANSFER_FILE_BYTES+10);
  assert.throws(()=>readBoundedTransferFile(path,MAX_TRANSFER_FILE_BYTES+9),(error:Error)=>"code" in error&&error.code==="too_large");
 }finally{rmSync(directory,{recursive:true,force:true});}
});
