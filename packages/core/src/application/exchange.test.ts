import assert from "node:assert/strict";
import { closeConsistent } from "../data/database/integrity.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { generateKeyPairSync, sign, verify, createHash, randomUUIDv7 } from "node:crypto";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate, MIGRATIONS } from "../data/database/migrations.ts";
import type { Database } from "../data/database/driver.ts";
import { createWorkspace, unlockWorkspace, lockWorkspace } from "../identity/workspace.ts";
import type { WorkspacePorts, OperationContext, Installation } from "../identity/types.ts";
import type { ExchangeCrypto } from "../exchange/types.ts";
import type { JournalEnvelope, SignedJournalEvent } from "@kolo/contracts/events";
import { canonicalJson } from "@kolo/contracts/canonical";
import { registerExchangeDestination, eventSigningMessage, verifyEvent, sealPendingEvents, setExchangeDeviceActive } from "./exchange.ts";
import { applyEvent, retryDeferred, reviewQuarantinedEvent } from "./event-application.ts";
import { createJournalBatch, importJournalBatch, createPeerReceipt, acknowledgeDelivery, eventsForDestination, exchangeStatus } from "./event-delivery.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";
import { auditTrail } from "./audit.ts";
import { stockOf } from "../data/inventory/movements.ts";
import { balanceOfAccount } from "../data/finance/cash.ts";

