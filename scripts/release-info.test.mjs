import assert from "node:assert/strict";
import { test } from "node:test";
import { requiredAssets, missingAssets } from "./release-info.mjs";

const complete = () => requiredAssets().map(name => ({ name, state: "uploaded", size: 1 }));
test("publication waits for all desktop and Android targets and metadata", () => {
  assert.deepEqual(missingAssets(complete()), []);
  for (const removed of requiredAssets()) {
    assert.deepEqual(missingAssets(complete().filter(asset => asset.name !== removed)), [removed]);
  }
});
test("stale-version, empty and unfinished uploads cannot complete a release", () => {
  const assets = complete();
  assets[0].name = "KOLO-0.0.0-win-x64-setup.exe";
  assets[1].size = 0;
  assets[2].state = "starter";
  assert.deepEqual(missingAssets(assets), requiredAssets().slice(0, 3));
});
