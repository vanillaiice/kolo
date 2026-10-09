import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, pbkdf2, createHash, createCipheriv, createDecipheriv, verify, sign, generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import { nodeWorkspaceFiles, openDatabase } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import { createWorkspace, unlockWorkspace } from "../identity/workspace.ts";
import type { WorkspacePorts, ProvisionedIdentity } from "../identity/types.ts";
import { nativeTransferCrypto } from "./native-crypto.ts";
import { createBackup, previewBackup, restoreWorkspace, cancelBackupPreview } from "../application/backup.ts";
import { encryptTransfer,decryptTransfer } from "./encryption.ts";
import * as operations from "../application/operations.ts";
import type { Database } from "../data/database/driver.ts";

const at="2026-10-06T14:00:00.000Z",password="a portable backup password",secret="654321";
/** Real OpenSSL, using the production shared native framing with a test-only Node codec backend. */
export const crypto=nativeTransferCrypto({
 randomHex:n=>randomBytes(n).toString("hex"),derive:(p,s,n)=>new Promise<string>((resolve,reject)=>pbkdf2(p,Buffer.from(s,"hex"),n,32,"sha256",(e,k)=>e===null?resolve(k.toString("hex")):reject(e))),
 sha256:async s=>createHash("sha256").update(s).digest("hex"),sha256Bytes:async b=>createHash("sha256").update(b).digest("hex"),verify:async(k,m,s)=>verify(null,Buffer.from(m),k,Buffer.from(s,"hex")),
 encodeText:s=>new Uint8Array(Buffer.from(s,"utf8")),decodeText:b=>Buffer.from(b).toString("utf8"),encodeBase64:b=>Buffer.from(b).toString("base64"),decodeBase64:s=>new Uint8Array(Buffer.from(s,"base64")),fromHex:s=>new Uint8Array(Buffer.from(s,"hex")),toHex:b=>Buffer.from(b).toString("hex"),
 cipher:(k,n)=>createCipheriv("aes-256-gcm",Buffer.from(k,"hex"),Buffer.from(n,"hex"),{authTagLength:16}),decipher:(k,n)=>createDecipheriv("aes-256-gcm",Buffer.from(k,"hex"),Buffer.from(n,"hex"),{authTagLength:16}),
});
const directories:string[]=[],databases:Database[]=[],controls:ReturnType<typeof nodeWorkspaceFiles>[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();for(const control of controls.splice(0))control.close();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),"kolo-f3-"));directories.push(directory);const files=nodeWorkspaceFiles(directory);controls.push(files);const db=files.openActive();databases.push(db);migrate(db);
 const records=new Map<string,{material:ProvisionedIdentity;key:string;secret:string}>();
 const ports:WorkspacePorts={database:db,newId:randomUUIDv7,now:()=>at,credentials:{
  async provision(r){const old=records.get(r.installationId);if(old!==undefined){assert.equal(old.secret,r.secret);return old.material;}
   const key=generateKeyPairSync("ed25519",{publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}}),material={publicKey:key.publicKey,keyReference:randomUUIDv7(),credentialReference:randomUUIDv7()};records.set(r.installationId,{material,key:key.privateKey,secret:r.secret});return material;},
  inspect:async id=>records.get(id)?.material,verify:async(ref,pin)=>[...records.values()].some(r=>r.material.credentialReference===ref&&r.secret===pin),sign:async(ref,message)=>{const row=[...records.values()].find(r=>r.material.keyReference===ref)!;return sign(null,Buffer.from(message),row.key).toString("hex");},
 }};
 return {directory,files,db,ports};
}
it("native encrypted files authenticate password, purpose, header, ciphertext and tag with fresh salts/nonces",async()=>{
 const bytes=crypto.encodeText('{"sale":100}'),id=randomUUIDv7(),one=await encryptTransfer(bytes,"exchange",id,password,crypto),two=await encryptTransfer(bytes,"exchange",id,password,crypto);
 assert.notEqual(one,two);assert.deepEqual(await decryptTransfer(one,"exchange",password,crypto),bytes);assert.equal(one.includes('"sale"'),false);
 await assert.rejects(decryptTransfer(one,"exchange","wrong backup password",crypto));await assert.rejects(decryptTransfer(one,"backup",password,crypto));
 for(const field of ["ciphertext","tag"]){const bad=JSON.parse(one);bad[field]=(bad[field][0]==="a"?"b":"a")+bad[field].slice(1);await assert.rejects(decryptTransfer(JSON.stringify(bad),"exchange",password,crypto));}
 const bad=JSON.parse(one);bad.header.file_id=randomUUIDv7();await assert.rejects(decryptTransfer(JSON.stringify(bad),"exchange",password,crypto));bad.header.iterations=1;await assert.rejects(decryptTransfer(JSON.stringify(bad),"exchange",password,crypto));
});
it("WAL-consistent encrypted backup restores a fresh native identity, preserves history and permits new writes",async()=>{
 const a=fixture(),b=fixture(),installation=await createWorkspace({businessName:"Backup shop",ownerName:"Owner",deviceLabel:"A",platform:"DESKTOP",currency:"XAF",secret},a.ports),context=await unlockWorkspace({userId:installation.ownerId,secret},a.ports);
 const p=randomUUIDv7();operations.saveProduct(context,{id:p,name:"Rice",unit:"bag",active:true,divisible:false,sellingPriceMinor:500,currency:"XAF",taxRateBasisPoints:0,minimumStock:0,createdAt:at,updatedAt:at});
 const account=String(a.db.get(`SELECT id FROM financial_accounts LIMIT 1`)!["id"]);
 operations.completeSale(context,{id:randomUUIDv7(),number:randomUUIDv7(),eventId:randomUUIDv7(),occurredAt:at,lines:[{id:randomUUIDv7(),movementId:randomUUIDv7(),productId:p,name:"Rice",unitPriceMinor:500,quantity:1000}],payments:[{id:randomUUIDv7(),accountId:account,amountMinor:500}]});
 const doc=await createBackup(context,password,a.files,crypto),preview=await previewBackup(doc.text,password,b.files,crypto);
 assert.equal(preview.businessId,installation.businessId);assert.equal(preview.appliedEvents,3);assert.equal(b.db.get(`SELECT count(*) AS n FROM businesses`)!["n"],0);
 await assert.rejects(restoreWorkspace({...preview},{confirmedBusinessId:installation.businessId,deviceLabel:"B",platform:"DESKTOP",secret},b.ports));
 const restored=await restoreWorkspace(preview,{confirmedBusinessId:installation.businessId,deviceLabel:"B",platform:"DESKTOP",secret},b.ports);databases.push(restored.database);
 assert.notEqual(restored.installation.deviceId,installation.deviceId);assert.notEqual(restored.installation.publicKey,installation.publicKey);assert.equal(restored.database.get(`SELECT count(*) AS n FROM sales`)!["n"],1);
 const newPorts={...b.ports,database:restored.database},next=await unlockWorkspace({userId:installation.ownerId,secret},newPorts);
 operations.adjustStock(next,{id:randomUUIDv7(),productId:p,type:"ADJUSTMENT",quantity:1000,reason:"Count correction",occurredAt:at},randomUUIDv7());
 assert.equal(restored.database.get(`SELECT origin_sequence FROM event_journal WHERE origin_device_id=?`,[restored.installation.deviceId])!["origin_sequence"],1);
 await assert.rejects(restoreWorkspace(preview,{confirmedBusinessId:installation.businessId,deviceLabel:"B",platform:"DESKTOP",secret},b.ports));
});
it("corrupt/wrong-password previews and cancelled previews leave the active workspace unchanged",async()=>{
 const a=fixture(),b=fixture(),i=await createWorkspace({businessName:"Shop",ownerName:"Owner",deviceLabel:"A",platform:"DESKTOP",currency:"XAF",secret},a.ports),c=await unlockWorkspace({userId:i.ownerId,secret},a.ports),doc=await createBackup(c,password,a.files,crypto);
 await assert.rejects(previewBackup(doc.text,password+"wrong",b.files,crypto));const preview=await previewBackup(doc.text,password,b.files,crypto);await cancelBackupPreview(preview);await assert.rejects(restoreWorkspace(preview,{confirmedBusinessId:i.businessId,deviceLabel:"B",platform:"DESKTOP",secret},b.ports));assert.equal(b.db.get(`SELECT count(*) AS n FROM businesses`)!["n"],0);
});