const at="2026-10-06T06:00:00.000Z", secret="fixture-owner-secret";
const crypto:ExchangeCrypto={sha256:async message=>createHash("sha256").update(message).digest("hex"),verify:async(key,message,signature)=>verify(null,Buffer.from(message),key,Buffer.from(signature,"hex"))};
const databases:Database[]=[], temporaryDirectories:string[]=[];
afterEach(()=>{closeConsistent(databases.splice(0));for(const path of temporaryDirectories.splice(0))rmSync(path,{recursive:true,force:true});});
interface Replica { db:Database; ports:WorkspacePorts; context:OperationContext; install:Installation; key:string; publicKey:string; }
function nativeFixture(db:Database){
 const pair=generateKeyPairSync("ed25519",{publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
 const material={publicKey:pair.publicKey,keyReference:randomUUIDv7(),credentialReference:randomUUIDv7()};
 let firstUser:string|undefined;
 const ports:WorkspacePorts={database:db,newId:randomUUIDv7,now:()=>at,credentials:{provision:async request=>{firstUser ??= request.userId;return firstUser===request.userId ? material : {...material,credentialReference:`fixture.${request.userId}`};},inspect:async()=>material,verify:async(ref,pin)=>ref===material.credentialReference&&pin===secret,sign:async(ref,message)=>{assert.equal(ref,material.keyReference);return sign(null,Buffer.from(message),pair.privateKey).toString("hex");}}};
 return {ports,material,key:pair.privateKey,publicKey:pair.publicKey};
}
async function replicas(count=2,directory?:string):Promise<Replica[]>{
 const db=openDatabase();databases.push(db);migrate(db);const a=nativeFixture(db);
 const install=await createWorkspace({businessName:"Fixture shop",ownerName:"Owner",deviceLabel:"A",platform:"DESKTOP",currency:"XAF",secret},a.ports);
 const result:Replica[]=[{db,...a,install,context:await unlockWorkspace({userId:install.ownerId,secret},a.ports)}];
 // Deliberately approved baseline replicas. Enrollment/encrypted files are F3.
 for(let i=1;i<count;i++){
  const other=openDatabase(directory===undefined ? {} : {location:join(directory,`replica-${i}.sqlite`)});databases.push(other);migrate(other);const b=nativeFixture(other),device=randomUUIDv7();
  for(const table of ["businesses","users","devices","financial_accounts"]){for(const row of db.all(`SELECT * FROM ${table}`)){const columns=Object.keys(row);other.run(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(()=>"?").join(",")})`,Object.values(row));}}
  other.run(`INSERT INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES (?,?,'Replica','DESKTOP',?,?,?)`,[device,install.businessId,at,at,at]);
  other.run(`INSERT INTO local_installation(id,installation_id,business_id,owner_id,device_id,public_key,key_reference,configured_at) VALUES (1,?,?,?,?,?,?,?)`,[randomUUIDv7(),install.businessId,install.ownerId,device,b.publicKey,b.material.keyReference,at]);
  other.run(`INSERT INTO local_memberships(business_id,user_id,credential_reference,role) VALUES (?,?,?,'OWNER')`,[install.businessId,install.ownerId,b.material.credentialReference]);
  other.run(`INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES (?,?,?,1,?)`,[install.businessId,device,b.publicKey,install.ownerId]);
  result.push({db:other,...b,install:{...install,deviceId:device,publicKey:b.publicKey},context:await unlockWorkspace({userId:install.ownerId,secret},b.ports)});
 }
 for(const receiver of result)for(const sender of result)if(receiver!==sender)registerExchangeDestination(receiver.context,{deviceId:sender.install.deviceId,publicKey:sender.publicKey,label:"Peer",platform:"DESKTOP",kind:"peer",authorityAllowed:true});
 return result;
}
function dest(from:Replica,to:Replica):string{return String(from.db.get(`SELECT id FROM exchange_destinations WHERE receiver_device_id=? AND kind='peer'`,[to.install.deviceId])!["id"]);}
function account(r:Replica):string{return String(r.db.get(`SELECT id FROM financial_accounts LIMIT 1`)!["id"]);}
function product(r:Replica):string{const id=randomUUIDv7();commands.saveProduct(r.context,{id,name:"Rice",unit:"bag",divisible:false,active:true,sellingPriceMinor:500,purchasePriceMinor:300,currency:"XAF",taxRateBasisPoints:0,minimumStock:0,createdAt:at,updatedAt:at});return id;}
function sale(r:Replica,p:string):string{const id=randomUUIDv7();commands.completeSale(r.context,{id,number:`V-${id}`,eventId:randomUUIDv7(),occurredAt:at,lines:[{id:randomUUIDv7(),movementId:randomUUIDv7(),productId:p,name:"Rice",unitPriceMinor:500,unitCostMinor:300,quantity:1000}],payments:[{id:randomUUIDv7(),accountId:account(r),amountMinor:500}]});return id;}
async function signed(r:Replica,e:JournalEnvelope):Promise<SignedJournalEvent>{const message=eventSigningMessage(e);return {envelope:e,digest:await crypto.sha256(message),signature:sign(null,Buffer.from(message),r.key).toString("hex")};}
async function send(from:Replica,to:Replica){const batch=await createJournalBatch(from.context,dest(from,to),crypto);assert.ok(batch);await importJournalBatch(to.context,batch,crypto);return batch;}
function count(r:Replica,table:string):number{return Number(r.db.get(`SELECT count(*) AS n FROM ${table}`)!["n"]);}

it("two offline sales converge with negative stock, unchanged origins and peer receipts leave cloud pending",async()=>{
 const [a,b,c]=await replicas(3) as [Replica,Replica,Replica],p=product(a);
 await send(a,b);sale(a,p);sale(b,p);
 const ab=await send(a,b);await send(b,a);
 assert.equal(count(a,"sales"),2);assert.equal(count(b,"sales"),2);
 assert.equal(stockOf(a.db,a.install.businessId,p).onHandThousandths,-2000);assert.equal(stockOf(b.db,b.install.businessId,p).onHandThousandths,-2000);
 assert.equal(balanceOfAccount(a.db,a.install.businessId,account(a)).onHandMinor,1000);assert.equal(balanceOfAccount(b.db,b.install.businessId,account(b)).onHandMinor,1000);
 const receipt=await createPeerReceipt(b.context,ab.batch.batch_id,crypto);assert.ok(receipt);
 await acknowledgeDelivery(a.context,dest(a,b),receipt,crypto);assert.equal(await acknowledgeDelivery(a.context,dest(a,b),receipt,crypto),0);
 assert.equal(exchangeStatus(a.context,dest(a,b))["pending"],0);assert.ok(exchangeStatus(a.context,dest(a,c))["pending"]!>0);
 assert.equal(a.db.get(`SELECT count(*) AS n FROM sync_outbox WHERE state='pending'`)!["n"],2);
 const bc=await send(b,c);assert.ok(bc.batch.events.some(e=>e.envelope.origin_device_id===a.install.deviceId));
 assert.equal(count(c,"sales"),2);assert.equal(stockOf(c.db,c.install.businessId,p).onHandThousandths,-2000);
});

it("the operation journal shows another till's facts once received, with the till that made them",async()=>{
 const [a,b]=await replicas() as [Replica,Replica],p=product(a),id=sale(a,p);
 commands.reconcileCash(a.context,account(a),0);
 const before=auditTrail(b.context).items.filter(entry=>entry.type==="SALE_COMPLETED");
 assert.deepEqual(before,[],"nothing before it arrives");
 await send(a,b);
 const sold=auditTrail(b.context,{group:"sales"}).items;
 assert.deepEqual(sold.map(entry=>[entry.subject?.id,entry.device.id,entry.device.label,entry.actor.name,entry.source,entry.status,entry.facts.amountMinor]),
  [[id,a.install.deviceId,"A","Owner","journal","applied",500]]);
 assert.deepEqual(auditTrail(b.context,{deviceId:b.install.deviceId,group:"sales"}).items,[]);
 assert.ok(auditTrail(a.context).items.some(entry=>entry.type==="CASH_COUNTED"));
 assert.ok(!auditTrail(b.context).items.some(entry=>entry.type==="CASH_COUNTED"),"a count that moved no money stays on its own till");
});
it("lost receipts, duplicate batches and application identities never repeat financial effects",async()=>{
 const [a,b]=await replicas() as [Replica,Replica],p=product(a);sale(a,p);const batch=await send(a,b);
 await importJournalBatch(b.context,batch,crypto);await send(a,b);assert.equal(count(b,"sales"),1);assert.equal(count(b,"sale_payments"),1);
 const receipt=await createPeerReceipt(b.context,batch.batch.batch_id,crypto);assert.ok(receipt);await acknowledgeDelivery(a.context,dest(a,b),receipt,crypto);
 assert.throws(()=>b.db.run(`DELETE FROM applied_events`));assert.throws(()=>b.db.run(`UPDATE event_journal SET canonical='{}'`));
});

it("sale before product defers with no partial rows and resolves after dependencies",async()=>{
 const [a,b]=await replicas() as [Replica,Replica],p=product(a);sale(a,p);await sealPendingEvents(a.context,crypto);
 const events=eventsForDestination(a.context,dest(a,b)),s=events.find(e=>e.envelope.event_type==="SALE_COMPLETED")!,catalog=events.find(e=>e.envelope.event_type==="PRODUCT_SAVED")!;
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,s,crypto)),"deferred");assert.equal(count(b,"sales"),0);
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,catalog,crypto)),"applied");assert.equal(retryDeferred(b.context),1);assert.equal(count(b,"sales"),1);
});

it("valid signatures with malformed fan-out or reused IDs are quarantined without rewriting first effects",async()=>{
 const [a,b]=await replicas() as [Replica,Replica],p=product(a);sale(a,p);const batch=await send(a,b),s=batch.batch.events.find(e=>e.envelope.event_type==="SALE_COMPLETED")!;
 const changed=structuredClone(s.envelope);changed.payload["sale"]={...(changed.payload["sale"] as object),number:"altered"};
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,await signed(a,changed),crypto)),"quarantined");assert.equal(count(b,"sales"),1);assert.equal(count(b,"exchange_conflicts"),1);
 const malformed=structuredClone(s.envelope);malformed.event_id=randomUUIDv7();malformed.origin_sequence=500;malformed.payload["movements"]=[];
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,await signed(a,malformed),crypto)),"quarantined");assert.equal(count(b,"sales"),1);
 const reusedPosition={...changed,event_id:randomUUIDv7()};assert.equal(applyEvent(b.context,await verifyEvent(b.context,await signed(a,reusedPosition),crypto)),"quarantined");assert.equal(count(b,"exchange_conflicts"),3-1);
});

it("origin proof binds all fields, forged tokens fail, and verification snapshots caller data",async()=>{
 const [a,b]=await replicas() as [Replica,Replica];product(a);await sealPendingEvents(a.context,crypto);const e=eventsForDestination(a.context,dest(a,b)).find(e=>e.envelope.event_type==="PRODUCT_SAVED")!;
 assert.throws(()=>applyEvent(b.context,{eventId:e.envelope.event_id,digest:e.digest}));
 for(const patch of [{event_id:randomUUIDv7()},{origin_sequence:100},{actor_id:randomUUIDv7()},{occurred_at:"2026-10-07T06:00:00.000Z"},{authority_revision:2},{required_permissions:[]},{branch_id:randomUUIDv7()}])await assert.rejects(verifyEvent(b.context,{...e,envelope:{...e.envelope,...patch}},crypto));
 const token=await verifyEvent(b.context,e,crypto);e.envelope.payload["product"]={};assert.equal(applyEvent(b.context,token),"applied");assert.equal(count(b,"products"),1);
});

it("SQL failure after sale insertion rolls back fan-out; retry succeeds once",async()=>{
 const [a,b]=await replicas() as [Replica,Replica],p=product(a);await send(a,b);sale(a,p);await sealPendingEvents(a.context,crypto);const e=eventsForDestination(a.context,dest(a,b)).find(e=>e.envelope.event_type==="SALE_COMPLETED")!;
 b.db.run(`CREATE TRIGGER fail_sale_payment BEFORE INSERT ON sale_payments BEGIN SELECT RAISE(ABORT,'failpoint'); END`);
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,e,crypto)),"deferred");for(const t of ["sales","sale_items","sale_payments","inventory_movements","journal_entity_claims"])assert.equal(count(b,t),0,t);
 b.db.run(`DROP TRIGGER fail_sale_payment`);assert.equal(retryDeferred(b.context),1);assert.equal(retryDeferred(b.context),0);assert.equal(count(b,"sales"),1);
});

it("a fact signed under a revision this till never recorded requires exact-digest owner review; unknown keys never verify",async()=>{
 const [a,b]=await replicas() as [Replica,Replica],p=product(a);await send(a,b);sale(a,p);await sealPendingEvents(a.context,crypto);const e=eventsForDestination(a.context,dest(a,b)).find(e=>e.envelope.event_type==="SALE_COMPLETED")!;
 b.db.run(`UPDATE local_memberships SET revision=2 WHERE business_id=? AND user_id=?`,[b.install.businessId,b.install.ownerId]);
 // As if the revision changed before this till kept revision history (migration 34).
 b.db.run(`DELETE FROM membership_revisions WHERE business_id=? AND user_id=?`,[b.install.businessId,b.install.ownerId]);
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,e,crypto)),"quarantined");assert.equal(count(b,"sales"),0);
 assert.equal(b.db.get(`SELECT reason FROM applied_events WHERE event_id=?`,[e.envelope.event_id])!["reason"],"authority_revision");
 assert.throws(()=>reviewQuarantinedEvent(b.context,e.envelope.event_id,"0".repeat(64)));assert.equal(reviewQuarantinedEvent(b.context,e.envelope.event_id,e.digest),"applied");
 const stranger=generateKeyPairSync("ed25519",{publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
 const forged={...e.envelope,event_id:randomUUIDv7(),origin_device_id:randomUUIDv7()},message=eventSigningMessage(forged);
 await assert.rejects(verifyEvent(b.context,{envelope:forged,digest:await crypto.sha256(message),signature:sign(null,Buffer.from(message),stranger.privateKey).toString("hex")},crypto),/untrusted_device/);
});

it("revoking a till keeps its earlier sales on every till; later ones wait for the owner instead of vanishing",async()=>{
 const [a,b,c]=await replicas(3) as [Replica,Replica,Replica],p=product(a);await send(a,b);await send(a,c);
 const early=sale(b,p);await send(b,a);
 setExchangeDeviceActive(a.context,b.install.deviceId,false);
 const late=sale(b,p);await sealPendingEvents(a.context,crypto);await sealPendingEvents(b.context,crypto);
 const fromA=eventsForDestination(a.context,dest(a,c)),of=(type:string)=>fromA.find(e=>e.envelope.event_type===type)!;
 const cutoff=of("DEVICE_HISTORY_ACCEPTED"),revoked=of("DEVICE_REVOKED");
 assert.ok(cutoff.envelope.origin_sequence<revoked.envelope.origin_sequence,"the cutoff is signed before the revocation");
 const held=Number(a.db.get(`SELECT max(origin_sequence) AS s FROM event_journal WHERE origin_device_id=?`,[b.install.deviceId])!["s"]);
 assert.deepEqual(cutoff.envelope.payload,{device_id:b.install.deviceId,through_sequence:held,revision:Number(revoked.envelope.payload["revision"])});
 // C, offline overnight, learns of the revocation before B's earlier sale reaches it, and the cutoff last.
 assert.equal(applyEvent(c.context,await verifyEvent(c.context,revoked,crypto)),"applied");
 const earlySale=fromA.find(e=>e.envelope.event_type==="SALE_COMPLETED"&&(e.envelope.payload["sale"] as {id:string}).id===early)!;
 assert.equal(applyEvent(c.context,await verifyEvent(c.context,earlySale,crypto)),"quarantined");
 assert.equal(c.db.get(`SELECT reason FROM applied_events WHERE event_id=?`,[earlySale.envelope.event_id])!["reason"],"device_revoked");
 assert.equal(applyEvent(c.context,await verifyEvent(c.context,cutoff,crypto)),"applied");assert.equal(retryDeferred(c.context),1);
 assert.equal(c.db.get(`SELECT count(*) AS n FROM sales WHERE id=?`,[early])!["n"],1,"the earlier sale is kept");
 // The sale B made after it was revoked is held for the owner, never applied silently and never lost.
 const lateSale=eventsForDestination(b.context,dest(b,c)).find(e=>e.envelope.event_type==="SALE_COMPLETED"&&(e.envelope.payload["sale"] as {id:string}).id===late)!;
 for(const r of [a,c]){
  assert.equal(applyEvent(r.context,await verifyEvent(r.context,lateSale,crypto)),"quarantined");
  assert.equal(r.db.get(`SELECT count(*) AS n FROM sales WHERE id=?`,[late])!["n"],0);
  assert.equal(reviewQuarantinedEvent(r.context,lateSale.envelope.event_id,lateSale.digest),"applied");
  assert.equal(r.db.get(`SELECT kind FROM event_exception_reviews WHERE event_id=?`,[lateSale.envelope.event_id])!["kind"],"device_revoked");
 }
 assert.equal(stockOf(a.db,a.install.businessId,p).onHandThousandths,stockOf(c.db,c.install.businessId,p).onHandThousandths);
 // Revoking again never widens the cutoff over a later fact that arrived while revoked.
 const later=sale(b,p);await sealPendingEvents(b.context,crypto);
 const laterSale=eventsForDestination(b.context,dest(b,a)).find(e=>e.envelope.event_type==="SALE_COMPLETED"&&(e.envelope.payload["sale"] as {id:string}).id===later)!;
 assert.equal(applyEvent(a.context,await verifyEvent(a.context,laterSale,crypto)),"quarantined");
 setExchangeDeviceActive(a.context,b.install.deviceId,false);
 assert.equal(a.db.get(`SELECT accepted_through FROM trusted_exchange_devices WHERE device_id=?`,[b.install.deviceId])!["accepted_through"],held);
 // Reinstating the till trusts it again, so what it signed meanwhile applies.
 setExchangeDeviceActive(a.context,b.install.deviceId,true);assert.equal(retryDeferred(a.context),1);
 assert.equal(a.db.get(`SELECT count(*) AS n FROM sales WHERE id=?`,[later])!["n"],1);
 assert.throws(()=>a.db.run(`DELETE FROM event_exception_reviews`),/immutable/);
});

it("a cashier's sales signed before a permission change are judged by the revision they were signed under",async()=>{
 const [a,b]=await replicas() as [Replica,Replica];
 const { createLocalMember }=await import("../identity/members.ts");const { grantPermission,revokePermission }=await import("../identity/workspace.ts");
 const member=await createLocalMember(a.context,{name:"Staff",role:"CASHIER",secret:"654321"});grantPermission(a.context,member,"cash.move");revokePermission(a.context,member,"cash.move");
 await send(a,b);assert.equal(b.db.get(`SELECT revision FROM local_memberships WHERE user_id=?`,[member])!["revision"],3);
 assert.deepEqual(b.db.all(`SELECT revision FROM membership_revisions WHERE user_id=? ORDER BY revision`,[member]).map(r=>r["revision"]),[1,2]);
 let next=800;
 const cash=async(revision:number)=>{const e:JournalEnvelope={event_id:randomUUIDv7(),business_id:a.install.businessId,origin_device_id:a.install.deviceId,actor_id:member,origin_sequence:++next,event_type:"CASH_MOVED",event_version:2,occurred_at:at,branch_id:null,authority_revision:revision,required_permissions:["cash.move"],payload:{movements:[{id:randomUUIDv7(),account_id:account(a),type:"CASH_IN",amount_minor:100,occurred_at:at}]}};
  const token=await verifyEvent(b.context,await signed(a,e),crypto);const outcome=applyEvent(b.context,token);return [outcome,b.db.get(`SELECT reason FROM applied_events WHERE event_id=?`,[e.event_id])!["reason"]];};
 assert.deepEqual(await cash(2),["applied",null],"revision 2 allowed moving cash, though it is revoked now");
 assert.deepEqual(await cash(1),["quarantined","permission_denied"],"revision 1 never allowed it");
 assert.deepEqual(await cash(3),["quarantined","permission_denied"]);
 assert.deepEqual(await cash(4),["deferred","missing_dependency"],"a future revision waits");
 b.db.run(`UPDATE local_memberships SET active=0,revision=4 WHERE user_id=?`,[member]);
 assert.deepEqual(await cash(2),["applied",null],"a later suspension keeps work done while active");
 assert.deepEqual(await cash(4),["quarantined","permission_denied"]);
});

it("two tills returning the same sale offline both keep their refund once the owner approves, computed as each till did",async()=>{
 const {returnSale,previewReturn}=await import("./returns.ts");const [a,b]=await replicas() as [Replica,Replica],p=product(a),saleId=randomUUIDv7(),lineId=randomUUIDv7();
 // Three bags for 1000 after a bill discount: one bag is worth 333, two 667. A till that recomputed the second
 // return against the first would ask 334 and find the cash refund a franc short.
 commands.completeSale(a.context,{id:saleId,number:saleId,discountMinor:500,lines:[{id:lineId,movementId:randomUUIDv7(),productId:p,name:"Rice",unitPriceMinor:500,quantity:3000}],payments:[{id:randomUUIDv7(),accountId:account(a),amountMinor:1000}],occurredAt:at,eventId:randomUUIDv7()});await send(a,b);
 const record=(r:Replica)=>{const preview=previewReturn(r.context,"SALE",saleId,[{originalItemId:lineId,quantity:1000}]);assert.equal(preview.totalMinor,333);
  returnSale(r.context,{id:randomUUIDv7(),eventId:randomUUIDv7(),originalId:saleId,priorId:preview.source.priorId,reason:"Returned rice",items:[{id:randomUUIDv7(),movementId:randomUUIDv7(),originalItemId:lineId,quantity:1000}],refunds:[{id:randomUUIDv7(),accountId:account(r),amountMinor:preview.totalMinor}]});};
 record(a);record(b);await sealPendingEvents(a.context,crypto);await sealPendingEvents(b.context,crypto);
 const returned=(from:Replica,to:Replica)=>eventsForDestination(from.context,dest(from,to)).find(e=>e.envelope.event_type==="SALE_RETURNED"&&e.envelope.origin_device_id===from.install.deviceId)!;
 for(const [from,to] of [[a,b],[b,a]] as const){
  const e=returned(from,to);
  assert.equal(applyEvent(to.context,await verifyEvent(to.context,e,crypto)),"quarantined");
  assert.equal(to.db.get(`SELECT reason FROM applied_events WHERE event_id=?`,[e.envelope.event_id])!["reason"],"return_conflict");
  assert.equal(reviewQuarantinedEvent(to.context,e.envelope.event_id,e.digest),"applied");
 }
 for(const r of [a,b]){
  assert.deepEqual(r.db.all(`SELECT total_minor,debt_minor FROM business_returns ORDER BY id`).map(row=>[row["total_minor"],row["debt_minor"]]),[[333,0],[333,0]]);
  assert.equal(stockOf(r.db,r.install.businessId,p).onHandThousandths,-1000);assert.equal(balanceOfAccount(r.db,r.install.businessId,account(r)).onHandMinor,334);
  assert.equal(count(r,"return_fork_links"),1);
  // A new return could count only one side of the split, so the sale takes no more.
  assert.throws(()=>record(r),/return_conflict/);
 }
});

it("future formats stay signed and unapplied; lock during async verification discards capability",async()=>{
 const [a,b]=await replicas() as [Replica,Replica];product(a);await sealPendingEvents(a.context,crypto);const e=eventsForDestination(a.context,dest(a,b))[0]!;
 const future=await signed(a,{...e.envelope,event_id:randomUUIDv7(),origin_sequence:700,event_version:3});assert.equal(applyEvent(b.context,await verifyEvent(b.context,future,crypto)),"unsupported");assert.equal(count(b,"products"),0);
 await assert.rejects(verifyEvent(b.context,e,{...crypto,sha256:async m=>{lockWorkspace(b.db);return crypto.sha256(m);}}));
});

it("receipt forgery, wrong destination and digest mismatch cannot acknowledge work",async()=>{
 const [a,b,c]=await replicas(3) as [Replica,Replica,Replica];product(a);const batch=await send(a,b),receipt=await createPeerReceipt(b.context,batch.batch.batch_id,crypto);assert.ok(receipt);
 await assert.rejects(acknowledgeDelivery(a.context,dest(a,c),receipt,crypto));
 const bad=structuredClone(receipt);bad.receipt.entries[0]!.digest="0".repeat(64);await assert.rejects(acknowledgeDelivery(a.context,dest(a,b),bad,crypto));
 const message=`kolo.receipt.v1\u0000${canonicalJson(bad.receipt)}`;bad.digest=await crypto.sha256(message);bad.signature=sign(null,Buffer.from(message),b.key).toString("hex");await assert.rejects(acknowledgeDelivery(a.context,dest(a,b),bad,crypto));
 assert.ok(exchangeStatus(a.context,dest(a,b))["pending"]!>0);assert.equal(count(a,"peer_receipts"),0);
});

it("migration archives exact legacy identities and counters without signing or changing cloud state",()=>{
 const db=openDatabase();databases.push(db);db.run(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT`);
 for(const m of MIGRATIONS.filter(m=>m.version<17))db.transaction(tx=>{for(const sql of m.statements)tx.run(sql);tx.run(`INSERT INTO schema_migrations VALUES (?,?,?)`,[m.version,m.name,at]);});
 const shop=randomUUIDv7(),user=randomUUIDv7(),device=randomUUIDv7(),event=randomUUIDv7();
 db.run(`INSERT INTO businesses(id,name,currency,created_at,updated_at) VALUES (?,'Legacy','XAF',?,?)`,[shop,at,at]);
 db.run(`INSERT INTO users(id,business_id,name,role,created_at,updated_at) VALUES (?,?,'Owner','OWNER',?,?)`,[user,shop,at,at]);
 db.run(`INSERT INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES (?,?,'Till','DESKTOP',?,?,?)`,[device,shop,at,at,at]);
 db.run(`INSERT INTO sync_outbox(event_id,business_id,user_id,device_id,type,payload,occurred_at,sequence) VALUES (?,?,?,?,'OLD','{}',?,42)`,[event,shop,user,device,at]);db.run(`UPDATE sync_sequence SET next=43 WHERE id=1`);
 migrate(db);assert.equal(db.get(`SELECT event_id FROM legacy_event_archive`)!["event_id"],event);assert.equal(db.get(`SELECT outbox_next FROM legacy_baselines`)!["outbox_next"],43);assert.equal(db.get(`SELECT state FROM sync_outbox`)!["state"],"pending");assert.equal(db.get(`SELECT count(*) AS n FROM event_signatures`)!["n"],0);
});

it("membership/grants replicate in revision order, never copying PINs, and denied staff imports have no effects",async()=>{
 const [a,b]=await replicas() as [Replica,Replica];
 const { createLocalMember }=await import("../identity/members.ts");const { grantPermission,revokePermission }=await import("../identity/workspace.ts");
 const member=await createLocalMember(a.context,{name:"Staff",role:"CASHIER",secret:"654321"});grantPermission(a.context,member,"inventory.adjust");revokePermission(a.context,member,"sales.discount");
 await sealPendingEvents(a.context,crypto);const events=eventsForDestination(a.context,dest(a,b));
 const changes=events.filter(e=>e.envelope.event_type.startsWith("PERMISSION_"));
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,changes[1]!,crypto)),"deferred");
 const created=events.find(e=>e.envelope.event_type==="MEMBER_CREATED")!;assert.equal(applyEvent(b.context,await verifyEvent(b.context,created,crypto)),"applied");
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,changes[0]!,crypto)),"applied");assert.equal(retryDeferred(b.context),1);
 const row=b.db.get(`SELECT * FROM local_memberships WHERE user_id=?`,[member])!;assert.equal(row["revision"],3);assert.match(String(row["credential_reference"]),/^remote\./);assert.equal(JSON.stringify(events).includes("654321"),false);
 const denied:JournalEnvelope={...created.envelope,event_id:randomUUIDv7(),origin_sequence:900,event_type:"CASH_MOVED",actor_id:member,authority_revision:3,required_permissions:["cash.move"],payload:{movements:[{id:randomUUIDv7(),account_id:account(a),type:"CASH_IN",amount_minor:100,occurred_at:at}]}};
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,await signed(a,denied),crypto)),"quarantined");assert.equal(count(b,"account_movements"),0);
});

