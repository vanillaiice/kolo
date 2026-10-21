import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv,createDecipheriv,randomBytes,randomUUIDv7 } from "node:crypto";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { SyncTransportError,type SyncTransport } from "@kolo/core/application/server-sync";
import { formatConnectionCode,formatJoinLink } from "@kolo/contracts/sync";
import type { Result } from "../shared/service.ts";
import { DesktopApplication } from "./application.ts";
import { localCredentialsOnDesktop,desktopSealingCrypto,type NativeSafeStorage } from "./local-credentials.ts";

function native():NativeSafeStorage{const key=randomBytes(32);return {isAsyncEncryptionAvailable:async()=>true,getSelectedStorageBackend:()=>"gnome_libsecret",encryptStringAsync:async text=>{const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);return Buffer.concat([nonce,cipher.update(text,"utf8"),cipher.final(),cipher.getAuthTag()]);},decryptStringAsync:async bytes=>{const decipher=createDecipheriv("aes-256-gcm",key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return {result:Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString("utf8"),shouldReEncrypt:false};}};}
function code<T>(result:Result<T>):string{assert.equal(result.ok,false,JSON.stringify(result));return result.ok?"":result.error.code;}

it("an empty computer joins with the owner's code and address or a server join link, and refuses a share code", async () => {
  const directory=mkdtempSync(join(tmpdir(),"kolo-join-entry-")),files=nodeWorkspaceFiles(join(directory,"data")),database=files.openActive();migrate(database);
  // The server is down: only which address each join reached matters here; the join itself is tested against a real server.
  const reached:string[]=[],transport=(url:string):SyncTransport=>{reached.push(url);const down=async():Promise<never>=>{throw new SyncTransportError("unreachable",0,true);};return {joinRead:down,joinRequest:down,joinPollEnrollment:down} as unknown as SyncTransport;};
  const app=new DesktopApplication({database,credentials:localCredentialsOnDesktop(join(directory,"vault"),native()),newId:randomUUIDv7,now:()=>new Date().toISOString()},desktopSealingCrypto,
    {files,dialogs:{open:async()=>undefined,save:async()=>false},crypto:desktopSealingCrypto,onActivated:async()=>undefined},undefined,transport);
  try{
    await app.initialize();
    const fingerprint="a".repeat(32);
    assert.equal(code(await app.lookupLocalJoin({link:formatConnectionCode({url:"https://sync.example.com",fingerprint})})),"not_join_code","the phone's share code is named, not called invalid");
    assert.equal(code(await app.lookupLocalJoin({link:"kolo://pair?x=1"})),"invalid_join_code");
    assert.equal(code(await app.lookupLocalJoin({link:"hello"})),"invalid_join_code");
    assert.equal(code(await app.lookupLocalJoin({link:"K7F2-9QXM-4D"})),"join_address_needed");
    assert.equal(code(await app.lookupLocalJoin({link:"K7F2-9QXM-4D",url:"ftp://sync.example.com"})),"invalid_address");
    assert.equal(code(await app.lookupLocalJoin({link:"K7F2-9QXM-4D",url:"http://sync.example.com"})),"invalid_address","plain HTTP only on a private network");
    assert.equal(reached.length,0,"nothing reaches the network before the input is understood");
    assert.equal(code(await app.lookupLocalJoin({link:" k7f2 9qxm 4d ",url:"sync.example.com"})),"server_unreachable");
    assert.equal(code(await app.lookupLocalJoin({link:formatJoinLink({url:"https://kolo.example.org/",fingerprint,code:"K7F29QXM4D"}),url:"ignored.example.com"})),"server_unreachable");
    assert.equal(code(await app.requestLocalJoin({link:"K7F2-9QXM-4D",url:"https://sync.example.com/",deviceLabel:"Second PC",secret:"112233"})),"server_unreachable");
    assert.equal(code(await app.finishLocalJoin({link:"K7F2-9QXM-4D",url:"sync.example.com"})),"server_unreachable");
    assert.deepEqual(reached,["https://sync.example.com","https://kolo.example.org","https://sync.example.com","https://sync.example.com"],"a typed address defaults to HTTPS; a link brings its own");
    assert.equal(code(await app.lookupLocalJoin({link:"K7F2-9QXM-4D",url:"sync.example.com",extra:1} as never)),"invalid_input");
  }finally{await app.dispose();database.close();files.close();rmSync(directory,{recursive:true,force:true});}
});
