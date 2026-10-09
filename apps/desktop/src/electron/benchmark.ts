import assert from "node:assert/strict";
import { randomUUIDv7 } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { app, type BrowserWindow } from "electron";
import type { Database } from "@kolo/core/data/database/driver";

/** Disposable, deliberately large SQLite fixture measured through the actual renderer/preload. */
export async function benchmarkDesktop(window: BrowserWindow, database: Database, bootMs: number): Promise<void> {
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  assert.equal(await evaluate(`window.kolo.createShop({businessName:'Performance fixture',ownerName:'Owner',deviceLabel:'Benchmark',cashAccountName:'Cash',secret:'654321'}).then(result=>result.ok)`), true);
  const business = String(database.get("SELECT id FROM businesses LIMIT 1")!["id"]);
  const user = String(database.get("SELECT id FROM users LIMIT 1")!["id"]);
  const device = String(database.get("SELECT id FROM devices LIMIT 1")!["id"]);
  const at = new Date().toISOString(), productIds: string[] = [];
  database.transaction(tx => {
    for (let i = 0; i < 10_000; i++) {
      const id = randomUUIDv7(); productIds.push(id);
      tx.run("INSERT INTO products(id,business_id,name,barcode,unit,purchase_price_minor,selling_price_minor,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [id, business, `Product ${String(i).padStart(5, '0')}`, `BENCH${i}`, "unit", 300, 500, "XAF", at, at]);
    }
    for (let i = 0; i < 100_000; i++) tx.run("INSERT INTO inventory_movements(id,business_id,product_id,type,quantity,unit_cost_minor,unit_cost_currency,user_id,device_id,occurred_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [randomUUIDv7(), business, productIds[i % productIds.length]!, "OPENING_BALANCE", 1000, 300, "XAF", user, device, at, at]);
  });
  assert.equal(await evaluate(`window.kolo.unlock({userId:${JSON.stringify(user)},secret:"654321"}).then(result=>result.ok)`), true);
  const measurements = await evaluate(`(async()=>{
    const workspace=(await window.kolo.getWorkspace()).value,sessionId=workspace.sessionId;
    const measure=async(work,n=20)=>{const times=[];for(let i=0;i<n;i++){const start=performance.now(),result=await work();if(!result.ok)throw Error(result.error.code);times.push(performance.now()-start);}times.sort((a,b)=>a-b);return {medianMs:times[Math.floor(n/2)],p95Ms:times[Math.ceil(n*.95)-1]};};
    const search=await measure(()=>window.kolo.listProducts({sessionId,term:'Product 099'}));
    const barcode=await measure(()=>window.kolo.scanProduct({sessionId,barcode:'BENCH9999'}));
    const reports=await measure(()=>window.kolo.report({sessionId,kind:'valuation',from:'2026-01-01T00:00:00.000Z',until:'2027-01-01T00:00:00.000Z'}),5);
    const account=(await window.kolo.listAccounts({sessionId})).value.items[0];
    const checkout=await measure(()=>window.kolo.checkout({sessionId,requestId:crypto.randomUUID(),accountId:account.id,lines:[{productId:${JSON.stringify(productIds[9999])},quantity:1000,unitPriceMinor:500}]}),5);
    return {search,barcode,reports,checkout};
  })()`);
  const rendererMemory = app.getAppMetrics().find(metric => metric.pid === window.webContents.getOSProcessId())?.memory;
  process.stdout.write(`${JSON.stringify({platform:process.platform,cpu:cpus()[0]?.model,ramMiB:Math.round(totalmem()/1048576),products:10000,movements:100000,bootMs,mainRssMiB:process.memoryUsage().rss/1048576,rendererWorkingSetMiB:(rendererMemory?.workingSetSize ?? 0)/1024,measurements})}\n`);
}
