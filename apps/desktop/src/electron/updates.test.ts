import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DesktopUpdates, installKind, nonBreaking, offered, releaseNotes, updateHandlers, writeSafetyCopy, type InstallKind, type Updater } from "./updates.ts";
import { openDesktopDatabase } from "./database.ts";
import type { UpdateView } from "../shared/service.ts";

type Check = string | { version: string; notes: string | { version: string; note: string | null }[] | null } | null | Error;

/** A scripted electron-updater: each check answers the next queued result; downloads wait until released. */
function fakeUpdater(script: { checks: Check[]; download?: () => Promise<void>; install?: boolean; current?: string }) {
  const calls: string[] = [];
  let progress: ((value: { percent: number }) => void) | undefined;
  const updater: Updater & { calls: string[]; progress: (percent: number) => void } = {
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, fullChangelog: false, calls,
    async checkForUpdates() {
      calls.push("check"); const next = script.checks.shift();
      if (next instanceof Error) throw next;
      if (next === null || next === undefined) return null;
      const { version, notes } = typeof next === "string" ? { version: next, notes: `<p>${next}</p>` } : next;
      return { isUpdateAvailable: version !== (script.current ?? "0.8.0"), updateInfo: { version, releaseNotes: notes } };
    },
    async downloadUpdate() { calls.push("download"); await script.download?.(); return []; },
    install(isSilent, isForceRunAfter) { calls.push(`install:${isSilent}:${isForceRunAfter}`); return script.install ?? true; },
    on(_event, listener) { progress = listener; return updater; },
    progress: percent => progress?.({ percent }),
  };
  return updater;
}