it("purchase/debt/customer payments/cash transfers/expense compensation converge with scoped branches",async()=>{
 const [a,b]=await replicas() as [Replica,Replica],p=product(a),customer=randomUUIDv7(),supplier=randomUUIDv7(),branch=randomUUIDv7();
 for(const r of [a,b])r.db.run(`INSERT INTO branches(id,business_id,name,created_at,updated_at) VALUES (?,?,'Counter',?,?)`,[branch,a.install.businessId,at,at]);
 commands.saveCustomer(a.context,{id:customer,name:"Buyer",active:true,createdAt:at,updatedAt:at});commands.saveSupplier(a.context,{id:supplier,name:"Wholesaler",active:true,createdAt:at,updatedAt:at});
 commands.recordPurchase(a.context,{id:randomUUIDv7(),branchId:branch,supplierId:supplier,supplierTransactionId:randomUUIDv7(),lines:[{id:randomUUIDv7(),movementId:randomUUIDv7(),productId:p,unitCostMinor:300,quantity:3000}],payments:[{id:randomUUIDv7(),accountId:account(a),amountMinor:100,reason:"Door payment"}],occurredAt:at,eventId:randomUUIDv7()});
 commands.paySupplier(a.context,{id:randomUUIDv7(),branchId:branch,supplierId:supplier,accountId:account(a),amountMinor:200,occurredAt:at,eventId:randomUUIDv7()});
 commands.completeSale(a.context,{id:randomUUIDv7(),branchId:branch,number:randomUUIDv7(),customerId:customer,creditTransactionId:randomUUIDv7(),lines:[{id:randomUUIDv7(),movementId:randomUUIDv7(),productId:p,name:"Rice",unitPriceMinor:500,quantity:1000}],payments:[],occurredAt:at,eventId:randomUUIDv7()});
 commands.receiveCustomerPayment(a.context,{id:randomUUIDv7(),branchId:branch,customerId:customer,accountId:account(a),amountMinor:150,occurredAt:at,eventId:randomUUIDv7()});
 const expense=randomUUIDv7();commands.recordExpense(a.context,{id:expense,branchId:branch,category:"RENT",accountId:account(a),amountMinor:50,occurredAt:at,eventId:randomUUIDv7()});commands.recordExpense(a.context,{id:randomUUIDv7(),branchId:branch,category:"RENT",accountId:account(a),amountMinor:-50,reversesId:expense,occurredAt:at,eventId:randomUUIDv7()});
 const second=randomUUIDv7();commands.saveAccount(a.context,{id:second,branchId:branch,name:"Branch wallet",kind:"MOBILE_MONEY",currency:"XAF",active:true,createdAt:at,updatedAt:at});
 commands.moveCash(a.context,{eventId:randomUUIDv7(),movements:[{id:randomUUIDv7(),branchId:branch,accountId:account(a),counterpartId:second,type:"TRANSFER_OUT",amountMinor:-20,occurredAt:at},{id:randomUUIDv7(),branchId:branch,accountId:second,counterpartId:account(a),type:"TRANSFER_IN",amountMinor:20,occurredAt:at}]});
 const batch=await createJournalBatch(a.context,dest(a,b),crypto);assert.ok(batch);
 // Reverse actual signed origin order, then authenticate the forwarding container again.
 batch.batch.events.reverse();const message=`kolo.batch.v2\u0000${canonicalJson(batch.batch)}`;batch.digest=await crypto.sha256(message);batch.signature=sign(null,Buffer.from(message),a.key).toString("hex");
 const outcomes=await importJournalBatch(b.context,batch,crypto);assert.ok(outcomes.every(o=>o.outcome==="applied"),JSON.stringify({outcomes,states:b.db.all(`SELECT e.event_type,a.status,a.reason FROM event_journal e JOIN applied_events a ON a.event_id=e.event_id`)}));
 for(const table of ["sales","purchases","inventory_movements","sale_items","purchase_items","customer_transactions","supplier_transactions","expenses","account_movements"]){
  assert.equal(count(a,table),count(b,table),table);
  if(!["sale_items","purchase_items"].includes(table))assert.ok(b.db.all(`SELECT branch_id FROM ${table}`).every(r=>r["branch_id"]===branch),table);
 }
 assert.equal(balanceOfAccount(a.db,a.install.businessId,account(a)).onHandMinor,balanceOfAccount(b.db,b.install.businessId,account(b)).onHandMinor);
 assert.equal(stockOf(b.db,b.install.businessId,p).onHandThousandths,2000);
});

