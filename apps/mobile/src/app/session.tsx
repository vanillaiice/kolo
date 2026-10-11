import { createContext, useCallback, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";
import { changeRevision, subscribeChanges, type ChangedDomain } from "@kolo/core/data/database/changes";
import type { Database } from "@kolo/core/data/database/driver";
import { capabilities } from "@kolo/core/application/queries";
import type { Permission } from "@kolo/core/identity/permissions";
import type { OperationContext, WorkspacePorts } from "@kolo/core/identity/types";
import type { SnapshotPort } from "@kolo/core/backup/types";
import { DraftStore } from "./draft-store.ts";
import type { SlotControl } from "../data/database/open-on-device.ts";
import type { BiometricUnlock } from "../data/auth/biometric-unlock.ts";

/**
 * One unlocked session. Everything below the session provider is keyed by `generation`, so
 * lock, actor change or database replacement unmounts its screens, drafts and subscriptions.
 */
export interface Session {
  readonly database: Database; readonly ports: WorkspacePorts; readonly files: SnapshotPort; readonly slots: SlotControl;
  readonly context: OperationContext; readonly generation: number;
  readonly businessName: string; readonly userName: string; readonly isOwner: boolean; readonly branchId: string | undefined;
  /** Owner on a device whose pairing allows staff management. */
  readonly canManageStaff: boolean;
  /** Locks now and forgets the remembered user: drafts, previews and privileged state are discarded. */
  readonly lock: () => void;
  /** "Stay signed in" on this phone (default on): no lock on background, cold boot reopens this user. */
  readonly rememberSession: boolean;
  /** Turns "Stay signed in" on (remembering this user) or off (forgetting them; background and cold boot lock again). */
  readonly setRememberSession: (enabled: boolean) => void;
  /** True while `generation` is still the unlocked session; async results check it before touching UI. */
  readonly isCurrent: (generation: number) => boolean;
  /**
   * Runs an Android screen KOLO opens itself (file/photo pickers, share, print). The app stays
   * signed in while it is open, even with "Stay signed in" off; a result that returns after a lock
   * or session change is refused with `locked`, and the actor must still be active.
   */
  readonly systemUi: <T>(task: () => Promise<T>) => Promise<T>;
  /** Fingerprint or face unlock on this phone: the owner's switch and each member's enrollment. */
  readonly biometric: BiometricUnlock;
  /** Erases every shop and its keystore entries on this phone and starts empty (owner, after confirmation). */
  readonly resetDevice: () => void;
  /** Replaces the active database after an owner restore or pairing completion. */
  readonly activate: (database: Database) => void;
}

const SessionContext = createContext<Session | undefined>(undefined);
/** Provides the unlocked session and a fresh draft store; key it by generation. */
export function SessionProvider({ session, children }: { readonly session: Session; readonly children: ReactNode }): React.JSX.Element {
  const store = useRef<DraftStore | undefined>(undefined);
  store.current ??= new DraftStore();
  return <SessionContext.Provider value={session}><DraftContext.Provider value={store.current}>{children}</DraftContext.Provider></SessionContext.Provider>;
}
/** The current unlocked session; only screens under the shop shell call this. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === undefined) throw new Error("useSession outside an unlocked session");
  return session;
}

/** Whether the screen is the visible top of its stack; hidden screens freeze their queries. */
export const ActiveContext = createContext(true);
/**
 * Subscribes to committed SQLite domain revisions; screens then reread SQLite. A hidden
 * screen keeps its last revision and rereads once it becomes visible again.
 */
export function useRevision(domains: readonly ChangedDomain[]): string {
  const { database } = useSession(), active = useContext(ActiveContext), key = domains.join(",");
  const last = useRef("");
  const subscribe = useCallback((notify: () => void) => active ? subscribeChanges(database, key.split(",") as ChangedDomain[], notify) : () => undefined, [database, key, active]);
  const snapshot = useCallback(() => {
    if (active || last.current === "") last.current = changeRevision(database, key.split(",") as ChangedDomain[]);
    return last.current;
  }, [database, key, active]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
/** Current effective permissions, refreshed when authority changes; empty when the context is no longer valid. */
export function usePermissions(): readonly Permission[] {
  const { context } = useSession(), revision = useRevision(["authority"]);
  const cache = useRef<{ revision: string; value: readonly Permission[] }>(undefined);
  if (cache.current?.revision !== revision) {
    let value: readonly Permission[] = [];
    try { value = capabilities(context); } catch { /* A locked or revoked context exposes nothing. */ }
    cache.current = { revision, value };
  }
  return cache.current.value;
}

const DraftContext = createContext<DraftStore | undefined>(undefined);
/**
 * A draft that survives navigation within the session (screens may unmount) and is discarded
 * with the session on lock, actor change, database replacement or cold boot.
 */
export function useDraft<T>(key: string, initial: () => T): [T, (update: T | ((current: T) => T)) => void, () => void] {
  const store = useContext(DraftContext);
  if (store === undefined) throw new Error("useDraft outside a session");
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [store, key]);
  const read = (): T => store.get(key, initial);
  const value = useSyncExternalStore(subscribe, read, read);
  const set = useCallback((update: T | ((current: T) => T)) => {
    const current = store.get(key, initial);
    store.set(key, typeof update === "function" ? (update as (current: T) => T)(current) : update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key]);
  const clear = useCallback(() => store.delete(key), [store, key]);
  return [value, set, clear];
}

