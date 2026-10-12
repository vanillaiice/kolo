import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "@kolo/core/data/database/driver";
import { LATEST_VERSION, schemaVersion } from "@kolo/core/data/database/migrations";
import { withBackup, withCopy } from "./source.ts";
import { check, csv, exportRows, exportTables, report, reportNames, shop, type ExportTable, type ReportName } from "./inspection.ts";
import { generateFixture } from "./fixture.ts";
import { runTill } from "./till.ts";
import { backupPassword, DEVELOPMENT_BACKUP_PASSWORD } from "./secrets.ts";

export const help = `kolo — offline inspection and isolated dev tooling

  kolo report <${reportNames.join("|")}> --db copy.db [--from ISO --to ISO]
  kolo export <table> --db copy.db [--format json|csv] [--out file]
  kolo check --db copy.db [--stuck-hours 24]
  kolo backup <verify|inspect> backup.json
  kolo backup decrypt backup.json --out copy.db
  kolo demo --out demo.kolo-backup.json [--products 50 --sales 500 --days 90]
  kolo fixture --out fixture.kolo-backup.json [--products 10000 --sales 2000]
  kolo till --help  (separately paired headless till)

Report, export and check also accept --backup file instead of --db.
Use --business ID for multi-shop copies. Periods are UTC, from inclusive,
to exclusive; defaults cover all history. Output defaults to JSON on stdout.
Tables: ${exportTables.join(", ")}
Backup passwords: KOLO_BACKUP_PASSWORD or --password-file file (one line, max 4 KB).
Without either, offline commands use the public demo/fixture password ${DEVELOPMENT_BACKUP_PASSWORD}.
Existing output files are never overwritten. Only standalone offline SQLite
copies are accepted; files with WAL/SHM companions are rejected.
`;

function integer(value: string | undefined, fallback: number, name: string, minimum = 1): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return result;
}
function time(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Periods require a UTC ISO date or timestamp");
  const result = new Date(value).toISOString();
  if (result.slice(0, 10) !== value.slice(0, 10)) throw new Error("Invalid calendar date");
  return result;
}
function output(data: string | Uint8Array, path: string | undefined, stdout: (text: string) => void): void {
  if (path) writeFileSync(resolve(path), data, { flag: "wx", mode: 0o600 });
  else if (typeof data === "string") stdout(data);
  else throw new Error("Binary output requires --out");
}

export async function run(args: string[], env: NodeJS.ProcessEnv = process.env, stdout: (text: string) => void = text => { process.stdout.write(text); }): Promise<number> {
  if (args[0] === "till") return runTill(args.slice(1), env, stdout);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, db: { type: "string" }, backup: { type: "string" }, business: { type: "string" },
    from: { type: "string" }, to: { type: "string" }, format: { type: "string" }, out: { type: "string" },
    "password-file": { type: "string" }, "stuck-hours": { type: "string" }, products: { type: "string" }, sales: { type: "string" },
    days: { type: "string" }, seed: { type: "string" }, name: { type: "string" },
  } });
  if (values.help || positionals.length === 0) { stdout(help); return 0; }
  const [command, subject, file] = positionals;
  const allowed: Record<string, string[]> = {
    report: ["db", "backup", "business", "from", "to", "out", "password-file"],
    export: ["db", "backup", "business", "format", "out", "password-file"],
    check: ["db", "backup", "out", "password-file", "stuck-hours"],
    backup: ["out", "password-file"],
    demo: ["out", "password-file", "products", "sales", "days", "seed", "name"],
    fixture: ["out", "password-file", "products", "sales", "days", "seed", "name"],
  };
  if (!command || !allowed[command]) throw new Error("Unknown command; use kolo --help");
  for (const key of Object.keys(values)) if (!allowed[command]!.includes(key)) throw new Error(`--${key} is not supported for ${command}`);
  const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
  if (command === "backup") {
    if (positionals.length !== 3 || !file || !["verify", "inspect", "decrypt"].includes(subject!)) throw new Error("Use kolo backup verify|inspect|decrypt file");
    if (subject === "decrypt" && !values.out) throw new Error("backup decrypt requires --out");
    await withBackup(file, backupPassword(values["password-file"], env), async (preview, handle) => {
      if (subject === "decrypt") {
        const bytes = await handle.bytes();
        try { output(bytes, values.out, stdout); } finally { bytes.fill(0); }
      } else output(json({ verified: true, ...preview }), values.out, stdout);
    });
    return 0;
  }
  if (command === "demo" || command === "fixture") {
    if (positionals.length !== 1 || !values.out) throw new Error(`${command} requires --out and no positional arguments`);
    const result = await generateFixture({
      products: integer(values.products, command === "demo" ? 50 : 10000, "products"),
      sales: integer(values.sales, command === "demo" ? 500 : 2000, "sales", 0),
      days: integer(values.days, 90, "days"), seed: integer(values.seed, 20261009, "seed", 0),
      name: values.name ?? (command === "demo" ? "Demo shop" : "Performance fixture"), password: backupPassword(values["password-file"], env),
    });
    output(result.text, values.out, stdout);
    const publicDefault = values["password-file"] === undefined && env["KOLO_BACKUP_PASSWORD"] === undefined;
    stdout(json({ output: resolve(values.out), products: result.products, sales: result.sales, elapsedMs: result.elapsedMs,
      ...(publicDefault ? { developmentBackupPassword: DEVELOPMENT_BACKUP_PASSWORD } : {}) }));
    return 0;
  }
  if (command === "report" && !reportNames.includes(subject as ReportName)) throw new Error("Unknown report; use kolo --help");
  if (command === "export" && !exportTables.includes(subject as ExportTable)) throw new Error("Unknown export table; use kolo --help");
  if (positionals.length !== (command === "check" ? 1 : 2)) throw new Error("Unexpected positional arguments");
  if (Boolean(values.db) === Boolean(values.backup)) throw new Error("Specify exactly one of --db or --backup");
  const from = time(values.from, "0001-01-01T00:00:00.000Z"), to = time(values.to, "9999-12-31T23:59:59.999Z");
  if (from >= to) throw new Error("--from must be before --to");
  if (values.format && !["json", "csv"].includes(values.format)) throw new Error("--format must be json or csv");
  const inspect = (db: Database): number => {
    if (command === "check") {
      const result = check(db, new Date(), integer(values["stuck-hours"], 24, "stuck-hours"));
      output(json(result), values.out, stdout); return result.ok ? 0 : 1;
    }
    const version = schemaVersion(db);
    if (version !== LATEST_VERSION) {
      const recovery = version < LATEST_VERSION
        ? "Use --backup to validate and migrate a private copy of an encrypted backup, or kolo backup decrypt to create an updated SQLite copy."
        : "Update the CLI to support this newer database.";
      throw new Error(`Unsupported database schema ${version}; this CLI requires ${LATEST_VERSION}. SQLite copies are never migrated. ${recovery} Use kolo check --db to inspect the copy.`);
    }
    const id = shop(db, values.business);
    if (command === "report") output(json(report(db, subject as ReportName, id, from, to)), values.out, stdout);
    else {
      const rows = exportRows(db, subject as ExportTable, id);
      output(values.format === "csv" ? csv(rows) : json(rows), values.out, stdout);
    }
    return 0;
  };
  if (values.db) return withCopy(values.db, inspect);
  return withBackup(values.backup!, backupPassword(values["password-file"], env), async (_preview, handle) => inspect(handle.database));
}
