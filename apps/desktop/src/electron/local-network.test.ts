import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv,createDecipheriv,randomBytes,randomUUIDv7 } from "node:crypto";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { assertConsistent } from "@kolo/core/data/database/integrity";
import type { Database } from "@kolo/core/data/database/driver";
import type { Result } from "../shared/service.ts";
import { DesktopApplication } from "./application.ts";
import { localCredentialsOnDesktop,desktopSealingCrypto,type NativeSafeStorage } from "./local-credentials.ts";
import { parseLocalJoinLink,localPacketSchema } from "@kolo/contracts/local-sync";
import { joinIdOf } from "@kolo/core/application/join";
import { createHttpSyncTransport } from "@kolo/core/application/http-sync-transport";
import { signMessage } from "@kolo/core/application/event-delivery";
import { sealLocalPacket,openLocalPacket,answerLocalExchange,synchronizeLocalPeer } from "@kolo/core/application/local-sync";
import { unlockWorkspace,lockWorkspace } from "@kolo/core/identity/workspace";
import { canonicalJson } from "@kolo/contracts/canonical";
import { sanitizeSnapshot } from "@kolo/core/backup/snapshot";

function value<T>(result:Result<T>):T{assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)throw new Error("unexpected failure");return result.value;}
function native():NativeSafeStorage{const key=randomBytes(32);return {isAsyncEncryptionAvailable:async()=>true,getSelectedStorageBackend:()=>"gnome_libsecret",encryptStringAsync:async text=>{const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);return Buffer.concat([nonce,cipher.update(text,"utf8"),cipher.final(),cipher.getAuthTag()]);},decryptStringAsync:async bytes=>{const decipher=createDecipheriv("aes-256-gcm",key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return {result:Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString("utf8"),shouldReEncrypt:false};}};}
async function installation(){
  const directory=mkdtempSync(join(tmpdir(),"kolo-local-")),files=nodeWorkspaceFiles(join(directory,"data")),credentials=localCredentialsOnDesktop(join(directory,"vault"),native()),databases:Database[]=[];
  const holder:{app:DesktopApplication|undefined;db:Database|undefined}={app:undefined,db:undefined};
  const ports=(database:Database)=>({database,credentials,newId:randomUUIDv7,now:()=>new Date().toISOString()});
  const serve=async(database:Database):Promise<DesktopApplication>=>{migrate(database);databases.push(database);const app=new DesktopApplication(ports(database),desktopSealingCrypto,{files,dialogs:{open:async()=>undefined,save:async()=>false},crypto:desktopSealingCrypto,onActivated:async next=>{const previous=holder.app;holder.db=next;holder.app=await serve(next);void previous?.dispose();}});await app.initialize();return app;};
  holder.db=files.openActive();holder.app=await serve(holder.db);
  return {get app(){return holder.app!;},get db(){return holder.db!;},ports:()=>ports(holder.db!),files,async dispose(){await holder.app?.dispose();for(const db of databases){try{assertConsistent(db,"local fixture");db.close();}catch(error){if(!(error instanceof Error)||!error.message.includes("closed"))throw error;}}files.close();rmSync(directory,{recursive:true,force:true});}};
}
async function owner(f:Awaited<ReturnType<typeof installation>>){const setup=value(await f.app.createShop({businessName:"Local shop",ownerName:"Owner",deviceLabel:"Main PC",cashAccountName:"Cash",secret:"654321"}));return value(await f.app.unlock({userId:setup.members[0]!.id,secret:"654321"})).sessionId!;}
async function pair(){
  const a=await installation(),b=await installation();
  try{const session=await owner(a);const product=value(await a.app.createProduct({sessionId:session,requestId:randomUUIDv7(),name:"Private rice",unit:"bag",divisible:false,sellingPriceMinor:500,openingThousandths:2000}));
    const code=value(await a.app.startLocalJoin({sessionId:session,authorityAllowed:false}));assert.ok(parseLocalJoinLink(code.link));
    value(await b.app.lookupLocalJoin({link:code.link}));value(await b.app.requestLocalJoin({link:code.link,deviceLabel:"Second PC",secret:"112233"}));
    assert.deepEqual(value(await a.app.pollLocalJoin({sessionId:session,joinId:code.joinId})),{state:"requested",label:"Second PC",platform:"DESKTOP"});
    assert.equal(value(await b.app.finishLocalJoin({link:code.link})),null,"no snapshot before owner approval");
    value(await a.app.approveLocalJoin({sessionId:session,joinId:code.joinId}));assert.deepEqual(value(await b.app.finishLocalJoin({link:code.link})),{activated:true});
    const workspace=value(await b.app.getWorkspace()),second=value(await b.app.unlock({userId:workspace.members[0]!.id,secret:"112233"})).sessionId!;
    assert.equal(b.db.get("SELECT count(*) AS n FROM local_network_listener")!["n"],0,"the owner's listener settings are never cloned");
    assert.equal(value(await b.app.localNetworkState({sessionId:second})).connections[0]!.url,code.url);
    return {a,b,session,second,product,code};
  }catch(error){await a.dispose();await b.dispose();throw error;}
}

