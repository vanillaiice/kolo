import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "../data/database/driver.ts";
import { migrate, MIGRATIONS, schemaVersion } from "../data/database/migrations.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { balanceOfAccount } from "../data/finance/cash.ts";
import { stockOf } from "../data/inventory/movements.ts";
import * as commands from "../application/operations.ts";
import { currentInstallation, createWorkspace, recoverWorkspaceSetup, unlockWorkspace, lockWorkspace,
  grantPermission, revokePermission, rememberMember, resumeWorkspace } from "./workspace.ts";
import { authorizedOperation } from "./internal-authority.ts";
import { resolvePermissions, PERMISSIONS } from "./permissions.ts";
import { WorkspaceError, type CreateWorkspaceInput, type CredentialPort, type Installation,
  type OperationContext, type ProvisionedIdentity, type WorkspacePorts } from "./types.ts";

const AT = "2026-10-06T06:00:00.000Z";
const SECRET = "test-only-owner-secret";
const input: CreateWorkspaceInput = {
  businessName: "Boutique Chez Jean", currency: "XAF", ownerName: "Jean",
  deviceLabel: "Caisse 1", platform: "ANDROID", secret: SECRET,
};
let database: Database;
let ports: WorkspacePorts;
let at: string;
let sequence: number;
let credentials: CredentialPort;
let provisionCalls: number;
let verifyCalls: number;
let materials: Map<string, ProvisionedIdentity>;
let secrets: Map<string, string>;

function id(): string {
  return `00000000-0000-7000-8000-${String(++sequence).padStart(12, "0")}`;
}
function advance(seconds = 60): void { at = new Date(Date.parse(at) + seconds * 1000).toISOString(); }
function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof WorkspaceError && error.code === expected;
}
function count(table: string): number { return Number(database.get(`SELECT COUNT(*) AS n FROM ${table}`)?.["n"]); }
function owner(installation: Installation): Promise<OperationContext> {
  return unlockWorkspace({ userId: installation.ownerId, secret: SECRET }, ports);
}
function account(): string { return String(database.get(`SELECT id FROM financial_accounts LIMIT 1`)?.["id"]); }
function productInput(productId = id()): commands.CommandInput<import("../data/products/products.ts").SaveProduct> {
  return { id: productId, name: "Riz", unit: "sac", divisible: false, purchasePriceMinor: 300,
    sellingPriceMinor: 500, currency: "XAF", taxRateBasisPoints: 0, minimumStock: 0,
    active: true, createdAt: at, updatedAt: at };
}
function saleInput(productId: string): commands.CommandInput<import("../data/sales/sales.ts").Cart> {
  return { id: id(), number: id(), lines: [{ id: id(), movementId: id(), productId, name: "Riz", unitPriceMinor: 500, quantity: 1000 }],
    payments: [{ id: id(), accountId: account(), amountMinor: 500 }], eventId: id(), occurredAt: at };
}
function staff(installation: Installation, role = "CASHIER"): string {
  const userId = id();
  database.run(`INSERT INTO users (id, business_id, name, role, created_at, updated_at) VALUES (?, ?, 'Staff', ?, ?, ?)`,
    [userId, installation.businessId, role, at, at]);
  database.run(`INSERT INTO local_memberships (business_id, user_id, credential_reference, role) VALUES (?, ?, ?, ?)`,
    [installation.businessId, userId, userId, role]);
  secrets.set(userId, "staff-secret");
  return userId;
}
async function cashier(): Promise<{ context: OperationContext; installation: Installation; productId: string }> {
  const installation = await createWorkspace(input, ports);
  const context = await owner(installation);
  const productId = id();
  commands.saveProduct(context, productInput(productId));
  const userId = staff(installation);
  const staffContext = await unlockWorkspace({ userId, secret: "staff-secret" }, ports);
  return { context: staffContext, installation, productId };
}

beforeEach(() => {
  sequence = 0; at = AT; provisionCalls = 0; verifyCalls = 0;
  materials = new Map(); secrets = new Map();
  database = openDatabase(); migrate(database);
  // A deliberately test-only credential port. Production must supply reviewed
  // native KDF/key storage; no in-memory verifier is exported by shared code.
  credentials = {
    async provision(request) {
      provisionCalls++;
      const existing = materials.get(request.installationId);
      if (existing !== undefined) {
        if (secrets.get(existing.credentialReference) !== request.secret) throw new Error("wrong secret");
        return existing;
      }
      const material = { publicKey: "test-public-key", keyReference: `key-${request.installationId}`,
        credentialReference: `credential-${request.userId}` };
      materials.set(request.installationId, material); secrets.set(material.credentialReference, request.secret);
      return material;
    },
    async inspect(installationId) { return materials.get(installationId); },
    async verify(reference, secret) { verifyCalls++; return secrets.get(reference) === secret; },
  };
  ports = { database, credentials, newId: id, now: () => at };
});
afterEach(() => { database.close(); });

