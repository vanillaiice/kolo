/**
 * End-to-end sync across real processes: a disposable PostgreSQL 18 container, the built sync server as its own
 * process, an owner till (core, in this process) and a separately paired headless till driven only through the
 * `kolo` CLI. Everything crosses real HTTP; nothing is mocked. Requires Docker. Cleans up only its own resources.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID, randomUUIDv7 } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { checkIntegrity } from "@kolo/core/data/database/integrity";
import { protectedCredentials } from "@kolo/core/identity/credentials";
import { createWorkspace, unlockWorkspace } from "@kolo/core/identity/workspace";
import * as commands from "@kolo/core/application/operations";
import { paymentAccounts } from "@kolo/core/application/queries";
import { connectServer, previewServer, synchronizeServer } from "@kolo/core/application/server-sync";
import { createHttpSyncTransport } from "@kolo/core/application/http-sync-transport";
import { approveJoin, endJoin, pollJoin, startJoin } from "@kolo/core/application/join";
import { sealPendingEvents } from "@kolo/core/application/exchange";
import { parseConnectionCode } from "@kolo/contracts/sync";
import { credentialCrypto, sealingCrypto } from "../apps/cli/dist/crypto.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, ".."), server = join(root, "apps/server/dist/main.js"), cli = join(root, "apps/cli/dist/main.js");
const directory = mkdtempSync(join(tmpdir(), "kolo-e2e-")), container = `kolo-e2e-postgres-${randomUUID().slice(0, 8)}`;
const tillState = join(directory, "headless-till"), secret = "e2e-till-secret-4821", ownerSecret = "e2e-owner-602913";
let containerCreated = false, serverProcess, ownerDatabase, ownerFiles, serverLog = "";
const step = message => process.stdout.write(`• ${message}\n`);

/** One `kolo` invocation; exit codes other than those expected fail the run with the CLI's message. */
function kolo(args, expected = [0]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, KOLO_TILL_SECRET: secret, KOLO_BACKUP_PASSWORD: "e2e-backup-password" } });
  if (!expected.includes(result.status)) throw new Error(`kolo ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  return { status: result.status, json: result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout) };
}
async function freePort() {
  return new Promise((resolvePort, reject) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); }).on("error", reject); });
}

try {
  step("PostgreSQL 18 in a disposable container");
  await execute("docker", ["run", "--rm", "--detach", "--name", container, "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=kolo", "-e", "POSTGRES_PASSWORD=kolo", "-e", "POSTGRES_DB=kolo", "postgres:18"]);
  containerCreated = true;
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await execute("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "kolo", "-d", "kolo"]); ready = true; } catch { await delay(500); }
  }
  assert.ok(ready, "PostgreSQL did not become ready");
  const pgPort = (await execute("docker", ["port", container, "5432/tcp"])).stdout.trim().split("\n")[0].split(":").pop();

  step("Sync server: migrate, issue a connection code, serve");
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, DATABASE_URL: `postgres://kolo:kolo@127.0.0.1:${pgPort}/kolo`, PORT: String(port), KOLO_HOST: "127.0.0.1", KOLO_PUBLIC_URL: url,
    KOLO_SERVER_KEY_FILE: join(directory, "server-key.json"), KOLO_ADMIN_PORT: "off", KOLO_LOG_LEVEL: "warn" };
  await execute(process.execPath, [server, "migrate"], { env });
  const code = parseConnectionCode((await execute(process.execPath, [server, "invite", "--label", "E2E shop"], { env })).stdout);
  assert.ok(code?.token, "invite printed a connection code with its single-use token");
  serverProcess = spawn(process.execPath, [server], { env, stdio: ["ignore", "pipe", "pipe"] });
  serverProcess.stdout.on("data", bytes => { serverLog += bytes; }); serverProcess.stderr.on("data", bytes => { serverLog += bytes; });
  let healthy = false;
  for (let attempt = 0; attempt < 60 && !healthy; attempt++) { try { healthy = (await fetch(`${url}/healthz`)).ok; } catch { await delay(250); } }
  assert.ok(healthy, "server did not become healthy");
  const transport = createHttpSyncTransport(url), identity = await previewServer(transport, sealingCrypto);
  assert.equal(identity.fingerprint, code.fingerprint, "the code pins the running server's key");

  step("Owner till: create the shop, attach it with the code, sell");
  ownerFiles = nodeWorkspaceFiles(join(directory, "owner"));
  ownerDatabase = ownerFiles.openActive(); migrate(ownerDatabase);
  const vault = new Map();
  const ports = { database: ownerDatabase, newId: randomUUIDv7, now: () => new Date().toISOString(), credentials: protectedCredentials({
    read: async key => vault.get(key), write: async (key, value) => { vault.set(key, value); }, forget: async key => { vault.delete(key); } }, credentialCrypto) };
  const installation = await createWorkspace({ businessName: "E2E shop", ownerName: "Owner", deviceLabel: "Owner till", platform: "DESKTOP", currency: "XAF", secret: ownerSecret }, ports);
  const owner = await unlockWorkspace({ userId: installation.ownerId, secret: ownerSecret }, ports);
  const account = paymentAccounts(owner).items[0].id, starter = randomUUIDv7(), at = () => new Date().toISOString();
  commands.saveProduct(owner, { id: starter, name: "E2E Starter", unit: "unit", currency: "XAF", sellingPriceMinor: 700, taxRateBasisPoints: 0, minimumStock: 0, divisible: false, active: true, createdAt: at(), updatedAt: at() });
  const sell = (productId, price) => commands.completeSale(owner, { id: randomUUIDv7(), number: `E2E-${randomUUIDv7()}`, eventId: randomUUIDv7(), occurredAt: at(),
    lines: [{ id: randomUUIDv7(), movementId: randomUUIDv7(), productId, name: "Line", unitPriceMinor: price, quantity: 1000 }], payments: [{ id: randomUUIDv7(), accountId: account, amountMinor: price }] });
  sell(starter, 700);
  const destination = await connectServer(owner, transport, { url, fingerprint: code.fingerprint, token: code.token }, sealingCrypto);
  const ownerSync = async () => { while (await sealPendingEvents(owner, sealingCrypto, 1000) === 1000) { /* Sign everything first. */ } return synchronizeServer(owner, destination, transport, sealingCrypto); };
  await ownerSync();

  step("Headless till: join by code; the owner allows it");
  kolo(["till", "init", "--state", tillState]);
  const start = await startJoin(owner, transport, sealingCrypto, { serverDeviceId: identity.server_device_id, url, fingerprint: code.fingerprint, authorityAllowed: false });
  assert.equal(kolo(["till", "join", "inspect", start.link]).json.businessName, "E2E shop");
  kolo(["till", "join", "request", start.link, "--state", tillState, "--label", "Automation"]);
  assert.equal(kolo(["till", "join", "complete", "--state", tillState]).json.pending, true, "waits for the owner");
  let candidate;
  for (let attempt = 0; attempt < 20 && candidate === undefined; attempt++) { candidate = await pollJoin(transport, sealingCrypto, start); if (candidate === undefined) await delay(250); }
  assert.equal(candidate?.label, "Automation");
  await approveJoin(owner, transport, sealingCrypto, ownerFiles, start, candidate);
  await endJoin(owner, transport, start, false);
  assert.equal(kolo(["till", "join", "complete", "--state", tillState]).json.paired, true);

  step("Both tills sync until the owner has granted the shop key");
  await ownerSync();
  kolo(["till", "connect", "--state", tillState]);
  let unlocked = false;
  for (let round = 0; round < 4 && !unlocked; round++) {
    const pass = kolo(["till", "sync", "--state", tillState], [0, 1]);
    unlocked = pass.status === 0;
    await ownerSync();
  }
  assert.ok(unlocked, "the headless till's facts were delivered once it held the shop key");
  assert.equal(kolo(["till", "report", "sales", "--state", tillState]).json.transactions, 1, "the owner's earlier sale reached the headless till");

  step("Headless till imports products; the owner receives them and sells one");
  const rice = randomUUIDv7(), oil = randomUUIDv7(), job = join(directory, "catalogue.json");
  writeFileSync(job, JSON.stringify({ id: randomUUIDv7(), rows: [
    { id: rice, name: "E2E Rice 25kg", unit: "bag", sellingPriceMinor: 18500, purchasePriceMinor: 16000, divisible: false },
    { id: oil, name: "E2E Oil 1L", unit: "bottle", sellingPriceMinor: 1500 } ] }));
  assert.equal(kolo(["till", "import", "products", job, "--state", tillState]).json.duplicate, false);
  assert.equal(kolo(["till", "import", "products", job, "--state", tillState]).json.duplicate, true, "a rerun is recognised");
  kolo(["till", "sync", "--state", tillState]);
  await ownerSync();
  assert.equal(ownerDatabase.get(`SELECT selling_price_minor AS p FROM products WHERE id=?`, [rice])?.["p"], 18500, "imported product reached the owner");
  sell(rice, 18500);
  await ownerSync();
  kolo(["till", "sync", "--state", tillState]);
  const sales = kolo(["till", "report", "sales", "--state", tillState]).json;
  assert.deepEqual({ transactions: sales.transactions, total: sales.totalMinor }, { transactions: 2, total: 19200 }, "the owner's new sale reached the headless till");

  step("The server holds no business record in the clear");
  const dump = (await execute("docker", ["exec", container, "pg_dump", "-U", "kolo", "kolo"], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  for (const secretText of ["E2E Rice", "E2E Oil", "E2E Starter", "18500"]) assert.equal(dump.includes(secretText), false, `server database contains "${secretText}"`);

  step("Both tills are consistent; the headless till's backup verifies");
  const ownerReport = checkIntegrity(ownerDatabase);
  assert.equal(ownerReport.consistent, true, JSON.stringify(ownerReport.issues));
  const backup = join(directory, "headless.kolo-backup.json");
  kolo(["till", "backup", "--state", tillState, "--out", backup]);
  assert.equal(kolo(["backup", "verify", backup]).json.businessName, "E2E shop");
  const tillReport = kolo(["check", "--backup", backup], [0, 1]).json;
  assert.equal(tillReport.consistent, true, JSON.stringify(tillReport.issues));
  process.stdout.write("End-to-end sync passed: real server, PostgreSQL, owner till and CLI headless till converge\n");
} catch (error) {
  process.stderr.write(`End-to-end sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
  if (serverLog.trim() !== "") process.stderr.write(`Server output:\n${serverLog.slice(-4000)}\n`);
  process.exitCode = 1;
} finally {
  serverProcess?.kill();
  try { ownerDatabase?.close(); ownerFiles?.close(); } catch { /* Already closed. */ }
  if (containerCreated) await execute("docker", ["rm", "--force", container]).catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
}
