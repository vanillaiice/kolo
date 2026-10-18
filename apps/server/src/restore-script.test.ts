import assert from "node:assert/strict";
import { after, it } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateServerKey } from "./identity.js";

// infrastructure/restore.sh against a stand-in `docker` that logs every call: the key check runs in real Node, the
// identity volume is a directory, and pg_restore accepts only a custom-format archive. No container is touched.
const skip = process.platform === "win32" ? "POSIX shell script" : false;
const script = fileURLToPath(new URL("../../../infrastructure/restore.sh", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "kolo-restore-")), bin = join(root, "bin");
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(bin);
writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$KOLO_FAKE_LOG"
shift 3
case "$1" in
  run) while [ "$1" != "--entrypoint" ]; do shift; done; entry=$2; shift 3
    if [ "$entry" = node ]; then exec node "$@"; fi
    exec sh -c "$(printf '%s' "$2" | sed "s#/var/lib/kolo#$KOLO_FAKE_VOLUME#g")" ;;
  exec) shift 3
    case "$1" in
      pg_restore) if [ "$2" = "--list" ]; then [ "$(head -c 5)" = PGDMP ]; exit; fi; cat > /dev/null; exit "\${KOLO_FAKE_RESTORE_FAILS:-0}" ;;
      psql) case "$*" in *"FROM pg_database"*) echo 1 ;; esac ;;
    esac ;;
esac
exit 0
`);
chmodSync(join(bin, "docker"), 0o755);

function restore(dump: string, key: string, options: { readonly restoreFails?: boolean } = {}) {
  const run = mkdtempSync(join(root, "run-")), volume = join(run, "identity"), log = join(run, "docker.log");
  mkdirSync(volume); writeFileSync(join(volume, "server-key.json"), "previous key\n"); writeFileSync(log, "");
  const result = spawnSync("sh", [script, dump, key], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`,
    KOLO_FAKE_LOG: log, KOLO_FAKE_VOLUME: volume, KOLO_FAKE_RESTORE_FAILS: options.restoreFails === true ? "1" : "0" } });
  return { status: result.status, stderr: result.stderr, calls: readFileSync(log, "utf8").trim().split("\n").filter(line => line !== ""), volume };
}
const file = (name: string, content: string | Buffer) => { const path = join(root, name); writeFileSync(path, content); return path; };
const { key, privateKeyPem } = generateServerKey();
const validKey = file("valid.server-key.json", `${JSON.stringify({ device_id: key.deviceId, private_key: privateKeyPem })}\n`);
const dump = file("valid.dump", Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(64, 1)]));
const destructive = (calls: readonly string[]) => calls.filter(call => / stop server| dropdb | createdb |ALTER DATABASE|server-key\.json\.new/.test(call));

it("missing, invalid or damaged inputs change nothing: no stop, drop, create or rename", { skip }, () => {
  const missing = restore(join(root, "absent.dump"), validKey);
  assert.equal(missing.status, 2); assert.deepEqual(missing.calls, [], "refused before any docker call");
  for (const [name, content] of [["no-key.json", `{"private_key":"not a key"}`], ["wrong-type.json", JSON.stringify({ device_id: key.deviceId, private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" })], ["not-json.json", "private_key"]] as const) {
    const refused = restore(dump, file(name, content));
    assert.equal(refused.status, 2, name); assert.match(refused.stderr, /not a valid kolo server key/, name);
    assert.deepEqual(destructive(refused.calls), [], name);
    assert.equal(readFileSync(join(refused.volume, "server-key.json"), "utf8"), "previous key\n");
  }
  const notDump = restore(file("not.dump", "plain text"), validKey);
  assert.equal(notDump.status, 2); assert.match(notDump.stderr, /not a valid backup dump/); assert.deepEqual(destructive(notDump.calls), []);
});

it("a dump that fails to restore leaves the server running on its database; only the staging copy is dropped", { skip }, () => {
  const failed = restore(dump, validKey, { restoreFails: true });
  assert.equal(failed.status, 1); assert.match(failed.stderr, /unchanged/);
  assert.equal(failed.calls.some(call => / stop server/.test(call) || /ALTER DATABASE/.test(call)), false);
  assert.ok(failed.calls.some(call => / dropdb -U kolo --if-exists kolo_restore_/.test(call)), "the staging database is removed");
  assert.equal(readFileSync(join(failed.volume, "server-key.json"), "utf8"), "previous key\n");
});

it("a valid backup is staged, then switched in with the previous database and key kept", { skip }, () => {
  const done = restore(dump, validKey), at = (pattern: RegExp) => done.calls.findIndex(call => pattern.test(call));
  assert.equal(done.status, 0, done.stderr);
  const staged = at(/createdb -U kolo kolo_restore_/), restored = at(/pg_restore -U kolo -d kolo_restore_/), stopped = at(/ stop server$/), renamed = at(/ALTER DATABASE kolo RENAME TO kolo_previous_.*; ALTER DATABASE kolo_restore_\S+ RENAME TO kolo;/), started = at(/ up -d server$/);
  assert.ok(staged >= 0 && staged < restored && restored < stopped && stopped < renamed && renamed < started, done.calls.join("\n"));
  assert.equal(readFileSync(join(done.volume, "server-key.json"), "utf8"), readFileSync(validKey, "utf8"));
  const kept = readdirSync(done.volume).filter(name => name.startsWith("server-key.json.previous-"));
  assert.equal(kept.length, 1); assert.equal(readFileSync(join(done.volume, kept[0]!), "utf8"), "previous key\n");
  assert.equal(readdirSync(done.volume).includes("server-key.json.new"), false);
});
