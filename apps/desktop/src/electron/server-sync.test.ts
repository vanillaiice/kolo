import assert from "node:assert/strict";
import { closeConsistent } from "@kolo/core/data/database/integrity";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes, randomUUIDv7 } from "node:crypto";
import { createWorkspace, unlockWorkspace } from "@kolo/core/identity/workspace";
import { registerExchangeDestination } from "@kolo/core/application/exchange";
import { SyncTransportError, type SyncTransport } from "@kolo/core/application/server-sync";
import type { WorkspacePorts } from "@kolo/core/identity/types";
import { openDesktopDatabase } from "./database.ts";
import { DesktopApplication } from "./application.ts";
import { formatConnectionCode } from "@kolo/contracts/sync";
import { localCredentialsOnDesktop, desktopSealingCrypto, type NativeSafeStorage } from "./local-credentials.ts";
import { AutoSync } from "./server-sync.ts";
import { memoryPreferences } from "./preferences.ts";
import type { Result } from "../shared/service.ts";

function native(): NativeSafeStorage {
  const key = randomBytes(32);
  return { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async message => { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, cipher.update(message, "utf8"), cipher.final(), cipher.getAuthTag()]); },
    decryptStringAsync: async bytes => { const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return { result: Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"), shouldReEncrypt: false }; } };
}
/** Only the network is substituted: every call fails the way an unreachable or refusing server would. */
function failing(error: SyncTransportError, calls: string[]): SyncTransport {
  const fail = async (name: string): Promise<never> => { calls.push(name); throw error; };
  return { identity: () => fail("identity"), challenge: () => fail("challenge"), enroll: () => fail("enroll"), session: () => fail("session"), endSession: () => fail("endSession"),
    bootstrap: () => fail("bootstrap"), push: () => fail("push"), pull: () => fail("pull"), receipt: () => fail("receipt"), status: () => fail("status"), entitlements: () => fail("entitlements") };
}
async function fixture(transport: SyncTransport) {
  const directory = mkdtempSync(join(tmpdir(), "kolo-desktop-sync-")), database = openDesktopDatabase(join(directory, "shop.db"));
  const ports: WorkspacePorts = { database, credentials: localCredentialsOnDesktop(join(directory, "vault"), native()), newId: randomUUIDv7, now: () => "2026-10-11T12:00:00.000Z" };
  const application = new DesktopApplication(ports, desktopSealingCrypto, undefined, undefined, memoryPreferences(), () => transport);
  await application.initialize();
  const setup = value(await application.createShop({ businessName: "Shop", ownerName: "Owner", deviceLabel: "PC", cashAccountName: "Cash", secret: "654321" }));
  const sessionId = value(await application.unlock({ userId: setup.members[0]!.id, secret: "654321" })).sessionId!;
  return { application, sessionId, async dispose() { await application.dispose(); closeConsistent([database]); rmSync(directory, { recursive: true, force: true }); } };
}
function value<T>(result: Result<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error("unexpected failure"); return result.value; }

it("server commands validate connection codes and map network and refusal failures to stable codes", async () => {
  const calls: string[] = [], f = await fixture(failing(new SyncTransportError("network_unavailable", 0, true), calls));
  const valid = (url: string) => formatConnectionCode({ url, fingerprint: "a".repeat(32), token: "b".repeat(32) });
  try {
    assert.deepEqual(value(await f.application.serverState({ sessionId: f.sessionId })), { servers: [], canEnroll: true });
    assert.deepEqual(await f.application.checkServer({ sessionId: f.sessionId, code: "" }), { ok: false, error: { code: "invalid_input" } });
    for (const code of ["https://sync.example.com", "kolo://connect?u=https%3A%2F%2Fsync.example.com&f=short"]) assert.deepEqual(await f.application.checkServer({ sessionId: f.sessionId, code }), { ok: false, error: { code: "invalid_code" } });
    for (const url of ["http://sync.example.com", "ftp://host", "https://user:secret@host"]) assert.deepEqual(await f.application.checkServer({ sessionId: f.sessionId, code: valid(url) }), { ok: false, error: { code: "invalid_address" } });
    assert.equal(calls.length, 0, "a refused code or address never reaches the network");
    assert.deepEqual(await f.application.checkServer({ sessionId: f.sessionId, code: `Here is your code: ${valid("https://sync.example.com")} (single use)` }), { ok: false, error: { code: "server_unreachable" } });
    assert.deepEqual(await f.application.checkServer({ sessionId: f.sessionId, code: valid("https://sync.example.com"), extra: 1 }), { ok: false, error: { code: "invalid_input" } });
    assert.deepEqual(await f.application.checkServer({ sessionId: randomUUIDv7(), code: valid("https://sync.example.com") }), { ok: false, error: { code: "locked" } });
    assert.deepEqual(await f.application.syncServer({ sessionId: f.sessionId, destinationId: randomUUIDv7() }), { ok: false, error: { code: "invalid_input" } });
  } finally { await f.dispose(); }
  for (const code of ["connection_code_used", "connection_code_expired", "invalid_connection_code", "shop_suspended", "shop_removed", "hosted_service_inactive"]) {
    const refused = await fixture(failing(new SyncTransportError(code, 403, false), []));
    try { assert.deepEqual(await refused.application.checkServer({ sessionId: refused.sessionId, code: valid("https://sync.example.com") }), { ok: false, error: { code } }); }
    finally { await refused.dispose(); }
  }
});

it("background sync backs off after failures and never runs without a signed-in context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kolo-desktop-auto-")), database = openDesktopDatabase(join(directory, "shop.db"));
  try {
    const ports: WorkspacePorts = { database, credentials: localCredentialsOnDesktop(join(directory, "vault"), native()), newId: randomUUIDv7, now: () => "2026-10-11T12:00:00.000Z" };
    const install = await createWorkspace({ businessName: "Shop", ownerName: "Owner", deviceLabel: "PC", platform: "DESKTOP", currency: "XAF", secret: "654321" }, ports);
    const context = await unlockWorkspace({ userId: install.ownerId, secret: "654321" }, ports);
    // A server connected earlier; its address now fails like an unreachable network.
    const key = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey;
    const destination = registerExchangeDestination(context, { deviceId: randomUUIDv7(), publicKey: key, label: "Server", platform: "SERVER", kind: "server" });
    database.run(`INSERT INTO server_endpoints(destination_id,business_id,url,connected_at) VALUES (?,?,?,?)`, [destination, install.businessId, "https://sync.example.com", "2026-10-11T12:00:00.000Z"]);
    let now = 0; const calls: string[] = [];
    const transport = failing(new SyncTransportError("network_unavailable", 0, true), calls), auto = new AutoSync(desktopSealingCrypto, () => transport, () => now);
    await auto.tick(undefined); assert.equal(calls.length, 0, "locked: nothing runs");
    await auto.tick(context); assert.deepEqual(calls, ["challenge"]);
    await auto.tick(context); assert.equal(calls.length, 1, "the next pass waits");
    now += 59_000; await auto.tick(context); assert.equal(calls.length, 1, "backoff after a failure exceeds the regular minute");
    now += 2_000; await auto.tick(context); assert.equal(calls.length, 2);
    auto.soon(); now += 5_000; await auto.tick(context); assert.equal(calls.length, 3, "a local change brings the pass forward");
    assert.equal(database.get(`SELECT last_error FROM server_endpoints`)?.["last_error"], "network_unavailable");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