describe("offline workspace setup", () => {
  it("creates shop, owner, device, accounts, membership and bootstrap atomically, locked with no cloud session", async () => {
    assert.deepEqual(currentInstallation(database), { state: "empty" });
    const accounts = [{ name: "Till", kind: "CASH" as const, secret: SECRET }, { name: "Wallet", kind: "MOBILE_MONEY" as const }];
    const installation = await createWorkspace({ ...input, accounts }, ports);
    assert.equal(currentInstallation(database).state, "locked");
    for (const table of ["businesses", "users", "devices", "local_installation", "local_memberships", "local_audit"]) assert.equal(count(table), 1);
    assert.equal(count("financial_accounts"), 2);
    assert.equal(count("workspace_setup"), 0);
    assert.equal(count("device_session"), 0);
    assert.equal(count("sync_outbox"), 0);
    assert.equal(installation.businessName, input.businessName);
    assert.equal(installation.publicKey, "test-public-key");
    for (const { name } of database.all(`SELECT name FROM sqlite_master WHERE type = 'table'`)) {
      for (const row of database.all(`SELECT * FROM "${String(name)}"`)) {
        assert.equal(JSON.stringify(row).includes(SECRET), false, `raw secret leaked into ${String(name)}`);
      }
    }
    const bootstrap = JSON.parse(String(database.get(`SELECT payload FROM local_audit`)?.["payload"]));
    assert.equal(JSON.stringify(bootstrap).includes("credential-"), false);
    assert.equal(JSON.stringify(bootstrap).includes("key-0000"), false);
  });
  it("validates currency, names, platform, accounts, secret and UUIDv7 before provisioning", async () => {
    const invalid = [{ currency: "EUR" }, { businessName: " " }, { ownerName: "x".repeat(121) },
      { platform: "WEB" }, { accounts: [] }, { accounts: [{ name: " ", kind: "CASH" }] },
      { accounts: [{ name: "Till", kind: "CASH" }, { name: " till ", kind: "CASH" }] }, { secret: "" }];
    for (const overrides of invalid) {
      await assert.rejects(createWorkspace({ ...input, ...overrides } as CreateWorkspaceInput, ports), code("invalid_input"));
    }
    await assert.rejects(createWorkspace(input, { ...ports, newId: () => "not-an-id" }), code("invalid_input"));
    await assert.rejects(createWorkspace(input, { ...ports, newId: () => "00000000-0000-7000-8000-000000000001" }), code("invalid_input"));
    assert.equal(provisionCalls, 0); assert.equal(count("workspace_setup"), 0);
  });
  it("refuses existing installation without touching native secrets", async () => {
    await createWorkspace(input, ports);
    await assert.rejects(createWorkspace({ ...input, businessName: "Another" }, ports), code("already_configured"));
    assert.equal(provisionCalls, 1); assert.equal(count("businesses"), 1);
  });
  it("does not adopt old demo/server data or discard pending outbox", async () => {
    database.run(`INSERT INTO businesses (id, name, currency, created_at, updated_at) VALUES ('old', 'Old', 'XAF', ?, ?)`, [at, at]);
    database.run(`INSERT INTO sync_outbox (event_id,business_id,user_id,device_id,type,payload,occurred_at,sequence)
      VALUES ('old-event','old','old-user','old-device','SALE_COMPLETED','{}',?,1)`, [at]);
    assert.equal(currentInstallation(database).state, "legacy");
    await assert.rejects(createWorkspace(input, ports), code("legacy_installation"));
    assert.equal(provisionCalls, 0); assert.equal(count("sync_outbox"), 1);
    assert.equal(database.get(`SELECT name FROM businesses`)?.["name"], "Old");
  });
  it("retains pending intent when native provisioning fails, and retries the same IDs", async () => {
    const failing = { ...ports, credentials: { ...credentials, provision: async () => { throw new Error(SECRET); } } };
    await assert.rejects(createWorkspace(input, failing), error => code("credential_unavailable")(error) && !(error as Error).message.includes(SECRET));
    const pending = currentInstallation(database);
    assert.equal(pending.state, "pending"); assert.equal(count("businesses"), 0);
    assert.equal((await recoverWorkspaceSetup(ports)).state, "pending");
    const allocated = sequence;
    await assert.rejects(createWorkspace({ ...input, ownerName: "Other" }, ports), code("setup_pending"));
    const installation = await createWorkspace(input, ports);
    assert.equal(sequence, allocated);
    assert.equal(pending.state === "pending" && pending.installationId, installation.installationId);
  });
  it("recovers after durable native provisioning but before completion returns", async () => {
    const interrupted = { ...ports, credentials: { ...credentials, provision: async (request: Parameters<CredentialPort["provision"]>[0]) => {
      await credentials.provision(request); throw new Error("process stopped after secrets");
    } } };
    await assert.rejects(createWorkspace(input, interrupted), code("credential_unavailable"));
    assert.equal(count("businesses"), 0);
    const state = await recoverWorkspaceSetup(ports);
    assert.equal(state.state, "locked"); assert.equal(provisionCalls, 1);
    await recoverWorkspaceSetup(ports);
    assert.equal(count("local_audit"), 1);
    if (state.state === "locked") await owner(state.installation);
  });
  it("rolls back every setup row on a SQLite failure, retaining recovery intent and native material", async () => {
    database.run(`CREATE TRIGGER test_fail_setup BEFORE INSERT ON financial_accounts BEGIN SELECT RAISE(ABORT,'forced setup failure'); END`);
    await assert.rejects(createWorkspace(input, ports));
    for (const table of ["businesses", "users", "devices", "local_installation", "local_memberships", "local_audit"]) assert.equal(count(table), 0);
    assert.equal(count("workspace_setup"), 1); assert.equal(materials.size, 1);
    database.run(`DROP TRIGGER test_fail_setup`);
    assert.equal((await recoverWorkspaceSetup(ports)).state, "locked");
    assert.equal(count("local_audit"), 1);
  });
  it("rejects incomplete public material and keeps setup pending", async () => {
    await assert.rejects(createWorkspace(input, { ...ports, credentials: { ...credentials,
      provision: async () => ({ publicKey: "", keyReference: "key", credentialReference: "credential" }) } }), code("credential_unavailable"));
    assert.equal(currentInstallation(database).state, "pending"); assert.equal(count("businesses"), 0);
  });
  it("handles overlapping same-intent setup completion without duplicate facts or IDs", async () => {
    const installations = await Promise.all([createWorkspace(input, ports), createWorkspace(input, ports)]);
    assert.deepEqual(installations[0], installations[1]);
    assert.equal(count("businesses"), 1); assert.equal(count("local_audit"), 1);
  });
  it("survives closing/reopening a file database, locked and able to unlock and sell offline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kolo-f1-"));
    const file = join(directory, "shop.sqlite");
    database.close(); database = openDatabase({ location: file }); migrate(database); ports = { ...ports, database };
    try {
      const installation = await createWorkspace(input, ports);
      const first = await owner(installation);
      const productId = id(); commands.saveProduct(first, productInput(productId));
      database.close(); database = openDatabase({ location: file }); migrate(database); ports = { ...ports, database };
      assert.equal(currentInstallation(database).state, "locked");
      const context = await owner(installation);
      commands.completeSale(context, saleInput(productId));
      assert.equal(count("sales"), 1);
      assert.equal(balanceOfAccount(database, installation.businessId, account()).onHandMinor, 500);
    } finally { database.close(); database = openDatabase(); rmSync(directory, { recursive: true }); }
  });
});

