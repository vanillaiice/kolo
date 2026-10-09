import assert from "node:assert/strict";
import { it } from "node:test";
import { canonicalJson, utf8Length } from "./canonical.ts";
import { parseJournalEnvelope, parseEventPayload } from "./events.ts";
import { decodeSignedJournalBatch } from "./delivery.ts";
it("canonical bytes follow UTF-16 key order, stable strings and safe integers",()=>{
  assert.equal(canonicalJson({"2":2,"10":10,"\u20ac":"\n\"","\ud83d\ude00":true}),'{"10":10,"2":2,"€":"\\n\\\"","😀":true}');
  assert.equal(canonicalJson({z:[-0,Number.MAX_SAFE_INTEGER],a:"é"}),'{"a":"é","z":[0,9007199254740991]}');
  assert.equal(utf8Length("é😀"),6);
});
it("canonicalizer rejects invalid Unicode, unsafe numbers, cycles, sparse/accessor/prototype data and bounds",()=>{
  const cyclic:unknown[]=[];cyclic.push(cyclic);
  for(const value of ["\ud800",1.2,Infinity,Number.MAX_SAFE_INTEGER+1,undefined,new Date(),cyclic,Array(2),Object.defineProperty({},"x",{enumerable:true,get:()=>1})]) assert.throws(()=>canonicalJson(value));
  assert.throws(()=>canonicalJson("éé",5));
  let nested:unknown=1;for(let n=0;n<34;n++)nested=[nested];assert.throws(()=>canonicalJson(nested));
});
it("strict payloads reject unknown fields, unsafe amounts, wrong sign, credentials and unsupported versions",()=>{
 const id="00000000-0000-7000-8000-000000000001",at="2026-10-06T06:00:00.000Z";
 const p={payment:{id,customer_id:id,account_id:id,amount_minor:100,occurred_at:at}};
 assert.deepEqual(parseEventPayload("CUSTOMER_PAYMENT",2,p),p);
 for(const value of [{...p,secret:"123456"},{payment:{...p.payment,amount_minor:-1}},{payment:{...p.payment,amount_minor:Number.MAX_SAFE_INTEGER+1}},{payment:{...p.payment,extra:1}}])assert.throws(()=>parseEventPayload("CUSTOMER_PAYMENT",2,value));
 assert.throws(()=>parseEventPayload("CUSTOMER_PAYMENT",3,p));
 assert.throws(()=>parseJournalEnvelope({}));assert.throws(()=>decodeSignedJournalBatch("{}"));
});
