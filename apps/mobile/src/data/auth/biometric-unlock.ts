import type { RememberedMember } from "@kolo/core/identity/workspace";
import type { PreferenceStorage } from "../database/preferences.ts";

const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyOf = (userId: string): string => `kolo.biometric.${userId}`;

/**
 * The phone's keystore entries that only open after the system fingerprint or face check
 * (`expo-secure-store` with `requireAuthentication`). `load` shows the system prompt and throws when
 * it is cancelled or fails; a key Android invalidated (new fingerprint enrolled) also throws.
 */
export interface BiometricVault {
  /** Whether this phone has strong biometrics set up that can protect a keystore entry. */
  available(): boolean;
  save(key: string, value: string): Promise<void>;
  load(key: string, prompt: string): Promise<string | undefined>;
  forget(key: string): Promise<void>;
}

/** What a fingerprint unlock attempt produced. */
export type BiometricResult =
  | { readonly kind: "member"; readonly member: RememberedMember }
  /** The prompt was dismissed or did not match: the entry is kept, the code still works. */
  | { readonly kind: "cancelled" }
  /** Nothing usable was stored for this member; the enrollment has been forgotten. */
  | { readonly kind: "gone" };

/**
 * Fingerprint or face unlock for members of this phone, beside "Stay signed in".
 *
 * Each enrolled member's remembered-session reference ({@link RememberedMember}) is kept behind the
 * system biometric check; the unlock code itself is never stored. A successful check hands the
 * reference to `resumeWorkspace`, which still requires the same active member, device, business and
 * credential, so a changed code, an owner recovery or a restored backup makes it stale. Android asks
 * for any fingerprint registered on the phone, not a particular person's: enrollment is opt-in per
 * member, and the owner can switch it off for the whole phone, which forgets every enrollment.
 * Which members are enrolled is a plain device preference, so the unlock screen can offer the
 * button without prompting.
 */
export interface BiometricUnlock {
  /** The owner's switch for this phone; on by default, off when the preference cannot be read. */
  allowed(): boolean;
  /** Turning it off forgets every enrolled member on this phone. */
  setAllowed(value: boolean): Promise<void>;
  /** Allowed here and supported by the phone. */
  usable(): boolean;
  enrolled(userId: string): boolean;
  /** Saves the member's reference behind the biometric check (Android prompts while saving). */
  enroll(member: RememberedMember): Promise<void>;
  forget(userId: string): Promise<void>;
  /** Forgets every enrolled member (device reset), leaving the owner's switch as it is. */
  forgetAll(): Promise<void>;
  /** Shows the system prompt and returns the stored reference for `userId`. */
  unlock(userId: string, prompt: string): Promise<BiometricResult>;
}

/** Wires the vault and the device preferences; see {@link BiometricUnlock}. */
export function biometricUnlock(vault: BiometricVault, preferences: PreferenceStorage): BiometricUnlock {
  const members = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(String(preferences.read("biometricMembers") ?? "[]"));
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && IDENTIFIER.test(item)) : [];
    } catch { return []; }
  };
  const setMembers = (list: readonly string[]): void => { preferences.write("biometricMembers", JSON.stringify([...new Set(list)])); };
  const allowed = (): boolean => { try { return preferences.read("biometricAllowed") !== "off"; } catch { return false; } };
  const forget = async (userId: string): Promise<void> => {
    setMembers(members().filter(item => item !== userId));
    await vault.forget(keyOf(userId)).catch(() => undefined);
  };
  return {
    allowed,
    async setAllowed(value) {
      preferences.write("biometricAllowed", value ? "on" : "off");
      if (!value) for (const userId of members()) await forget(userId);
    },
    async forgetAll() { for (const userId of members()) await forget(userId); },
    usable() { try { return allowed() && vault.available(); } catch { return false; } },
    enrolled(userId) { return allowed() && members().includes(userId); },
    async enroll(member) {
      if (!allowed() || !vault.available() || !IDENTIFIER.test(member.userId)) throw new Error("biometric_unavailable");
      await vault.save(keyOf(member.userId), JSON.stringify({ businessId: member.businessId, userId: member.userId, credentialReference: member.credentialReference }));
      setMembers([...members(), member.userId]);
    },
    forget,
    async unlock(userId, prompt) {
      if (!allowed() || !members().includes(userId)) return { kind: "gone" };
      let stored: string | undefined;
      try { stored = await vault.load(keyOf(userId), prompt); }
      catch (error) {
        // Android invalidates the key when a fingerprint is added or removed; that entry can never open again.
        if (/invalidat/i.test(error instanceof Error ? error.message : String(error))) { await forget(userId); return { kind: "gone" }; }
        return { kind: "cancelled" };
      }
      let parsed: unknown;
      try { parsed = stored === undefined ? undefined : JSON.parse(stored); } catch { parsed = undefined; }
      const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
      const { businessId, credentialReference } = record;
      if (record["userId"] !== userId || typeof businessId !== "string" || !IDENTIFIER.test(businessId) ||
        typeof credentialReference !== "string" || credentialReference.length === 0 || credentialReference.length > 300) { await forget(userId); return { kind: "gone" }; }
      return { kind: "member", member: { businessId, userId, credentialReference } };
    },
  };
}