it("HTTP v1 cannot apply unsigned incoming work to a configured v2 workspace",async()=>{
 const [a]=await replicas(1) as [Replica];const { SyncEngine }=await import("../data/sync/engine.ts");
 assert.throws(()=>new SyncEngine({database:a.db,businessId:a.install.businessId,transport:{push:async()=>({results:[],cursor:0,accepted:0,duplicates:0,rejected:0}),pull:async()=>({events:[],cursor:0,has_more:false})}}),/signed v2/);
});

it("reopening an interrupted file-backed import retains verified facts and applies each once",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"kolo-journal-restart-"));temporaryDirectories.push(directory);
 const [a,b]=await replicas(2,directory) as [Replica,Replica],p=product(a);await send(a,b);sale(a,p);await sealPendingEvents(a.context,crypto);
 const e=eventsForDestination(a.context,dest(a,b)).find(e=>e.envelope.event_type==="SALE_COMPLETED")!;
 b.db.run(`CREATE TRIGGER interrupted BEFORE INSERT ON sale_payments BEGIN SELECT RAISE(ABORT,'interruption'); END`);
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,e,crypto)),"deferred");
 databases.splice(databases.indexOf(b.db),1);b.db.close();b.db=openDatabase({location:join(directory,"replica-1.sqlite")});databases.push(b.db);migrate(b.db);b.ports={...b.ports,database:b.db};
 b.context=await unlockWorkspace({userId:b.install.ownerId,secret},b.ports);
 assert.equal(b.db.get(`SELECT status FROM applied_events WHERE event_id=?`,[e.envelope.event_id])!["status"],"deferred");
 b.db.run(`DROP TRIGGER interrupted`);assert.equal(retryDeferred(b.context),1);assert.equal(retryDeferred(b.context),0);assert.equal(count(b,"sales"),1);assert.equal(count(b,"sale_payments"),1);
});