function fixture(kind: InstallKind, updater: ReturnType<typeof fakeUpdater>, options: { preferences?: string; current?: string; copy?: () => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kolo-updates-")), file = join(directory, "updates.json"), events: string[] = [], published: UpdateView[] = [];
  if (options.preferences !== undefined) writeFileSync(file, options.preferences);
  let loads = 0;
  const updates = new DesktopUpdates({ kind, currentVersion: options.current ?? "0.8.0", preferences: file, now: () => "2026-10-20T08:00:00.000Z",
    updater: async () => { loads++; return updater; }, publish: view => published.push(view),
    safetyCopy: async () => { events.push("copy"); options.copy?.(); },
    beforeInstall: async () => { events.push("closed"); }, afterInstall: started => { events.push(`after:${started}`); } });
  return { updates, file, events, published, loads: () => loads, dispose() { updates.dispose(); rmSync(directory, { recursive: true, force: true }); } };
}
const settle = (): Promise<void> => new Promise(setImmediate);
const notesOf = (version: string) => [{ version, html: `<p>${version}</p>` }];

it("names the install kind from the packaged runtime", () => {
  const base = { packaged: true, windowsStore: false, env: {}, packageType: undefined };
  assert.equal(installKind({ ...base, platform: "win32" }), "nsis");
  assert.equal(installKind({ ...base, platform: "win32", env: { PORTABLE_EXECUTABLE_FILE: "C:\\KOLO.exe" } }), "portable");
  assert.equal(installKind({ ...base, platform: "win32", windowsStore: true, env: { PORTABLE_EXECUTABLE_FILE: "x" } }), "store");
  assert.equal(installKind({ ...base, platform: "linux", env: { APPIMAGE: "/home/a/KOLO.AppImage" }, packageType: "deb" }), "appimage");
  assert.equal(installKind({ ...base, platform: "linux", packageType: "deb" }), "deb");
  assert.equal(installKind({ ...base, platform: "linux", packageType: "rpm" }), "other");
  assert.equal(installKind({ ...base, platform: "linux" }), "other");
  assert.equal(installKind({ ...base, platform: "darwin" }), "other");
  for (const platform of ["win32", "linux"]) assert.equal(installKind({ ...base, platform, packaged: false, env: { APPIMAGE: "/a" } }), "development");
});

it("non-breaking follows semver's caret rule, and betas reach only beta copies", () => {
  const cases: [string, string, boolean][] = [
    ["1.0.0", "1.0.1", true], ["1.0.0", "1.4.0", true], ["1.9.9", "2.0.0", false], ["1.2.0", "1.1.9", false],
    ["0.8.0", "0.8.1", true], ["0.8.0", "0.9.0", false], ["0.8.3", "1.0.0", false], ["0.0.3", "0.0.4", false],
    ["1.0.0", "1.1.0-beta.1", false], ["1.0.0-beta.1", "1.0.0", true], ["1.0.0-beta.1", "1.0.0-beta.2", true],
  ];
  for (const [current, next, expected] of cases) assert.equal(nonBreaking(current, next), expected, `${current} → ${next}`);
  const offers: [string, string, boolean][] = [
    ["0.8.0", "0.9.0", true], ["1.0.0", "2.0.0", true], ["0.8.0", "0.8.0", false], ["0.8.1", "0.8.0", false],
    ["1.0.0", "1.1.0-beta.1", false], ["0.8.0", "0.9.0-beta.1", false], ["1.0.0-beta.1", "1.0.0-beta.2", true], ["1.0.0-beta.2", "1.0.0", true],
    ["1.0.0", "not-a-version", false],
  ];
  for (const [current, next, expected] of offers) assert.equal(offered(current, next), expected, `${current} → ${next}`);
});

it("release notes are bounded, valid and newest first", () => {
  assert.deepEqual(releaseNotes("0.9.0", "<p>one</p>"), [{ version: "0.9.0", html: "<p>one</p>" }]);
  assert.deepEqual(releaseNotes("0.9.0", null), []);
  assert.deepEqual(releaseNotes("0.9.0", undefined), []);
  assert.deepEqual(releaseNotes("0.9.0", "   "), []);
  assert.deepEqual(releaseNotes("0.9.0", [{ version: "0.8.1", note: "a" }, { version: "0.9.0", note: "b" }, { version: "x", note: "c" }, { version: "0.8.2", note: null }]),
    [{ version: "0.9.0", html: "b" }, { version: "0.8.1", html: "a" }]);
  const many = Array.from({ length: 30 }, (_value, index) => ({ version: `0.${index + 9}.0`, note: "x".repeat(100_000) }));
  const bounded = releaseNotes("0.38.0", many);
  assert.equal(bounded.length, 20); assert.equal(bounded[0]!.version, "0.38.0"); assert.equal(bounded[0]!.html.length, 64 * 1024);
});

it("a check reports the found version with its notes and downloads only on request", async () => {
  const updater = fakeUpdater({ checks: [{ version: "0.9.0", notes: [{ version: "0.9.0", note: "<p>new</p>" }, { version: "0.8.1", note: "<p>fix</p>" }] }] }), f = fixture("nsis", updater);
  try {
    assert.deepEqual(f.updates.view(), { currentVersion: "0.8.0", mode: "install", automatic: false, installsOnClose: true, status: { state: "idle" } });
    assert.deepEqual((await f.updates.check()).status, { state: "available", version: "0.9.0", breaking: true,
      notes: [{ version: "0.9.0", html: "<p>new</p>" }, { version: "0.8.1", html: "<p>fix</p>" }] });
    assert.equal(updater.allowPrerelease, true, "0.x releases are GitHub pre-releases"); assert.equal(updater.fullChangelog, true);
    assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
    assert.deepEqual(updater.calls, ["check"]);
    assert.deepEqual(f.published.map(view => view.status.state), ["checking", "available"]);
    assert.equal((await f.updates.download()).status.state, "ready");
    assert.deepEqual(updater.calls, ["check", "download"]);
  } finally { f.dispose(); }
});

it("from 1.0.0 only full releases are read; a beta found anyway is not offered", async () => {
  const updater = fakeUpdater({ checks: ["1.1.0-beta.1"], current: "1.0.0" }), f = fixture("nsis", updater, { current: "1.0.0" });
  try {
    assert.deepEqual((await f.updates.check()).status, { state: "current", checkedAt: "2026-10-20T08:00:00.000Z" });
    assert.equal(updater.allowPrerelease, false);
  } finally { f.dispose(); }
  const beta = fakeUpdater({ checks: ["1.0.0-beta.2"], current: "1.0.0-beta.1" }), g = fixture("nsis", beta, { current: "1.0.0-beta.1" });
  try {
    assert.equal((await g.updates.check()).status.state, "available");
    assert.equal(beta.allowPrerelease, true);
  } finally { g.dispose(); }
  const early = fakeUpdater({ checks: ["0.9.0-beta.1"] }), h = fixture("nsis", early);
  try { assert.equal((await h.updates.check()).status.state, "current", "a 0.x copy is not moved onto a beta"); } finally { h.dispose(); }
});

it("an up-to-date or inactive updater reports current; a failed check says only which step failed", async () => {
  const updater = fakeUpdater({ checks: ["0.8.0", null, new Error("getaddrinfo ENOTFOUND github.com /home/secret")] }), f = fixture("appimage", updater);
  try {
    assert.deepEqual((await f.updates.check()).status, { state: "current", checkedAt: "2026-10-20T08:00:00.000Z" });
    assert.deepEqual((await f.updates.check()).status, { state: "current", checkedAt: "2026-10-20T08:00:00.000Z" });
    assert.deepEqual((await f.updates.check()).status, { state: "failed", step: "check" });
    assert.equal(f.loads(), 1);
  } finally { f.dispose(); }
});

it("concurrent checks reach the updater once; a running download or a ready update is not checked over", async () => {
  let release!: () => void;
  const updater = fakeUpdater({ checks: ["0.8.1", "0.8.2"], download: () => new Promise(done => { release = done; }) }), f = fixture("nsis", updater);
  try {
    const [first, second] = await Promise.all([f.updates.check(), f.updates.check()]);
    assert.equal(first.status.state, "available"); assert.equal(second.status.state, "checking");
    assert.deepEqual(updater.calls, ["check"]);
    const downloading = f.updates.download();
    await settle();
    updater.progress(42.6); updater.progress(140); updater.progress(-3);
    const found = { version: "0.8.1", notes: notesOf("0.8.1"), breaking: false };
    assert.deepEqual(f.published.slice(-3).map(view => view.status), [
      { state: "downloading", ...found, percent: 43 }, { state: "downloading", ...found, percent: 100 }, { state: "downloading", ...found, percent: 0 }]);
    assert.equal((await f.updates.check()).status.state, "downloading");
    assert.equal((await f.updates.download()).status.state, "downloading");
    release(); await downloading;
    assert.equal((await f.updates.check()).status.state, "ready");
    assert.deepEqual(updater.calls, ["check", "download"]);
    updater.progress(10);
    assert.equal(f.updates.view().status.state, "ready");
  } finally { f.dispose(); }
});

it("automatic updates are off by default, persist, and install non-breaking versions on close only where no password is asked", async () => {
  const off = fixture("nsis", fakeUpdater({ checks: ["0.8.1"] }));
  try {
    assert.equal(off.updates.view().automatic, false);
    await off.updates.check(); await settle();
    assert.equal(off.updates.view().status.state, "available", "nothing downloads without the setting");
  } finally { off.dispose(); }
  for (const [kind, onClose] of [["nsis", true], ["appimage", true], ["deb", false]] as const) {
    const updater = fakeUpdater({ checks: ["0.8.1"] }), f = fixture(kind, updater);
    try {
      assert.equal(f.updates.setAutomatic(true).automatic, true);
      assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { automatic: true });
      await f.updates.check(); await settle();
      assert.equal(f.updates.view().status.state, "ready", kind);
      assert.equal(updater.autoInstallOnAppQuit, onClose, kind);
      assert.equal(f.updates.view().installsOnClose, onClose);
      f.updates.setAutomatic(false);
      assert.equal(updater.autoInstallOnAppQuit, false);
    } finally { f.dispose(); }
  }
  const updater = fakeUpdater({ checks: ["0.8.1"] }), later = fixture("nsis", updater);
  try {
    await later.updates.check();
    later.updates.setAutomatic(true); await settle();
    assert.equal(later.updates.view().status.state, "ready", "turning it on downloads a non-breaking update already found");
  } finally { later.dispose(); }
});

