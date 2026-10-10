import type { SecretStore } from "@kolo/core/data/auth/secure-store";
import type { RememberedMember } from "@kolo/core/identity/workspace";
import type { PreferenceStorage } from "../database/preferences.ts";

const REMEMBERED_KEY = "kolo.session.remembered";
const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Stay signed in" for this phone, as on the desktop. */
export interface SessionMemory {
  /** Whether the option is on; on by default, off when the preference cannot be read. */
  enabled(): boolean;
  setEnabled(value: boolean): void;
  /** The remembered member, or undefined when absent, unreadable or malformed. */
  read(): Promise<RememberedMember | undefined>;
  /** Saves the remembered member, or forgets it with `undefined`. */
  write(value: RememberedMember | undefined): Promise<void>;
}

/**
 * The on/off choice is a plain device preference; the remembered member lives only in the
 * protected keystore. Neither enters shop backups or events.
 */
export function sessionMemory(vault: SecretStore, preferences: PreferenceStorage): SessionMemory {
  return {
    enabled() { try { return preferences.read("rememberSession") !== "off"; } catch { return false; } },
    setEnabled(value) { preferences.write("rememberSession", value ? "on" : "off"); },
    async read() {
      let parsed: unknown;
      try { const stored = await vault.read(REMEMBERED_KEY); if (stored === undefined) return undefined; parsed = JSON.parse(stored); }
      catch { return undefined; }
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const { businessId, userId, credentialReference } = parsed as Record<string, unknown>;
      if (typeof businessId !== "string" || !IDENTIFIER.test(businessId) || typeof userId !== "string" || !IDENTIFIER.test(userId) ||
        typeof credentialReference !== "string" || credentialReference.length === 0 || credentialReference.length > 300) return undefined;
      return { businessId, userId, credentialReference };
    },
    async write(value) {
      if (value === undefined) await vault.forget(REMEMBERED_KEY);
      else await vault.write(REMEMBERED_KEY, JSON.stringify({ businessId: value.businessId, userId: value.userId, credentialReference: value.credentialReference }));
    },
  };
}