it("safe individual transactions cannot expose an unsafe aggregate account balance",async()=>{
 const [a]=await replicas(1) as [Replica];
 for(let n=0;n<2;n++)commands.moveCash(a.context,{eventId:randomUUIDv7(),movements:[{id:randomUUIDv7(),accountId:account(a),type:"CASH_IN",amountMinor:4600000000000000,occurredAt:at}]});
 assert.equal(count(a,"account_movements"),2);assert.throws(()=>balanceOfAccount(a.db,a.install.businessId,account(a)));
});

it("an approved immutable bootstrap manifest remains readable after owner revision changes",async()=>{
 const [a,b]=await replicas() as [Replica,Replica];await sealPendingEvents(a.context,crypto);const root=eventsForDestination(a.context,dest(a,b)).find(e=>e.envelope.event_type==="WORKSPACE_CREATED")!;
 b.db.run(`UPDATE local_memberships SET revision=2 WHERE user_id=?`,[b.install.ownerId]);
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,root,crypto)),"applied");assert.equal(b.db.get(`SELECT revision FROM local_memberships WHERE user_id=?`,[b.install.ownerId])!["revision"],2);
});

it("bounded retries rotate past unsupported facts so they cannot starve later applicable work",async()=>{
 const [a,b]=await replicas() as [Replica,Replica];product(a);await sealPendingEvents(a.context,crypto);const productEvent=eventsForDestination(a.context,dest(a,b)).find(e=>e.envelope.event_type==="PRODUCT_SAVED")!;
 for(let n=0;n<4;n++){const future=await signed(a,{...productEvent.envelope,event_id:randomUUIDv7(),origin_sequence:n+10,event_version:3});assert.equal(applyEvent(b.context,await verifyEvent(b.context,future,crypto)),"unsupported");}
 b.db.run(`CREATE TRIGGER hold_product BEFORE INSERT ON products BEGIN SELECT RAISE(ABORT,'interruption'); END`);
 const later=await signed(a,{...productEvent.envelope,event_id:randomUUIDv7(),origin_sequence:100});assert.equal(applyEvent(b.context,await verifyEvent(b.context,later,crypto)),"deferred");b.db.run(`DROP TRIGGER hold_product`);
 let applied=0;for(let attempt=0;attempt<4;attempt++)applied+=retryDeferred(b.context,2,1);
 assert.equal(applied,1);assert.equal(count(b,"products"),1);
});

it("relayed durable-deferred receipts count a pending dependency once at each destination",async()=>{
 const [a,b,c]=await replicas(3) as [Replica,Replica,Replica],p=product(a);sale(a,p);await sealPendingEvents(a.context,crypto);
 const e=eventsForDestination(a.context,dest(a,b)).find(e=>e.envelope.event_type==="SALE_COMPLETED")!;assert.equal(applyEvent(b.context,await verifyEvent(b.context,e,crypto)),"deferred");
 const batch=await send(b,c),receipt=await createPeerReceipt(c.context,batch.batch.batch_id,crypto);assert.ok(receipt);assert.equal(receipt.receipt.entries.find(entry=>entry.event_id===e.envelope.event_id)!.state,"deferred");
 await acknowledgeDelivery(b.context,dest(b,c),receipt,crypto);assert.equal(exchangeStatus(b.context,dest(b,c))["deferred"],1);assert.equal(exchangeStatus(b.context,dest(b,c))["pending"],0);assert.equal(count(b,"sales"),0);assert.equal(count(c,"sales"),0);
});