it("owner-confirmed pairing and encrypted duplicate exchanges converge on cash, credit, stock and reports; fresh restore can re-pair without losing newer sales",async()=>{
 const a=fixture(),b=fixture(),c=fixture(),installation=await createWorkspace({businessName:"Pair shop",ownerName:"Owner",deviceLabel:"A",platform:"DESKTOP",currency:"XAF",secret},a.ports),actor=await unlockWorkspace({userId:installation.ownerId,secret},a.ports);
 const {createPairingInvite,previewPairingInvite,acceptPairingInvite,previewPairingRequest,confirmPairing,completePairing}=await import("../application/pairing.ts");
 const {exportBundle,previewBundle,importBundle,exportReceipt,importReceipt,exchangeDestinations,exchangeDiagnostics}=await import("../application/file-exchange.ts");
 const {exchangeStatus}=await import("../application/event-delivery.ts");
 const {stockOf}=await import("../data/inventory/movements.ts"),{balanceOfAccount}=await import("../data/finance/cash.ts"),{salesBetween,profitBetween}=await import("../data/reports/reports.ts"),{balanceOf}=await import("../data/customers/customers.ts");
 const p=randomUUIDv7(),customer=randomUUIDv7();operations.saveProduct(actor,{id:p,name:"Rice",unit:"bag",active:true,divisible:false,sellingPriceMinor:500,purchasePriceMinor:300,currency:"XAF",taxRateBasisPoints:0,minimumStock:0,createdAt:at,updatedAt:at});
 operations.saveCustomer(actor,{id:customer,name:"Customer",active:true,creditLimitMinor:2000,createdAt:at,updatedAt:at});
 const invite=await createPairingInvite(actor,crypto),summary=await previewPairingInvite(invite.text,crypto);
 await assert.rejects(acceptPairingInvite(invite.text,{confirmedFingerprint:"wrong",label:"B",platform:"DESKTOP",secret},b.ports,crypto));assert.equal(b.db.get(`SELECT id FROM businesses`),undefined);
 const request=await acceptPairingInvite(invite.text,{confirmedFingerprint:summary.fingerprint,label:"B",platform:"DESKTOP",secret},b.ports,crypto),requestSummary=await previewPairingRequest(request.document.text,crypto);assert.equal(requestSummary.verificationCode,request.verificationCode);
 await assert.rejects(confirmPairing(actor,request.document.text,"wrong",password,a.files,crypto));assert.equal(a.db.get(`SELECT device_id FROM trusted_exchange_devices WHERE device_id<>?`,[installation.deviceId]),undefined);
 const approved=await confirmPairing(actor,request.document.text,request.verificationCode,password,a.files,crypto);
 await assert.rejects(completePairing(approved.text,password,"wrong",b.ports,b.files,crypto));
 const paired=await completePairing(approved.text,password,request.verificationCode,b.ports,b.files,crypto);databases.push(paired.database);
 const bPorts={...b.ports,database:paired.database},bActor=await unlockWorkspace({userId:installation.ownerId,secret},bPorts);
 assert.notEqual(paired.installation.publicKey,installation.publicKey);assert.equal(paired.database.get(`SELECT authority_allowed FROM trusted_exchange_devices WHERE device_id=?`,[paired.installation.deviceId])!["authority_allowed"],0);
 await assert.rejects(createPairingInvite(bActor,crypto));
 const sale=(ctx:typeof actor,db:Database)=>{const id=randomUUIDv7(),account=String(db.get(`SELECT id FROM financial_accounts LIMIT 1`)!["id"]);operations.completeSale(ctx,{id,number:`V-${id}`,customerId:customer,creditTransactionId:randomUUIDv7(),eventId:randomUUIDv7(),occurredAt:at,lines:[{id:randomUUIDv7(),movementId:randomUUIDv7(),productId:p,name:"Rice",unitPriceMinor:500,unitCostMinor:300,quantity:1000}],payments:[{id:randomUUIDv7(),accountId:account,amountMinor:200}]});};
 sale(actor,a.db);sale(bActor,paired.database);
 const toB=exchangeDestinations(actor).find(d=>d.deviceId===paired.installation.deviceId)!.id,toA=exchangeDestinations(bActor).find(d=>d.deviceId===installation.deviceId)!.id;
 const ab=await exportBundle(actor,toB,password,crypto),ba=await exportBundle(bActor,toA,password,crypto);assert.ok(ab);assert.ok(ba);
 const before=paired.database.get(`SELECT count(*) AS n FROM sales`)!["n"],preview=await previewBundle(bActor,ab.text,password,crypto);assert.equal(paired.database.get(`SELECT count(*) AS n FROM sales`)!["n"],before);
 await assert.rejects(importBundle(bActor,{...preview},crypto));
 for(let pass=0;pass<2;pass++){await importBundle(bActor,await previewBundle(bActor,ab.text,password,crypto),crypto);await importBundle(actor,await previewBundle(actor,ba.text,password,crypto),crypto);}
 for(const db of [a.db,paired.database]){assert.equal(db.get(`SELECT count(*) AS n FROM sales`)!["n"],2);assert.equal(stockOf(db,installation.businessId,p).onHandThousandths,-2000);assert.equal(balanceOfAccount(db,installation.businessId,String(db.get(`SELECT id FROM financial_accounts LIMIT 1`)!["id"])).onHandMinor,400);assert.equal(balanceOf(db,installation.businessId,customer).outstandingMinor,600);}
 const range={from:"2026-10-06T00:00:00.000Z",to:"2026-10-07T00:00:00.000Z"};assert.deepEqual(salesBetween(a.db,installation.businessId,range.from,range.to),salesBetween(paired.database,installation.businessId,range.from,range.to));assert.deepEqual(profitBetween(a.db,installation.businessId,range.from,range.to),profitBetween(paired.database,installation.businessId,range.from,range.to));
 const receipt=await exportReceipt(bActor,preview.batchId,password,crypto);assert.ok(receipt);assert.ok(exchangeStatus(actor,toB)["pending"]!>0);await importReceipt(actor,toB,receipt.text,password,crypto);assert.equal(await importReceipt(actor,toB,receipt.text,password,crypto),0);assert.equal(exchangeStatus(actor,toB)["pending"],0);assert.ok(Number(a.db.get(`SELECT count(*) AS n FROM sync_outbox WHERE state='pending'`)!["n"])>0);assert.equal(exchangeDiagnostics(actor,"en").length,0);
 const backup=await createBackup(bActor,password,b.files,crypto),restored=await restoreWorkspace(await previewBackup(backup.text,password,c.files,crypto),{confirmedBusinessId:installation.businessId,deviceLabel:"C",platform:"DESKTOP",secret},c.ports);databases.push(restored.database);
 const cPorts={...c.ports,database:restored.database},cActor=await unlockWorkspace({userId:installation.ownerId,secret},cPorts);sale(cActor,restored.database);
 const secondInvite=await createPairingInvite(actor,crypto),fp=await previewPairingInvite(secondInvite.text,crypto),repair=await acceptPairingInvite(secondInvite.text,{confirmedFingerprint:fp.fingerprint,label:"C",platform:"DESKTOP",secret,existingContext:cActor},cPorts,crypto),completion=await confirmPairing(actor,repair.document.text,repair.verificationCode,password,a.files,crypto);
 const retained=await completePairing(completion.text,password,repair.verificationCode,cPorts,c.files,crypto,cActor);assert.equal(retained.database,restored.database);assert.equal(restored.database.get(`SELECT count(*) AS n FROM sales`)!["n"],3);
 const ca=await exportBundle(cActor,exchangeDestinations(cActor).find(d=>d.deviceId===installation.deviceId)!.id,password,crypto);assert.ok(ca);await importBundle(actor,await previewBundle(actor,ca.text,password,crypto),crypto);assert.equal(a.db.get(`SELECT count(*) AS n FROM sales`)!["n"],3);
});

