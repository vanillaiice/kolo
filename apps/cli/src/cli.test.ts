import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@kolo/core/data/database/node-sqlite";
import { migrate, LATEST_VERSION } from "@kolo/core/data/database/migrations";
import { run } from "./cli.ts";
import { check, csv, exportRows, exportTables, shop } from "./inspection.ts";
import { withBackup, withCopy } from "./source.ts";
import { generateFixture } from "./fixture.ts";
import { backupPassword, DEVELOPMENT_BACKUP_PASSWORD, MAX_SECRET_FILE_BYTES, readSecretFile } from "./secrets.ts";

const env = { KOLO_BACKUP_PASSWORD: "test-password-2026" };
test("read-only inspection preserves bytes, rejects writes and never creates missing databases", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-cli-test-")), path = join(directory, "copy.db");
  try {
    const db = openDatabase({ location: path }); migrate(db); db.close();
    const before = readFileSync(path);
    await withCopy(path, db => {
      assert.equal(check(db).ok, true);
      assert.throws(() => db.run("DELETE FROM schema_migrations"));
      assert.throws(() => db.all("DELETE FROM schema_migrations RETURNING version"));
    });
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(path + "-wal"), false);
    assert.equal(existsSync(path + "-shm"), false);
    const missing = join(directory, "missing.db");
    await assert.rejects(withCopy(missing, () => undefined));
    assert.equal(existsSync(missing), false);
    writeFileSync(path + "-wal", "");
    await assert.rejects(withCopy(path, () => undefined), /standalone/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("signed fixtures verify, decrypt, report and export without touching the source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-cli-test-")), path = join(directory, "fixture.json"), copy = join(directory, "copy.db");
  try {
    const fixture = await generateFixture({ products: 3, sales: 7, days: 3, seed: 42, name: "CLI test", password: env.KOLO_BACKUP_PASSWORD });
    writeFileSync(path, fixture.text);
    let stdout = "";
    const capture = (text: string): void => { stdout += text; };
    assert.equal(await run(["backup", "verify", path], env, capture), 0);
    assert.equal(JSON.parse(stdout).businessName, "CLI test");
    await assert.rejects(run(["backup", "verify", path], { KOLO_BACKUP_PASSWORD: "wrong-password" }, capture), /authentication_failed/);
    const envelope = JSON.parse(fixture.text);
    envelope.payload = "AAAA";
    const damaged = join(directory, "damaged.json"); writeFileSync(damaged, JSON.stringify(envelope));
    await assert.rejects(run(["backup", "verify", damaged], env, capture));
    assert.equal(await run(["backup", "decrypt", path, "--out", copy], env, capture), 0);
    await assert.rejects(run(["backup", "decrypt", path, "--out", copy], env, capture), /EEXIST/);
    stdout = "";
    assert.equal(await run(["report", "sales", "--db", copy], env, capture), 0);
    assert.equal(JSON.parse(stdout).transactions, 7);
    stdout = "";
    assert.equal(await run(["report", "sales", "--backup", path, "--from", "2026-01-01", "--to", "2026-01-02"], env, capture), 0);
    assert.equal(JSON.parse(stdout).transactions, 3);
    stdout = "";
    assert.equal(await run(["check", "--db", copy], env, capture), 0);
    assert.deepEqual(JSON.parse(stdout).issues, []);
    await withCopy(copy, db => { for (const table of exportTables) assert.ok(Array.isArray(exportRows(db, table, shop(db)))); });
    stdout = "";
    assert.equal(await run(["export", "products", "--db", copy, "--format", "csv"], env, capture), 0);
    assert.match(stdout, /Product 00001/);
    await withBackup(path, env.KOLO_BACKUP_PASSWORD, async (_preview, handle) => {
      const db = handle.database;
      const eventId = String(db.get("SELECT event_id FROM applied_events LIMIT 1")!["event_id"]);
      db.run("DROP TRIGGER applied_events_keep_application");
      db.run("UPDATE applied_events SET status='quarantined' WHERE event_id=?", [eventId]);
      assert.ok(check(db).issues.some(issue => issue.code === "quarantined_events"));
      db.run("UPDATE applied_events SET status='deferred',updated_at='2026-01-01T00:00:00.000Z' WHERE event_id=?", [eventId]);
      assert.ok(check(db, new Date("2026-02-01T00:00:00.000Z")).issues.some(issue => issue.code === "stuck_application"));
      db.run("UPDATE journal_origins SET next_sequence=1");
      assert.ok(check(db).issues.some(issue => issue.code === "journal_origin_sequence"));
      db.run("DROP TRIGGER inventory_movements_no_update");
      db.run("UPDATE inventory_movements SET quantity=quantity-1000 WHERE type='SALE'");
      assert.ok(check(db).issues.some(issue => issue.code === "sale_stock_mismatch"));
      db.run("UPDATE sync_outbox SET state='rejected'");
      assert.ok(check(db).issues.some(issue => issue.code === "rejected_outbox"));
      const broken = join(directory, "broken.db");
      writeFileSync(broken, await handle.bytes());
      assert.equal(await run(["check", "--db", broken], env, capture), 1);
    });
    assert.equal(readFileSync(path, "utf8"), fixture.text);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("argument validation and spreadsheet exports", async () => {
  await assert.rejects(run(["report", "sales"]), /exactly one/);
  await assert.rejects(run(["report", "sales", "--db", "a", "--backup", "b"]), /exactly one/);
  await assert.rejects(run(["report", "sales", "--db", "a", "--from", "2026-02-30"]), /calendar/);
  await assert.rejects(run(["check", "--db", "a", "--products", "1"]), /not supported/);
  await assert.rejects(run(["export", "device_session", "--db", "a"]), /Unknown export/);
  await assert.rejects(run(["fixture", "--out", "a", "--products", "NaN"]), /integer/);
  assert.equal(csv([{ name: '=HYPERLINK("bad")', amount: -10 }]), '"name","amount"\r\n"\'=HYPERLINK(""bad"")","-10"\r\n');
});

test("demo and fixture backups open without password setup; explicit passwords take precedence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-cli-default-password-"));
  let stdout = ""; const capture = (text: string): void => { stdout += text; };
  try {
    for (const command of ["demo", "fixture"]) {
      const path = join(directory, `${command}.json`);
      stdout = "";
      assert.equal(await run([command, "--products", "1", "--sales", "1", "--out", path], {}, capture), 0);
      assert.equal(JSON.parse(stdout).developmentBackupPassword, DEVELOPMENT_BACKUP_PASSWORD);
      stdout = "";
      assert.equal(await run(["backup", "inspect", path], {}, capture), 0);
      assert.equal(JSON.parse(stdout).verified, true);
      stdout = "";
      assert.equal(await run(["report", "sales", "--backup", path], {}, capture), 0);
      assert.equal(JSON.parse(stdout).transactions, 1);
      await assert.rejects(run(["backup", "inspect", path], env, capture), /authentication_failed/);
    }
    stdout = "";
    const custom = join(directory, "custom.json");
    await run(["demo", "--products", "1", "--sales", "0", "--out", custom], env, capture);
    assert.equal(JSON.parse(stdout).developmentBackupPassword, undefined);
    assert.equal(stdout.includes(env.KOLO_BACKUP_PASSWORD), false);
    await assert.rejects(run(["backup", "inspect", custom], {}, capture), /authentication_failed/);
    assert.equal(await run(["backup", "inspect", custom], env, capture), 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("secret file reads are bounded in bytes and explicit empty passwords do not select the demo default", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-cli-secret-file-")), path = join(directory, "password");
  try {
    writeFileSync(path, "file-password-2026\r\n");
    assert.equal(backupPassword(path, env), "file-password-2026");
    writeFileSync(path, "x".repeat(MAX_SECRET_FILE_BYTES));
    assert.equal(readSecretFile(path).length, MAX_SECRET_FILE_BYTES);
    writeFileSync(path, "é".repeat(MAX_SECRET_FILE_BYTES / 2) + "\n");
    assert.throws(() => readSecretFile(path), /4 KB/);
    for (const args of [
      ["backup", "inspect", "missing.json", "--password-file", path],
      ["report", "sales", "--backup", "missing.json", "--password-file", path],
      ["demo", "--products", "1", "--out", join(directory, "demo.json"), "--password-file", path],
    ]) await assert.rejects(run(args, {}, () => undefined), /4 KB/);
    writeFileSync(path, "\n");
    assert.throws(() => backupPassword(path, env), /empty/);
    assert.throws(() => backupPassword(undefined, { KOLO_BACKUP_PASSWORD: "" }), /empty/);
    assert.equal(backupPassword(undefined, {}), DEVELOPMENT_BACKUP_PASSWORD);
    assert.throws(() => readSecretFile(directory), /regular files/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("older SQLite copies give migration guidance without modifying the source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-cli-old-schema-")), path = join(directory, "old.db");
  try {
    const database = openDatabase({ location: path }); migrate(database);
    database.run("DELETE FROM schema_migrations WHERE version=?", [LATEST_VERSION]); database.close();
    const before = readFileSync(path);
    for (const args of [["report", "sales", "--db", path], ["export", "products", "--db", path]]) {
      await assert.rejects(run(args, {}, () => undefined), error => error instanceof Error
        && error.message.includes(`schema ${LATEST_VERSION - 1}`)
        && error.message.includes(`requires ${LATEST_VERSION}`)
        && error.message.includes("kolo backup decrypt"));
    }
    let output = "";
    assert.equal(await run(["check", "--db", path], {}, text => { output += text; }), 1);
    assert.equal(JSON.parse(output).schemaVersion, LATEST_VERSION - 1);
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