it("category dependencies and last-write-wins edits relay without losing product associations", async () => {
  const [a,b] = await replicas() as [Replica,Replica], category = randomUUIDv7(), p = randomUUIDv7();
  commands.saveCategory(a.context, { id: category, name: "Groceries", active: true, createdAt: at, updatedAt: at });
  commands.saveProduct(a.context, { id: p, categoryId: category, name: "Rice", unit: "unit", divisible: false, sellingPriceMinor: 500, currency: "XAF", taxRateBasisPoints: 0, minimumStock: 0, active: true, createdAt: at, updatedAt: at });
  await sealPendingEvents(a.context,crypto); const events = eventsForDestination(a.context,dest(a,b));
  const productEvent = events.find(e => e.envelope.event_type === "PRODUCT_SAVED")!, categoryEvent = events.find(e => e.envelope.event_type === "CATEGORY_SAVED")!;
  assert.equal(applyEvent(b.context,await verifyEvent(b.context,productEvent,crypto)), "deferred");
  assert.equal(applyEvent(b.context,await verifyEvent(b.context,categoryEvent,crypto)), "applied"); assert.equal(retryDeferred(b.context),1);
  commands.saveCategory(a.context, { id: category, name: "Food", active: false, createdAt: at, updatedAt: "2026-10-06T06:01:00.000Z" });
  await send(a,b); assert.equal(b.db.get(`SELECT name FROM categories WHERE id=?`,[category])!["name"], "Food");
  assert.equal(b.db.get(`SELECT category_id FROM products WHERE id=?`,[p])!["category_id"],category);
  assert.equal(applyEvent(b.context,await verifyEvent(b.context,categoryEvent,crypto)), "duplicate");
});

it("additional product categories relay under last-write-wins, keep the main category for reports and replay harmlessly", async () => {
  const [a,b] = await replicas() as [Replica,Replica], food = randomUUIDv7(), drinks = randomUUIDv7(), promo = randomUUIDv7(), p = randomUUIDv7();
  for (const [id, name] of [[food, "Food"], [drinks, "Drinks"], [promo, "Promo"]] as const) commands.saveCategory(a.context, { id, name, active: true, createdAt: at, updatedAt: at });
  commands.saveProduct(a.context, { id: p, categoryId: food, name: "Juice", unit: "unit", divisible: false, sellingPriceMinor: 500, currency: "XAF", taxRateBasisPoints: 0, minimumStock: 0, active: true, createdAt: at, updatedAt: at });
  assert.equal(commands.setProductCategories(a.context, { productId: p, categoryIds: [promo, food, drinks, drinks], updatedAt: "2026-10-06T06:01:00.000Z" }), true);
  assert.deepEqual(a.db.all(`SELECT category_id FROM product_categories WHERE product_id=? ORDER BY category_id`, [p]).map(row => row["category_id"]), [drinks, promo].sort(), "the main category and duplicates are dropped");
  for (const id of [food, drinks, promo]) assert.deepEqual(queries.products(a.context, { categoryId: id }).items.map(item => item.id), [p]);
  assert.equal(commands.setProductCategories(a.context, { productId: p, categoryIds: [], updatedAt: "2026-10-06T06:00:30.000Z" }), false, "an older set loses");
  assert.throws(() => commands.setProductCategories(a.context, { productId: p, categoryIds: [randomUUIDv7()], updatedAt: "2026-10-06T06:02:00.000Z" }));
  await send(a,b);
  assert.deepEqual(b.db.all(`SELECT category_id FROM product_categories WHERE product_id=? ORDER BY category_id`, [p]).map(row => row["category_id"]), [drinks, promo].sort());
  assert.equal(b.db.get(`SELECT category_id FROM products WHERE id=?`, [p])!["category_id"], food);
  commands.setProductCategories(b.context, { productId: p, categoryIds: [promo], updatedAt: "2026-10-06T06:03:00.000Z" });
  await send(b,a);
  assert.deepEqual(a.db.all(`SELECT category_id FROM product_categories WHERE product_id=?`, [p]).map(row => row["category_id"]), [promo]);
  const sets = eventsForDestination(a.context, dest(a,b)).filter(e => e.envelope.event_type === "PRODUCT_CATEGORIES_SET");
  for (const e of sets) assert.equal(applyEvent(b.context, await verifyEvent(b.context, e, crypto)), "duplicate");
  assert.deepEqual(b.db.all(`SELECT category_id FROM product_categories WHERE product_id=?`, [p]).map(row => row["category_id"]), [promo], "a replayed older set never overwrites the newer one");
});

it("partial returns replay in predecessor order, duplicate harmlessly and quarantine competing source chains",async()=>{
 const {returnSale,previewReturn}=await import("./returns.ts");const [a,b]=await replicas() as [Replica,Replica],p=product(a),saleId=randomUUIDv7(),lineId=randomUUIDv7();
 commands.completeSale(a.context,{id:saleId,number:saleId,lines:[{id:lineId,movementId:randomUUIDv7(),productId:p,name:"Rice",unitPriceMinor:500,quantity:3000}],payments:[{id:randomUUIDv7(),accountId:account(a),amountMinor:1500}],occurredAt:at,eventId:randomUUIDv7()});await send(a,b);
 const record=(r:Replica)=>{const preview=previewReturn(r.context,"SALE",saleId,[{originalItemId:lineId,quantity:1000}]);returnSale(r.context,{id:randomUUIDv7(),eventId:randomUUIDv7(),originalId:saleId,priorId:preview.source.priorId,reason:"Returned rice",items:[{id:randomUUIDv7(),movementId:randomUUIDv7(),originalItemId:lineId,quantity:1000}],refunds:[{id:randomUUIDv7(),accountId:account(r),amountMinor:preview.totalMinor}]});};
 record(a);record(a);await sealPendingEvents(a.context,crypto);const returns=eventsForDestination(a.context,dest(a,b)).filter(e=>e.envelope.event_type==="SALE_RETURNED");assert.equal(returns.length,2);
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,returns[1]!,crypto)),"deferred");assert.equal(applyEvent(b.context,await verifyEvent(b.context,returns[0]!,crypto)),"applied");assert.equal(retryDeferred(b.context),1);
 for(const e of returns)assert.equal(applyEvent(b.context,await verifyEvent(b.context,e,crypto)),"duplicate");
 assert.equal(stockOf(a.db,a.install.businessId,p).onHandThousandths,stockOf(b.db,b.install.businessId,p).onHandThousandths);assert.equal(balanceOfAccount(b.db,b.install.businessId,account(b)).onHandMinor,500);
 record(a);record(b);await sealPendingEvents(b.context,crypto);const competing=eventsForDestination(b.context,dest(b,a)).find(e=>e.envelope.event_type==="SALE_RETURNED"&&e.envelope.origin_device_id===b.install.deviceId)!;
 assert.equal(applyEvent(a.context,await verifyEvent(a.context,competing,crypto)),"quarantined");assert.equal(count(a,"business_returns"),3);assert.equal(stockOf(a.db,a.install.businessId,p).onHandThousandths,0);
});

