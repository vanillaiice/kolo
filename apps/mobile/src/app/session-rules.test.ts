import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSIONS, type Permission } from "@kolo/core/identity/permissions";
import { WorkspaceError } from "@kolo/core/identity/types";
import { ExchangeError } from "@kolo/core/exchange/types";
import { TransferError } from "@kolo/core/backup/types";
import { PhotoError } from "@kolo/core/data/products/photos";
import { RuleError } from "@kolo/core/rules/amounts";
import { DraftStore } from "./draft-store.ts";
import { availableTabs } from "./destinations.ts";
import { failureKey, FormProblem, nextVersion, requireVersion, StaleRecord } from "./failures.ts";
import { translate } from "./strings.ts";

test("drafts survive reads and navigation, notify only their key, and a new store starts empty", () => {
  const store = new DraftStore(); let cart = 0, other = 0;
  const stopCart = store.subscribe("sell", () => { cart++; }); store.subscribe("purchase", () => { other++; });
  assert.deepEqual(store.get("sell", () => ({ lines: 0 })), { lines: 0 });
  const value = { lines: 2 }; store.set("sell", value); store.set("sell", value);
  assert.equal(cart, 1, "setting the same value again is not a change"); assert.equal(other, 0);
  assert.equal(store.get("sell", () => ({ lines: 9 })), value, "the initial factory runs only once");
  store.delete("sell"); assert.equal(cart, 2); assert.deepEqual(store.get("sell", () => ({ lines: 0 })), { lines: 0 });
  stopCart(); store.set("sell", { lines: 5 }); assert.equal(cart, 2, "unsubscribed listeners are not called");
  assert.deepEqual(new DraftStore().get("sell", () => "fresh"), "fresh", "a new session holds no draft");
});

test("destinations follow permissions in fixed order and More is always reachable", () => {
  assert.deepEqual(availableTabs(PERMISSIONS), ["sell", "products", "activity", "more"]);
  assert.deepEqual(availableTabs([]), ["more"]);
  assert.deepEqual(availableTabs(["sales.create"]), ["more"], "selling needs the catalogue too");
  assert.deepEqual(availableTabs(["reports.sales"]), ["more"], "a report-only actor lands on More");
  assert.deepEqual(availableTabs(["products.view", "expenses.view"]), ["products", "activity", "more"]);
  assert.deepEqual(availableTabs(["sales.view_own", "sales.create", "products.view"] satisfies Permission[]), ["sell", "products", "activity", "more"]);
});

test("failures map to stable localized keys and never to raw messages", () => {
  const cases: [unknown, string][] = [
    [new FormProblem("nameRequired"), "nameRequired"], [new StaleRecord(), "changedMeanwhile"], [new ExchangeError("return_conflict"), "returnConflict"],
    [new WorkspaceError("permission_denied"), "denied"], [new WorkspaceError("locked"), "locked"], [new WorkspaceError("scope_mismatch"), "scopeMismatch"],
    [new PhotoError("photo_storage_full"), "photoStorageFull"], [new PhotoError("invalid_photo"), "invalidPhoto"], [new TransferError("too_large"), "transferError.too_large"],
    [new RuleError("overflow"), "TOO_LARGE"], [new RuleError("invalid_amount"), "INVALID_AMOUNT"], [new Error("SQLITE_CONSTRAINT secret"), "error"], ["x", "error"],
  ];
  for (const [error, key] of cases) {
    assert.equal(failureKey(error), key);
    assert.ok(!translate("en", failureKey(error)).includes("SQLITE"));
  }
});

test("edits advance past the stored version and refuse a stale one", () => {
  const now = Date.parse("2026-10-10T10:00:00.000Z");
  assert.equal(nextVersion("2026-10-10T09:00:00.000Z", now), "2026-10-10T10:00:00.000Z");
  assert.equal(nextVersion("2026-10-10T11:00:00.000Z", now), "2026-10-10T11:00:00.001Z", "a clock behind the stored edit still moves forward");
  assert.equal(nextVersion("garbage", now), "2026-10-10T10:00:00.000Z");
  assert.doesNotThrow(() => requireVersion({ updatedAt: "a" }, "a"));
  assert.throws(() => requireVersion({ updatedAt: "b" }, "a"), StaleRecord);
  assert.throws(() => requireVersion(undefined, "a"), StaleRecord);
});