it("snapshot validation rejects unexpected executable schema and scope corruption without touching the active slot",async()=>{
 const a=fixture(),b=fixture(),i=await createWorkspace({businessName:"Shop",ownerName:"Owner",deviceLabel:"A",platform:"DESKTOP",currency:"XAF",secret},a.ports),ctx=await unlockWorkspace({userId:i.ownerId,secret},a.ports);
 a.db.run(`CREATE TRIGGER unexpected_import_trigger AFTER INSERT ON products BEGIN SELECT 1; END`);
 const doc=await createBackup(ctx,password,a.files,crypto);await assert.rejects(previewBackup(doc.text,password,b.files,crypto));assert.equal(b.db.get(`SELECT id FROM businesses`),undefined);
 a.db.run(`DROP TRIGGER unexpected_import_trigger`);
 a.db.run(`INSERT INTO businesses(id,name,currency,created_at,updated_at) VALUES(?,'Other','XAF',?,?)`,[randomUUIDv7(),at,at]);
 const wrong=await createBackup(ctx,password,a.files,crypto);await assert.rejects(previewBackup(wrong.text,password,b.files,crypto));assert.equal(b.db.get(`SELECT id FROM businesses`),undefined);
});

it("explicit recovery keeps the original file; a stale active-slot activation fails and restart selects the committed replacement",async()=>{
 const a=fixture(),i=await createWorkspace({businessName:"Shop",ownerName:"Owner",deviceLabel:"A",platform:"DESKTOP",currency:"XAF",secret},a.ports),ctx=await unlockWorkspace({userId:i.ownerId,secret},a.ports),doc=await createBackup(ctx,password,a.files,crypto);
 const preview=await previewBackup(doc.text,password,a.files,crypto);await assert.rejects(restoreWorkspace(preview,{confirmedBusinessId:i.businessId,deviceLabel:"Restored",platform:"DESKTOP",secret},a.ports));
 const result=await restoreWorkspace(preview,{confirmedBusinessId:i.businessId,deviceLabel:"Restored",platform:"DESKTOP",secret,recoveryContext:ctx},a.ports);databases.push(result.database);
 assert.equal(a.db.get(`SELECT device_id FROM local_installation WHERE id=1`)!["device_id"],i.deviceId);
 const candidate=await a.files.empty();await assert.rejects(candidate.activate(a.db));await candidate.discard();
 const reopened=a.files.openActive();databases.push(reopened);assert.equal(reopened.get(`SELECT device_id FROM local_installation WHERE id=1`)!["device_id"],result.installation.deviceId);
});

