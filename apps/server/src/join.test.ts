import assert from "node:assert/strict";
import { after, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { closeConsistent } from "@kolo/core/data/database/integrity";
import type { Database } from "@kolo/core/data/database/driver";
import { unlockWorkspace } from "@kolo/core/identity/workspace";
import type { WorkspacePorts } from "@kolo/core/identity/types";
import { approveJoin, endJoin, finishJoin, joinIdOf, joinPending, lookupJoin, pollJoin, prepareJoinEnrollment, requestJoin, startJoin } from "@kolo/core/application/join";
import { decryptTransfer, isTransferContainer } from "@kolo/core/backup/encryption";
import { transferFileFromText } from "@kolo/core/backup/file-kind";
import { canonicalJson } from "@kolo/contracts/canonical";
import { deflateRawSync } from "node:zlib";
import { connectServer, pendingShopServer, synchronizeServer, SyncTransportError } from "@kolo/core/application/server-sync";
import { shopKeys } from "@kolo/core/application/sealed-sync";
import { protectedCredentials } from "@kolo/core/identity/credentials";
import { normalizeJoinCode, parseJoinLink } from "@kolo/contracts/sync";
import { at, cleanup, connect, count, credentialCrypto, crypto, memoryVault, owner, paired, product, query, sale, started, sync } from "./sync.fixtures.js";

const skip = false, directories: string[] = [], databases: Database[] = [];
const workspaces: ReturnType<typeof nodeWorkspaceFiles>[] = [];
after(async () => {
  try { await cleanup(); }
  finally {
    try { closeConsistent(databases); }
    finally {
      for (const files of workspaces) files.close();
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  }
});
function scratch(): string { const directory = mkdtempSync(join(tmpdir(), "kolo-join-")); directories.push(directory); return directory; }
function workspaceFiles(): ReturnType<typeof nodeWorkspaceFiles> {
  const files = nodeWorkspaceFiles(scratch()); workspaces.push(files); return files;
}
/** A brand-new, empty till with the real credential vault and real snapshot files. */
function emptyTill() {
  const files = workspaceFiles(), database = files.openActive();
  databases.push(database);
  migrate(database);
  const ports: WorkspacePorts = { database, credentials: protectedCredentials(memoryVault(), credentialCrypto), newId: randomUUIDv7, now: () => at };
  return { files, ports };
}

it("a new till joins by code through the server and syncs, with no file, fingerprint or password", { skip }, async () => {
  const target = await started(), a = await owner("Boutique du Code"), p = product(a, "Riz parfumé");
  sale(a, p);
  await connect(a, target); await sync(a, target);
  const ownerFiles = workspaceFiles();
  const start = await startJoin(a.context, target.transport, crypto, { serverDeviceId: target.key.deviceId, url: target.url, fingerprint: target.key.fingerprint, authorityAllowed: false });
  assert.match(start.display, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/);
  assert.equal(normalizeJoinCode(start.display.toLowerCase().replace(/0/g, "o")), start.code, "typing is forgiving");
  assert.deepEqual(parseJoinLink(start.link), { url: target.url, fingerprint: target.key.fingerprint, code: start.code });
  const stored = JSON.stringify(await query(target, `SELECT * FROM join_sessions`));
  assert.equal(stored.includes(start.code), false, "the server never holds the code");

  const b = emptyTill();
  await assert.rejects(lookupJoin(target.transport, crypto, "0000000000"), (error: unknown) => error instanceof SyncTransportError && error.code === "join_not_found");
  const invitation = await lookupJoin(target.transport, crypto, start.code);
  assert.equal(invitation.businessName, "Boutique du Code");
  await requestJoin(start.code, invitation, { label: "Téléphone", platform: "ANDROID", secret: "582914" }, b.ports, target.transport, crypto);
  await requestJoin(start.code, invitation, { label: "Téléphone", platform: "ANDROID", secret: "582914" }, b.ports, target.transport, crypto); // An interrupted request repeats harmlessly.
  assert.equal(joinPending(b.ports.database), true);
  assert.equal(await finishJoin(start.code, b.ports, b.files, target.transport, crypto), undefined, "waiting for the owner");

  const candidate = await pollJoin(target.transport, crypto, start);
  assert.equal(candidate?.label, "Téléphone"); assert.equal(candidate?.platform, "ANDROID");
  await approveJoin(a.context, target.transport, crypto, ownerFiles, start, candidate!);
  await endJoin(a.context, target.transport, start, false);
  const carried = String((await query(target, `SELECT enrollment FROM join_sessions`))[0].enrollment);
  assert.equal(carried.includes("Riz parfumé"), false, "the shop file on the server is encrypted");
  assert.match(carried, /^[A-Za-z0-9+/]+={0,2}$/, "the mailbox carries the binary container as base64");
  assert.ok(isTransferContainer(transferFileFromText(carried, crypto)));

  const joined = await finishJoin(start.code, b.ports, b.files, target.transport, crypto);
  assert.ok(joined !== undefined);
  databases.push(joined.database);
  assert.equal(joined.database.get(`SELECT name FROM businesses`)?.["name"], "Boutique du Code");
  assert.equal(Number(joined.database.get(`SELECT count(*) AS n FROM sales`)!["n"]), 1, "the shop's history arrived");
  // Signed in, the new till follows the owner's server address on its own and receives the shop key.
  const portsB: WorkspacePorts = { ...b.ports, database: joined.database }, contextB = await unlockWorkspace({ userId: a.install.ownerId, secret: "582914" }, portsB);
  await sync(a, target); // The owner's till publishes its approval of the new till.
  const shared = pendingShopServer(contextB);
  assert.deepEqual(shared, { url: target.url, fingerprint: target.key.fingerprint, serverDeviceId: target.key.deviceId });
  const destination = await connectServer(contextB, target.transport, { ...shared!, source: "shop" }, crypto);
  for (let round = 0; round < 2; round++) { await synchronizeServer(contextB, destination, target.transport, crypto); await sync(a, target); }
  assert.equal((await shopKeys(contextB, crypto)).length, 1);
  sale(a, p); await sync(a, target); await synchronizeServer(contextB, destination, target.transport, crypto);
  assert.equal(Number(joined.database.get(`SELECT count(*) AS n FROM sales`)!["n"]), 2, "new sales arrive by sync");
  void count; void paired;
});

it("a JSON enrollment as releases before ADR-035 sent it is refused and installs nothing", { skip }, async () => {
  const target = await started(), a = await owner("Boutique ancienne"), p = product(a, "Mil");
  sale(a, p); await connect(a, target); await sync(a, target);
  const start = await startJoin(a.context, target.transport, crypto, { serverDeviceId: target.key.deviceId, url: target.url, fingerprint: target.key.fingerprint, authorityAllowed: false });
  const b = emptyTill(), invitation = await lookupJoin(target.transport, crypto, start.code);
  await requestJoin(start.code, invitation, { label: "Caisse 2", platform: "DESKTOP", secret: "582914" }, b.ports, target.transport, crypto);
  const candidate = (await pollJoin(target.transport, crypto, start))!;
  // Capture the random enrollment password, then re-wrap the same snapshot as releases before ADR-035 wrote it.
  let secret = "";
  const capturing = { ...crypto, randomHex: (bytes: number) => { const value = crypto.randomHex(bytes); if (bytes === 32 && secret === "") secret = value; return value; } };
  const current = await prepareJoinEnrollment(a.context, capturing, workspaceFiles(), start, candidate);
  const plain = await decryptTransfer(transferFileFromText(current.enrollment, crypto), "enrollment", secret, crypto), compressed = new Uint8Array(deflateRawSync(plain));
  const header = { format: "kolo.encrypted", format_version: 2, purpose: "enrollment", file_id: randomUUIDv7(), cipher: "AES-256-GCM", kdf: "PBKDF2-SHA256", iterations: 600000,
    salt: crypto.randomHex(32), nonce: crypto.randomHex(12), compression: "deflate", plaintext_bytes: compressed.byteLength, content_bytes: plain.byteLength };
  const sealed = await crypto.encrypt(await crypto.derive(secret, header.salt, 600000), header.nonce, compressed, canonicalJson(header));
  const legacy = canonicalJson({ header, ...sealed }, 64 * 1024 * 1024);
  // The mailbox MAC as join.ts defines it: HMAC under an HKDF key from the code, over the carried text's digest and the sealed password.
  const key = await crypto.hkdf(Buffer.from(start.code, "utf8").toString("hex"), "", "kolo.join-mac.v1", 32);
  const mac = await crypto.hmac(key, `kolo.join.enrollment.v1\u0000${await crypto.sha256(legacy)}\u0000${canonicalJson(current.sealed_password)}`);
  await target.transport.joinEnroll(start.token, start.joinId, { enrollment: legacy, sealed_password: current.sealed_password, mac });
  // The MAC is genuine, so only the format check stops it.
  await assert.rejects(finishJoin(start.code, b.ports, b.files, target.transport, crypto), (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_file");
  assert.equal(b.ports.database.get(`SELECT id FROM businesses`), undefined);
  assert.equal(joinPending(b.ports.database), true, "the till can still finish once the owner sends a current file");
});

it("a wrong code, a swapped invite, a forged request or a refused join never installs anything", { skip }, async () => {
  const target = await started(), a = await owner(), b = await paired(a, "No authority");
  await connect(a, target); await sync(a, target);
  // Only an authority till can open a mailbox.
  b.destination = await connectServer(b.context, target.transport, { url: target.url, fingerprint: target.key.fingerprint }, crypto);
  await assert.rejects(startJoin(b.context, target.transport, crypto, { serverDeviceId: target.key.deviceId, url: target.url, fingerprint: target.key.fingerprint, authorityAllowed: false }));
  const start = await startJoin(a.context, target.transport, crypto, { serverDeviceId: target.key.deviceId, url: target.url, fingerprint: target.key.fingerprint, authorityAllowed: true });
  // A server (or anyone) replacing the invite's tag is detected by the new till.
  await query(target, `UPDATE join_sessions SET offer = jsonb_set(offer, '{mac}', to_jsonb(repeat('0',64)))`);
  await assert.rejects(lookupJoin(target.transport, crypto, start.code), /authentication_failed/);
  await endJoin(a.context, target.transport, start, true);
  // A request not made with the code is refused by the owner's till.
  const second = await startJoin(a.context, target.transport, crypto, { serverDeviceId: target.key.deviceId, url: target.url, fingerprint: target.key.fingerprint, authorityAllowed: false });
  const c = emptyTill(), invitation = await lookupJoin(target.transport, crypto, second.code);
  await requestJoin(second.code, invitation, { label: "Till C", platform: "ANDROID", secret: "135790" }, c.ports, target.transport, crypto);
  await query(target, `UPDATE join_sessions SET request = jsonb_set(request, '{mac}', to_jsonb(repeat('1',64)))`);
  await assert.rejects(pollJoin(target.transport, crypto, second), /authentication_failed/);
  // Refusing removes the mailbox: the waiting till is told the code is gone and nothing is installed.
  await endJoin(a.context, target.transport, second, true);
  await assert.rejects(finishJoin(second.code, c.ports, c.files, target.transport, crypto), (error: unknown) => error instanceof SyncTransportError && error.code === "join_not_found");
  assert.equal(c.ports.database.get(`SELECT count(*) AS n FROM businesses`)!["n"], 0);
  assert.equal(Number((await query(target, `SELECT count(*)::int AS n FROM join_sessions`))[0].n), 0);
  assert.equal(await joinIdOf(second.code, crypto) === second.joinId, true);
});
