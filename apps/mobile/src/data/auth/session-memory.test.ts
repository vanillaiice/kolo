import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecretStore } from "@kolo/core/data/auth/secure-store";
import type { PreferenceStorage } from "../database/preferences.ts";
import { sessionMemory } from "./session-memory.ts";

const id = (n: number): string => `0190f1c2-0000-7000-8000-${String(n).padStart(12, "0")}`;
function fakes(): { vault: SecretStore & { data: Map<string, string> }; preferences: PreferenceStorage & { data: Map<string, string>; broken: boolean } } {
  const data = new Map<string, string>(), prefs = new Map<string, string>();
  const preferences = { data: prefs, broken: false, read(key: string) { if (preferences.broken) throw new Error("io"); return prefs.get(key); }, write(key: string, value: string) { prefs.set(key, value); } };
  return { vault: { data, read: async key => data.get(key), write: async (key, value) => { data.set(key, value); }, forget: async key => { data.delete(key); } }, preferences };
}

test("stay signed in is on by default, off on request, and off when the preference cannot be read", () => {
  const { vault, preferences } = fakes(), memory = sessionMemory(vault, preferences);
  assert.equal(memory.enabled(), true);
  memory.setEnabled(false); assert.equal(memory.enabled(), false);
  memory.setEnabled(true); assert.equal(memory.enabled(), true);
  preferences.broken = true; assert.equal(memory.enabled(), false);
});

test("the remembered member round-trips through the vault and malformed records grant nothing", async () => {
  const { vault, preferences } = fakes(), memory = sessionMemory(vault, preferences);
  const member = { businessId: id(1), userId: id(2), credentialReference: "credential-ref" };
  assert.equal(await memory.read(), undefined);
  await memory.write(member); assert.deepEqual(await memory.read(), member);
  await memory.write(undefined); assert.equal(await memory.read(), undefined);
  for (const stored of ["not json", "null", "[]", JSON.stringify({ ...member, userId: "x" }), JSON.stringify({ ...member, credentialReference: "" }), JSON.stringify({ ...member, businessId: 3 })]) {
    vault.data.set("kolo.session.remembered", stored); assert.equal(await memory.read(), undefined, stored);
  }
  const failing = sessionMemory({ ...vault, read: async () => { throw new Error("keystore"); } }, preferences);
  assert.equal(await failing.read(), undefined);
});