describe("local unlock and authority", () => {
  it("denies a forged or copied context and invalidates the issued capability on lock/replacement unlock", async () => {
    const installation = await createWorkspace(input, ports);
    const context = await owner(installation);
    assert.throws(() => authorizedOperation({ ...context }, [], () => 1), code("locked"));
    const second = await owner(installation);
    assert.throws(() => authorizedOperation(context, [], () => 1), code("locked"));
    assert.equal(authorizedOperation(second, [], () => 42), 42);
    lockWorkspace(database);
    assert.equal(currentInstallation(database).state, "locked");
    assert.throws(() => authorizedOperation(second, [], () => 1), code("locked"));
  });
  it("rejects wrong secrets and persists exponential retry and recovery after ten failures", async () => {
    const installation = await createWorkspace(input, ports);
    for (let n = 0; n < 10; n++) {
      await assert.rejects(unlockWorkspace({ userId: installation.ownerId, secret: "wrong" }, ports), code("invalid_credential"));
      if (n === 0) {
        await assert.rejects(owner(installation), code("retry_later"));
        assert.equal(verifyCalls, 1);
        at = "2026-10-05T00:00:00.000Z";
        await assert.rejects(owner(installation), code("retry_later"));
        at = AT;
      }
      advance(60);
    }
    await assert.rejects(owner(installation), code("recovery_required"));
    assert.equal(verifyCalls, 10); assert.equal(currentInstallation(database).state, "locked");
  });
  it("clears retry failures only after successful native verification", async () => {
    const installation = await createWorkspace(input, ports);
    await assert.rejects(unlockWorkspace({ userId: installation.ownerId, secret: "wrong" }, ports));
    advance(1); await owner(installation);
    assert.equal(database.get(`SELECT failures FROM local_memberships`)?.["failures"], 0);
  });
  it("does not leak native errors and reserves a failure for unavailable native storage", async () => {
    const installation = await createWorkspace(input, ports);
    await assert.rejects(unlockWorkspace({ userId: installation.ownerId, secret: SECRET }, { ...ports, credentials: {
      ...credentials, verify: async () => { throw new Error(SECRET); },
    } }), error => code("credential_unavailable")(error) && !(error as Error).message.includes(SECRET));
    assert.equal(database.get(`SELECT failures FROM local_memberships`)?.["failures"], 1);
  });
  it("denies unknown/suspended actors without invoking the credential verifier", async () => {
    const installation = await createWorkspace(input, ports);
    await assert.rejects(unlockWorkspace({ userId: id(), secret: SECRET }, ports), code("actor_inactive"));
    database.run(`UPDATE users SET active = 0 WHERE id = ?`, [installation.ownerId]);
    await assert.rejects(owner(installation), code("actor_inactive")); assert.equal(verifyCalls, 0);
  });
  it("rechecks actor suspension after asynchronous credential verification", async () => {
    const installation = await createWorkspace(input, ports);
    await assert.rejects(unlockWorkspace({ userId: installation.ownerId, secret: SECRET }, { ...ports, credentials: {
      ...credentials, verify: async () => { database.run(`UPDATE local_memberships SET active = 0`); return true; },
    } }), code("actor_inactive"));
    assert.equal(currentInstallation(database).state, "locked");
  });
  it("lock invalidates an in-flight unlock and simultaneous unlock attempts are refused", async () => {
    const installation = await createWorkspace(input, ports);
    let resolve: (verified: boolean) => void = () => {};
    const deferred = { ...ports, credentials: { ...credentials, verify: () => new Promise<boolean>(r => { resolve = r; }) } };
    const unlocking = unlockWorkspace({ userId: installation.ownerId, secret: SECRET }, deferred);
    await assert.rejects(owner(installation), code("retry_later"));
    lockWorkspace(database); resolve(true);
    await assert.rejects(unlocking, code("locked"));
    assert.equal(currentInstallation(database).state, "locked");
  });
  it("local authority survives cloud session expiry/removal", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    advance(60 * 60 * 24 * 365);
    database.run(`DELETE FROM device_session`);
    assert.equal(authorizedOperation(context, ["sales.create"], () => true), true);
  });
  it("rejects asynchronous transaction callbacks and rolls back their synchronous effects", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    assert.throws(() => authorizedOperation(context, [], async (_database, tx) => {
      tx.run(`UPDATE businesses SET name = 'should roll back'`);
    }), code("invalid_input"));
    assert.equal(database.get(`SELECT name FROM businesses`)?.["name"], input.businessName);
  });
  it("revocation overrides defaults and grants, while cashier excludes financial reports", () => {
    assert.equal(resolvePermissions("CASHIER", [], []).includes("reports.financial"), false);
    assert.equal(resolvePermissions("MANAGER", [], []).includes("users.manage"), false);
    assert.deepEqual(resolvePermissions("OWNER", ["sales.create"], ["sales.create"]), PERMISSIONS.filter(p => p !== "sales.create"));
    assert.throws(() => resolvePermissions("UNKNOWN" as "OWNER", [], []));
    assert.throws(() => resolvePermissions("OWNER", ["unknown" as "sales.create"], []));
  });
  it("audits owner grants/revocations with revisions and preserves owner management authority", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    const userId = staff(installation);
    grantPermission(context, userId, "sales.discount"); revokePermission(context, userId, "sales.create");
    assert.equal(database.get(`SELECT revision FROM local_memberships WHERE user_id = ?`, [userId])?.["revision"], 3);
    assert.equal(count("local_audit"), 3);
    assert.throws(() => revokePermission(context, installation.ownerId, "users.manage"), code("permission_denied"));
    const cashierContext = await unlockWorkspace({ userId, secret: "staff-secret" }, ports);
    assert.throws(() => authorizedOperation(cashierContext, ["sales.create"], () => 1), code("permission_denied"));
    assert.equal(authorizedOperation(cashierContext, ["sales.discount"], () => 1), 1);
    assert.throws(() => grantPermission(cashierContext, userId, "users.manage"), code("permission_denied"));
  });
  it("an existing context loses revoked permission immediately and corrupt authority fails closed", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    revokePermission(context, installation.ownerId, "sales.create");
    assert.throws(() => authorizedOperation(context, ["sales.create"], () => 1), code("permission_denied"));
    database.run(`UPDATE local_memberships SET granted = '["typo"]'`);
    assert.throws(() => authorizedOperation(context, [], () => 1), code("permission_denied"));
  });
  it("local audit is immutable and membership cannot reference another shop's user", async () => {
    const installation = await createWorkspace(input, ports);
    assert.throws(() => database.run(`UPDATE local_audit SET action = 'changed'`));
    assert.throws(() => database.run(`DELETE FROM local_audit`));
    database.run(`INSERT INTO businesses (id,name,currency,created_at,updated_at) VALUES ('other','Other','XAF',?,?)`, [at, at]);
    assert.throws(() => database.run(`INSERT INTO local_memberships (business_id,user_id,credential_reference,role) VALUES ('other',?,'bad','OWNER')`, [installation.ownerId]));
  });
});