it("a breaking update never downloads or installs by itself, even when it is downloaded by hand", async () => {
  for (const [current, next] of [["0.8.0", "0.9.0"], ["1.4.0", "2.0.0"]] as const) {
    const updater = fakeUpdater({ checks: [next], current }), f = fixture("nsis", updater, { current, preferences: '{"automatic":true}' });
    try {
      const found = await f.updates.check(); await settle();
      assert.deepEqual(found.status, { state: "available", version: next, breaking: true, notes: notesOf(next) });
      f.updates.setAutomatic(true); await settle();
      assert.equal(f.updates.view().status.state, "available");
      assert.deepEqual(updater.calls, ["check"]);
      await f.updates.download();
      assert.equal(f.updates.view().status.state, "ready");
      assert.equal(updater.autoInstallOnAppQuit, false, "a breaking update waits for Restart and install");
      await f.updates.beforeQuit();
      assert.deepEqual(f.events, [], "no copy for an install that will not happen");
    } finally { f.dispose(); }
  }
  const later = fakeUpdater({ checks: ["1.5.0"], current: "1.4.0" }), g = fixture("appimage", later, { current: "1.4.0", preferences: '{"automatic":true}' });
  try {
    await g.updates.check(); await settle();
    assert.equal(g.updates.view().status.state, "ready", "a minor release from 1.0.0 is non-breaking");
    assert.equal(later.autoInstallOnAppQuit, true);
  } finally { g.dispose(); }
});