it("two real desktop installations pair without a server, exchange offline sales both ways and safely retry",async()=>{
  const f=await pair();
  try{
    const customer=value(await f.a.app.createCustomer({sessionId:f.session,requestId:randomUUIDv7(),name:"Credit customer"}));
    value(await f.b.app.syncLocalNetwork({sessionId:f.second}));
    const account=value(await f.a.app.listCashAccounts({sessionId:f.session})).items[0]!.id;
    const sale=(sessionId:string)=>({sessionId,requestId:randomUUIDv7(),customerId:customer.id,lines:[{productId:f.product.id,quantity:1000,unitPriceMinor:500}],payments:[{accountId:account,amountMinor:100}]});
    value(await f.a.app.checkout(sale(f.session)));value(await f.b.app.checkout(sale(f.second)));
    const bContext=await unlockWorkspace({userId:value(await f.b.app.getWorkspace()).members[0]!.id,secret:"112233"},f.b.ports());
    const peerId=String(f.b.db.get("SELECT device_id FROM local_peer_connections WHERE url IS NOT NULL")!["device_id"]);
    await assert.rejects(()=>synchronizeLocalPeer(bContext,peerId,desktopSealingCrypto,async(url,init)=>{const response=await fetch(url,init);await response.text();throw new Error("lost reply");}));
    await synchronizeLocalPeer(bContext,peerId,desktopSealingCrypto);
    await synchronizeLocalPeer(bContext,peerId,desktopSealingCrypto);
    f.second=value(await f.b.app.unlock({userId:bContext.userId,secret:"112233"})).sessionId!;
    for(const x of [f.a,f.b]){assert.equal(x.db.get("SELECT count(*) AS n FROM sales")!["n"],2);assert.equal(x.db.get("SELECT sum(amount_minor) AS n FROM customer_transactions")!["n"],800);assert.equal(x.db.get("SELECT sum(quantity) AS n FROM inventory_movements")!["n"],0);assertConsistent(x.db,"bidirectional direct sync");}
    assert.equal(f.a.db.get("SELECT count(*) AS n FROM server_endpoints")!["n"],0);assert.equal(f.b.db.get("SELECT count(*) AS n FROM server_endpoints")!["n"],0);
    const snapshot=await f.a.files.capture(f.a.db);try{sanitizeSnapshot(snapshot.database,String(f.a.db.get("SELECT device_id FROM local_installation WHERE id=1")!["device_id"]));assert.equal(snapshot.database.get("SELECT count(*) AS n FROM local_network_listener")!["n"],0);assert.equal(snapshot.database.get("SELECT count(*) AS n FROM local_peer_connections")!["n"],0);}finally{await snapshot.discard();}
    const address=f.code.url;value(await f.a.app.lock());
    await assert.rejects(()=>fetch(address+"/api/local/v1/exchange",{method:"POST",body:"{}"}));
    const view=value(await f.a.app.getWorkspace());f.session=value(await f.a.app.unlock({userId:view.members[0]!.id,secret:"654321"})).sessionId!;
    const running=value(await f.a.app.localNetworkState({sessionId:f.session}));assert.ok(running.urls.includes(address),"the listener reopens on its saved port after unlock");
    value(await f.b.app.syncLocalNetwork({sessionId:f.second}));
  }finally{await f.a.dispose();await f.b.dispose();}
});

