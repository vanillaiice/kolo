import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { generateKeyPairSync, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { memorySecretStore, type SecretStore } from "../data/auth/secure-store.ts";
import type { AuthTransport } from "../data/auth/login.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate } from "../data/database/migrations.ts";
import type { Database } from "../data/database/driver.ts";
import { protectedCredentials, validateLocalSecret, CREDENTIAL_ITERATIONS, type CredentialCrypto } from "./credentials.ts";
import { adoptLegacyWorkspace, createWorkspace, currentInstallation, recoverWorkspaceSetup, unlockWorkspace, lockWorkspace, resumeWorkspaceProvisioning, grantPermission } from "./workspace.ts";
import { recoverOwnerAccess, resumeOwnerRecovery, ownerRecoveryCode, setMemberActive } from "./recovery.ts";
import { createLocalMember, listLocalMembers, resumeMemberProvisioning, resetLocalMemberCredential } from "./members.ts";
import { dashboard, lowStock } from "../application/reports.ts";
import { WorkspaceError, type WorkspacePorts, type CredentialPort } from "./types.ts";

const SECRET = "654321", NEXT_SECRET = "765432", AT = "2026-10-06T09:00:00.000Z";
let database: Database, ports: WorkspacePorts, credentials: CredentialPort, store: ReturnType<typeof memorySecretStore>, now: string, sequence: number;
const crypto: CredentialCrypto = {
  randomHex: bytes => randomBytes(bytes).toString("hex"),
  derive: (secret, salt, iterations) => new Promise((resolve, reject) => {
    pbkdf2(secret, Buffer.from(salt, "hex"), iterations, 32, "sha256", (error, key) => error === null ? resolve(key.toString("hex")) : reject(error));
  }),
  equalHex: (a, b) => /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
  deviceKey: async () => generateKeyPairSync("ed25519", { publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" } }),
};
function id(): string { return `00000000-0000-7000-8000-${String(++sequence).padStart(12, "0")}`; }
function code(value: string): (error: unknown) => boolean { return error => error instanceof WorkspaceError && error.code === value; }
function advance(): void { now = new Date(Date.parse(now) + 61_000).toISOString(); }
async function setup() {
  const installation = await createWorkspace({ businessName: "Shop", ownerName: "Owner", currency: "XAF", deviceLabel: "Till", platform: "ANDROID", secret: SECRET }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret: SECRET }, ports);
  return { installation, context };
}
beforeEach(() => { database = openDatabase(); migrate(database); store = memorySecretStore(); credentials = protectedCredentials(store, crypto); now = AT; sequence = 0;
  ports = { database, credentials, newId: id, now: () => now }; });
afterEach(() => database.close());

describe("protected native credential contract", () => {
  it("uses the configured expensive KDF, unique salts, Ed25519 keys and protected references with no raw PIN", async () => {
    const calls: number[] = [];
    const port = protectedCredentials(store, { ...crypto, derive: async (secret, salt, iterations) => { calls.push(iterations); return await crypto.derive(secret, salt, iterations); } });
    const request = { installationId: id(), businessId: id(), userId: id(), deviceId: id(), secret: SECRET };
    const material = await port.provision(request);
    assert.match(material.publicKey, /BEGIN PUBLIC KEY/);
    assert.equal(await port.verify(material.credentialReference, SECRET), true);
    assert.equal(await port.verify(material.credentialReference, "000000"), false);
    const record = JSON.parse((await store.read(material.credentialReference))!);
    assert.equal(record.salt.length, 32); assert.equal(record.verifier.length, 64); assert.notEqual(record.salt, record.recoverySalt);
    assert.equal(record.secret, undefined); assert.equal(Object.values(record).includes(SECRET), false);
    assert.deepEqual(new Set(calls), new Set([CREDENTIAL_ITERATIONS]));
    assert.equal(JSON.stringify(material).includes(record.privateKey), false);
    assert.equal(JSON.stringify(material).includes(record.verifier), false);
  });
  it("never replaces an existing verifier/key on retries or wrong PIN", async () => {
    const request = { installationId: id(), businessId: id(), userId: id(), deviceId: id(), secret: SECRET };
    const original = await credentials.provision(request);
    assert.deepEqual(await credentials.provision(request), original);
    await assert.rejects(credentials.provision({ ...request, secret: NEXT_SECRET }), code("invalid_credential"));
    assert.equal(await credentials.verify(original.credentialReference, SECRET), true);
    assert.deepEqual(await credentials.inspect(request.installationId), original);
  });
  it("handles record-written/manifest-missing native crashes without replacing keys", async () => {
    const failing: SecretStore = { ...store, write: async (key, value) => { if (key.endsWith(".manifest")) throw new Error("native manifest fail"); await store.write(key, value); } };
    const request = { installationId: id(), businessId: id(), userId: id(), deviceId: id(), secret: SECRET };
    await assert.rejects(protectedCredentials(failing, crypto).provision(request));
    assert.equal(await credentials.inspect(request.installationId), undefined);
    const recordCount = store.size();
    await credentials.provision(request);
    assert.equal(store.size(), recordCount + 1);
    assert.notEqual(await credentials.inspect(request.installationId), undefined);
  });
  it("fails closed on missing/corrupt native records and bounds local PIN/password strength", async () => {
    assert.throws(() => validateLocalSecret("1234"), code("invalid_input"));
    assert.throws(() => validateLocalSecret("short"), code("invalid_input"));
    validateLocalSecret("123456"); validateLocalSecret("a long passphrase");
    await assert.rejects(credentials.verify("missing", SECRET), code("credential_unavailable"));
    await store.write("bad", '{"version":2}');
    await assert.rejects(credentials.verify("bad", SECRET), code("credential_unavailable"));
  });
});

describe("owner recovery and local staff", () => {
  it("secondary-device PIN recovery remains local and cannot invent authority revisions", async () => {
    const { installation, context }=await setup();
    database.run(`UPDATE trusted_exchange_devices SET authority_allowed=0 WHERE device_id=?`,[installation.deviceId]);
    const recovery=await ownerRecoveryCode(context,SECRET);assert.ok(recovery);
    const before=database.get(`SELECT revision FROM local_memberships WHERE user_id=?`,[installation.ownerId])!["revision"],facts=database.get(`SELECT count(*) AS n FROM event_journal`)!["n"];
    await recoverOwnerAccess({recoveryCode:recovery,newSecret:NEXT_SECRET},ports);
    const next=await unlockWorkspace({userId:installation.ownerId,secret:NEXT_SECRET},ports);
    assert.equal(database.get(`SELECT revision FROM local_memberships WHERE user_id=?`,[installation.ownerId])!["revision"],before);
    assert.equal(database.get(`SELECT count(*) AS n FROM event_journal`)!["n"],facts);
    assert.equal(database.get(`SELECT action FROM local_audit ORDER BY sequence DESC LIMIT 1`)!["action"],"OWNER_LOCAL_ACCESS_RECOVERED");
    await assert.rejects(createLocalMember(next,{name:"Unauthorized",role:"CASHIER",secret:SECRET}),code("permission_denied"));
  });
  it("restores access after PIN lockout using independent recovery proof and rotates both PIN/reference/code", async () => {
    const { installation, context } = await setup();
    const recovery = await ownerRecoveryCode(context, SECRET); assert.equal(recovery?.length, 64);
    lockWorkspace(database);
    database.run(`UPDATE local_memberships SET failures = 10`);
    await assert.rejects(unlockWorkspace({ userId: installation.ownerId, secret: SECRET }, ports), code("recovery_required"));
    await recoverOwnerAccess({ recoveryCode: recovery!, newSecret: NEXT_SECRET }, ports);
    assert.equal(currentInstallation(database).state, "locked");
    await assert.rejects(unlockWorkspace({ userId: installation.ownerId, secret: SECRET }, ports), code("invalid_credential"));
    advance();
    const recovered = await unlockWorkspace({ userId: installation.ownerId, secret: NEXT_SECRET }, ports);
    assert.notEqual(await ownerRecoveryCode(recovered, NEXT_SECRET), recovery);
    assert.equal(database.get(`SELECT failures FROM local_memberships`)?.["failures"], 0);
    assert.equal(database.get(`SELECT action FROM local_audit ORDER BY sequence DESC LIMIT 1`)?.["action"], "OWNER_ACCESS_RECOVERED");
  });
  it("denies invalid recovery codes, throttles before another expensive derivation and changes no authority", async () => {
    const { installation } = await setup();
    const original = database.get(`SELECT credential_reference FROM local_memberships`)?.["credential_reference"];
    await assert.rejects(recoverOwnerAccess({ recoveryCode: "wrong", newSecret: NEXT_SECRET }, ports), code("invalid_credential"));
    await assert.rejects(recoverOwnerAccess({ recoveryCode: "wrong", newSecret: NEXT_SECRET }, ports), code("retry_later"));
    assert.equal(database.get(`SELECT credential_reference FROM local_memberships`)?.["credential_reference"], original);
    assert.equal(database.get(`SELECT failures FROM local_credential_recovery`)?.["failures"], 1);
    advance(); await unlockWorkspace({ userId: installation.ownerId, secret: SECRET }, ports);
  });
  it("boot completes a native-reset/SQLite-crash gap exactly once without either secret in SQLite", async () => {
    const { context } = await setup(); const recovery = await ownerRecoveryCode(context, SECRET);
    database.run(`CREATE TRIGGER recovery_fail BEFORE INSERT ON local_audit WHEN NEW.action = 'OWNER_ACCESS_RECOVERED' BEGIN SELECT RAISE(ABORT,'fail'); END`);
    await assert.rejects(recoverOwnerAccess({ recoveryCode: recovery!, newSecret: NEXT_SECRET }, ports));
    assert.notEqual(database.get(`SELECT id FROM local_credential_recovery`), undefined);
    database.run(`DROP TRIGGER recovery_fail`);
    await resumeOwnerRecovery(ports); await resumeOwnerRecovery(ports);
    assert.equal(database.get(`SELECT id FROM local_credential_recovery`), undefined);
    assert.equal(database.get(`SELECT COUNT(*) AS n FROM local_audit WHERE action = 'OWNER_ACCESS_RECOVERED'`)?.["n"], 1);
    for (const table of ["local_memberships", "local_credential_recovery", "local_audit"]) {
      for (const row of database.all(`SELECT * FROM ${table}`)) assert.equal(JSON.stringify(row).includes(recovery!), false);
    }
  });
  it("creates staff with their own credential/role and owner suspension prevents their next unlock", async () => {
    const { installation, context } = await setup();
    const userId = await createLocalMember(context, { name: "Cashier", role: "CASHIER", secret: NEXT_SECRET });
    assert.equal(listLocalMembers(context).length, 2);
    assert.equal((await credentials.inspect(installation.installationId))?.credentialReference,
      String(database.get(`SELECT credential_reference FROM local_memberships WHERE user_id = ?`, [installation.ownerId])?.["credential_reference"]));
    setMemberActive(context, userId, false);
    await assert.rejects(unlockWorkspace({ userId, secret: NEXT_SECRET }, ports), code("actor_inactive"));
    setMemberActive(context, userId, true);
    const staff = await unlockWorkspace({ userId, secret: NEXT_SECRET }, ports);
    await assert.rejects(createLocalMember(staff, { name: "Another", role: "CASHIER", secret: SECRET }), code("permission_denied"));
    assert.throws(() => setMemberActive(staff, installation.ownerId, false), code("permission_denied"));
  });
  it("protects reports with current granular grants and always scopes them to the unlocked shop", async () => {
    const { context } = await setup();
    assert.equal(typeof dashboard(context, "2026-10-01T00:00:00.000Z", "2026-10-31T00:00:00.000Z"), "object");
    const userId = await createLocalMember(context, { name: "Cashier", role: "CASHIER", secret: NEXT_SECRET });
    grantPermission(context, userId, "reports.inventory");
    const staff = await unlockWorkspace({ userId, secret: NEXT_SECRET }, ports);
    assert.deepEqual(lowStock(staff), []);
    assert.throws(() => dashboard(staff, "2026-10-01T00:00:00.000Z", "2026-10-31T00:00:00.000Z"), code("permission_denied"));
    // Persisted changes are checked on the next report, even within this unlock session.
    database.run(`UPDATE local_memberships SET revoked = '["reports.inventory"]' WHERE user_id = ?`, [userId]);
    assert.throws(() => lowStock(staff), code("permission_denied"));
    assert.throws(() => lowStock({ ...staff }), code("locked"));
  });
  it("recovers staff provisioning after native success and rollback, without duplicate users", async () => {
    const { context } = await setup();
    database.run(`CREATE TRIGGER member_fail BEFORE INSERT ON local_memberships WHEN NEW.role = 'CASHIER' BEGIN SELECT RAISE(ABORT,'fail'); END`);
    await assert.rejects(createLocalMember(context, { name: "Cashier", role: "CASHIER", secret: NEXT_SECRET }));
    assert.equal(database.get(`SELECT COUNT(*) AS n FROM users`)?.["n"], 1);
    database.run(`DROP TRIGGER member_fail`);
    await resumeMemberProvisioning(context); await resumeMemberProvisioning(context);
    assert.equal(listLocalMembers(context).length, 2);
    assert.equal(database.get(`SELECT COUNT(*) AS n FROM local_member_setup`)?.["n"], 0);
  });
  it("owner resets locked-out staff without changing role, grants, identity or suspension", async () => {
    const { context } = await setup();
    const userId = await createLocalMember(context, { name: "Cashier", role: "CASHIER", secret: NEXT_SECRET });
    grantPermission(context, userId, "reports.inventory"); setMemberActive(context, userId, false);
    database.run(`UPDATE local_memberships SET failures = 10 WHERE user_id = ?`, [userId]);
    await resetLocalMemberCredential(context, userId, "876543");
    const member = database.get(`SELECT * FROM local_memberships WHERE user_id = ?`, [userId])!;
    assert.equal(member["active"], 0); assert.equal(member["role"], "CASHIER"); assert.equal(member["failures"], 0);
    assert.equal(member["granted"], '["reports.inventory"]'); assert.equal(listLocalMembers(context).length, 2);
    setMemberActive(context, userId, true);
    await assert.rejects(unlockWorkspace({ userId, secret: NEXT_SECRET }, ports), code("invalid_credential")); advance();
    const staff = await unlockWorkspace({ userId, secret: "876543" }, ports);
    assert.equal(staff.userId, userId);
    await assert.rejects(resetLocalMemberCredential(staff, userId, SECRET), code("permission_denied"));
  });
  it("staff reset resumes native/SQLite crash gaps without a replacement user or duplicate audit", async () => {
    const { context } = await setup();
    const userId = await createLocalMember(context, { name: "Cashier", role: "CASHIER", secret: NEXT_SECRET });
    database.run(`CREATE TRIGGER reset_fail BEFORE INSERT ON local_audit WHEN NEW.action = 'MEMBER_ACCESS_RESET' BEGIN SELECT RAISE(ABORT,'fail'); END`);
    await assert.rejects(resetLocalMemberCredential(context, userId, "876543"));
    database.run(`DROP TRIGGER reset_fail`);
    await resumeMemberProvisioning(context); await resumeMemberProvisioning(context);
    assert.equal(listLocalMembers(context).length, 2);
    assert.equal(database.get(`SELECT COUNT(*) AS n FROM local_audit WHERE action = 'MEMBER_ACCESS_RESET'`)?.["n"], 1);
    await unlockWorkspace({ userId, secret: "876543" }, ports);
  });
  it("losing owner context during asynchronous staff provisioning cannot commit a user", async () => {
    const { context } = await setup();
    const original = credentials.provision;
    credentials.provision = async request => { const material = await original(request); lockWorkspace(database); return material; };
    await assert.rejects(createLocalMember(context, { name: "Cashier", role: "CASHIER", secret: NEXT_SECRET }), code("locked"));
    assert.equal(database.get(`SELECT COUNT(*) AS n FROM users`)?.["n"], 1);
  });
});

describe("explicit legacy authority conversion", () => {
  function legacy() {
    const businessId = id(), userId = id(), deviceId = id(), eventId = id();
    database.run(`INSERT INTO businesses(id,name,currency,created_at,updated_at) VALUES (?,'Legacy','XAF',?,?)`, [businessId, now, now]);
    database.run(`INSERT INTO users(id,business_id,name,role,created_at,updated_at) VALUES (?,?,'Owner','OWNER',?,?)`, [userId, businessId, now, now]);
    database.run(`INSERT INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES (?,?,'Till','ANDROID',?,?,?)`, [deviceId, businessId, now, now, now]);
    database.run(`INSERT INTO device_session VALUES(1,'old-session',?,?,?,?,'2027-01-01T00:00:00.000Z')`, [businessId, userId, deviceId, now]);
    database.run(`INSERT INTO sync_outbox(event_id,business_id,user_id,device_id,type,payload,occurred_at,sequence) VALUES (?,?,?,?,'SALE_COMPLETED','{}',?,1)`, [eventId, businessId, userId, deviceId, now]);
    const authority: AuthTransport = { login: async request => {
      assert.equal(request.device.id, deviceId);
      return { token: "server-token-must-not-be-stored", business: { id: businessId, name: "Server name", currency: "XAF" }, branches: [],
        user: { id: userId, name: "Owner", role: "OWNER", permissions: ["users.manage"] }, device: { id: deviceId, label: "Till", platform: "ANDROID" },
        session: { id: id(), issuedAt: now, expiresAt: "2027-01-01T00:00:00.000Z" } };
    } };
    return { authority, businessId, userId, deviceId, eventId };
  }
  it("preserves local shop/device/user/event/session identities and never stores the owner proof token", async () => {
    const old = legacy();
    const installation = await adoptLegacyWorkspace({ phone: "phone", serverPin: "server-pin", localSecret: SECRET }, ports, old.authority);
    assert.equal(installation.businessId, old.businessId); assert.equal(installation.ownerId, old.userId); assert.equal(installation.deviceId, old.deviceId);
    assert.equal(installation.businessName, "Legacy");
    assert.equal(database.get(`SELECT event_id FROM sync_outbox`)?.["event_id"], old.eventId);
    assert.equal(database.get(`SELECT session_id FROM device_session`)?.["session_id"], "old-session");
    assert.equal(JSON.stringify(database.all(`SELECT * FROM local_audit`)).includes("server-token-must-not-be-stored"), false);
    await unlockWorkspace({ userId: old.userId, secret: SECRET }, ports);
  });
  it("requires fresh owner proof for the exact shop/device; cached OWNER is insufficient", async () => {
    const old = legacy(); const response = await old.authority.login({ businessId: old.businessId, phone: "phone", pin: "pin", device: { id: old.deviceId } });
    for (const proof of [{ ...response, user: { ...response.user, role: "CASHIER" } },
      { ...response, business: { ...response.business, id: id() } }, { ...response, device: { ...response.device, id: id() } },
      { ...response, session: { ...response.session, expiresAt: "2025-01-01T00:00:00.000Z" } }]) {
      await assert.rejects(adoptLegacyWorkspace({ phone: "phone", serverPin: "pin", localSecret: SECRET }, ports, { login: async () => proof }), code("permission_denied"));
    }
    assert.equal(currentInstallation(database).state, "legacy");
    assert.equal(database.get(`SELECT id FROM workspace_setup`), undefined);
  });
  it("recovers owner-proven migration's native/SQLite gap and retries incomplete provisioning without new IDs", async () => {
    const old = legacy();
    const unavailable = { ...ports, credentials: { ...credentials, provision: async () => { throw new Error("unavailable"); } } };
    await assert.rejects(adoptLegacyWorkspace({ phone: "phone", serverPin: "pin", localSecret: SECRET }, unavailable, old.authority), code("credential_unavailable"));
    assert.equal((await recoverWorkspaceSetup(ports)).state, "pending");
    const reserved = sequence;
    const installation = await resumeWorkspaceProvisioning(SECRET, ports);
    assert.equal(sequence, reserved); assert.equal(installation.businessId, old.businessId);
  });
});