describe("remembered sessions", () => {
  it("resumes the same member and permissions after a lock without verifying a secret", async () => {
    const { context, installation } = await cashier();
    const remembered = rememberMember(context);
    assert.deepEqual(remembered, { businessId: installation.businessId, userId: remembered.userId, credentialReference: remembered.userId });
    lockWorkspace(database); verifyCalls = 0;
    const resumed = resumeWorkspace(remembered, ports);
    assert.equal(verifyCalls, 0); assert.equal(resumed.userId, remembered.userId);
    assert.equal(currentInstallation(database).state, "unlocked");
    assert.throws(() => authorizedOperation(context, [], () => 1), code("locked"));
    assert.throws(() => authorizedOperation(resumed, ["inventory.adjust"], () => 1), code("permission_denied"));
    assert.equal(authorizedOperation(resumed, ["sales.create"], () => 42), 42);
  });
  it("grants nothing for a changed credential, another shop, an unknown or suspended member, or a locked-out member", async () => {
    const installation = await createWorkspace(input, ports);
    const remembered = rememberMember(await owner(installation));
    for (const forged of [{ ...remembered, credentialReference: "credential-other" }, { ...remembered, businessId: id() }, { ...remembered, userId: id() }]) {
      lockWorkspace(database);
      assert.throws(() => resumeWorkspace(forged, ports), error => error instanceof WorkspaceError);
      assert.equal(currentInstallation(database).state, "locked");
    }
    database.run(`UPDATE local_memberships SET failures = 10`);
    assert.throws(() => resumeWorkspace(remembered, ports), code("recovery_required"));
    database.run(`UPDATE local_memberships SET failures = 0, active = 0`);
    assert.throws(() => resumeWorkspace(remembered, ports), code("actor_inactive"));
    database.run(`UPDATE local_memberships SET active = 1`); database.run(`UPDATE devices SET active = 0`);
    assert.throws(() => resumeWorkspace(remembered, ports), code("actor_inactive"));
    assert.equal(currentInstallation(database).state, "locked");
  });
  it("is stale after the member's credential is replaced", async () => {
    const installation = await createWorkspace(input, ports);
    const remembered = rememberMember(await owner(installation));
    database.run(`UPDATE local_memberships SET credential_reference = 'credential-replaced' WHERE user_id = ?`, [installation.ownerId]);
    lockWorkspace(database);
    assert.throws(() => resumeWorkspace(remembered, ports), code("locked"));
  });
  it("refuses while an unlock is in flight and before setup", async () => {
    assert.throws(() => resumeWorkspace({ businessId: id(), userId: id(), credentialReference: "x" }, ports), code("not_configured"));
    const installation = await createWorkspace(input, ports);
    const remembered = rememberMember(await owner(installation));
    lockWorkspace(database);
    const pending = owner(installation);
    assert.throws(() => resumeWorkspace(remembered, ports), code("retry_later"));
    await pending;
  });
});