it("local join rejects modified QR identity, wrong codes, browser origins, cancelled invites and enrollment without approval",async()=>{
  const a=await installation(),b=await installation();
  try{const session=await owner(a),code=value(await a.app.startLocalJoin({sessionId:session,authorityAllowed:false}));
    assert.equal((await b.app.lookupLocalJoin({link:code.link.replace(/f=[a-f0-9]{32}/,"f="+"0".repeat(32))})).ok,false);
    const parsed=parseLocalJoinLink(code.link)!,id=await joinIdOf("0000000000",desktopSealingCrypto);
    await assert.rejects(()=>createHttpSyncTransport(parsed.url).joinRead(id));
    const origin=await fetch(parsed.url+"/api/v2/join/"+code.joinId,{headers:{origin:"https://example.com"}});assert.equal(origin.status,403);
    value(await a.app.cancelLocalJoin({sessionId:session,joinId:code.joinId}));assert.equal((await b.app.lookupLocalJoin({link:code.link})).ok,false);
  }finally{await a.dispose();await b.dispose();}
});

it("direct packets are encrypted, signed, destination-bound and refuse tampering, forged key changes and locks",async()=>{
  const f=await pair();
  try{
    // Native unlock contexts exercise the same pure transport protocol used on Android, against real SQLite/OpenSSL.
    const a=await unlockWorkspace({userId:value(await f.a.app.getWorkspace()).members[0]!.id,secret:"654321"},f.a.ports());
    const b=await unlockWorkspace({userId:value(await f.b.app.getWorkspace()).members[0]!.id,secret:"112233"},f.b.ports());
    const key=String(f.a.db.get("SELECT public_key FROM device_encryption_keys WHERE device_id=?",[a.deviceId])!["public_key"]);
    const packet=await sealLocalPacket(b,a.deviceId,key,{batch:null,receipt:null},desktopSealingCrypto);
    assert.equal(localPacketSchema.safeParse(packet).success,true);assert.ok(!JSON.stringify(packet).includes("Private rice"));
    assert.deepEqual((await openLocalPacket(a,packet,desktopSealingCrypto)).payload,{batch:null,receipt:null});
    for(const changed of [{...packet,signature:"0".repeat(128)},{...packet,tag:"0".repeat(32)},{...packet,header:{...packet.header,receiver_device_id:randomUUIDv7()}},{...packet,header:{...packet.header,encryption_public_key:key}}])await assert.rejects(()=>openLocalPacket(a,changed,desktopSealingCrypto));
    const changed={header:{...packet.header,nonce:"0".repeat(24)},ciphertext:packet.ciphertext,tag:packet.tag};
    const signed=await signMessage(b,desktopSealingCrypto,`kolo.local-sync.v1\u0000${canonicalJson(changed)}`);
    await assert.rejects(()=>openLocalPacket(a,{...changed,signature:signed.signature},desktopSealingCrypto),"even a signed header cannot change the encryption's authenticated data");
    await assert.rejects(()=>openLocalPacket(a,packet,desktopSealingCrypto,randomUUIDv7()));
    const response=await answerLocalExchange(a,packet,desktopSealingCrypto);await assert.rejects(()=>openLocalPacket(b,response,desktopSealingCrypto));
    lockWorkspace(f.a.db);await assert.rejects(()=>openLocalPacket(a,packet,desktopSealingCrypto));
  }finally{await f.a.dispose();await f.b.dispose();}
});
