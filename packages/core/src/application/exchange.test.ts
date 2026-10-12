import assert from "node:assert/strict";
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
import { registerExchangeDestination, eventSigningMessage, verifyEvent, sealPendingEvents } from "./exchange.ts";
import { applyEvent, retryDeferred, reviewQuarantinedEvent } from "./event-application.ts";
import { createJournalBatch, importJournalBatch, createPeerReceipt, acknowledgeDelivery, eventsForDestination, exchangeStatus } from "./event-delivery.ts";
import * as commands from "./operations.ts";
import * as queries from "./queries.ts";
import { stockOf } from "../data/inventory/movements.ts";
import { balanceOfAccount } from "../data/finance/cash.ts";

const at="2026-10-06T06:00:00.000Z", secret="fixture-owner-secret";
const crypto:ExchangeCrypto={sha256:async message=>createHash("sha256").update(message).digest("hex"),verify:async(key,message,signature)=>verify(null,Buffer.from(message),key,Buffer.from(signature,"hex"))};
const databases:Database[]=[], temporaryDirectories:string[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();for(const path of temporaryDirectories.splice(0))rmSync(path,{recursive:true,force:true});});
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

it("late facts require exact-digest owner review after revocation; device revocation blocks verification",async()=>{
 const [a,b]=await replicas() as [Replica,Replica],p=product(a);await send(a,b);sale(a,p);await sealPendingEvents(a.context,crypto);const e=eventsForDestination(a.context,dest(a,b)).find(e=>e.envelope.event_type==="SALE_COMPLETED")!;
 b.db.run(`UPDATE local_memberships SET revision=2 WHERE business_id=? AND user_id=?`,[b.install.businessId,b.install.ownerId]);
 assert.equal(applyEvent(b.context,await verifyEvent(b.context,e,crypto)),"quarantined");assert.equal(count(b,"sales"),0);
 assert.throws(()=>reviewQuarantinedEvent(b.context,e.envelope.event_id,"0".repeat(64)));assert.equal(reviewQuarantinedEvent(b.context,e.envelope.event_id,e.digest),"applied");
 b.db.run(`UPDATE trusted_exchange_devices SET active=0,revision=revision+1 WHERE device_id=?`,[a.install.deviceId]);await assert.rejects(verifyEvent(b.context,e,crypto));
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
