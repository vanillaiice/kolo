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

test("release notes need the version's changelog section and put it before the download instructions", async () => {
  const { changelogFor, releaseNotes, releaseVersion } = await import("./release-info.mjs");
  const changelog = `# KOLO changelog\n\n## Unreleased\n\n- later\n\n## [1.2.0] - 2026-11-01\n\n### Français\n\n- correctif\n\n## 1.1.0\n\n- older\n`;
  assert.equal(changelogFor("1.2.0", changelog), "### Français\n\n- correctif");
  assert.equal(changelogFor("1.1.0", changelog), "- older");
  assert.throws(() => changelogFor("1.0.0", changelog), /no "## 1.0.0" section/);
  assert.throws(() => changelogFor("1.2", changelog), /no "## 1.2" section/, "a shorter version never matches a longer heading");
  assert.throws(() => changelogFor("1.1.0", "## 1.1.0\n\n## 1.0.0\n- x\n"), /is empty/);
  assert.throws(() => changelogFor("1.0.0-beta.1", "## 1.0.0-beta.10\n- x\n"), /no "## 1.0.0-beta.1" section/);
  assert.equal(changelogFor("1.0.0+build", "## 1.0.0+build\n- x\n"), "- x");
  const notes = releaseNotes(`## ${releaseVersion}\n\n- what changed\n`);
  assert.ok(notes.startsWith("- what changed\n\n---\n\n"), notes);
  assert.match(notes, /Windows: download the setup installer/);
});

test("releases are GitHub pre-releases only before 1.0.0 or with a pre-release suffix", async () => {
  const { isPrerelease } = await import("./release-info.mjs");
  for (const version of ["0.8.0", "0.10.3", "1.0.0-beta.1", "2.1.0-rc.2"]) assert.equal(isPrerelease(version), true, version);
  for (const version of ["1.0.0", "1.4.2", "10.0.0"]) assert.equal(isPrerelease(version), false, version);
});