it("reads the preference file defensively", () => {
  for (const [text, expected] of [['{"automatic":true}', true], ['{"automatic":"yes"}', false], ["[true]", false], ["null", false], ["{", false], ["", false]] as const) {
    const f = fixture("nsis", fakeUpdater({ checks: [] }), { preferences: text });
    try { assert.equal(f.updates.view().automatic, expected, text); } finally { f.dispose(); }
  }
});

it("a failed download can be found and downloaded again", async () => {
  let fail = true;
  const updater = fakeUpdater({ checks: ["0.9.0", "0.9.0"], download: async () => { if (fail) throw new Error("ECONNRESET"); } }), f = fixture("nsis", updater);
  try {
    await f.updates.check();
    assert.deepEqual((await f.updates.download()).status, { state: "failed", step: "download" });
    fail = false;
    assert.equal((await f.updates.check()).status.state, "available");
    assert.equal((await f.updates.download()).status.state, "ready");
  } finally { f.dispose(); }
});

it("installing copies the shop, closes it, then starts the installer; a failed copy installs nothing", async () => {
  const updater = fakeUpdater({ checks: ["0.9.0"] }), f = fixture("nsis", updater);
  try {
    await f.updates.install();
    assert.deepEqual(f.events, [], "nothing to install yet");
    await f.updates.check(); await f.updates.download();
    await f.updates.install();
    assert.deepEqual(f.events, ["copy", "closed", "after:true"]);
    assert.equal(updater.calls[updater.calls.length - 1], "install:true:true");
  } finally { f.dispose(); }
  const full = fakeUpdater({ checks: ["0.9.0"] }), noSpace = fixture("nsis", full, { copy: () => { throw new Error("ENOSPC"); } });
  try {
    await noSpace.updates.check(); await noSpace.updates.download();
    assert.deepEqual((await noSpace.updates.install()).status, { state: "failed", step: "backup" });
    assert.deepEqual(noSpace.events, ["copy"]);
    assert.ok(!full.calls.some(call => call.startsWith("install")));
  } finally { noSpace.dispose(); }
  const refusing = fakeUpdater({ checks: ["0.9.0"], install: false }), g = fixture("deb", refusing);
  try {
    await g.updates.check(); await g.updates.download();
    assert.deepEqual((await g.updates.install()).status, { state: "failed", step: "install" });
    assert.deepEqual(g.events, ["copy", "closed", "after:false"]);
  } finally { g.dispose(); }
  const throwing = fakeUpdater({ checks: ["0.9.0"] }); throwing.install = () => { throw new Error("EACCES"); };
  const h = fixture("appimage", throwing);
  try {
    await h.updates.check(); await h.updates.download();
    assert.equal((await h.updates.install()).status.state, "failed");
    assert.deepEqual(h.events, ["copy", "closed", "after:false"]);
  } finally { h.dispose(); }
});

it("an install on close copies the shop first and is cancelled when the copy fails", async () => {
  const updater = fakeUpdater({ checks: ["0.8.1"] }), f = fixture("nsis", updater, { preferences: '{"automatic":true}' });
  try {
    await f.updates.beforeQuit();
    assert.deepEqual(f.events, [], "no update, no copy");
    await f.updates.check(); await settle();
    assert.equal(updater.autoInstallOnAppQuit, true);
    await f.updates.beforeQuit();
    assert.deepEqual(f.events, ["copy"]); assert.equal(updater.autoInstallOnAppQuit, true);
  } finally { f.dispose(); }
  const failing = fakeUpdater({ checks: ["0.8.1"] }), g = fixture("appimage", failing, { preferences: '{"automatic":true}', copy: () => { throw new Error("EIO"); } });
  try {
    await g.updates.check(); await settle();
    await g.updates.beforeQuit();
    assert.equal(failing.autoInstallOnAppQuit, false);
  } finally { g.dispose(); }
});