it("native provisioning interruption resumes the same pairing identity; cancellation changes no business",async()=>{
 const a=fixture(),b=fixture(),i=await createWorkspace({businessName:"Shop",ownerName:"Owner",deviceLabel:"A",platform:"DESKTOP",currency:"XAF",secret},a.ports),ctx=await unlockWorkspace({userId:i.ownerId,secret},a.ports);
 const {createPairingInvite,previewPairingInvite,acceptPairingInvite,cancelPairing}=await import("../application/pairing.ts");const invite=await createPairingInvite(ctx,crypto),preview=await previewPairingInvite(invite.text,crypto);
 let installationId:string|undefined,deviceId:string|undefined;
 const failPorts={...b.ports,credentials:{...b.ports.credentials,provision:async(request:Parameters<typeof b.ports.credentials.provision>[0])=>{installationId=request.installationId;deviceId=request.deviceId;throw new Error("native write interrupted");}}};
 await assert.rejects(acceptPairingInvite(invite.text,{confirmedFingerprint:preview.fingerprint,label:"B",platform:"DESKTOP",secret},failPorts,crypto));assert.ok(installationId);assert.ok(deviceId);
 await assert.rejects(createWorkspace({businessName:"Wrong",ownerName:"Owner",deviceLabel:"B",platform:"DESKTOP",currency:"XAF",secret},b.ports));
 const resumed=await acceptPairingInvite(invite.text,{confirmedFingerprint:preview.fingerprint,label:"B",platform:"DESKTOP",secret},b.ports,crypto),request=JSON.parse(resumed.document.text);assert.equal(request.request.installation_id,installationId);assert.equal(request.request.device_id,deviceId);
 const state=String(b.db.get(`SELECT intent FROM workspace_enrollment`)!["intent"]);assert.equal(state.includes(secret),false);assert.equal(state.includes("PRIVATE KEY"),false);
 cancelPairing(b.ports);assert.equal(b.db.get(`SELECT id FROM workspace_enrollment`),undefined);assert.equal(b.db.get(`SELECT id FROM businesses`),undefined);
});

