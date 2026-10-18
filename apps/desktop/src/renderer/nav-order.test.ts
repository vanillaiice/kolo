import assert from "node:assert/strict";
import { it } from "node:test";
import { NAV_IDS, dropNav, moveNav, normalizeNavOrder } from "./nav-order.ts";

it("a stored menu order is always complete, whatever was stored", () => {
  assert.deepEqual(normalizeNavOrder(undefined), [...NAV_IDS]);
  assert.deepEqual(normalizeNavOrder(["settings", "till"]).slice(0, 2), ["settings", "till"], "chosen sections first");
  assert.equal(normalizeNavOrder(["settings", "till"]).length, NAV_IDS.length, "sections a newer version added are kept");
  const repaired = normalizeNavOrder(["reports", "reports", "nope", 4, null]);
  assert.deepEqual([repaired[0], [...repaired].sort()], ["reports", [...NAV_IDS].sort()], "repeats and unknown entries are dropped");
  assert.deepEqual(normalizeNavOrder("not a list"), [...NAV_IDS]);
  assert.deepEqual(NAV_IDS.slice(-2), ["devices", "settings"], "backup & devices, then settings, close the menu");
  assert.deepEqual(normalizeNavOrder(["till", "products", "customers", "purchases", "finance", "analytics", "reports", "staff", "devices", "receipts", "settings"]), [...NAV_IDS],
    "the old default, saved without anyone choosing it, follows the new default");
  const chosen = ["settings", "till", "products", "customers", "purchases", "finance", "analytics", "reports", "staff", "receipts", "devices"];
  assert.deepEqual(normalizeNavOrder(chosen), ["settings", "till", "products", "customers", "purchases", "finance", "analytics", "reports", "journal", "staff", "receipts", "devices"],
    "a section added later lands after the one it follows by default, inside a chosen order");
});

it("moving and dragging keep every section exactly once", () => {
  const order = [...NAV_IDS];
  assert.deepEqual(moveNav(order, "products", -1).slice(0, 2), ["products", "till"]);
  assert.deepEqual(moveNav(order, "till", -1), order, "the first stays first");
  assert.deepEqual(moveNav(order, "settings", 1), order, "the last stays last");
  const dropped = dropNav(order, "settings", "till");
  assert.deepEqual(dropped.slice(0, 2), ["settings", "till"], "dropped onto the first: goes before it");
  assert.deepEqual(dropNav(order, "till", "products").slice(0, 2), ["products", "till"], "dragged down: goes after the target");
  for (const result of [dropped, dropNav(order, "devices", "customers"), moveNav(order, "staff", 1)]) assert.deepEqual([...result].sort(), [...NAV_IDS].sort());
});
