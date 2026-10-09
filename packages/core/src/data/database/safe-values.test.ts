import assert from "node:assert/strict";
import { it } from "node:test";
import { sqlInteger } from "./safe-values.ts";
it("SQLite number/BigInt boundaries refuse lossy native values and preserve exact limits",()=>{
 assert.equal(sqlInteger(9007199254740991n),Number.MAX_SAFE_INTEGER);
 assert.equal(sqlInteger(-9007199254740991n),Number.MIN_SAFE_INTEGER);
 for(const value of [9007199254740992n,9007199254740992,1.1,Infinity,"not a number",{}]) assert.throws(()=>sqlInteger(value));
});