describe("authorized application writes", () => {
  it("cashier completes a sale without allowing caller-supplied actor/shop/device/persistence time", async () => {
    const { context, installation, productId } = await cashier();
    const sale = { ...saleInput(productId), userId: installation.ownerId, businessId: "fake", deviceId: "fake", recordedAt: "fake" };
    const result = commands.completeSale(context, sale);
    assert.equal(result.totalMinor, 500);
    const row = database.get(`SELECT * FROM sales WHERE id = ?`, [sale.id]);
    assert.equal(row?.["user_id"], context.userId); assert.equal(row?.["business_id"], context.businessId);
    assert.equal(row?.["device_id"], context.deviceId); assert.equal(row?.["recorded_at"], at);
    assert.equal(stockOf(database, installation.businessId, productId).onHandThousandths, -1000);
    assert.equal(balanceOfAccount(database, installation.businessId, account()).onHandMinor, 500);
    assert.equal(database.get(`SELECT user_id FROM local_audit ORDER BY sequence DESC LIMIT 1`)?.["user_id"], context.userId);
  });
  it("denies discounted and price-overridden sales without the respective permissions", async () => {
    const { context, productId } = await cashier();
    const cart = saleInput(productId);
    assert.throws(() => commands.completeSale(context, { ...cart, discountMinor: 1, payments: [{ ...cart.payments[0]!, amountMinor: 499 }] }), code("permission_denied"));
    assert.throws(() => commands.completeSale(context, { ...cart, lines: [{ ...cart.lines[0]!, unitPriceMinor: 501 }], payments: [{ ...cart.payments[0]!, amountMinor: 501 }] }), code("permission_denied"));
    assert.equal(count("sales"), 0);
  });
  it("checks credit and separate credit-limit override inside the sale command", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    const productId = id(); commands.saveProduct(context, productInput(productId));
    const customerId = id();
    commands.saveCustomer(context, { id: customerId, name: "Regular", creditLimitMinor: 100, active: true, createdAt: at, updatedAt: at });
    revokePermission(context, installation.ownerId, "customers.credit_override");
    const cart = { ...saleInput(productId), customerId, payments: [], creditTransactionId: id() };
    assert.throws(() => commands.completeSale(context, cart), code("permission_denied"));
    grantPermission(context, installation.ownerId, "customers.credit_override");
    revokePermission(context, installation.ownerId, "customers.credit");
    assert.throws(() => commands.completeSale(context, cart), code("permission_denied"));
    grantPermission(context, installation.ownerId, "customers.credit");
    commands.completeSale(context, cart); assert.equal(count("customer_transactions"), 1);
  });
  it("denies direct writes for suspended user/member/device/business, despite an issued context", async () => {
    const { context, productId } = await cashier();
    for (const table of ["users", "local_memberships", "devices", "businesses"]) {
      database.run(`UPDATE ${table} SET active = 0`);
      assert.throws(() => commands.completeSale(context, saleInput(productId)), code("actor_inactive"));
      database.run(`UPDATE ${table} SET active = 1`);
    }
    assert.equal(count("sales"), 0);
  });
  it("denies cashier stock, purchase, supplier, cash, expense and catalog mutations", async () => {
    const { context, productId } = await cashier();
    const requests = [
      () => commands.adjustStock(context, { id: id(), productId, type: "ADJUSTMENT", quantity: 1000, reason: "count", occurredAt: at }, id()),
      () => commands.recordPurchase(context, { id: id(), lines: [], payments: [], eventId: id(), occurredAt: at }),
      () => commands.paySupplier(context, { id: id(), supplierId: id(), accountId: account(), amountMinor: 10, eventId: id(), occurredAt: at }),
      () => commands.moveCash(context, { movements: [], eventId: id() }),
      () => commands.recordExpense(context, { id: id(), category: "RENT", accountId: account(), amountMinor: 10, eventId: id(), occurredAt: at }),
      () => commands.saveProduct(context, productInput()),
      () => commands.saveSupplier(context, { id: id(), name: "Supplier", active: true, createdAt: at, updatedAt: at }),
      () => commands.saveAccount(context, { id: id(), name: "Cash", kind: "CASH", currency: "XAF", active: true, createdAt: at, updatedAt: at }),
      () => commands.reconcileCash(context, account(), 0),
    ];
    for (const request of requests) assert.throws(request, code("permission_denied"));
    assert.equal(count("inventory_movements"), 0); assert.equal(count("expenses"), 0);
  });
  it("rejects cross-shop product, account, customer, supplier and global-ID upserts", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    const productId = id(); commands.saveProduct(context, productInput(productId));
    const foreign = id();
    database.run(`INSERT INTO businesses (id,name,currency,created_at,updated_at) VALUES (?,'Other','XAF',?,?)`, [foreign, at, at]);
    const foreignProduct = id(), foreignAccount = id(), foreignCustomer = id(), foreignSupplier = id();
    database.run(`INSERT INTO products (id,business_id,name,unit,selling_price_minor,currency,created_at,updated_at) VALUES (?,?,'Foreign','unit',500,'XAF',?,?)`, [foreignProduct, foreign, at, at]);
    database.run(`INSERT INTO financial_accounts (id,business_id,name,kind,currency,created_at,updated_at) VALUES (?,?,'Foreign','CASH','XAF',?,?)`, [foreignAccount, foreign, at, at]);
    database.run(`INSERT INTO customers (id,business_id,name,created_at,updated_at) VALUES (?,?,'Foreign',?,?)`, [foreignCustomer, foreign, at, at]);
    database.run(`INSERT INTO suppliers (id,business_id,name,created_at,updated_at) VALUES (?,?,'Foreign',?,?)`, [foreignSupplier, foreign, at, at]);
    const cart = saleInput(productId);
    const requests = [
      () => commands.completeSale(context, saleInput(foreignProduct)),
      () => commands.completeSale(context, { ...cart, payments: [{ ...cart.payments[0]!, accountId: foreignAccount }] }),
      () => commands.completeSale(context, { ...cart, customerId: foreignCustomer }),
      () => commands.receiveCustomerPayment(context, { id: id(), customerId: foreignCustomer, accountId: account(), amountMinor: 1, eventId: id(), occurredAt: at }),
      () => commands.paySupplier(context, { id: id(), supplierId: foreignSupplier, accountId: account(), amountMinor: 1, eventId: id(), occurredAt: at }),
      () => commands.recordExpense(context, { id: id(), category: "RENT", accountId: foreignAccount, amountMinor: 1, eventId: id(), occurredAt: at }),
      () => commands.saveProduct(context, productInput(foreignProduct)),
      () => commands.saveCustomer(context, { id: foreignCustomer, name: "Edit", active: true, createdAt: at, updatedAt: at }),
      () => commands.saveSupplier(context, { id: foreignSupplier, name: "Edit", active: true, createdAt: at, updatedAt: at }),
    ];
    for (const request of requests) assert.throws(request, code("scope_mismatch"));
    assert.equal(count("sales"), 0); assert.equal(count("expenses"), 0);
  });
  it("refuses a cross-shop branch/category and an actor bypassing their bound branch", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    const productId = id(); commands.saveProduct(context, productInput(productId));
    database.run(`INSERT INTO businesses (id,name,currency,created_at,updated_at) VALUES ('foreign','Foreign','XAF',?,?)`, [at, at]);
    database.run(`INSERT INTO branches (id,business_id,name,created_at,updated_at) VALUES ('foreign-branch','foreign','Branch',?,?)`, [at, at]);
    database.run(`INSERT INTO categories (id,business_id,name,created_at,updated_at) VALUES ('foreign-category','foreign','Category',?,?)`, [at, at]);
    assert.throws(() => commands.completeSale(context, { ...saleInput(productId), branchId: "foreign-branch" }), code("scope_mismatch"));
    assert.throws(() => commands.saveProduct(context, { ...productInput(), categoryId: "foreign-category" }), code("scope_mismatch"));
    const ownBranch = id();
    database.run(`INSERT INTO branches (id,business_id,name,created_at,updated_at) VALUES (?,?,'Branch',?,?)`, [ownBranch, installation.businessId, at, at]);
    database.run(`UPDATE users SET branch_id = ? WHERE id = ?`, [ownBranch, installation.ownerId]);
    assert.throws(() => commands.completeSale(context, saleInput(productId)), code("scope_mismatch"));
    commands.completeSale(context, { ...saleInput(productId), branchId: ownBranch });
    assert.equal(count("sales"), 1);
  });
  it("rolls back sale, stock, payment, outbox and audit if audit persistence fails", async () => {
    const { context, productId } = await cashier();
    const events = count("sync_outbox"), audits = count("local_audit");
    database.run(`CREATE TRIGGER test_fail_audit BEFORE INSERT ON local_audit BEGIN SELECT RAISE(ABORT,'forced audit failure'); END`);
    assert.throws(() => commands.completeSale(context, saleInput(productId)));
    for (const table of ["sales", "sale_items", "sale_payments", "inventory_movements"]) assert.equal(count(table), 0);
    assert.equal(count("sync_outbox"), events); assert.equal(count("local_audit"), audits);
  });
  it("rolls back business effects on reused event ID rather than duplicating money or stock", async () => {
    const { context, productId } = await cashier();
    const first = saleInput(productId); commands.completeSale(context, first);
    assert.throws(() => commands.completeSale(context, { ...saleInput(productId), eventId: first.eventId }));
    assert.equal(count("sales"), 1); assert.equal(count("inventory_movements"), 1);
    assert.equal(balanceOfAccount(database, context.businessId, account()).onHandMinor, 500);
  });
  it("runs owner stock, purchase, customer/supplier payments, cash, expense and account commands", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    const productId = id(); commands.saveProduct(context, productInput(productId));
    const customerId = id(); commands.saveCustomer(context, { id: customerId, name: "Regular", active: true, createdAt: at, updatedAt: at });
    const supplierId = id(); commands.saveSupplier(context, { id: supplierId, name: "Wholesaler", active: true, createdAt: at, updatedAt: at });
    commands.adjustStock(context, { id: id(), productId, type: "ADJUSTMENT", quantity: 1000, reason: "Opening count", occurredAt: at }, id());
    commands.recordPurchase(context, { id: id(), supplierId, lines: [{ id: id(), movementId: id(), productId, quantity: 1000, unitCostMinor: 300 }],
      payments: [], supplierTransactionId: id(), eventId: id(), occurredAt: at });
    commands.receiveCustomerPayment(context, { id: id(), customerId, accountId: account(), amountMinor: 1000, eventId: id(), occurredAt: at });
    commands.paySupplier(context, { id: id(), supplierId, accountId: account(), amountMinor: 300, eventId: id(), occurredAt: at });
    commands.moveCash(context, { movements: [{ id: id(), accountId: account(), type: "CASH_IN", amountMinor: 50, occurredAt: at }], eventId: id() });
    commands.recordExpense(context, { id: id(), category: "RENT", accountId: account(), amountMinor: 100, eventId: id(), occurredAt: at });
    assert.equal(commands.reconcileCash(context, account(), 650).differenceMinor, 0);
    assert.equal(stockOf(database, installation.businessId, productId).onHandThousandths, 2000);
    assert.equal(balanceOfAccount(database, installation.businessId, account()).onHandMinor, 650);
    const newAccount = id();
    commands.saveAccount(context, { id: newAccount, name: "Bank", kind: "BANK", currency: "XAF", active: true, createdAt: at, updatedAt: at });
    assert.equal(count("financial_accounts"), 2);
    for (const event of database.all(`SELECT event_id FROM sync_outbox`)) {
      assert.match(String(event["event_id"]), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });
  it("cannot invent sale/return movements through the stock adjustment command", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    assert.throws(() => commands.adjustStock(context, { id: id(), productId: id(), type: "SALE_RETURN", quantity: 1000, occurredAt: at }, id()), code("invalid_input"));
    assert.equal(count("inventory_movements"), 0);
  });
  it("requires reciprocal cash transfer legs and rejects partial/mismatched transfers", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    const secondAccount = id();
    commands.saveAccount(context, { id: secondAccount, name: "Safe", kind: "CASH", currency: "XAF", active: true, createdAt: at, updatedAt: at });
    const leaving: commands.CommandInput<import("../data/finance/cash.ts").CashMovement> = {
      id: id(), accountId: account(), counterpartId: secondAccount, type: "TRANSFER_OUT", amountMinor: -100, occurredAt: at,
    };
    const arriving: commands.CommandInput<import("../data/finance/cash.ts").CashMovement> = {
      id: id(), accountId: secondAccount, counterpartId: account(), type: "TRANSFER_IN", amountMinor: 100, occurredAt: at,
    };
    assert.throws(() => commands.moveCash(context, { movements: [leaving], eventId: id() }), code("invalid_input"));
    assert.throws(() => commands.moveCash(context, { movements: [leaving, { ...arriving, amountMinor: 99 }], eventId: id() }), code("invalid_input"));
    assert.equal(count("account_movements"), 0);
    commands.moveCash(context, { movements: [leaving, arriving], eventId: id() });
    assert.equal(count("account_movements"), 2);
    assert.equal(balanceOfAccount(database, installation.businessId, secondAccount).onHandMinor, 100);
  });
  it("requires an expense reversal to compensate the original amount/account/category", async () => {
    const installation = await createWorkspace(input, ports); const context = await owner(installation);
    const original = { id: id(), accountId: account(), category: "RENT" as const, amountMinor: 100, occurredAt: at, eventId: id() };
    commands.recordExpense(context, original);
    const reversal = { ...original, id: id(), eventId: id(), reversesId: original.id, amountMinor: -100 };
    assert.throws(() => commands.recordExpense(context, { ...reversal, amountMinor: -101 }), code("invalid_input"));
    assert.throws(() => commands.recordExpense(context, { ...reversal, category: "WATER" }), code("invalid_input"));
    commands.recordExpense(context, reversal);
    assert.equal(balanceOfAccount(database, installation.businessId, account()).onHandMinor, 0);
    assert.throws(() => commands.recordExpense(context, { ...reversal, id: id(), eventId: id() }));
    assert.equal(count("expenses"), 2);
  });
});

