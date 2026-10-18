import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7, generateKeyPairSync } from "node:crypto";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { protectedCredentials } from "@kolo/core/identity/credentials";
import { createWorkspace, unlockWorkspace } from "@kolo/core/identity/workspace";
import { createPairingInvite, confirmPairing, previewPairingRequest } from "@kolo/core/application/pairing";
import { previewBundle, importBundle, exchangeDestinations, exportBundle, exportReceipt } from "@kolo/core/application/file-exchange";
import { revokePermission } from "@kolo/core/identity/workspace";
import { initializeTill, TillState } from "./till-state.ts";
import { transferCrypto, credentialCrypto, sealingCrypto } from "./crypto.ts";
import { runTill } from "./till.ts";
import { run } from "./cli.ts";
import { importData } from "./till-import.ts";
import { startJoin, pollJoin, approveJoin } from "@kolo/core/application/join";
import { registerExchangeDestination } from "@kolo/core/application/exchange";
import { keyFingerprint, shareServerEndpoint, type SyncTransport } from "@kolo/core/application/server-sync";
import type { JoinOffer, JoinRequestBody, JoinEnrollment } from "@kolo/contracts/sync";

const secret = "654321", password = "test-till-backup-password";
const env = { KOLO_TILL_SECRET: secret, KOLO_BACKUP_PASSWORD: password };
async function owner(directory: string) {
  const files = nodeWorkspaceFiles(directory), database = files.openActive(); migrate(database);
  const vault = new Map<string, string>();
  const ports = { database, newId: randomUUIDv7, now: () => new Date().toISOString(), credentials: protectedCredentials({
    read: async key => vault.get(key), write: async (key, value) => { vault.set(key, value); }, forget: async key => { vault.delete(key); },
  }, credentialCrypto) };
  const installation = await createWorkspace({ businessName: "Owner shop", ownerName: "Owner", secret, currency: "XAF", deviceLabel: "Desktop", platform: "DESKTOP" }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  return { files, database, ports, context, installation };
}

test("headless till pairs across restarts, imports atomically, signs, exchanges, and checks permissions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-till-test-")), state = join(directory, "till");
  const source = await owner(join(directory, "owner"));
  let output = ""; const stdout = (text: string): void => { output += text; };
  const invoke = async (args: string[]): Promise<number> => { output = ""; return runTill(args, env, stdout); };
  const file = (name: string, value: unknown): string => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value)); return path; };
  try {
    await invoke(["init", "--state", state]);
    const invite = await createPairingInvite(source.context, transferCrypto);
    const invitePath = join(directory, "invite.json"); writeFileSync(invitePath, invite.bytes);
    await invoke(["pair", "inspect", invitePath]); const fingerprint = JSON.parse(output).fingerprint as string;
    const requestPath = join(directory, "request.json");
    await assert.rejects(invoke(["pair", "request", invitePath, "--state", state, "--fingerprint", "0".repeat(32), "--label", "Automation", "--out", requestPath]), /confirmation_required/);
    await invoke(["pair", "request", invitePath, "--state", state, "--fingerprint", fingerprint, "--label", "Automation", "--out", requestPath]);
    const request = new Uint8Array(readFileSync(requestPath)), code = (await previewPairingRequest(request, transferCrypto)).verificationCode;
    const enrollment = await confirmPairing(source.context, request, code, password, source.files, transferCrypto);
    const enrollmentPath = join(directory, "shop.kolo-enrollment"); writeFileSync(enrollmentPath, enrollment.bytes);
    const pendingPairPath = join(state, "vault", "kolo.cli.pair"), pendingPairBytes = readFileSync(pendingPairPath);
    await invoke(["pair", "complete", enrollmentPath, "--state", state, "--code", code]);
    // Simulate activation succeeding just before the process lost its response/cleanup.
    writeFileSync(pendingPairPath, pendingPairBytes, { mode: 0o600 });
    await invoke(["pair", "complete", enrollmentPath, "--state", state, "--code", code]); assert.equal(JSON.parse(output).paired, true);
    await invoke(["status", "--state", state]);
    assert.equal(JSON.parse(output).installation.businessId, source.installation.businessId);
    const deviceId = JSON.parse(output).installation.deviceId as string;
    assert.notEqual(deviceId, source.installation.deviceId);
    const oversizedSecret = join(directory, "oversized-secret"); writeFileSync(oversizedSecret, "x".repeat(4097));
    const oversizedOutput = join(directory, "oversized.kolo-backup");
    await assert.rejects(invoke(["backup", "--state", state, "--secret-file", oversizedSecret, "--out", oversizedOutput]), /4 KB/);
    await assert.rejects(invoke(["backup", "--state", state, "--password-file", oversizedSecret, "--out", oversizedOutput]), /4 KB/);
    assert.equal(existsSync(oversizedOutput), false);
    const productId = randomUUIDv7(), jobId = randomUUIDv7();
    const productPath = file("products.json", { id: jobId, rows: [{ id: productId, name: "Rice", unit: "bag", sellingPriceMinor: 500, purchasePriceMinor: 300, barcode: "b".repeat(256) }] });
    await invoke(["import", "products", productPath, "--state", state]); assert.equal(JSON.parse(output).duplicate, false);
    await invoke(["import", "products", productPath, "--state", state]); assert.equal(JSON.parse(output).duplicate, true);
    await invoke(["export", "products", "--state", state]); assert.equal(JSON.parse(output).length, 1);
    assert.equal(JSON.parse(output)[0].sellingPriceMinor, 500);
    assert.equal(JSON.parse(output)[0].barcode.length, 256);
    const longBarcode = file("long-barcode.json", { id: randomUUIDv7(), rows: [{ id: productId, barcode: "b".repeat(257) }] });
    await assert.rejects(invoke(["import", "products", longBarcode, "--state", state]), /Invalid barcode/);
    const altered = file("altered.json", { id: jobId, rows: [{ id: productId, name: "Rice", unit: "bag", sellingPriceMinor: 999 }] });
    await assert.rejects(invoke(["import", "products", altered, "--state", state]), /different content/);
    const stockJob = file("stock.json", { id: randomUUIDv7(), rows: [{ id: productId, quantityThousandths: 10000, reason: "Supplier delivery adjustment" }] });
    await invoke(["import", "stock", stockJob, "--state", state]);
    await invoke(["import", "stock", stockJob, "--state", state]); assert.equal(JSON.parse(output).duplicate, true);
    const badJob = file("bad.json", { id: randomUUIDv7(), rows: [{ id: productId, quantityThousandths: 1000, reason: "Adjustment" }, { id: randomUUIDv7(), quantityThousandths: 1000, reason: "Missing product" }] });
    await assert.rejects(invoke(["import", "stock", badJob, "--state", state]), /Unknown product/);
    const priceJob = file("prices.json", { id: randomUUIDv7(), rows: [{ id: productId, sellingPriceMinor: 650 }] });
    await invoke(["import", "prices", priceJob, "--state", state]);
    await invoke(["peers", "--state", state]); const destination = JSON.parse(output).peers[0].id as string;
    const bundlePath = join(directory, "batch.kolo-exchange");
    await invoke(["exchange", "export", "--state", state, "--destination", destination, "--out", bundlePath]);
    const preview = await previewBundle(source.context, new Uint8Array(readFileSync(bundlePath)), password, transferCrypto);
    const outcomes = await importBundle(source.context, preview, transferCrypto);
    assert.ok(outcomes.every(item => ["applied", "duplicate"].includes(item.outcome)));
    const receipt = await exportReceipt(source.context, preview.batchId, password, transferCrypto);
    assert.ok(receipt); const receiptPath = join(directory, "batch.kolo-receipt"); writeFileSync(receiptPath, receipt.bytes);
    await invoke(["exchange", "acknowledge", receiptPath, "--state", state, "--destination", destination]);
    assert.ok(JSON.parse(output).acknowledged > 0);
    assert.equal(source.database.get("SELECT selling_price_minor FROM products WHERE id=?", [productId])!["selling_price_minor"], 650);
    assert.equal(source.database.get("SELECT sum(quantity) AS n FROM inventory_movements WHERE product_id=?", [productId])!["n"], 10000);
    const till = new TillState(state);
    try {
      assert.throws(() => new TillState(state), /busy/);
      assert.equal(till.database.get("SELECT count(*) AS n FROM event_journal e LEFT JOIN event_signatures s ON s.event_id=e.event_id WHERE e.origin_device_id=? AND s.event_id IS NULL", [deviceId])!["n"], 0);
      assert.equal(till.database.get("SELECT count(*) AS n FROM local_audit WHERE device_id=? AND action='PRODUCT_SAVED'", [deviceId])!["n"], 2);
      const context = await till.unlock(secret);
      // An applied journal marker still recognizes a committed import after loss of the printed response.
      assert.equal((await importData(till, "stock", JSON.parse(readFileSync(stockJob, "utf8")), secret)).duplicate, true);
      assert.ok(context.deviceId === deviceId);
    } finally { till.close(); }
    const vaultFiles = readdirSync(join(state, "vault"));
    for (const entry of vaultFiles) assert.equal(readFileSync(join(state, "vault", entry)).includes(Buffer.from("PRIVATE KEY")), false);
    const liveBackup = join(directory, "live.kolo-backup");
    await invoke(["backup", "--state", state, "--out", liveBackup]);
    assert.equal(await run(["backup", "verify", liveBackup], env, stdout), 0);
    // Owner changes authority; exchange imports those changes before the next write.
    revokePermission(source.context, source.installation.ownerId, "products.price");
    const sourceDestination = exchangeDestinations(source.context).find(peer => peer.deviceId === deviceId)!.id;
    const authority = await exportBundle(source.context, sourceDestination, password, transferCrypto);
    assert.ok(authority); const authorityPath = join(directory, "authority.kolo-exchange"); writeFileSync(authorityPath, authority.bytes);
    await invoke(["exchange", "import", authorityPath, "--state", state]);
    const denied = file("denied.json", { id: randomUUIDv7(), rows: [{ id: productId, sellingPriceMinor: 700 }] });
    await assert.rejects(invoke(["import", "prices", denied, "--state", state]), /permission_denied/);
    await invoke(["export", "products", "--state", state]); assert.equal(JSON.parse(output)[0].sellingPriceMinor, 650);
    const interruptedJob = { id: randomUUIDv7(), rows: [{ id: productId, quantityThousandths: 2000, reason: "Signature retry" }] };
    const interrupted = new TillState(state);
    try {
      interrupted.credentials.sign = async () => { throw new Error("Native signing unavailable"); };
      await assert.rejects(importData(interrupted, "stock", interruptedJob, secret), /invalid_signature/);
    } finally { interrupted.close(); }
    const resumed = new TillState(state);
    try {
      assert.equal((await importData(resumed, "stock", interruptedJob, secret)).duplicate, true);
      assert.equal(resumed.database.get("SELECT sum(quantity) AS n FROM inventory_movements WHERE product_id=?", [productId])!["n"], 12000);
      assert.equal(resumed.database.get("SELECT count(*) AS n FROM event_journal e LEFT JOIN event_signatures s ON s.event_id=e.event_id WHERE e.origin_device_id=? AND s.event_id IS NULL", [deviceId])!["n"], 0);
    } finally { resumed.close(); }
  } finally { source.database.close(); source.files.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("till state refuses unrelated directories, shared permissions, symlinks and extra flags", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-till-test-"));
  try {
    const foreign = join(directory, "desktop"); mkdirSync(foreign); writeFileSync(join(foreign, "kolo.db"), "desktop data");
    assert.throws(() => initializeTill(foreign), /empty/);
    await assert.rejects(runTill(["status", "--state", foreign], env, () => undefined));
    const state = join(directory, "state"); initializeTill(state);
    if (process.platform !== "win32") {
      chmodSync(join(state, "vault.key"), 0o644); assert.throws(() => new TillState(state), /owner-only/);
      chmodSync(join(state, "vault.key"), 0o600);
      mkdirSync(join(state, "data"), { mode: 0o700 }); symlinkSync(join(foreign, "kolo.db"), join(state, "data", "kolo.db"));
      assert.throws(() => new TillState(state), /regular files/);
    }
    assert.equal(existsSync(join(state, "process.lock")), false);
    await assert.rejects(runTill(["init", "--state", state, "--db", foreign], env, () => undefined));
    assert.equal(readFileSync(join(foreign, "kolo.db"), "utf8"), "desktop data");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("join-by-code resumes across commands, pins the server and uses the shared sync connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-till-join-test-")), state = join(directory, "till");
  const source = await owner(join(directory, "owner"));
  const pair = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const serverId = randomUUIDv7(), fingerprint = await keyFingerprint(pair.publicKey, transferCrypto);
  const url = "http://localhost:4010";
  let offer: JoinOffer | undefined, request: JoinRequestBody | null = null, answer: JoinEnrollment | null = null;
  let pushes = 0, ended = 0;
  const expires = new Date(Date.now() + 3600000).toISOString();
  const implementation: Partial<SyncTransport> = {
    identity: async () => ({ api_version: 2, server_device_id: serverId, public_key: pair.publicKey, fingerprint, enrollment_open: false }),
    challenge: async () => ({ challenge_id: randomUUIDv7(), nonce: "a".repeat(64), expires_at: expires }),
    session: async ({ claim }) => ({ token: "a".repeat(43), expires_at: expires, business_id: claim.business_id, device_id: claim.device_id, server_device_id: serverId }),
    endSession: async () => { ended++; },
    joinCreate: async (_token, body) => { offer = body; return { expires_at: expires }; },
    joinRead: async () => { assert.ok(offer); return offer; },
    joinRequest: async (_id, body) => { request = body; },
    joinPollRequest: async () => request,
    joinEnroll: async (_token, _id, body) => { answer = body; },
    joinPollEnrollment: async () => answer,
    entitlements: async () => ({ status: "unlimited", paid_until: null, grace_until: null }),
    push: async (_token, batch) => {
      pushes++;
      assert.ok(batch.batch.events.every(event => "sealed" in event || ["DEVICE_ENCRYPTION_KEY", "DEVICE_TRUSTED", "SHOP_KEY_GRANTED", "SERVER_ENDPOINT_SET"].includes(event.clear.envelope.event_type)));
      return { results: batch.batch.events.map(event => ({ event_id: "sealed" in event ? event.sealed.event_id : event.clear.envelope.event_id, status: "stored" })), receipt: null };
    },
    pull: async () => ({ batch: null, cursor: null, has_more: false }),
  };
  const transport = new Proxy(implementation, { get(target, property) { if (property === "then") return undefined; if (property in target) return target[property as keyof SyncTransport]; return () => { throw new Error(`Unexpected transport call ${String(property)}`); }; } }) as SyncTransport;
  let output = ""; const stdout = (text: string): void => { output += text; };
  const invoke = async (args: string[]): Promise<number> => { output = ""; return runTill(args, env, stdout, () => transport); };
  try {
    registerExchangeDestination(source.context, { deviceId: serverId, publicKey: pair.publicKey, label: "Server", platform: "SERVER", kind: "server" });
    shareServerEndpoint(source.context, { serverDeviceId: serverId, url, fingerprint });
    const start = await startJoin(source.context, transport, sealingCrypto, { serverDeviceId: serverId, url, fingerprint, authorityAllowed: false });
    await invoke(["init", "--state", state]);
    await invoke(["join", "inspect", start.link]); assert.equal(JSON.parse(output).businessName, "Owner shop");
    await assert.rejects(invoke(["join", "request", start.code, "--url", url, "--fingerprint", "0".repeat(32), "--state", state, "--label", "Automation"]), /fingerprint_mismatch/);
    await invoke(["join", "request", start.link, "--state", state, "--label", "Automation"]);
    await invoke(["join", "complete", "--state", state]); assert.equal(JSON.parse(output).pending, true);
    const candidate = await pollJoin(transport, sealingCrypto, start); assert.ok(candidate); assert.equal(candidate.label, "Automation");
    await approveJoin(source.context, transport, sealingCrypto, source.files, start, candidate);
    const pendingJoinPath = join(state, "vault", "kolo.cli.join"), pendingJoinBytes = readFileSync(pendingJoinPath);
    await invoke(["join", "complete", "--state", state]); assert.equal(JSON.parse(output).paired, true);
    writeFileSync(pendingJoinPath, pendingJoinBytes, { mode: 0o600 });
    await invoke(["join", "complete", "--state", state]); assert.equal(JSON.parse(output).paired, true);
    await invoke(["connect", "--state", state]); assert.ok(JSON.parse(output).destinationId);
    assert.equal(await invoke(["sync", "--state", state]), 1);
    assert.ok(JSON.parse(output)[0].locked > 0, "Business events wait for an owner-granted shop key");
    assert.ok(pushes > 0); assert.ok(ended > 0);
    await invoke(["peers", "--state", state]); assert.equal(JSON.parse(output).servers[0].fingerprint, fingerprint);
  } finally { source.database.close(); source.files.close(); rmSync(directory, { recursive: true, force: true }); }
});
