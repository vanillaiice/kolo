import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import type { RememberedMember } from "@kolo/core/identity/workspace";
import { desktopSecretStore, type NativeSafeStorage } from "./local-credentials.ts";
import type { SessionMemory } from "./application.ts";

const rememberedKey = "kolo.session.remembered";
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stay-signed-in storage for one desktop user-data directory. The remembered member is kept only
 * in the OS-protected vault; the on/off choice is a plain flag that defaults to on. Malformed or
 * unreadable records are treated as absent.
 */
export function desktopSessionMemory(directory: string, native: NativeSafeStorage, platform: string = process.platform): SessionMemory {
  const vault = desktopSecretStore(directory, native, platform), flag = join(directory, "remember-session.json");
  return {
    async enabled() {
      try { return (JSON.parse(await readFile(flag, "utf8")) as { enabled?: unknown }).enabled !== false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; return false; }
    },
    async setEnabled(value) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${flag}.${randomUUIDv7()}.pending`, handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ enabled: value })); await handle.sync(); }
      finally { await handle.close(); }
      try { await rename(temporary, flag); }
      catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    },
    async read() {
      let parsed: unknown;
      try { const stored = await vault.read(rememberedKey); if (stored === undefined) return undefined; parsed = JSON.parse(stored); }
      catch { return undefined; }
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const { businessId, userId, credentialReference } = parsed as Record<string, unknown>;
      if (typeof businessId !== "string" || !identifier.test(businessId) || typeof userId !== "string" || !identifier.test(userId) ||
        typeof credentialReference !== "string" || credentialReference.length === 0 || credentialReference.length > 300) return undefined;
      return { businessId, userId, credentialReference } satisfies RememberedMember;
    },
    async write(value) {
      if (value === undefined) await vault.forget(rememberedKey);
      else await vault.write(rememberedKey, JSON.stringify({ businessId: value.businessId, userId: value.userId, credentialReference: value.credentialReference }));
    },
  };
}
