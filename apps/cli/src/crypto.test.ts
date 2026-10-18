import assert from "node:assert/strict";
import { it } from "node:test";
import { runPlatformCheck } from "@kolo/core/application/platform-check";
import { sealingCrypto, transferCrypto } from "./crypto.ts";

it("the CLI's Node adapters pass the platform check the apps run in their own runtimes", async () => {
  for (const result of [await runPlatformCheck(transferCrypto), await runPlatformCheck(sealingCrypto, sealingCrypto)])
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter(item => !item.ok)));
});
