import assert from "node:assert/strict";
import { it } from "node:test";
import { formatLocalJoinLink,parseLocalJoinLink,localNetworkUrl } from "./local-sync.ts";

it("local QR links round-trip only exact private/loopback IP endpoints and normalized codes",()=>{
  const input={url:"http://192.168.1.10:43129",fingerprint:"a".repeat(32),code:"K7F29QXM4D"},link=formatLocalJoinLink(input);
  assert.deepEqual(parseLocalJoinLink(link),input);
  for(const url of ["http://10.0.0.1:43129","http://172.16.0.1:43129","http://127.0.0.1:43129"])assert.equal(localNetworkUrl(url),url);
  for(const url of ["https://192.168.1.1:43129","http://8.8.8.8:43129","http://localhost:43129","http://127.0.0.1:43129/path","http://user:secret@10.0.0.1:43129","http://10.0.0.1:43129?token=a","http://172.32.0.1:43129"])assert.equal(localNetworkUrl(url),undefined);
  for(const bad of [link+"&u=http%3A%2F%2F127.0.0.1%3A1",link+"&x=1",link+"#x",link.replace("kolo://local","kolo://join")])assert.equal(parseLocalJoinLink(bad),undefined);
});
