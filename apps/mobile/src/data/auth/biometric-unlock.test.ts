import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "@kolo/core/data/database/node-sqlite";
import { sqlitePreferences } from "../database/preferences.ts";
import { biometricUnlock, type BiometricVault } from "./biometric-unlock.ts";

const id = (n: number): string => `0190f1c2-0000-7000-8000-${String(n).padStart(12, "0")}`;
function setup(): { vault: BiometricVault & { data: Map<string, string>; failure: string | undefined; supported: boolean }; unlock: ReturnType<typeof biometricUnlock> } {
  const data = new Map<string, string>();
  const vault = { data, failure: undefined as string | undefined, supported: true,
    available: () => vault.supported,
    save: async (key: string, value: string) => { data.set(key, value); },
    load: async (key: string) => { if (vault.failure !== undefined) throw new Error(vault.failure); return data.get(key); },
    forget: async (key: string) => { data.delete(key); } };
  return { vault, unlock: biometricUnlock(vault, sqlitePreferences(openDatabase())) };
}
const member = { businessId: id(1), userId: id(2), credentialReference: "credential-ref" };

test("an enrolled member unlocks with the stored reference; the code is never stored", async () => {
  const { vault, unlock } = setup();
  assert.equal(unlock.allowed(), true); assert.equal(unlock.usable(), true); assert.equal(unlock.enrolled(member.userId), false);
  assert.deepEqual(await unlock.unlock(member.userId, "Unlock"), { kind: "gone" });
  await unlock.enroll(member);
  assert.equal(unlock.enrolled(member.userId), true); assert.equal(unlock.enrolled(id(3)), false);
  assert.deepEqual(JSON.parse(vault.data.get(`kolo.biometric.${member.userId}`)!), member);
  assert.deepEqual(await unlock.unlock(member.userId, "Unlock"), { kind: "member", member });
});

test("a cancelled prompt keeps the enrollment; an invalidated key or a malformed record forgets it", async () => {
  const { vault, unlock } = setup();
  await unlock.enroll(member);
  vault.failure = "User canceled the authentication";
  assert.deepEqual(await unlock.unlock(member.userId, "Unlock"), { kind: "cancelled" }); assert.equal(unlock.enrolled(member.userId), true);
  vault.failure = "android.security.keystore.KeyPermanentlyInvalidatedException: Key permanently invalidated";
  assert.deepEqual(await unlock.unlock(member.userId, "Unlock"), { kind: "gone" }); assert.equal(unlock.enrolled(member.userId), false);
  assert.equal(vault.data.size, 0);
  vault.failure = undefined;
  for (const stored of ["not json", "null", JSON.stringify({ ...member, userId: id(9) }), JSON.stringify({ ...member, credentialReference: "" }), JSON.stringify({ ...member, businessId: "x" })]) {
    await unlock.enroll(member); vault.data.set(`kolo.biometric.${member.userId}`, stored);
    assert.deepEqual(await unlock.unlock(member.userId, "Unlock"), { kind: "gone" }, stored); assert.equal(unlock.enrolled(member.userId), false, stored);
  }
});

test("the owner's switch off forgets every enrollment, and enrolling needs it on and supported hardware", async () => {
  const { vault, unlock } = setup(), other = { ...member, userId: id(4) };
  await unlock.enroll(member); await unlock.enroll(other);
  await unlock.setAllowed(false);
  assert.equal(unlock.allowed(), false); assert.equal(unlock.usable(), false); assert.equal(unlock.enrolled(member.userId), false);
  assert.equal(vault.data.size, 0);
  await assert.rejects(unlock.enroll(member));
  await unlock.setAllowed(true); assert.equal(unlock.enrolled(member.userId), false);
  vault.supported = false; assert.equal(unlock.usable(), false); await assert.rejects(unlock.enroll(member));
  vault.supported = true; await unlock.enroll(member); await unlock.forget(member.userId);
  assert.equal(unlock.enrolled(member.userId), false); assert.equal(vault.data.size, 0);
  await unlock.enroll(member); await unlock.enroll(other); await unlock.forgetAll();
  assert.equal(unlock.allowed(), true); assert.equal(unlock.enrolled(other.userId), false); assert.equal(vault.data.size, 0);
});
