import { preferenceStorageOnDevice } from "../database/open-on-device.ts";

/** The server a phone joined through, so it connects there once signed in even if the owner's shared address differs. */
export interface JoinServer { readonly url: string; readonly fingerprint?: string }
/** Remembers the server for the first sign-in after joining. Best effort: the owner's shared address still works. */
export async function rememberJoinServer(server: JoinServer): Promise<void> { try { preferenceStorageOnDevice.write("joinServer", JSON.stringify(server)); } catch { /* See above. */ } }
/** Reads and forgets the remembered server. */
export function takeJoinServer(): JoinServer | undefined {
  try {
    const text = preferenceStorageOnDevice.read("joinServer");
    if (typeof text !== "string" || text === "") return undefined;
    preferenceStorageOnDevice.write("joinServer", "");
    const value = JSON.parse(text) as JoinServer;
    return typeof value.url === "string" ? value : undefined;
  } catch { return undefined; }
}