it("the safety copy is a consistent SQLite copy of the shop, and only the newest three are kept", () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-safety-")), database = openDesktopDatabase(join(directory, "shop.db")), copies = join(directory, "pre-update");
  try {
    database.run("CREATE TABLE safety_probe(id INTEGER PRIMARY KEY, total INTEGER NOT NULL)");
    database.run("INSERT INTO safety_probe(total) VALUES (1500), (2750)");
    const first = writeSafetyCopy(database, copies, "0.8.0", new Date("2026-10-20T08:00:00.000Z"));
    assert.equal(first, join(copies, "0.8.0-2026-10-20T08-00-00-000Z.db"));
    const copy = new DatabaseSync(first, { readOnly: true });
    try { assert.deepEqual(copy.prepare("SELECT total FROM safety_probe ORDER BY id").all().map(row => row["total"]), [1500, 2750]); } finally { copy.close(); }
    writeFileSync(join(copies, "notes.txt"), "kept: not a copy");
    // Versions that sort wrongly as text still keep the newest by time.
    for (const [version, minute] of [["0.9.0", 1], ["0.10.0", 2], ["0.9.0", 3], ["0.10.0", 4]] as const) writeSafetyCopy(database, copies, version, new Date(`2026-10-20T08:0${minute}:00.000Z`));
    assert.deepEqual(readdirSync(copies).sort(), ["0.10.0-2026-10-20T08-02-00-000Z.db", "0.10.0-2026-10-20T08-04-00-000Z.db", "0.9.0-2026-10-20T08-03-00-000Z.db", "notes.txt"]);
    assert.throws(() => writeSafetyCopy(database, copies, "0.10.0", new Date("2026-10-20T08:04:00.000Z")), "an existing copy is never overwritten");
    assert.equal(readdirSync(copies).length, 4);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("a portable copy only reports a new version; Store and development copies never check", async () => {
  const updater = fakeUpdater({ checks: ["0.8.1"] }), portable = fixture("portable", updater);
  try {
    portable.updates.setAutomatic(true);
    assert.equal((await portable.updates.check()).status.state, "available");
    assert.equal((await portable.updates.download()).status.state, "available");
    assert.equal(portable.updates.view().mode, "notify");
    assert.deepEqual(updater.calls, ["check"]);
  } finally { portable.dispose(); }
  for (const kind of ["store", "development", "other"] as const) {
    const f = fixture(kind, fakeUpdater({ checks: ["0.9.0"] }));
    try {
      f.updates.start(0, 1);
      await new Promise(done => setTimeout(done, 20));
      assert.deepEqual((await f.updates.check()).status, { state: "idle" });
      assert.equal(f.updates.view().mode, "none"); assert.equal(f.loads(), 0, kind);
    } finally { f.dispose(); }
  }
});

it("scheduled checks run after the first delay and stop on dispose", async () => {
  const updater = fakeUpdater({ checks: ["0.8.0", "0.8.0", "0.8.0", "0.8.0", "0.8.0", "0.8.0"] }), f = fixture("nsis", updater);
  try {
    f.updates.start(5, 10);
    await new Promise(done => setTimeout(done, 40));
    f.updates.dispose();
    const count = updater.calls.length;
    assert.ok(count >= 2, `checked ${count} times`);
    await new Promise(done => setTimeout(done, 30));
    assert.equal(updater.calls.length, count);
  } finally { f.dispose(); }
});

it("the update bridge refuses untrusted senders and malformed arguments", async () => {
  const opened: string[] = [], f = fixture("portable", fakeUpdater({ checks: ["0.9.0"] }));
  try {
    const trustedSender = {}, handlers = updateHandlers(f.updates, event => event === trustedSender, async () => { opened.push("downloads"); });
    const invoke = (channel: string, event: unknown, ...args: unknown[]) => handlers[channel]!(event, ...args);
    assert.deepEqual(Object.keys(handlers).sort(), ["kolo:automatic-updates", "kolo:check-update", "kolo:download-update", "kolo:install-update", "kolo:open-downloads", "kolo:update-state"]);
    for (const channel of Object.keys(handlers)) assert.deepEqual(await invoke(channel, {}, { enabled: true }), { ok: false, error: { code: "permission_denied" } }, channel);
    for (const channel of Object.keys(handlers).filter(name => name !== "kolo:automatic-updates")) assert.deepEqual(await invoke(channel, trustedSender, "extra"), { ok: false, error: { code: "invalid_input" } }, channel);
    for (const input of [[], [{ enabled: "true" }], [{ enabled: true, extra: 1 }], [null], ["true"], [{ enabled: true }, 1]])
      assert.deepEqual(await invoke("kolo:automatic-updates", trustedSender, ...input), { ok: false, error: { code: "invalid_input" } }, JSON.stringify(input));
    assert.equal(f.updates.view().automatic, false);
    const set = await invoke("kolo:automatic-updates", trustedSender, { enabled: true }) as { ok: true; value: UpdateView };
    assert.equal(set.ok, true); assert.equal(set.value.automatic, true);
    const checked = await invoke("kolo:check-update", trustedSender) as { ok: true; value: UpdateView };
    assert.deepEqual(checked.value.status, { state: "available", version: "0.9.0", breaking: true, notes: notesOf("0.9.0") });
    assert.deepEqual(await invoke("kolo:open-downloads", trustedSender), { ok: true, value: null });
    assert.deepEqual(opened, ["downloads"]);
  } finally { f.dispose(); }
});