describe("upgrade from shipped schema 14", () => {
  it("preserves identities, cloud session and pending outbox, marking existing data as legacy", () => {
    const previous = openDatabase();
    try {
      previous.run(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT`);
      for (const migration of MIGRATIONS.slice(0, 14)) previous.transaction(tx => {
        for (const statement of migration.statements) tx.run(statement);
        tx.run(`INSERT INTO schema_migrations VALUES (?,?,?)`, [migration.version, migration.name, AT]);
      });
      previous.run(`INSERT INTO businesses (id,name,currency,created_at,updated_at) VALUES ('old','Old','XAF',?,?)`, [AT, AT]);
      previous.run(`INSERT INTO users (id,business_id,name,role,created_at,updated_at) VALUES ('user','old','User','CASHIER',?,?)`, [AT, AT]);
      previous.run(`INSERT INTO devices (id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES ('device','old','Device','ANDROID',?,?,?)`, [AT, AT, AT]);
      previous.run(`INSERT INTO device_session VALUES (1,'session','old','user','device',?,'2027-01-01T00:00:00.000Z')`, [AT]);
      previous.run(`INSERT INTO sync_outbox (event_id,business_id,user_id,device_id,type,payload,occurred_at,sequence) VALUES ('event','old','user','device','SALE_COMPLETED','{}',?,1)`, [AT]);
      assert.equal(schemaVersion(previous), 14);
      assert.deepEqual(migrate(previous).applied.map(m => m.version), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
      assert.equal(previous.get(`SELECT session_id FROM device_session`)?.["session_id"], "session");
      assert.equal(previous.get(`SELECT event_id FROM sync_outbox WHERE state = 'pending'`)?.["event_id"], "event");
      assert.equal(currentInstallation(previous).state, "legacy");
      assert.deepEqual(previous.all(`PRAGMA foreign_key_check`), []);
    } finally { previous.close(); }
  });
});
