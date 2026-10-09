import assert from "node:assert/strict";
import { it } from "node:test";
import { discountedLineTotals, incrementalReturnMinor } from "./returns.ts";
it("largest remainder allocations preserve every franc and deterministic line ordering",()=>{
 const lines=[{id:"b",unitPriceMinor:1,quantity:1000},{id:"a",unitPriceMinor:1,quantity:1000},{id:"c",unitPriceMinor:1,quantity:1000}];
 assert.deepEqual([...discountedLineTotals(lines,1)].sort(),[["a",0],["b",1],["c",1]]);assert.deepEqual([...discountedLineTotals([...lines].reverse(),1)].sort(),[["a",0],["b",1],["c",1]]);
 assert.throws(()=>discountedLineTotals(lines,4));assert.deepEqual([...discountedLineTotals([{id:"a",unitPriceMinor:0,quantity:1000}],0)],[["a",0]]);
});
it("cumulative partial entitlements match independent BigInt rounding and sum exactly to original net",()=>{
 for(const total of [0,1,7,1499,Number.MAX_SAFE_INTEGER])for(const quantity of [3,1000,3000]){
  let returned=0,sum=0;for(const chunk of [1,1,quantity-2]){
   const round=(n:bigint,d:bigint)=>n/d+(2n*(n%d)>=d?1n:0n);
   const expected=Number(round(BigInt(total)*BigInt(returned+chunk),BigInt(quantity))-round(BigInt(total)*BigInt(returned),BigInt(quantity)));
   const actual=incrementalReturnMinor(total,quantity,returned,chunk);assert.equal(actual,expected);sum+=actual;returned+=chunk;
  }assert.equal(sum,total);
 }
 assert.throws(()=>incrementalReturnMinor(10,1000,500,501));assert.throws(()=>incrementalReturnMinor(10,1000,0,0));
});
