import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, randomUUIDv7 } from "node:crypto";
import { openDesktopDatabase } from "./database.ts";
import { DesktopApplication } from "./application.ts";
import { desktopHandlers } from "./handlers.ts";
import { localCredentialsOnDesktop, desktopExchangeCrypto, type NativeSafeStorage } from "./local-credentials.ts";
import { balanceOfAccount } from "@kolo/core/data/finance/cash";
import { createLocalMember } from "@kolo/core/identity/members";
import { unlockWorkspace } from "@kolo/core/identity/workspace";
import { saveAccount } from "@kolo/core/application/operations";
import type { CredentialPort, WorkspacePorts } from "@kolo/core/identity/types";
import type { ProductRequest, Result, WorkspaceView } from "../shared/service.ts";

function value<T>(result: Result<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error("unexpected failure"); return result.value; }
function failure(result: Result<unknown>, code: string): void { assert.deepEqual(result, { ok: false, error: { code } }); }
// Host tests use real SQLite/OpenSSL/AES, substituting only the OS-vault API.
// The separate actual Electron workflow exercises the OS provider itself.
function native(): NativeSafeStorage {
  const key=randomBytes(32);
  return { isAsyncEncryptionAvailable:async()=>true,getSelectedStorageBackend:()=>"gnome_libsecret",
    encryptStringAsync:async message=>{const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,iv);return Buffer.concat([iv,cipher.update(message,"utf8"),cipher.final(),cipher.getAuthTag()]);},
    decryptStringAsync:async bytes=>{const decipher=createDecipheriv("aes-256-gcm",key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return {result:Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString("utf8"),shouldReEncrypt:false};} };
}
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),"kolo-desktop-application-")),database=openDesktopDatabase(join(directory,"shop.db")),os=native();
  const credentials=localCredentialsOnDesktop(join(directory,"vault"),os);
  const ports:WorkspacePorts={database,credentials,newId:randomUUIDv7,now:()=>"2026-10-06T12:00:00.000Z"};
  const application=new DesktopApplication(ports,desktopExchangeCrypto);
  return {directory,database,ports,os,application,async dispose(){await application.dispose();database.close();rmSync(directory,{recursive:true,force:true});}};
}
async function owner(f:ReturnType<typeof fixture>):Promise<WorkspaceView>{
  await f.application.initialize();
  const setup=value(await f.application.createShop({businessName:"Shop",ownerName:"Owner",deviceLabel:"PC",cashAccountName:"Cash",secret:"654321"}));
  assert.equal(setup.state,"locked");
  return value(await f.application.unlock({userId:setup.members[0]!.id,secret:"654321"}));
}
function product(sessionId:string,changes:Partial<ProductRequest>={}):ProductRequest{
  return {sessionId,requestId:randomUUID(),name:"Rice",unit:"bag",divisible:true,sellingPriceMinor:500,purchasePriceMinor:300,barcode:"123456789",openingThousandths:3000,...changes};
}
it("real desktop setup, cash checkout/retry, signature and restart preserve stock/cash/receipt",async()=>{
  const f=fixture();let reopened:DesktopApplication|undefined;let next:ReturnType<typeof openDesktopDatabase>|undefined;
  try{
    const workspace=await owner(f),sessionId=workspace.sessionId!,input=product(sessionId);
    const saved=value(await f.application.createProduct(input));assert.equal(saved.onHandThousandths,3000);
    assert.equal(value(await f.application.createProduct(input)).id,saved.id);
    assert.equal(f.database.get("SELECT count(*) AS n FROM inventory_movements")!["n"],1);
    const account=value(await f.application.listCashAccounts({sessionId})).items[0]!;
    const request={sessionId,requestId:randomUUID(),accountId:account.id,lines:[{productId:saved.id,quantity:500,unitPriceMinor:500}]};
    const sale=value(await f.application.checkout(request));
    assert.equal(value(await f.application.checkout(request)).saleId,sale.saleId);
    failure(await f.application.checkout({...request,lines:[{...request.lines[0]!,quantity:1000}]}),"request_conflict");
    assert.equal(value(await f.application.getReceipt({sessionId,saleId:sale.saleId})).totalMinor,250);
    assert.equal(value(await f.application.listProducts({sessionId})).items[0]!.onHandThousandths,2500);
    assert.equal(balanceOfAccount(f.database,String(f.database.get("SELECT id FROM businesses")!["id"]),account.id).onHandMinor,250);
    await f.application.seal();assert.equal(f.database.get("SELECT count(*) AS n FROM event_signatures")!["n"],f.database.get("SELECT count(*) AS n FROM event_journal")!["n"]);
    const recovery=value(await f.application.recoveryKey({sessionId,secret:"654321"}));assert.match(recovery!,/^[0-9a-f]{64}$/);
    await f.application.dispose();f.database.close();
    next=openDesktopDatabase(join(f.directory,"shop.db"));
    reopened=new DesktopApplication({...f.ports,database:next,credentials:localCredentialsOnDesktop(join(f.directory,"vault"),f.os)});
    await reopened.initialize();assert.equal(value(await reopened.getWorkspace()).state,"locked");
    failure(await reopened.getReceipt({sessionId,saleId:sale.saleId}),"locked");
    const unlocked=value(await reopened.unlock({userId:workspace.members[0]!.id,secret:"654321"}));assert.notEqual(unlocked.sessionId,sessionId);
    assert.equal(value(await reopened.getReceipt({sessionId:unlocked.sessionId!,saleId:sale.saleId})).totalMinor,250);
    assert.equal(value(await reopened.listProducts({sessionId:unlocked.sessionId!})).items[0]!.onHandThousandths,2500);
    assert.equal(value(await reopened.checkout({...request,sessionId:unlocked.sessionId!})).saleId,sale.saleId);
    assert.equal(next.get("SELECT count(*) AS n FROM sales")!["n"],1);
  }finally{await reopened?.dispose();next?.close();await f.application.dispose();try{f.database.close();}catch{/* Fixture was already closed to verify restart. */}rmSync(f.directory,{recursive:true,force:true});}
});
it("strict runtime validation rejects malformed/oversized/claimed-authority requests without effects",async()=>{
  const f=fixture();try{
    failure(await f.application.createShop({businessName:"Shop",ownerName:"Owner",deviceLabel:"PC",cashAccountName:"Cash",secret:"654321",businessId:randomUUID()}),"invalid_input");
    assert.equal(f.database.get("SELECT count(*) AS n FROM businesses")!["n"],0);
    const {sessionId}=await owner(f);
    for(const input of [null,[],Object.create({sessionId}),{sessionId,limit:101},{sessionId,limit:NaN},{sessionId,term:"a".repeat(121)},{sessionId,executeSql:"DELETE"},{sessionId,after:{name:"A",id:"not-uuid"}}])failure(await f.application.listProducts(input),"invalid_input");
    for(const override of [{sellingPriceMinor:1.5},{sellingPriceMinor:"500"},{divisible:"true"},{name:"a".repeat(121)},{requestId:"../file"},{openingThousandths:Number.MAX_SAFE_INTEGER+1}])failure(await f.application.createProduct({...product(sessionId!),...override}),"invalid_input");
    failure(await f.application.checkout({sessionId,requestId:randomUUID(),accountId:randomUUID(),lines:new Array(201).fill({productId:randomUUID(),quantity:1000,unitPriceMinor:500})}),"invalid_input");
    assert.equal(f.database.get("SELECT count(*) AS n FROM products")!["n"],0);
  }finally{await f.dispose();}
});
it("product/opening stock and sale fan-out roll back together, leaving the same request safe to retry",async()=>{
  const f=fixture();try{
    const {sessionId}=await owner(f),input=product(sessionId!);
    f.database.run(`CREATE TRIGGER fail_stock_audit BEFORE INSERT ON local_audit WHEN NEW.action='STOCK_ADJUSTED' BEGIN SELECT RAISE(ABORT,'failpoint'); END`);
    failure(await f.application.createProduct(input),"storage_failed");assert.equal(f.database.get("SELECT count(*) AS n FROM products")!["n"],0);assert.equal(f.database.get("SELECT count(*) AS n FROM event_journal")!["n"],1);
    f.database.run("DROP TRIGGER fail_stock_audit");const item=value(await f.application.createProduct(input));
    const account=value(await f.application.listCashAccounts({sessionId})).items[0]!,request={sessionId,requestId:randomUUID(),accountId:account.id,lines:[{productId:item.id,quantity:1000,unitPriceMinor:500}]};
    f.database.run(`CREATE TRIGGER fail_sale_audit BEFORE INSERT ON local_audit WHEN NEW.action='SALE_COMPLETED' BEGIN SELECT RAISE(ABORT,'failpoint'); END`);
    failure(await f.application.checkout(request),"storage_failed");assert.equal(f.database.get("SELECT count(*) AS n FROM sales")!["n"],0);assert.equal(value(await f.application.listProducts({sessionId})).items[0]!.onHandThousandths,3000);
    f.database.run("DROP TRIGGER fail_sale_audit");value(await f.application.checkout(request));assert.equal(f.database.get("SELECT count(*) AS n FROM sales")!["n"],1);
  }finally{await f.dispose();}
});
it("cashier commands recheck revocation and own-receipt scope, including direct bridge bypass attempts",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),item=value(await f.application.createProduct(product(workspace.sessionId!))),account=value(await f.application.listCashAccounts({sessionId:workspace.sessionId})).items[0]!;
    const ownerSale=value(await f.application.checkout({sessionId:workspace.sessionId,requestId:randomUUID(),accountId:account.id,lines:[{productId:item.id,quantity:1000,unitPriceMinor:500}]}));
    const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports);
    const staff=await createLocalMember(context,{name:"Cashier",role:"CASHIER",secret:"765432"});
    const cashier=value(await f.application.unlock({userId:staff,secret:"765432"})),sessionId=cashier.sessionId!;
    failure(await f.application.createProduct(product(sessionId)),"permission_denied");
    failure(await f.application.getReceipt({sessionId,saleId:ownerSale.saleId}),"scope_mismatch");
    assert.equal(value(await f.application.listReceipts({sessionId})).items.length,0);
    const request={sessionId,requestId:randomUUID(),accountId:account.id,lines:[{productId:item.id,quantity:1000,unitPriceMinor:500}]};
    const sale=value(await f.application.checkout(request));assert.equal(value(await f.application.getReceipt({sessionId,saleId:sale.saleId})).totalMinor,500);
    f.database.run(`UPDATE local_memberships SET revoked='["sales.view_own"]',revision=revision+1 WHERE user_id=?`,[staff]);
    failure(await f.application.getReceipt({sessionId,saleId:sale.saleId}),"permission_denied");
    assert.equal(value(await f.application.checkout(request)).saleId,sale.saleId);
    f.database.run(`UPDATE local_memberships SET revoked='["sales.create"]',revision=revision+1 WHERE user_id=?`,[staff]);
    failure(await f.application.checkout({...request,requestId:randomUUID()}),"permission_denied");
    f.database.run(`UPDATE local_memberships SET active=0 WHERE user_id=?`,[staff]);
    failure(await f.application.listProducts({sessionId}),"actor_inactive");assert.equal(value(await f.application.getWorkspace()).state,"locked");
  }finally{await f.dispose();}
});
it("stale prices, whole-unit fractions, foreign references and changed same-ID creations are refused",async()=>{
  const f=fixture();try{
    const {sessionId}=await owner(f),input=product(sessionId!,{divisible:false}),item=value(await f.application.createProduct(input));
    failure(await f.application.createProduct({...input,name:"Different"}),"request_conflict");
    const foreignShop=randomUUIDv7(),foreignProduct=randomUUIDv7(),foreignAccount=randomUUIDv7(),at=f.ports.now();
    f.database.run(`INSERT INTO businesses(id,name,currency,created_at,updated_at) VALUES (?,'Other shop','XAF',?,?)`,[foreignShop,at,at]);
    f.database.run(`INSERT INTO products(id,business_id,name,unit,divisible,selling_price_minor,currency,created_at,updated_at) VALUES (?,?,'Other rice','bag',0,500,'XAF',?,?)`,[foreignProduct,foreignShop,at,at]);
    f.database.run(`INSERT INTO financial_accounts(id,business_id,name,kind,currency,created_at,updated_at) VALUES (?,?,'Other cash','CASH','XAF',?,?)`,[foreignAccount,foreignShop,at,at]);
    const account=value(await f.application.listCashAccounts({sessionId})).items[0]!,request={sessionId,requestId:randomUUID(),accountId:account.id,lines:[{productId:item.id,quantity:1000,unitPriceMinor:500}]};
    failure(await f.application.checkout({...request,accountId:randomUUID()}),"scope_mismatch");
    failure(await f.application.checkout({...request,accountId:foreignAccount}),"scope_mismatch");
    failure(await f.application.checkout({...request,lines:[{...request.lines[0]!,productId:foreignProduct}]}),"scope_mismatch");
    failure(await f.application.createProduct({...input,requestId:foreignProduct}),"request_conflict");
    assert.equal(value(await f.application.listProducts({sessionId,term:"Other"})).items.length,0);
    failure(await f.application.checkout({...request,lines:[{...request.lines[0]!,unitPriceMinor:499}]}),"price_changed");
    failure(await f.application.checkout({...request,lines:[{...request.lines[0]!,quantity:500}]}),"invalid_input");
    failure(await f.application.getReceipt({sessionId,saleId:randomUUID()}),"scope_mismatch");
    failure(await f.application.checkout({...request,lines:[{...request.lines[0]!,productId:randomUUID()}]}),"scope_mismatch");
    const large=value(await f.application.checkout({...request,lines:[{...request.lines[0]!,quantity:5000}]}));assert.ok(large.saleId);assert.equal(value(await f.application.listProducts({sessionId})).items[0]!.onHandThousandths,-2000);
    assert.equal(value(await f.application.scanProduct({sessionId,barcode:"Rice"})),null);assert.equal(value(await f.application.scanProduct({sessionId,barcode:"123456789"}))!.id,item.id);
  }finally{await f.dispose();}
});
it("lock cancels an in-flight native unlock and the host rejects overlapping identity commands",async()=>{
  const f=fixture();let delayed:DesktopApplication|undefined;
  try{
    const workspace=await owner(f);await f.application.dispose();
    let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    const credentials:CredentialPort={...f.ports.credentials,verify:async(reference,secret)=>{started();await gate;return await f.ports.credentials.verify(reference,secret);}};
    delayed=new DesktopApplication({...f.ports,credentials});await delayed.initialize();
    const unlocking=delayed.unlock({userId:workspace.members[0]!.id,secret:"654321"});await entered;
    failure(await delayed.unlock({userId:workspace.members[0]!.id,secret:"654321"}),"busy");value(await delayed.lock());release();failure(await unlocking,"locked");assert.equal(value(await delayed.getWorkspace()).state,"locked");
  }finally{await delayed?.dispose();await f.dispose();}
});
it("interrupted native setup preserves its intent and shutdown waits before closing SQLite",async()=>{
  const f=fixture();let slow:DesktopApplication|undefined;
  try{
    await f.application.dispose();let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    slow=new DesktopApplication({...f.ports,credentials:{...f.ports.credentials,provision:async request=>{started();await gate;return await f.ports.credentials.provision(request);}}});
    const creating=slow.createShop({businessName:"Shop",ownerName:"Owner",deviceLabel:"PC",cashAccountName:"Cash",secret:"654321"});await entered;
    assert.equal(f.database.get("SELECT count(*) AS n FROM workspace_setup")!["n"],1);
    let disposed=false;const disposing=slow.dispose().then(()=>{disposed=true;});await Promise.resolve();assert.equal(disposed,false);release();failure(await creating,"locked");await disposing;assert.equal(disposed,true);
    failure(await slow.getWorkspace(),"unavailable");assert.equal(f.database.get("SELECT count(*) AS n FROM businesses")!["n"],1);
    slow=new DesktopApplication(f.ports);await slow.initialize();assert.equal(value(await slow.getWorkspace()).state,"locked");
  }finally{await slow?.dispose();await f.dispose();}
});
it("pending setup can resume and owner recovery replaces access without removing business facts",async()=>{
  const f=fixture();let interrupted:DesktopApplication|undefined;
  try{
    await f.application.dispose();interrupted=new DesktopApplication({...f.ports,credentials:{...f.ports.credentials,provision:async()=>{throw new Error("native interruption");}}});
    failure(await interrupted.createShop({businessName:"Shop",ownerName:"Owner",deviceLabel:"PC",cashAccountName:"Cash",secret:"654321"}),"credential_unavailable");
    assert.equal(value(await interrupted.getWorkspace()).state,"pending");await interrupted.dispose();
    interrupted=new DesktopApplication(f.ports);await interrupted.initialize();assert.equal(value(await interrupted.getWorkspace()).state,"pending");
    const ready=value(await interrupted.finishSetup({secret:"654321"})),unlocked=value(await interrupted.unlock({userId:ready.members[0]!.id,secret:"654321"})),sessionId=unlocked.sessionId!;
    value(await interrupted.createProduct(product(sessionId)));const key=value(await interrupted.recoveryKey({sessionId,secret:"654321"}));
    assert.equal(value(await interrupted.recoverAccess({recoveryCode:key!,newSecret:"765432"})).state,"locked");
    failure(await interrupted.listProducts({sessionId}),"locked");
    const next=value(await interrupted.unlock({userId:ready.members[0]!.id,secret:"765432"}));assert.equal(value(await interrupted.listProducts({sessionId:next.sessionId!})).items.length,1);
  }finally{await interrupted?.dispose();await f.dispose();}
});
it("dispatcher allowlist rejects untrusted frames and argument smuggling before any operation",async()=>{
  const f=fixture();try{
    const frame={},handlers=desktopHandlers(f.application,()=>({schemaVersion:20,shopName:null}),event=>event===frame);
    assert.equal(handlers["kolo:execute-sql"],undefined);
    failure(await handlers["kolo:setup"]!({},{} ) as Result<unknown>,"permission_denied");
    failure(await handlers["kolo:workspace"]!(frame,{}) as Result<unknown>,"invalid_input");
    failure(await handlers["kolo:setup"]!(frame,{},"extra") as Result<unknown>,"invalid_input");
    assert.equal(value(await handlers["kolo:workspace"]!(frame) as Result<WorkspaceView>).state,"empty");
    assert.throws(()=>handlers["kolo:installation-status"]!({},),/invalid status caller/);
  }finally{await f.dispose();}
});
it("product edits name their version: identical retries are no-ops, stale edits are refused, and price/category rules hold",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),sessionId=workspace.sessionId!,item=value(await f.application.createProduct(product(sessionId,{divisible:false,openingThousandths:0})));
    const group=value(await f.application.createCategory({sessionId,requestId:randomUUID(),name:"Grain"}));
    const edit={sessionId,productId:item.id,version:item.version,name:"Rice 25kg",unit:"bag",barcode:"987654321",sellingPriceMinor:650,categoryId:group.id,minimumStockThousandths:2000};
    const events=():unknown=>f.database.get("SELECT count(*) AS n FROM event_journal")!["n"];
    const edited=value(await f.application.updateProduct(edit));
    assert.deepEqual([edited.name,edited.barcode,edited.sellingPriceMinor,edited.purchasePriceMinor,edited.categoryId,edited.minimumStockThousandths],["Rice 25kg","987654321",650,undefined,group.id,2000]);
    // The fixture clock is fixed: the edit still advances the version so local LWW applies it.
    assert.ok(edited.version>item.version);
    const before=events();assert.equal(value(await f.application.updateProduct(edit)).version,edited.version);assert.equal(events(),before);
    failure(await f.application.updateProduct({...edit,name:"Overwrite"}),"request_conflict");
    assert.equal(value(await f.application.updateProduct({...edit,version:edited.version,barcode:undefined})).barcode,undefined);
    const current=value(await f.application.listProducts({sessionId})).items[0]!;
    failure(await f.application.updateProduct({...edit,version:current.version,minimumStockThousandths:1500}),"invalid_input");
    failure(await f.application.updateProduct({...edit,version:current.version,categoryId:randomUUID()}),"scope_mismatch");
    const archived=value(await f.application.updateCategory({sessionId,categoryId:group.id,version:group.version,name:"Grain",active:false}));assert.equal(archived.active,false);
    const other=value(await f.application.createProduct(product(sessionId,{name:"Beans",barcode:"55",openingThousandths:0})));
    failure(await f.application.updateProduct({sessionId,productId:other.id,version:other.version,name:"Beans",unit:"bag",sellingPriceMinor:500,categoryId:group.id,minimumStockThousandths:0}),"scope_mismatch");
    for(const extra of [{divisible:true},{active:false},{businessId:randomUUID()}])failure(await f.application.updateProduct({...edit,version:current.version,...extra}),"invalid_input");
    const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports);
    const keeper=await createLocalMember(context,{name:"Stock",role:"INVENTORY",secret:"765432"}),stock=value(await f.application.unlock({userId:keeper,secret:"765432"})).sessionId!;
    const latest=value(await f.application.listProducts({sessionId:stock,term:"Rice"})).items[0]!;
    failure(await f.application.updateProduct({...edit,sessionId:stock,version:latest.version,sellingPriceMinor:700,barcode:undefined}),"permission_denied");
    assert.equal(value(await f.application.updateProduct({...edit,sessionId:stock,version:latest.version,name:"Rice sack",barcode:undefined,categoryId:undefined})).name,"Rice sack");
  }finally{await f.dispose();}
});
it("archived products leave the till and stock workflows until restored; category retries and authority are checked",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),sessionId=workspace.sessionId!,item=value(await f.application.createProduct(product(sessionId)));
    const archived=value(await f.application.setProductActive({sessionId,productId:item.id,version:item.version,active:false}));
    assert.equal(value(await f.application.setProductActive({sessionId,productId:item.id,version:item.version,active:false})).version,archived.version);
    assert.equal(value(await f.application.listProducts({sessionId})).items.length,0);
    assert.equal(value(await f.application.listProducts({sessionId,includeInactive:true})).items[0]!.active,false);
    assert.equal(value(await f.application.scanProduct({sessionId,barcode:"123456789"})),null);
    const account=value(await f.application.listCashAccounts({sessionId})).items[0]!;
    failure(await f.application.checkout({sessionId,requestId:randomUUID(),accountId:account.id,lines:[{productId:item.id,quantity:1000,unitPriceMinor:500}]}),"scope_mismatch");
    failure(await f.application.moveStock({sessionId,requestId:randomUUID(),productId:item.id,kind:"add",quantityThousandths:1000,reason:"Delivery"}),"scope_mismatch");
    failure(await f.application.updateProduct({sessionId,productId:item.id,version:archived.version,name:"X",unit:"bag",sellingPriceMinor:500,minimumStockThousandths:0}),"scope_mismatch");
    failure(await f.application.setProductActive({sessionId,productId:item.id,version:item.version,active:true}),"request_conflict");
    assert.equal(value(await f.application.setProductActive({sessionId,productId:item.id,version:archived.version,active:true})).active,true);
    const request={sessionId,requestId:randomUUID(),name:"Drinks"},created=value(await f.application.createCategory(request));
    assert.equal(value(await f.application.createCategory(request)).id,created.id);failure(await f.application.createCategory({...request,name:"Food"}),"request_conflict");
    const renamed=value(await f.application.updateCategory({sessionId,categoryId:created.id,version:created.version,name:"Cold drinks",active:true}));
    failure(await f.application.createCategory(request),"request_conflict");
    failure(await f.application.updateCategory({sessionId,categoryId:created.id,version:created.version,name:"Hot drinks",active:true}),"request_conflict");
    assert.deepEqual(value(await f.application.listCategories({sessionId})).items.map(item=>item.name),["Cold drinks"]);
    value(await f.application.updateCategory({sessionId,categoryId:created.id,version:renamed.version,name:"Cold drinks",active:false}));
    assert.equal(value(await f.application.listCategories({sessionId})).items.length,0);assert.equal(value(await f.application.listCategories({sessionId,includeInactive:true})).items.length,1);
    const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports);
    const staff=await createLocalMember(context,{name:"Cashier",role:"CASHIER",secret:"765432"}),cashier=value(await f.application.unlock({userId:staff,secret:"765432"})).sessionId!;
    failure(await f.application.createCategory({sessionId:cashier,requestId:randomUUID(),name:"Snacks"}),"permission_denied");
    failure(await f.application.setProductActive({sessionId:cashier,productId:item.id,version:archived.version,active:false}),"permission_denied");
    failure(await f.application.moveStock({sessionId:cashier,requestId:randomUUID(),productId:item.id,kind:"add",quantityThousandths:1000,reason:"Delivery"}),"permission_denied");
    failure(await f.application.countStock({sessionId:cashier,requestId:randomUUID(),productId:item.id,countedThousandths:1000,reason:"Shelf"}),"permission_denied");
    assert.equal(value(await f.application.stockHistory({sessionId:cashier,productId:item.id})).items.length,1);
  }finally{await f.dispose();}
});
it("stock moves and counts are retry-safe, never recount after later sales, and roll back on failure",async()=>{
  const f=fixture();try{
    const {sessionId}=await owner(f),item=value(await f.application.createProduct(product(sessionId!,{divisible:false})));
    const add={sessionId:sessionId!,requestId:randomUUID(),productId:item.id,kind:"add" as const,quantityThousandths:5000,reason:"Delivery"};
    assert.equal(value(await f.application.moveStock(add)).onHandThousandths,8000);assert.equal(value(await f.application.moveStock(add)).onHandThousandths,8000);
    failure(await f.application.moveStock({...add,quantityThousandths:6000}),"request_conflict");failure(await f.application.moveStock({...add,kind:"damage"}),"request_conflict");
    failure(await f.application.moveStock({...add,requestId:randomUUID(),quantityThousandths:500}),"invalid_input");
    for(const bad of [{quantityThousandths:0},{quantityThousandths:-1000},{kind:"opening"},{reason:" "},{reason:undefined}])failure(await f.application.moveStock({...add,requestId:randomUUID(),...bad}),"invalid_input");
    assert.equal(value(await f.application.moveStock({...add,requestId:randomUUID(),kind:"damage",quantityThousandths:10000,reason:"Flood"})).onHandThousandths,-2000);
    const count={sessionId:sessionId!,requestId:randomUUID(),productId:item.id,countedThousandths:4000,reason:"Shelf"};
    assert.deepEqual(value(await f.application.countStock(count)).deltaThousandths,6000);
    const account=value(await f.application.listCashAccounts({sessionId})).items[0]!;
    value(await f.application.checkout({sessionId,requestId:randomUUID(),accountId:account.id,lines:[{productId:item.id,quantity:1000,unitPriceMinor:500}]}));
    const retried=value(await f.application.countStock(count));assert.equal(retried.deltaThousandths,6000);assert.equal(retried.product.onHandThousandths,3000);
    failure(await f.application.countStock({...count,countedThousandths:5000}),"request_conflict");failure(await f.application.countStock({...count,requestId:add.requestId}),"request_conflict");
    const matched={...count,requestId:randomUUID(),countedThousandths:3000};
    assert.equal(value(await f.application.countStock(matched)).deltaThousandths,0);
    value(await f.application.checkout({sessionId,requestId:randomUUID(),accountId:account.id,lines:[{productId:item.id,quantity:1000,unitPriceMinor:500}]}));
    assert.equal(value(await f.application.countStock(matched)).product.onHandThousandths,2000);
    f.database.run(`CREATE TRIGGER fail_count BEFORE INSERT ON local_audit WHEN NEW.action='STOCK_COUNTED' BEGIN SELECT RAISE(ABORT,'failpoint'); END`);
    const failed={...count,requestId:randomUUID(),countedThousandths:10000};failure(await f.application.countStock(failed),"storage_failed");
    assert.equal(value(await f.application.listProducts({sessionId})).items[0]!.onHandThousandths,2000);
    f.database.run("DROP TRIGGER fail_count");assert.equal(value(await f.application.countStock(failed)).deltaThousandths,8000);
    const first=value(await f.application.stockHistory({sessionId:sessionId!,productId:item.id,limit:3}));
    assert.equal(first.items.length,3);assert.ok(first.next!==undefined);
    const rest=value(await f.application.stockHistory({sessionId:sessionId!,productId:item.id,after:first.next!,limit:100}));
    const all=[...first.items,...rest.items];
    assert.equal(all.length,new Set(all.map(item=>item.id)).size);assert.equal(all.reduce((sum,item)=>sum+item.quantityThousandths,0),10000);
    assert.deepEqual(all.filter(item=>item.type==="DAMAGE").map(item=>[item.quantityThousandths,item.reason]),[[-10000,"Flood"]]);
    failure(await f.application.stockHistory({sessionId:sessionId!,productId:randomUUID()}),"scope_mismatch");
  }finally{await f.dispose();}
});
async function wallet(f:ReturnType<typeof fixture>,workspace:WorkspaceView):Promise<string>{
  const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports),id=randomUUIDv7(),at=f.ports.now();
  saveAccount(context,{id,name:"Wallet",kind:"MOBILE_MONEY",currency:"XAF",active:true,createdAt:at,updatedAt:at});return id;
}
it("split and credit checkout records payments per account, leaves the balance on the customer and retries by content",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),momo=await wallet(f,workspace),sessionId=value(await f.application.unlock({userId:workspace.members[0]!.id,secret:"654321"})).sessionId!;
    const item=value(await f.application.createProduct(product(sessionId,{divisible:false,openingThousandths:10000}))),accounts=value(await f.application.listPaymentAccounts({sessionId})).items;
    assert.deepEqual(accounts.map(account=>account.kind).sort(),["CASH","MOBILE_MONEY"]);const cash=accounts.find(account=>account.kind==="CASH")!.id;
    const customer=value(await f.application.createCustomer({sessionId,requestId:randomUUID(),name:"Awa",phone:"670000000",creditLimitMinor:1000}));
    const request={sessionId,requestId:randomUUID(),customerId:customer.id,lines:[{productId:item.id,quantity:3000,unitPriceMinor:500}],payments:[{accountId:cash,amountMinor:400},{accountId:momo,amountMinor:300}]};
    const sale=value(await f.application.checkout(request));
    assert.equal(value(await f.application.checkout({...request,payments:[...request.payments].reverse()})).saleId,sale.saleId);
    const other=value(await f.application.createCustomer({sessionId,requestId:randomUUID(),name:"Binta"}));
    failure(await f.application.checkout({...request,customerId:undefined}),"invalid_input");
    for(const changed of [{customerId:other.id},{payments:[{accountId:cash,amountMinor:700}]},{payments:[{accountId:cash,amountMinor:400}]}])failure(await f.application.checkout({...request,...changed}),"request_conflict");
    const receipt=value(await f.application.getReceipt({sessionId,saleId:sale.saleId}));
    assert.deepEqual([receipt.totalMinor,receipt.paidMinor,receipt.outstandingMinor,receipt.customerName,receipt.payments.length],[1500,700,800,"Awa",2]);
    assert.equal(value(await f.application.getCustomer({sessionId,customerId:customer.id})).outstandingMinor,800);
    const ledger=value(await f.application.customerStatement({sessionId,customerId:customer.id})).items;
    assert.deepEqual(ledger.map(entry=>[entry.type,entry.amountMinor,entry.saleId]),[["CREDIT_SALE",800,sale.saleId]]);
    assert.equal(f.database.get("SELECT count(*) AS n FROM sales")!["n"],1);
    const full={sessionId,requestId:randomUUID(),lines:[{productId:item.id,quantity:1000,unitPriceMinor:500}],payments:[{accountId:momo,amountMinor:500}]};
    value(await f.application.checkout(full));assert.equal(value(await f.application.listProducts({sessionId})).items[0]!.onHandThousandths,6000);
    for(const bad of [{payments:[{accountId:cash,amountMinor:600}]},{payments:[]},{payments:[{accountId:cash,amountMinor:200},{accountId:cash,amountMinor:300}]},
      {payments:new Array(9).fill({accountId:cash,amountMinor:1})},{payments:[{accountId:cash,amountMinor:0}]},{accountId:cash},{payments:undefined},{customerId:"x"}])
      failure(await f.application.checkout({...full,requestId:randomUUID(),...bad}),"invalid_input");
    failure(await f.application.checkout({...full,requestId:randomUUID(),payments:[{accountId:randomUUID(),amountMinor:500}]}),"scope_mismatch");
    assert.equal(f.database.get("SELECT count(*) AS n FROM sales")!["n"],2);
  }finally{await f.dispose();}
});
it("credit needs permission and respects the limit unless overridden; nothing is written when refused",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),sessionId=workspace.sessionId!,item=value(await f.application.createProduct(product(sessionId,{divisible:false,openingThousandths:10000})));
    const cash=value(await f.application.listPaymentAccounts({sessionId})).items[0]!.id;
    const limited=value(await f.application.createCustomer({sessionId,requestId:randomUUID(),name:"Limited",creditLimitMinor:1000}));
    const none=value(await f.application.createCustomer({sessionId,requestId:randomUUID(),name:"Cash only",creditLimitMinor:0}));
    const open=value(await f.application.createCustomer({sessionId,requestId:randomUUID(),name:"Regular"}));
    const sale=(session:string,customerId:string|undefined,quantity:number,paid:number)=>f.application.checkout({sessionId:session,requestId:randomUUID(),...(customerId===undefined?{}:{customerId}),
      lines:[{productId:item.id,quantity,unitPriceMinor:500}],payments:paid===0?[]:[{accountId:cash,amountMinor:paid}]});
    const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports);
    const managerId=await createLocalMember(context,{name:"Manager",role:"MANAGER",secret:"765432"}),cashierId=await createLocalMember(context,{name:"Cashier",role:"CASHIER",secret:"876543"});
    f.database.run(`UPDATE local_memberships SET revoked='["customers.credit_override"]',revision=revision+1 WHERE user_id=?`,[managerId]);
    const manager=value(await f.application.unlock({userId:managerId,secret:"765432"})).sessionId!;
    value(await sale(manager,limited.id,2000,0));failure(await sale(manager,limited.id,1000,0),"credit_limit");
    failure(await sale(manager,none.id,1000,500-1),"credit_limit");value(await sale(manager,none.id,1000,500));
    value(await sale(manager,open.id,10000,0));failure(await sale(manager,undefined,1000,0),"invalid_input");
    assert.equal(f.database.get("SELECT count(*) AS n FROM sales")!["n"],3);
    const ownerSession=value(await f.application.unlock({userId:workspace.members.find(member=>member.name==="Owner")!.id,secret:"654321"})).sessionId!;
    value(await sale(ownerSession,limited.id,1000,0));assert.equal(value(await f.application.getCustomer({sessionId:ownerSession,customerId:limited.id})).outstandingMinor,1500);
    const cashier=value(await f.application.unlock({userId:cashierId,secret:"876543"})).sessionId!;
    failure(await sale(cashier,open.id,1000,0),"permission_denied");value(await sale(cashier,open.id,1000,500));
    failure(await f.application.createCustomer({sessionId:cashier,requestId:randomUUID(),name:"New"}),"permission_denied");
    assert.equal(f.database.get("SELECT count(*) AS n FROM sales")!["n"],5);
  }finally{await f.dispose();}
});
it("customer details, archive and payments are versioned, retry-safe, scoped and roll back on failure",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),sessionId=workspace.sessionId!,item=value(await f.application.createProduct(product(sessionId,{divisible:false})));
    const cash=value(await f.application.listPaymentAccounts({sessionId})).items[0]!.id,request={sessionId,requestId:randomUUID(),name:"Awa",notes:"Market"};
    const created=value(await f.application.createCustomer(request));
    assert.equal(value(await f.application.createCustomer(request)).id,created.id);failure(await f.application.createCustomer({...request,phone:"1"}),"request_conflict");
    for(const bad of [{name:" "},{phone:"9".repeat(41)},{creditLimitMinor:-1},{creditLimitMinor:1.5},{businessId:randomUUID()}])failure(await f.application.createCustomer({...request,requestId:randomUUID(),...bad}),"invalid_input");
    const edit={sessionId,customerId:created.id,version:created.version,name:"Awa N.",phone:"690000000",active:true};
    const edited=value(await f.application.updateCustomer(edit));assert.deepEqual([edited.name,edited.phone,edited.notes],["Awa N.","690000000",undefined]);
    assert.equal(value(await f.application.updateCustomer(edit)).version,edited.version);failure(await f.application.updateCustomer({...edit,name:"Other"}),"request_conflict");
    value(await f.application.checkout({sessionId,requestId:randomUUID(),customerId:created.id,lines:[{productId:item.id,quantity:2000,unitPriceMinor:500}],payments:[]}));
    const pay={sessionId,requestId:randomUUID(),customerId:created.id,accountId:cash,amountMinor:300,note:"Friday"};
    assert.equal(value(await f.application.receiveCustomerPayment(pay)).outstandingMinor,700);assert.equal(value(await f.application.receiveCustomerPayment(pay)).outstandingMinor,700);
    for(const changed of [{amountMinor:400},{note:undefined},{accountId:randomUUID()}])failure(await f.application.receiveCustomerPayment({...pay,...changed}),"request_conflict");
    for(const bad of [{amountMinor:0},{amountMinor:-5},{note:"x".repeat(201)}])failure(await f.application.receiveCustomerPayment({...pay,requestId:randomUUID(),...bad}),"invalid_input");
    // Paying more than is owed leaves the customer in credit with the shop.
    assert.equal(value(await f.application.receiveCustomerPayment({...pay,requestId:randomUUID(),amountMinor:1000,note:undefined})).outstandingMinor,-300);
    f.database.run(`CREATE TRIGGER fail_payment BEFORE INSERT ON local_audit WHEN NEW.action='CUSTOMER_PAYMENT' BEGIN SELECT RAISE(ABORT,'failpoint'); END`);
    const failed={...pay,requestId:randomUUID(),note:undefined};failure(await f.application.receiveCustomerPayment(failed),"storage_failed");
    assert.equal(value(await f.application.getCustomer({sessionId,customerId:created.id})).outstandingMinor,-300);
    f.database.run("DROP TRIGGER fail_payment");assert.equal(value(await f.application.receiveCustomerPayment(failed)).outstandingMinor,-600);
    const page=value(await f.application.customerStatement({sessionId,customerId:created.id,limit:2})),rest=value(await f.application.customerStatement({sessionId,customerId:created.id,after:page.next!}));
    assert.deepEqual([...page.items,...rest.items].map(entry=>entry.amountMinor).reduce((sum,amount)=>sum+amount,0),-600);
    assert.ok([...page.items,...rest.items].some(entry=>entry.note==="Friday"));
    const archived=value(await f.application.updateCustomer({...edit,version:edited.version,active:false}));assert.equal(archived.active,false);
    assert.equal(value(await f.application.listCustomers({sessionId})).items.length,0);assert.equal(value(await f.application.listCustomers({sessionId,includeInactive:true})).items[0]!.outstandingMinor,-600);
    failure(await f.application.receiveCustomerPayment({...pay,requestId:randomUUID()}),"scope_mismatch");
    failure(await f.application.checkout({sessionId,requestId:randomUUID(),customerId:created.id,lines:[{productId:item.id,quantity:1000,unitPriceMinor:500}],payments:[{accountId:cash,amountMinor:500}]}),"scope_mismatch");
    failure(await f.application.getCustomer({sessionId,customerId:randomUUID()}),"scope_mismatch");
    const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports);
    const staff=await createLocalMember(context,{name:"Cashier",role:"CASHIER",secret:"765432"}),cashier=value(await f.application.unlock({userId:staff,secret:"765432"})).sessionId!;
    failure(await f.application.updateCustomer({...edit,sessionId:cashier,version:archived.version,active:true}),"permission_denied");
    assert.equal(value(await f.application.listCustomers({sessionId:cashier,includeInactive:true})).items.length,1);
  }finally{await f.dispose();}
});
it("sale discounts need discount authority, reduce the total before settlement and are part of retry identity",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),sessionId=workspace.sessionId!,item=value(await f.application.createProduct(product(sessionId,{divisible:false,openingThousandths:10000})));
    const cash=value(await f.application.listPaymentAccounts({sessionId})).items[0]!.id;
    const request={sessionId,requestId:randomUUID(),discountMinor:150,lines:[{productId:item.id,quantity:2000,unitPriceMinor:500}],payments:[{accountId:cash,amountMinor:850}]};
    const sale=value(await f.application.checkout(request));assert.equal(value(await f.application.checkout(request)).saleId,sale.saleId);
    failure(await f.application.checkout({...request,discountMinor:100,payments:[{accountId:cash,amountMinor:900}]}),"request_conflict");
    const receipt=value(await f.application.getReceipt({sessionId,saleId:sale.saleId}));assert.deepEqual([receipt.discountMinor,receipt.totalMinor,receipt.paidMinor],[150,850,850]);
    for(const bad of [{discountMinor:1001,payments:[]},{discountMinor:-1},{discountMinor:1.5},{discountMinor:"150"}])failure(await f.application.checkout({...request,requestId:randomUUID(),...bad}),"invalid_input");
    failure(await f.application.checkout({sessionId,requestId:randomUUID(),accountId:cash,discountMinor:100,lines:request.lines}),"invalid_input");
    failure(await f.application.checkout({...request,requestId:randomUUID(),payments:[{accountId:cash,amountMinor:1000}]}),"invalid_input");
    const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports);
    const staff=await createLocalMember(context,{name:"Cashier",role:"CASHIER",secret:"765432"}),cashier=value(await f.application.unlock({userId:staff,secret:"765432"})).sessionId!;
    failure(await f.application.checkout({...request,sessionId:cashier,requestId:randomUUID()}),"permission_denied");
    assert.equal(f.database.get("SELECT count(*) AS n FROM sales")!["n"],1);
  }finally{await f.dispose();}
});
it("purchases add stock at cost, pay at the door or owe the supplier, and retry by content including door payments",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),momo=await wallet(f,workspace),sessionId=value(await f.application.unlock({userId:workspace.members[0]!.id,secret:"654321"})).sessionId!;
    const item=value(await f.application.createProduct(product(sessionId,{divisible:false,openingThousandths:0}))),oil=value(await f.application.createProduct(product(sessionId,{name:"Oil",barcode:"77",openingThousandths:0})));
    const cash=value(await f.application.listPaymentAccounts({sessionId})).items.find(account=>account.kind==="CASH")!.id;
    const supplier=value(await f.application.createSupplier({sessionId,requestId:randomUUID(),name:"Grossiste",contact:"Paul"}));
    const request={sessionId,requestId:randomUUID(),supplierId:supplier.id,reference:"BL-12",lines:[{productId:item.id,quantity:10000,unitCostMinor:300},{productId:oil.id,quantity:2500,unitCostMinor:1000}],payment:{accountId:cash,amountMinor:2000}};
    const purchase=value(await f.application.recordPurchase(request));assert.equal(value(await f.application.recordPurchase({...request,lines:[...request.lines].reverse()})).purchaseId,purchase.purchaseId);
    for(const changed of [{payment:{accountId:momo,amountMinor:2000}},{payment:{accountId:cash,amountMinor:2100}},{reference:"BL-13"},{lines:[request.lines[0]!]}])failure(await f.application.recordPurchase({...request,...changed}),"request_conflict");
    const detail=value(await f.application.getPurchase({sessionId,purchaseId:purchase.purchaseId}));
    assert.deepEqual([detail.totalMinor,detail.paidMinor,detail.outstandingMinor,detail.supplierName,detail.lines.length],[5500,2000,3500,"Grossiste",2]);
    assert.deepEqual(value(await f.application.listProducts({sessionId})).items.map(p=>[p.name,p.onHandThousandths]),[["Oil",2500],["Rice",10000]]);
    assert.equal(value(await f.application.getSupplier({sessionId,supplierId:supplier.id})).outstandingMinor,3500);
    const pay={sessionId,requestId:randomUUID(),supplierId:supplier.id,accountId:momo,amountMinor:1500,note:"Avance"};
    assert.equal(value(await f.application.paySupplier(pay)).outstandingMinor,2000);assert.equal(value(await f.application.paySupplier(pay)).outstandingMinor,2000);
    failure(await f.application.paySupplier({...pay,amountMinor:1}),"request_conflict");
    const ledger=value(await f.application.supplierStatement({sessionId,supplierId:supplier.id})).items;
    assert.deepEqual(ledger.map(entry=>[entry.type,entry.amountMinor]).sort(),[["PAYMENT",-1500],["PURCHASE",3500]]);
    assert.equal(ledger.find(entry=>entry.type==="PURCHASE")!.purchaseId,purchase.purchaseId);
    const market={sessionId,requestId:randomUUID(),lines:[{productId:item.id,quantity:1000,unitCostMinor:250}],payment:{accountId:cash,amountMinor:250}};
    value(await f.application.recordPurchase(market));assert.equal(value(await f.application.recordPurchase(market)).purchaseId,market.requestId);
    assert.deepEqual(value(await f.application.listPurchases({sessionId})).items.map(row=>row.totalMinor).sort(),[250,5500]);
    for(const bad of [{payment:undefined},{payment:{accountId:cash,amountMinor:300}},{lines:[]},{lines:[{productId:item.id,quantity:500,unitCostMinor:250}]},
      {lines:[market.lines[0]!,market.lines[0]!]},{reference:" "},{supplierId:"x"}])failure(await f.application.recordPurchase({...market,requestId:randomUUID(),...bad}),"invalid_input");
    failure(await f.application.recordPurchase({...market,requestId:randomUUID(),lines:[{productId:randomUUID(),quantity:1000,unitCostMinor:250}]}),"scope_mismatch");
    assert.equal(f.database.get("SELECT count(*) AS n FROM purchases")!["n"],2);
  }finally{await f.dispose();}
});
it("supplier details are versioned and purchase authority is enforced; failed purchases leave nothing",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),sessionId=workspace.sessionId!,item=value(await f.application.createProduct(product(sessionId,{divisible:false,openingThousandths:0})));
    const cash=value(await f.application.listPaymentAccounts({sessionId})).items[0]!.id,request={sessionId,requestId:randomUUID(),name:"Grossiste",phone:"699"};
    const created=value(await f.application.createSupplier(request));assert.equal(value(await f.application.createSupplier(request)).id,created.id);
    failure(await f.application.createSupplier({...request,name:"Other"}),"request_conflict");
    const edit={sessionId,supplierId:created.id,version:created.version,name:"Grossiste SA",active:true};
    const edited=value(await f.application.updateSupplier(edit));assert.deepEqual([edited.name,edited.phone],["Grossiste SA",undefined]);
    failure(await f.application.updateSupplier({...edit,address:"Douala"}),"request_conflict");
    f.database.run(`CREATE TRIGGER fail_purchase BEFORE INSERT ON local_audit WHEN NEW.action='PURCHASE_RECORDED' BEGIN SELECT RAISE(ABORT,'failpoint'); END`);
    const purchase={sessionId,requestId:randomUUID(),supplierId:created.id,lines:[{productId:item.id,quantity:4000,unitCostMinor:300}]};
    failure(await f.application.recordPurchase(purchase),"storage_failed");
    assert.deepEqual([f.database.get("SELECT count(*) AS n FROM purchases")!["n"],value(await f.application.listProducts({sessionId})).items[0]!.onHandThousandths,value(await f.application.getSupplier({sessionId,supplierId:created.id})).outstandingMinor],[0,0,0]);
    f.database.run("DROP TRIGGER fail_purchase");value(await f.application.recordPurchase(purchase));
    assert.equal(value(await f.application.getSupplier({sessionId,supplierId:created.id})).outstandingMinor,1200);
    value(await f.application.updateSupplier({...edit,version:edited.version,active:false}));
    failure(await f.application.recordPurchase({...purchase,requestId:randomUUID()}),"scope_mismatch");
    failure(await f.application.paySupplier({sessionId,requestId:randomUUID(),supplierId:created.id,accountId:cash,amountMinor:100}),"scope_mismatch");
    const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports);
    const keeperId=await createLocalMember(context,{name:"Stock",role:"INVENTORY",secret:"765432"}),cashierId=await createLocalMember(context,{name:"Cashier",role:"CASHIER",secret:"876543"});
    const keeper=value(await f.application.unlock({userId:keeperId,secret:"765432"})).sessionId!;
    failure(await f.application.recordPurchase({sessionId:keeper,requestId:randomUUID(),lines:[{productId:item.id,quantity:1000,unitCostMinor:1}],payment:{accountId:cash,amountMinor:1}}),"permission_denied");
    assert.equal(value(await f.application.listPurchases({sessionId:keeper})).items.length,1);
    const cashier=value(await f.application.unlock({userId:cashierId,secret:"876543"})).sessionId!;
    failure(await f.application.listSuppliers({sessionId:cashier}),"permission_denied");failure(await f.application.listPurchases({sessionId:cashier}),"permission_denied");
  }finally{await f.dispose();}
});
it("accounts move, transfer, count and correct money exactly; retries never move it twice",async()=>{
  const f=fixture();try{
    const {sessionId}=await owner(f),cash=value(await f.application.listAccounts({sessionId})).items[0]!;
    const bank=value(await f.application.createAccount({sessionId,requestId:randomUUID(),name:"Bank",kind:"BANK"}));
    const deposit={sessionId:sessionId!,requestId:randomUUID(),accountId:cash.id,direction:"in" as const,amountMinor:10000,reason:"Float"};
    assert.equal(value(await f.application.moveMoney(deposit)).onHandMinor,10000);assert.equal(value(await f.application.moveMoney(deposit)).onHandMinor,10000);
    failure(await f.application.moveMoney({...deposit,direction:"out"}),"request_conflict");
    const transfer={sessionId:sessionId!,requestId:randomUUID(),fromAccountId:cash.id,toAccountId:bank.id,amountMinor:4000,reason:"Banking"};
    assert.equal(value(await f.application.transferMoney(transfer)).onHandMinor,6000);assert.equal(value(await f.application.transferMoney(transfer)).onHandMinor,6000);
    failure(await f.application.transferMoney({...transfer,amountMinor:1}),"request_conflict");
    assert.deepEqual(value(await f.application.listAccounts({sessionId})).items.map(item=>[item.name,item.onHandMinor]),[["Bank",4000],["Cash",6000]]);
    for(const bad of [{toAccountId:cash.id},{amountMinor:0},{reason:""}])failure(await f.application.transferMoney({...transfer,requestId:randomUUID(),...bad}),"invalid_input");
    assert.deepEqual(value(await f.application.countCash({sessionId,accountId:cash.id,countedMinor:5500})),{expectedMinor:6000,countedMinor:5500,differenceMinor:-500});
    const correction={sessionId:sessionId!,requestId:randomUUID(),accountId:cash.id,countedMinor:5500,reason:"Shortage"};
    assert.equal(value(await f.application.correctCash(correction)).differenceMinor,-500);
    value(await f.application.moveMoney({...deposit,requestId:randomUUID(),amountMinor:100}));
    assert.deepEqual(value(await f.application.correctCash(correction)),{expectedMinor:6000,countedMinor:5500,differenceMinor:-500});
    failure(await f.application.correctCash({...correction,countedMinor:5000}),"request_conflict");
    assert.equal(value(await f.application.listAccounts({sessionId})).items.find(item=>item.id===cash.id)!.onHandMinor,5600);
    const renamed=value(await f.application.updateAccount({sessionId,accountId:bank.id,version:bank.version,name:"Afriland",kind:"BANK",active:true}));
    failure(await f.application.updateAccount({sessionId,accountId:bank.id,version:bank.version,name:"Other",kind:"BANK",active:true}),"request_conflict");
    value(await f.application.updateAccount({sessionId,accountId:bank.id,version:renamed.version,name:"Afriland",kind:"BANK",active:false}));
    failure(await f.application.transferMoney({...transfer,requestId:randomUUID()}),"scope_mismatch");
    assert.equal(value(await f.application.listAccounts({sessionId,includeInactive:true})).items.length,2);
    for(const bad of [{kind:"WALLET"},{name:" "}])failure(await f.application.createAccount({sessionId,requestId:randomUUID(),name:"X",kind:"CASH",...bad}),"invalid_input");
  }finally{await f.dispose();}
});
it("expenses are recorded, retried and reversed once by compensation, under expense authority",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),sessionId=workspace.sessionId!,cash=value(await f.application.listAccounts({sessionId})).items[0]!;
    value(await f.application.moveMoney({sessionId,requestId:randomUUID(),accountId:cash.id,direction:"in",amountMinor:20000,reason:"Float"}));
    const rent={sessionId,requestId:randomUUID(),accountId:cash.id,category:"RENT" as const,amountMinor:15000,description:"October"};
    const saved=value(await f.application.recordExpense(rent));assert.equal(value(await f.application.recordExpense(rent)).id,saved.id);
    failure(await f.application.recordExpense({...rent,amountMinor:1}),"request_conflict");
    for(const bad of [{category:"FOOD"},{amountMinor:0},{description:"x".repeat(201)}])failure(await f.application.recordExpense({...rent,requestId:randomUUID(),...bad}),"invalid_input");
    assert.equal(value(await f.application.listAccounts({sessionId})).items[0]!.onHandMinor,5000);
    const reversal={sessionId,requestId:randomUUID(),expenseId:saved.id};
    assert.equal(value(await f.application.reverseExpense(reversal)).reversed,true);assert.equal(value(await f.application.reverseExpense(reversal)).reversed,true);
    failure(await f.application.reverseExpense({...reversal,requestId:randomUUID()}),"request_conflict");
    const list=value(await f.application.listExpenses({sessionId})).items;
    assert.deepEqual(list.map(item=>[item.amountMinor,item.reversed,item.reversesId===saved.id]).sort(),[[-15000,false,true],[15000,true,false]]);
    failure(await f.application.reverseExpense({sessionId,requestId:randomUUID(),expenseId:list.find(item=>item.amountMinor<0)!.id}),"request_conflict");
    assert.equal(value(await f.application.listAccounts({sessionId})).items[0]!.onHandMinor,20000);
    const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports);
    const staff=await createLocalMember(context,{name:"Cashier",role:"CASHIER",secret:"765432"}),cashier=value(await f.application.unlock({userId:staff,secret:"765432"})).sessionId!;
    failure(await f.application.recordExpense({...rent,sessionId:cashier,requestId:randomUUID()}),"permission_denied");
    failure(await f.application.listAccounts({sessionId:cashier}),"permission_denied");failure(await f.application.listExpenses({sessionId:cashier}),"permission_denied");
    failure(await f.application.moveMoney({sessionId:cashier,requestId:randomUUID(),accountId:cash.id,direction:"out",amountMinor:1,reason:"x"}),"permission_denied");
  }finally{await f.dispose();}
});
it("core validation refusals reach the UI as invalid input, not storage failures",async()=>{
  const f=fixture();try{
    const {sessionId}=await owner(f),cash=value(await f.application.listAccounts({sessionId})).items[0]!;
    failure(await f.application.recordExpense({sessionId,requestId:randomUUID(),accountId:cash.id,category:"OTHER",amountMinor:100}),"invalid_input");
    value(await f.application.recordExpense({sessionId,requestId:randomUUID(),accountId:cash.id,category:"OTHER",amountMinor:100,description:"Charcoal"}));
  }finally{await f.dispose();}
});
it("reports read exact period figures under report authority and refuse malformed periods",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),sessionId=workspace.sessionId!,item=value(await f.application.createProduct(product(sessionId,{divisible:false,openingThousandths:0,purchasePriceMinor:300})));
    const cash=value(await f.application.listPaymentAccounts({sessionId})).items[0]!.id,customer=value(await f.application.createCustomer({sessionId,requestId:randomUUID(),name:"Awa"}));
    value(await f.application.recordPurchase({sessionId,requestId:randomUUID(),lines:[{productId:item.id,quantity:5000,unitCostMinor:300}],payment:{accountId:cash,amountMinor:1500}}));
    value(await f.application.moveMoney({sessionId,requestId:randomUUID(),accountId:cash,direction:"in",amountMinor:5000,reason:"Float"}));
    value(await f.application.checkout({sessionId,requestId:randomUUID(),customerId:customer.id,lines:[{productId:item.id,quantity:2000,unitPriceMinor:500}],payments:[{accountId:cash,amountMinor:600}]}));
    value(await f.application.recordExpense({sessionId,requestId:randomUUID(),accountId:cash,category:"RENT",amountMinor:100}));
    const period={sessionId,from:"2026-10-06T00:00:00.000Z",until:"2026-10-07T00:00:00.000Z"};
    const dashboard=value(await f.application.report({...period,kind:"dashboard"}));
    assert.deepEqual(dashboard.kind==="dashboard"&&[dashboard.salesMinor,dashboard.transactions,dashboard.grossProfitMinor,dashboard.expensesMinor,dashboard.netResultMinor,dashboard.customerDebtMinor],[1000,1,400,100,300,400]);
    const byProduct=value(await f.application.report({...period,kind:"salesByProduct"}));assert.deepEqual(byProduct.kind==="salesByProduct"&&byProduct.lines.map(line=>[line.label,line.totalMinor]),[["Rice",1000]]);
    const flow=value(await f.application.report({...period,kind:"cashFlow"}));assert.equal(flow.kind==="cashFlow"&&flow.accounts[0]!.closingMinor,4000);
    const valuation=value(await f.application.report({...period,kind:"valuation"}));assert.deepEqual(valuation.kind==="valuation"&&[valuation.totalMinor,valuation.products[0]!.onHandThousandths],[900,3000]);
    const debts=value(await f.application.report({...period,kind:"customerDebt"}));assert.deepEqual(debts.kind==="customerDebt"&&debts.lines.map(line=>line.totalMinor),[400]);
    const bought=value(await f.application.report({...period,kind:"purchases"}));assert.deepEqual(bought.kind==="purchases"&&[bought.totalMinor,bought.deliveries],[1500,1]);
    const empty=value(await f.application.report({...period,kind:"sales",from:"2026-10-07T00:00:00.000Z",until:"2026-10-08T00:00:00.000Z"}));assert.equal(empty.kind==="sales"&&empty.totalMinor,0);
    for(const bad of [{kind:"everything"},{from:"2026-10-07"},{until:period.from},{from:"2026-10-06T00:00:00.000Z",until:"2040-01-01T00:00:00.000Z"},{until:"not a date"},{extra:1}])
      failure(await f.application.report({...period,kind:"sales",...bad}),"invalid_input");
    const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports);
    const keeperId=await createLocalMember(context,{name:"Stock",role:"INVENTORY",secret:"765432"}),cashierId=await createLocalMember(context,{name:"Cashier",role:"CASHIER",secret:"876543"});
    const keeper=value(await f.application.unlock({userId:keeperId,secret:"765432"})).sessionId!;
    value(await f.application.report({...period,sessionId:keeper,kind:"stockAlerts"}));failure(await f.application.report({...period,sessionId:keeper,kind:"dashboard"}),"permission_denied");
    const cashier=value(await f.application.unlock({userId:cashierId,secret:"876543"})).sessionId!;
    for(const kind of ["sales","valuation","customerDebt"] as const)failure(await f.application.report({...period,sessionId:cashier,kind}),"permission_denied");
  }finally{await f.dispose();}
});
it("sale and purchase returns compensate stock, money and ledgers, retry by content and refuse stale predecessors",async()=>{
  const f=fixture();try{
    const workspace=await owner(f),sessionId=workspace.sessionId!,item=value(await f.application.createProduct(product(sessionId,{divisible:false,openingThousandths:10000})));
    const cash=value(await f.application.listPaymentAccounts({sessionId})).items[0]!.id,customer=value(await f.application.createCustomer({sessionId,requestId:randomUUID(),name:"Awa"}));
    const sale=value(await f.application.checkout({sessionId,requestId:randomUUID(),customerId:customer.id,lines:[{productId:item.id,quantity:4000,unitPriceMinor:500}],payments:[{accountId:cash,amountMinor:1500}]}));
    value(await f.application.moveMoney({sessionId,requestId:randomUUID(),accountId:cash,direction:"in",amountMinor:1000,reason:"Float"}));
    const source=value(await f.application.returnSource({sessionId,kind:"SALE",originalId:sale.saleId}));
    assert.deepEqual([source.hasCounterparty,source.items.length,source.items[0]!.originalQuantity,source.priorId],[true,1,4000,undefined]);
    const items=[{originalItemId:source.items[0]!.id,quantity:2000}];
    assert.equal(value(await f.application.previewReturn({sessionId,kind:"SALE",originalId:sale.saleId,items})).totalMinor,1000);
    const request={sessionId,requestId:randomUUID(),kind:"SALE" as const,originalId:sale.saleId,reason:"Damaged",items,refund:{accountId:cash,amountMinor:600}};
    const first=value(await f.application.recordReturn(request));assert.equal(value(await f.application.recordReturn(request)).returnId,first.returnId);
    for(const changed of [{reason:"Other"},{refund:{accountId:cash,amountMinor:500}},{items:[{...items[0]!,quantity:1000}]}])failure(await f.application.recordReturn({...request,...changed}),"request_conflict");
    assert.equal(value(await f.application.listProducts({sessionId})).items[0]!.onHandThousandths,8000);
    assert.equal(value(await f.application.getCustomer({sessionId,customerId:customer.id})).outstandingMinor,100);
    assert.equal(value(await f.application.listAccounts({sessionId})).items[0]!.onHandMinor,1900);
    assert.equal(value(await f.application.getReceipt({sessionId,saleId:sale.saleId})).returnedMinor,1000);
    failure(await f.application.recordReturn({...request,requestId:randomUUID()}),"stale_return");
    const next=value(await f.application.returnSource({sessionId,kind:"SALE",originalId:sale.saleId}));assert.equal(next.priorId,first.returnId);assert.equal(next.items[0]!.returnedQuantity,2000);
    for(const bad of [{items:[{...items[0]!,quantity:3000}]},{refund:{accountId:cash,amountMinor:1001}},{items:[]},{reason:""},{kind:"GIFT"}])
      failure(await f.application.recordReturn({...request,requestId:randomUUID(),priorId:next.priorId,...bad}),"invalid_input");
    value(await f.application.recordReturn({...request,requestId:randomUUID(),priorId:next.priorId,refund:undefined}));
    assert.equal(value(await f.application.getCustomer({sessionId,customerId:customer.id})).outstandingMinor,-900);
    const supplierCash=value(await f.application.recordPurchase({sessionId,requestId:randomUUID(),lines:[{productId:item.id,quantity:2000,unitCostMinor:300}],payment:{accountId:cash,amountMinor:600}}));
    const bought=value(await f.application.returnSource({sessionId,kind:"PURCHASE",originalId:supplierCash.purchaseId}));
    failure(await f.application.recordReturn({sessionId,requestId:randomUUID(),kind:"PURCHASE",originalId:supplierCash.purchaseId,reason:"Expired",items:[{originalItemId:bought.items[0]!.id,quantity:1000}]}),"invalid_input");
    value(await f.application.recordReturn({sessionId,requestId:randomUUID(),kind:"PURCHASE",originalId:supplierCash.purchaseId,reason:"Expired",items:[{originalItemId:bought.items[0]!.id,quantity:1000}],refund:{accountId:cash,amountMinor:300}}));
    assert.equal(value(await f.application.listProducts({sessionId})).items[0]!.onHandThousandths,11000);
    const context=await unlockWorkspace({userId:workspace.members[0]!.id,secret:"654321"},f.ports);
    const staff=await createLocalMember(context,{name:"Cashier",role:"CASHIER",secret:"765432"}),cashier=value(await f.application.unlock({userId:staff,secret:"765432"})).sessionId!;
    failure(await f.application.returnSource({sessionId:cashier,kind:"SALE",originalId:sale.saleId}),"permission_denied");
    failure(await f.application.returnSource({sessionId:cashier,kind:"SALE",originalId:randomUUID()}),"permission_denied");
  }finally{await f.dispose();}
});