it("backup compaction removes native references and failed pointer commit preserves the old file and active identity",async()=>{
 const a=fixture(),b=fixture(),i=await createWorkspace({businessName:"Shop",ownerName:"Owner",deviceLabel:"A",platform:"DESKTOP",currency:"XAF",secret},a.ports),ctx=await unlockWorkspace({userId:i.ownerId,secret},a.ports);
 const {decodeSnapshot}=await import("./snapshot.ts"),doc=await createBackup(ctx,password,a.files,crypto),plain=await decryptTransfer(doc.text,"backup",password,crypto),{image}=decodeSnapshot(plain,crypto);
 for(const row of a.db.all(`SELECT key_reference FROM local_installation UNION SELECT credential_reference FROM local_memberships`))assert.equal(Buffer.from(image).includes(Buffer.from(String(Object.values(row)[0]))),false);plain.fill(0);image.fill(0);
 const preview=await previewBackup(doc.text,password,b.files,crypto),control=openDatabase({location:join(b.directory,"workspace-slots.db")});
 try{control.run(`CREATE TRIGGER reject_activation BEFORE UPDATE ON active_slot BEGIN SELECT RAISE(ABORT,'activation failpoint'); END`);
  await assert.rejects(restoreWorkspace(preview,{confirmedBusinessId:i.businessId,deviceLabel:"B",platform:"DESKTOP",secret},b.ports));assert.equal(b.db.get(`SELECT id FROM businesses`),undefined);assert.equal(control.get(`SELECT filename FROM active_slot`)!["filename"],"kolo.db");
  const reopened=b.files.openActive();databases.push(reopened);assert.equal(reopened.get(`SELECT id FROM businesses`),undefined);
 }finally{control.close();}
});