it("tax settings, product tax rules and payment terms relay under last-write-wins; sales keep their frozen rate everywhere", async () => {
  const [a,b] = await replicas() as [Replica,Replica], p = product(a), exempt = product(a), customer = randomUUIDv7(), later = "2026-10-06T07:00:00.000Z";
  commands.saveCustomer(a.context, { id: customer, name: "Ama", active: true, createdAt: at, updatedAt: at });
  commands.setTaxSettings(a.context, { enabled: true, label: "TVA", standardRateBasisPoints: 1925, registration: "NIU-1", updatedAt: at });
  commands.setProductTaxRule(a.context, { productId: exempt, rule: "EXEMPT", updatedAt: at });
  commands.setPaymentTerms(a.context, { party: "CUSTOMER", days: 15, updatedAt: at });
  commands.setPaymentTerms(a.context, { party: "CUSTOMER", partyId: customer, days: 45, updatedAt: at });
  const sold = sale(a,p);
  await send(a,b);
  assert.deepEqual({ ...b.db.get(`SELECT enabled,label,standard_rate_basis_points AS rate,registration FROM shop_tax_settings`) }, { enabled: 1, label: "TVA", rate: 1925, registration: "NIU-1" });
  assert.equal(b.db.get(`SELECT rule FROM product_tax_rules WHERE id=?`, [exempt])!["rule"], "EXEMPT");
  assert.deepEqual(b.db.all(`SELECT party_id,days FROM payment_terms ORDER BY days`).map(row => [row["party_id"], row["days"]]), [[null, 15], [customer, 45]]);
  assert.equal(b.db.get(`SELECT tax_rate_basis_points AS r FROM sale_items WHERE sale_id=?`, [sold])!["r"], 1925, "the replica keeps the rate frozen by the till that sold");
  assert.equal(queries.receipt(b.context, sold).tax?.groups[0]?.taxMinor, 81);

  // B changes the rate later; A adopts it, and A's older replayed facts never undo it.
  commands.setTaxSettings(b.context, { enabled: true, label: "TVA", standardRateBasisPoints: 1000, updatedAt: later });
  commands.setPaymentTerms(b.context, { party: "CUSTOMER", partyId: customer, days: null, updatedAt: later });
  await send(b,a);
  assert.equal(a.db.get(`SELECT standard_rate_basis_points AS r FROM shop_tax_settings`)!["r"], 1000);
  assert.equal(a.db.get(`SELECT days FROM payment_terms WHERE party_id=?`, [customer])!["days"], null);
  assert.equal(a.db.get(`SELECT tax_rate_basis_points AS r FROM sale_items WHERE sale_id=?`, [sold])!["r"], 1925, "history is never re-rated");
  for (const e of eventsForDestination(a.context, dest(a,b)).filter(e => ["TAX_SETTINGS_SET","PAYMENT_TERMS_SET","PRODUCT_TAX_SET"].includes(e.envelope.event_type)))
    assert.equal(applyEvent(b.context, await verifyEvent(b.context, e, crypto)), "duplicate");
  assert.equal(b.db.get(`SELECT standard_rate_basis_points AS r FROM shop_tax_settings`)!["r"], 1000);

  // A signed fact claiming less authority than its kind needs is quarantined with no effect.
  const original = eventsForDestination(a.context, dest(a,b)).find(e => e.envelope.event_type === "TAX_SETTINGS_SET")!;
  const forged = structuredClone(original.envelope); forged.event_id = randomUUIDv7(); forged.origin_sequence = 900; forged.required_permissions = ["sales.create"];
  forged.payload = { enabled: false, label: "TVA", standard_rate_basis_points: 0, updated_at: "2026-10-06T08:00:00.000Z" };
  assert.notEqual(applyEvent(b.context, await verifyEvent(b.context, await signed(a, forged), crypto)), "applied");
  assert.equal(b.db.get(`SELECT enabled FROM shop_tax_settings`)!["enabled"], 1);
  const badTerms = structuredClone(eventsForDestination(a.context, dest(a,b)).find(e => e.envelope.event_type === "PAYMENT_TERMS_SET")!.envelope);
  badTerms.event_id = randomUUIDv7(); badTerms.origin_sequence = 901; badTerms.payload = { party: "CUSTOMER", days: null, updated_at: "2026-10-06T08:00:00.000Z" };
  assert.equal(applyEvent(b.context, await verifyEvent(b.context, await signed(a, badTerms), crypto)), "quarantined", "a shop default must have days");
});

it("a sale at a price the catalogue held replays after a later repricing; an unclaimed override stays quarantined", async () => {
  const [a,b] = await replicas() as [Replica,Replica], p = product(a), later = "2026-10-06T07:00:00.000Z";
  await send(a,b);
  commands.saveProduct(b.context, { id: p, name: "Rice", unit: "bag", divisible: false, active: true, sellingPriceMinor: 600, purchasePriceMinor: 300, currency: "XAF", taxRateBasisPoints: 0, minimumStock: 0, createdAt: at, updatedAt: later });
  const sold = sale(a,p), batch = await send(a,b), event = batch.batch.events.find(e => e.envelope.event_type === "SALE_COMPLETED")!;
  assert.deepEqual(event.envelope.required_permissions, ["sales.create"]);
  assert.equal(b.db.get(`SELECT status FROM applied_events WHERE event_id=?`, [event.envelope.event_id])!["status"], "applied");
  assert.equal(b.db.get(`SELECT unit_price_minor AS price FROM sale_items WHERE sale_id=?`, [sold])!["price"], 500);
  assert.equal(stockOf(b.db,b.install.businessId,p).onHandThousandths, -1000);

  // A price no signed catalogue fact ever set still needs the override its signer claimed.
  const id = randomUUIDv7();
  commands.completeSale(a.context, { id, number: `V-${id}`, eventId: randomUUIDv7(), occurredAt: at, lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, name: "Rice", unitPriceMinor: 450, quantity: 1000 }], payments: [{ id: randomUUIDv7(), accountId: account(a), amountMinor: 450 }] });
  await sealPendingEvents(a.context, crypto);
  const override = eventsForDestination(a.context, dest(a,b)).find(e => e.envelope.event_type === "SALE_COMPLETED" && (e.envelope.payload["sale"] as { id: string }).id === id)!;
  assert.ok(override.envelope.required_permissions.includes("sales.price_override"));
  const unclaimed = structuredClone(override.envelope); unclaimed.required_permissions = ["sales.create"];
  assert.equal(applyEvent(b.context, await verifyEvent(b.context, await signed(a, unclaimed), crypto)), "quarantined");
  assert.equal(b.db.get(`SELECT reason FROM applied_events WHERE event_id=?`, [unclaimed.event_id])!["reason"], "permission_denied");
  assert.equal(count(b,"sales"), 1);
});

it("change kept on account travels as an ordinary customer payment and reads back on the other till's receipt", async () => {
  const [a,b] = await replicas() as [Replica,Replica], p = product(a), customer = randomUUIDv7(), id = randomUUIDv7();
  commands.saveCustomer(a.context, { id: customer, name: "Awa", active: true, createdAt: at, updatedAt: at });
  commands.completeSale(a.context, { id, number: `V-${id}`, eventId: randomUUIDv7(), occurredAt: at, customerId: customer,
    lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId: p, name: "Rice", unitPriceMinor: 500, quantity: 1000 }], payments: [{ id: randomUUIDv7(), accountId: account(a), amountMinor: 500 }] },
  { id: randomUUIDv7(), eventId: randomUUIDv7(), accountId: account(a), amountMinor: 500 });
  const batch = await send(a,b);
  assert.deepEqual(batch.batch.events.map(e => e.envelope.event_type).filter(type => ["SALE_COMPLETED","CUSTOMER_PAYMENT"].includes(type)), ["SALE_COMPLETED","CUSTOMER_PAYMENT"]);
  for (const r of [a,b]) {
    assert.equal(r.db.get(`SELECT sum(amount_minor) AS n FROM customer_transactions WHERE customer_id=?`, [customer])!["n"], -500, "the same advance on both tills");
    assert.equal(queries.receipt(r.context, id).changeKeptMinor, 500);
    assert.equal(balanceOfAccount(r.db, r.install.businessId, account(r)).onHandMinor, 1000);
  }
  assert.deepEqual(b.db.all(`SELECT a.status FROM applied_events a JOIN event_journal e ON e.event_id=a.event_id WHERE e.provenance='received' AND a.status<>'applied'`), []);
});

