import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, randomUUIDv7 } from "node:crypto";
import { openDesktopDatabase } from "./database.ts";
import { DesktopApplication } from "./application.ts";
import { desktopHandlers } from "./handlers.ts";
import { localCredentialsOnDesktop, desktopExchangeCrypto, type NativeSafeStorage } from "./local-credentials.ts";
import { createLocalMember } from "@kolo/core/identity/members";
import { unlockWorkspace } from "@kolo/core/identity/workspace";
import type { WorkspacePorts } from "@kolo/core/identity/types";
import type { Result, WorkspaceView } from "../shared/service.ts";

function value<T>(result: Result<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error("unexpected failure"); return result.value; }
function failure(result: Result<unknown>, code: string): void { assert.deepEqual(result, { ok: false, error: { code } }); }
function native(): NativeSafeStorage {
  const key = randomBytes(32);
  return { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async message => { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, cipher.update(message, "utf8"), cipher.final(), cipher.getAuthTag()]); },
    decryptStringAsync: async bytes => { const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return { result: Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"), shouldReEncrypt: false }; } };
}
async function fixture(clock = { now: "2026-10-06T12:00:00.000Z" }) {
  const directory = mkdtempSync(join(tmpdir(), "kolo-desktop-settings-")), database = openDesktopDatabase(join(directory, "shop.db"));
  const ports: WorkspacePorts = { database, credentials: localCredentialsOnDesktop(join(directory, "vault"), native()), newId: randomUUIDv7, now: () => clock.now };
  const application = new DesktopApplication(ports, desktopExchangeCrypto);
  await application.initialize();
  const setup = value(await application.createShop({ businessName: "Shop", ownerName: "Owner", deviceLabel: "PC", cashAccountName: "Cash", secret: "654321" }));
  const workspace: WorkspaceView = value(await application.unlock({ userId: setup.members[0]!.id, secret: "654321" }));
  return { directory, database, ports, application, clock, workspace, sessionId: workspace.sessionId!,
    async dispose() { await application.dispose(); database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

it("tax settings and product rules are versioned edits; checkout stamps the rate and the receipt shows it", async () => {
  const f = await fixture();
  try {
    const { application: app, sessionId } = f;
    assert.deepEqual(value(await app.taxSettings({ sessionId })), { enabled: false, label: "TVA", standardRateBasisPoints: 1925 });
    const saved = value(await app.updateTaxSettings({ sessionId, enabled: true, label: "TVA", standardRateBasisPoints: 1925, registration: "M0123" }));
    assert.equal(saved.version, "2026-10-06T12:00:00.000Z");
    assert.deepEqual(value(await app.updateTaxSettings({ sessionId, enabled: true, label: "TVA", standardRateBasisPoints: 1925, registration: "M0123" })), saved, "an identical retry is a no-op");
    failure(await app.updateTaxSettings({ sessionId, enabled: false, label: "TVA", standardRateBasisPoints: 1925 }), "request_conflict");
    failure(await app.updateTaxSettings({ sessionId, version: "2026-01-01T00:00:00.000Z", enabled: false, label: "TVA", standardRateBasisPoints: 1925 }), "request_conflict");
    const next = value(await app.updateTaxSettings({ sessionId, version: saved.version!, enabled: true, label: "TVA", standardRateBasisPoints: 1925 }));
    assert.equal(next.registration, undefined); assert.ok(next.version! > saved.version!, "a same-second edit still moves the version forward");
    for (const input of [{ standardRateBasisPoints: 10001 }, { label: "" }, { label: "x".repeat(21) }, { standardRateBasisPoints: 19.25 }, { enabled: "yes" }, { extra: 1 }])
      failure(await app.updateTaxSettings({ sessionId, version: next.version!, enabled: true, label: "TVA", standardRateBasisPoints: 1925, ...input } as never), "invalid_input");

    const item = value(await app.createProduct({ sessionId, requestId: randomUUID(), name: "Soap", unit: "bar", divisible: false, sellingPriceMinor: 11925, openingThousandths: 5000 }));
    const exempt = value(await app.createProduct({ sessionId, requestId: randomUUID(), name: "Rice", unit: "kg", divisible: false, sellingPriceMinor: 1000, openingThousandths: 5000 }));
    assert.deepEqual(value(await app.productTax({ sessionId, productId: item.id })), { rule: "STANDARD", effectiveRateBasisPoints: 1925 });
    const rule = value(await app.setProductTax({ sessionId, productId: exempt.id, rule: "EXEMPT" }));
    assert.deepEqual(value(await app.setProductTax({ sessionId, productId: exempt.id, rule: "EXEMPT" })), rule);
    failure(await app.setProductTax({ sessionId, productId: exempt.id, rule: "STANDARD" }), "request_conflict");
    for (const input of [{ rule: "RATE" }, { rule: "RATE", rateBasisPoints: 0 }, { rule: "EXEMPT", rateBasisPoints: 100 }, { rule: "NONE" }])
      failure(await app.setProductTax({ sessionId, productId: exempt.id, version: rule.version!, ...input } as never), "invalid_input");
    failure(await app.setProductTax({ sessionId, productId: randomUUID(), rule: "EXEMPT" }), "scope_mismatch");

    const cash = value(await app.listCashAccounts({ sessionId })).items[0]!.id;
    const sale = value(await app.checkout({ sessionId, requestId: randomUUID(), payments: [{ accountId: cash, amountMinor: 12925 }], lines: [{ productId: item.id, quantity: 1000, unitPriceMinor: 11925 }, { productId: exempt.id, quantity: 1000, unitPriceMinor: 1000 }] }));
    const receipt = value(await app.getReceipt({ sessionId, saleId: sale.saleId }));
    assert.deepEqual(receipt.tax, { label: "TVA", groups: [{ rateBasisPoints: 1925, grossMinor: 11925, taxMinor: 1925, netMinor: 10000 }] });
    const report = value(await app.report({ sessionId, kind: "tax", from: "2026-10-06T00:00:00.000Z", until: "2026-10-07T00:00:00.000Z" }));
    assert.equal(report.kind === "tax" ? report.taxMinor : -1, 1925);
  } finally { await f.dispose(); }
});

it("payment terms and credit standing are versioned, permission-checked and age credit sales", async () => {
  const f = await fixture();
  try {
    const { application: app, sessionId, clock } = f;
    assert.deepEqual(value(await app.paymentTerms({ sessionId })), { customer: { days: 30, stored: false }, supplier: { days: 30, stored: false } });
    const terms = value(await app.setShopTerms({ sessionId, party: "CUSTOMER", days: 10 }));
    assert.equal(terms.customer.days, 10);
    failure(await app.setShopTerms({ sessionId, party: "CUSTOMER", days: 20 }), "request_conflict");
    for (const days of [-1, 3651, 1.5, "7"]) failure(await app.setShopTerms({ sessionId, party: "CUSTOMER", days, version: terms.customer.version! } as never), "invalid_input");
    failure(await app.setShopTerms({ sessionId, party: "OWNER", days: 1 } as never), "invalid_input");

    const item = value(await app.createProduct({ sessionId, requestId: randomUUID(), name: "Rice", unit: "kg", divisible: false, sellingPriceMinor: 1000, openingThousandths: 10000 }));
    const buyer = value(await app.createCustomer({ sessionId, requestId: randomUUID(), name: "Ama" }));
    value(await app.checkout({ sessionId, requestId: randomUUID(), customerId: buyer.id, payments: [], lines: [{ productId: item.id, quantity: 2000, unitPriceMinor: 1000 }] }));
    let status = value(await app.creditStatus({ sessionId, party: "CUSTOMER", partyId: buyer.id }));
    assert.deepEqual({ ...status }, { days: 10, source: "shop", balanceMinor: 2000, overdueMinor: 0, dueSoonMinor: 0, oldestDueAt: "2026-10-16T12:00:00.000Z", nextDueAt: "2026-10-16T12:00:00.000Z" });
    clock.now = "2026-10-20T12:00:00.000Z";
    status = value(await app.creditStatus({ sessionId, party: "CUSTOMER", partyId: buyer.id }));
    assert.equal(status.overdueMinor, 2000);
    const alerts = value(await app.notifications({ sessionId }));
    assert.deepEqual(alerts.items.map(item => item.kind), ["customer_overdue"]);
    const own = value(await app.setPartyTerms({ sessionId, party: "CUSTOMER", partyId: buyer.id, days: 30 }));
    assert.deepEqual({ source: own.source, overdue: own.overdueMinor }, { source: "party", overdue: 0 });
    assert.deepEqual(value(await app.setPartyTerms({ sessionId, party: "CUSTOMER", partyId: buyer.id, days: 30 })), own, "identical retry");
    failure(await app.setPartyTerms({ sessionId, party: "CUSTOMER", partyId: buyer.id, days: null }), "request_conflict");
    assert.equal(value(await app.setPartyTerms({ sessionId, party: "CUSTOMER", partyId: buyer.id, days: null, version: own.version! })).source, "shop");
    failure(await app.setPartyTerms({ sessionId, party: "SUPPLIER", partyId: buyer.id, days: 5 }), "scope_mismatch");
    failure(await app.creditStatus({ sessionId, party: "CUSTOMER", partyId: "not-an-id" }), "invalid_input");

    const marked = value(await app.markNotifications({ sessionId }));
    assert.equal(marked.unread, 0);
    failure(await app.markNotifications({ sessionId, announced: true }), "invalid_input");
    failure(await app.markNotifications({ sessionId, keys: "all" } as never), "invalid_input");

    const context = await unlockWorkspace({ userId: f.workspace.members[0]!.id, secret: "654321" }, f.ports);
    const staff = await createLocalMember(context, { name: "Cashier", role: "CASHIER", secret: "765432" });
    const cashier = value(await app.unlock({ userId: staff, secret: "765432" })).sessionId!;
    failure(await app.setShopTerms({ sessionId: cashier, party: "SUPPLIER", days: 5 }), "permission_denied");
    failure(await app.updateTaxSettings({ sessionId: cashier, enabled: true, label: "TVA", standardRateBasisPoints: 1925 }), "permission_denied");
    failure(await app.setPartyTerms({ sessionId: cashier, party: "CUSTOMER", partyId: buyer.id, days: 1 }), "permission_denied");
    assert.equal(value(await app.taxSettings({ sessionId: cashier })).enabled, false);
    assert.equal(value(await app.creditStatus({ sessionId: cashier, party: "CUSTOMER", partyId: buyer.id })).overdueMinor, 2000);
    assert.equal(value(await app.notifications({ sessionId: cashier })).items.length, 1, "the cashier sees the overdue customer, unread for them");
    failure(await app.notifications({ sessionId }), "locked");

    const frame = {}, handlers = desktopHandlers(app, () => ({ schemaVersion: 28, shopName: "Shop" }), event => event === frame);
    for (const channel of ["kolo:tax-settings", "kolo:update-tax-settings", "kolo:product-tax", "kolo:set-product-tax", "kolo:payment-terms", "kolo:set-shop-terms", "kolo:credit-status", "kolo:set-party-terms", "kolo:notifications", "kolo:mark-notifications"]) {
      failure(await handlers[channel]!({}, { sessionId: cashier }) as Result<unknown>, "permission_denied");
      failure(await handlers[channel]!(frame, { sessionId: cashier }, "extra") as Result<unknown>, "invalid_input");
    }
    assert.equal(value(await handlers["kolo:notifications"]!(frame, { sessionId: cashier }) as Result<{ unread: number }>).unread, 1);
  } finally { await f.dispose(); }
});
