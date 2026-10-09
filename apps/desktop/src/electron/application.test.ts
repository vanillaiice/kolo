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