it("custom roles and moves onto them converge; a move waits for its role, a changed base or same-revision rewrite is a conflict",async()=>{
 const [a,b]=await replicas() as [Replica,Replica];
 const { createLocalMember }=await import("../identity/members.ts");
 const { createCustomRole,updateCustomRole,deleteCustomRole,changeMemberRole,listCustomRoles }=await import("../identity/roles.ts");
 const member=await createLocalMember(a.context,{name:"Staff",role:"CASHIER",secret:"654321"});
 const night=createCustomRole(a.context,{id:randomUUIDv7(),name:"Night",baseRole:"CASHIER"}),gone=createCustomRole(a.context,{id:randomUUIDv7(),name:"Gone",baseRole:"MANAGER"});
 updateCustomRole(a.context,night.id,{permissions:["sales.create","reports.sales"]});deleteCustomRole(a.context,gone.id);
 changeMemberRole(a.context,member,{customRoleId:night.id});
 await send(a,b);
 assert.deepEqual(listCustomRoles(b.context),listCustomRoles(a.context));assert.equal(listCustomRoles(b.context)[0]!.holders,1);
 assert.equal(b.db.get(`SELECT deleted FROM custom_roles WHERE id=?`,[gone.id])!["deleted"],1,"the tombstone travels");
 const row=(r:Replica)=>r.db.get(`SELECT m.role,m.custom_role_id,m.revision,u.role AS user_role FROM local_memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=?`,[member]);
 assert.deepEqual(row(b),row(a));assert.equal(row(b)!["custom_role_id"],night.id);
 assert.ok(auditTrail(b.context,{}).items.some(entry=>entry.type==="MEMBER_ROLE_CHANGED"&&entry.facts.reference==="Night"),"the journal names the custom role");
 const later=createCustomRole(a.context,{id:randomUUIDv7(),name:"Later",baseRole:"INVENTORY"});changeMemberRole(a.context,member,{customRoleId:later.id});
 const facts=(type:string)=>a.db.all(`SELECT canonical FROM event_journal WHERE event_type=?`,[type]).map(r=>JSON.parse(String(r["canonical"])) as JournalEnvelope);
 const fact=facts("CUSTOM_ROLE_SET").find(e=>e.payload["role_id"]===night.id&&e.payload["revision"]===2)!;
 let next=Number(a.db.get(`SELECT max(origin_sequence) AS n FROM event_journal WHERE origin_device_id=?`,[a.install.deviceId])!["n"]);
 const variant=async(payload:Record<string,unknown>,base=fact)=>{const e:JournalEnvelope={...base,event_id:randomUUIDv7(),origin_sequence:++next,payload:payload as JournalEnvelope["payload"]};return [e,applyEvent(b.context,await verifyEvent(b.context,await signed(a,e),crypto))] as const;};
 assert.equal((await variant({...fact.payload,revision:1,permissions:[]}))[1],"applied","a stale revision loses");
 assert.deepEqual(listCustomRoles(b.context)[0]!.permissions,["sales.create","reports.sales"]);
 const [rewrite,rewritten]=await variant({...fact.payload,name:"Day"});assert.equal(rewritten,"quarantined");
 assert.equal(b.db.get(`SELECT reason FROM applied_events WHERE event_id=?`,[rewrite.event_id])!["reason"],"conflict");
 assert.equal((await variant({...fact.payload,base_role:"MANAGER",revision:9}))[1],"quarantined","a role's base never changes");
 assert.equal((await variant({...fact.payload,base_role:"OWNER",revision:9}))[1],"quarantined");
 // A move onto a role the other till has not seen waits for that role.
 const move=facts("MEMBER_ROLE_CHANGED").at(-1)!,laterFact=facts("CUSTOM_ROLE_SET").find(e=>e.payload["role_id"]===later.id)!;
 assert.notEqual(applyEvent(b.context,await verifyEvent(b.context,await signed(a,move),crypto)),"applied");
 assert.equal(row(b)!["custom_role_id"],night.id);
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,await signed(a,laterFact),crypto)),"applied");
 await retryDeferred(b.context);assert.equal(row(b)!["custom_role_id"],later.id);assert.equal(row(b)!["role"],"INVENTORY");
 const staffFact:JournalEnvelope={...fact,event_id:randomUUIDv7(),origin_sequence:++next,actor_id:member,authority_revision:Number(row(a)!["revision"]),payload:{...fact.payload,revision:20}};
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,await signed(a,staffFact),crypto)),"quarantined","only the owner sets roles");
});

it("the role matrix, role moves and cleared exceptions converge; stale role facts lose and a same-revision rewrite is a conflict",async()=>{
 const [a,b]=await replicas() as [Replica,Replica];
 const { createLocalMember }=await import("../identity/members.ts");const { grantPermission,clearPermissionOverride }=await import("../identity/workspace.ts");
 const { setRolePermissions,changeMemberRole,listRoles }=await import("../identity/roles.ts");
 const member=await createLocalMember(a.context,{name:"Staff",role:"CASHIER",secret:"654321"});
 setRolePermissions(a.context,"CASHIER",["sales.create","products.view"]);setRolePermissions(a.context,"MANAGER",["reports.sales"]);setRolePermissions(a.context,"MANAGER",null);
 changeMemberRole(a.context,member,"ACCOUNTANT");grantPermission(a.context,member,"sales.create");clearPermissionOverride(a.context,member,"sales.create");
 await send(a,b);
 assert.deepEqual(listRoles(b.context),listRoles(a.context));
 const row=(r:Replica)=>r.db.get(`SELECT m.role,m.granted,m.revoked,m.revision,u.role AS user_role FROM local_memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=?`,[member]);
 assert.deepEqual(row(b),row(a));assert.equal(row(b)!["role"],"ACCOUNTANT");assert.equal(row(b)!["revision"],4);
 const fact=a.db.all(`SELECT canonical FROM event_journal WHERE event_type='ROLE_PERMISSIONS_SET'`).map(r=>JSON.parse(String(r["canonical"])) as JournalEnvelope).find(e=>e.payload["role"]==="CASHIER")!;
 const next=Number(a.db.get(`SELECT max(origin_sequence) AS n FROM event_journal WHERE origin_device_id=?`,[a.install.deviceId])!["n"]);
 const stale:JournalEnvelope={...fact,event_id:randomUUIDv7(),origin_sequence:next+1,payload:{role:"MANAGER",permissions:[],revision:1}};
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,await signed(a,stale),crypto)),"applied");
 assert.equal(listRoles(b.context).find(v=>v.role==="MANAGER")!.customized,false,"revision 2 already returned the role to its defaults");
 const rewrite:JournalEnvelope={...fact,event_id:randomUUIDv7(),origin_sequence:next+2,payload:{role:"CASHIER",permissions:["sales.create","sales.refund"],revision:1}};
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,await signed(a,rewrite),crypto)),"quarantined");assert.equal(b.db.get(`SELECT reason FROM applied_events WHERE event_id=?`,[rewrite.event_id])!["reason"],"conflict");
 assert.deepEqual(listRoles(b.context).find(v=>v.role==="CASHIER")!.permissions,["products.view","sales.create"]);
 const staffFact:JournalEnvelope={...fact,event_id:randomUUIDv7(),origin_sequence:next+3,actor_id:member,authority_revision:4,payload:{role:"CASHIER",permissions:null,revision:9}};
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,await signed(a,staffFact),crypto)),"quarantined","only the owner sets roles");
 assert.throws(()=>reviewQuarantinedEvent(b.context,staffFact.event_id,b.db.get(`SELECT digest FROM event_signatures WHERE event_id=?`,[staffFact.event_id])!["digest"] as string),/permission_denied/);
 assert.equal(listRoles(b.context).find(v=>v.role==="CASHIER")!.revision,1);
});
