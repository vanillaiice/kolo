import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, StatusBar, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import * as SplashScreen from "expo-splash-screen";
import { currentInstallation, recoverWorkspaceSetup, lockWorkspace, unlockedActor, rememberMember, resumeWorkspace, type RememberedMember } from "@kolo/core/identity/workspace";
import { sealPendingEvents } from "@kolo/core/application/exchange";
import { ServerSyncScheduler } from "@kolo/core/application/sync-scheduler";
import { resumeOwnerRecovery } from "@kolo/core/identity/recovery";
import { resumeMemberProvisioning } from "@kolo/core/identity/members";
import { WorkspaceError, type InstallationState, type OperationContext, type WorkspacePorts } from "@kolo/core/identity/types";
import { HttpAuthTransport, type AuthTransport } from "@kolo/core/data/auth/login";
import { PERMISSIONS } from "@kolo/core/identity/permissions";
import { subscribeChanges } from "@kolo/core/data/database/changes";
import type { Database } from "@kolo/core/data/database/driver";
import type { SnapshotPort } from "@kolo/core/backup/types";
import { eraseShopsOnDevice, openOnDevice, preferenceStorageOnDevice, type SlotControl } from "../data/database/open-on-device.ts";
import { localCredentialsOnDevice, newIdOnDevice, exchangeCryptoOnDevice, sealingCryptoOnDevice } from "../data/auth/local-credentials-on-device.ts";
import { syncTransportOnDevice } from "../data/sync/sync-on-device.ts";
import { takeJoinServer } from "../data/sync/join-server.ts";
import { connectServer, previewServer } from "@kolo/core/application/server-sync";
import { secretStoreOnDevice } from "../data/auth/store-on-device.ts";
import { sessionMemory } from "../data/auth/session-memory.ts";
import { biometricUnlock } from "../data/auth/biometric-unlock.ts";
import { biometricVaultOnDevice } from "../data/auth/biometric-on-device.ts";
import { EntryScreen } from "../features/entry/EntryScreen.tsx";
import { Shell } from "../features/shell/Shell.tsx";
import { Notice, Page } from "../components/ui.tsx";
import { spacing, useTheme } from "../components/theme.ts";
import { PreferencesProvider, useText } from "./i18n.tsx";
import { SessionProvider, type Session } from "./session.tsx";
import { API_BASE_URL } from "./config.ts";
import { seedDemoShop } from "./dev-seed.ts";
import { LanguageControl } from "../components/controls.tsx";

// The native launch screen (logo on brand green) stays up until the shop database has opened.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);
const hideSplash = (): void => { void SplashScreen.hideAsync().catch(() => undefined); };

type Boot = { state: "opening" } | { state: "failed" } |
  { state: "ready"; ports: WorkspacePorts; files: SnapshotPort; slots: SlotControl; installation: InstallationState; authority: AuthTransport };
/** Every domain a business commit can touch; any of them may leave an unsigned event to seal. */
const ALL_DOMAINS = ["products", "inventory", "sales", "customers", "suppliers", "purchases", "accounts", "expenses", "authority"] as const;
/** Coalescing window after a commit, and the recovery retry while unlocked. */
const SEAL_DELAY_MS = 400, SEAL_RETRY_MS = 60_000;
/** How often the server-sync schedule is checked while signed in; the schedule itself decides whether a pass is due. */
const SYNC_TICK_MS = 15_000;

/**
 * With "Stay signed in" on (the default, as on the desktop) the last user stays signed in across
 * background and cold boot; with it off the phone boots locked and locks in the background. Core
 * operations use local authority. Each unlock starts a new session generation: screens, drafts and subscriptions under
 * it unmount on lock, actor change or database replacement, and late async results are refused.
 */
function AppContent(): React.JSX.Element {
  const { t } = useText(), { colors, scheme } = useTheme();
  const [boot, setBoot] = useState<Boot>({ state: "opening" });
  useEffect(() => { if (boot.state !== "opening") hideSplash(); }, [boot.state]);
  // A slow first open (large migration) falls back to the in-app spinner rather than a frozen logo.
  useEffect(() => { const timer = setTimeout(hideSplash, 8000); return () => clearTimeout(timer); }, []);
  const [unlocked, setUnlocked] = useState<{ context: OperationContext; generation: number }>();
  const generation = useRef(0);
  const activeDatabase = useRef<Database | undefined>(undefined);
  const unlockedRef = useRef(false), resetting = useRef(false), [bootRun, setBootRun] = useState(0);
  // Declared before the boot effect, which closes any retired handles before a reset erases files.
  const retired = useRef<Database[]>([]);
  /** Android screens KOLO itself opened (file/photo pickers, share, print) that are still open. */
  const systemScreens = useRef(0);

  // "Stay signed in" (on by default, as on the desktop): the phone does not lock on background and a
  // cold boot reopens the last unlocked user. Off restores locking on background and cold boot.
  const memory = useMemo(() => sessionMemory(secretStoreOnDevice(), preferenceStorageOnDevice), []);
  const biometric = useMemo(() => biometricUnlock(biometricVaultOnDevice(), preferenceStorageOnDevice), []);
  const [remember, setRemember] = useState(() => memory.enabled());
  const rememberRef = useRef(remember); rememberRef.current = remember;
  /** Saves or forgets the remembered user; failure only means the next start is locked. A save overtaken by a lock is undone. */
  const store = useCallback(async (value: RememberedMember | undefined, owner?: number): Promise<void> => {
    try {
      await memory.write(value);
      if (value !== undefined && owner !== undefined && owner !== generation.current) await memory.write(undefined);
    } catch { /* The keystore is unavailable: the next cold boot opens locked. */ }
  }, [memory]);

  const refresh = useCallback((): void => setBoot(current => current.state === "ready" ? { ...current, installation: currentInstallation(activeDatabase.current ?? current.ports.database) } : current), []);
  const lock = useCallback((): void => {
    // Only an unlocked session gets a new generation; locking the entry screen must not reset its steps.
    if (unlockedRef.current) generation.current++;
    unlockedRef.current = false;
    if (activeDatabase.current !== undefined) lockWorkspace(activeDatabase.current);
    setUnlocked(undefined); refresh();
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let opened: ReturnType<typeof openOnDevice>;
    // A device reset runs here, after the previous boot's handles were closed by its cleanup.
    let erased: string[] = [];
    for (const database of retired.current.splice(0)) { try { database.close(); } catch { /* Already closed. */ } }
    if (resetting.current) { resetting.current = false; try { erased = eraseShopsOnDevice(); } catch { setBoot({ state: "failed" }); return; } }
    try { opened = openOnDevice(); activeDatabase.current = opened.database; }
    catch { setBoot({ state: "failed" }); return; }
    const database = opened.database;
    const ports: WorkspacePorts = { database, credentials: localCredentialsOnDevice(), newId: newIdOnDevice, now: () => new Date().toISOString() };
    let authority: AuthTransport = new HttpAuthTransport({ baseUrl: API_BASE_URL });
    if (__DEV__ && process.env["EXPO_PUBLIC_DEMO_SHOP"] === "1") {
      seedDemoShop(database);
      // Only the explicit developer seed gets a synthetic authority transport.
      // Production never treats cached role/shop UUID as owner proof.
      if (database.get(`SELECT id FROM businesses`)?.["id"] === "00000000-0000-7000-8000-000000000001") {
        authority = { login: async request => {
          if (request.businessId !== "00000000-0000-7000-8000-000000000001" || request.device.id !== "00000000-0000-7000-8000-000000000003") throw new Error("not the developer fixture");
          const now = new Date();
          return { token: "developer-only", business: { id: request.businessId, name: "Boutique Chez Jean", currency: "XAF" }, branches: [],
            user: { id: "00000000-0000-7000-8000-000000000002", name: "Jean Mbarga", role: "OWNER", permissions: PERMISSIONS },
            device: { id: request.device.id, label: "Caisse 1", platform: "ANDROID" },
            session: { id: newIdOnDevice(), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() } };
        } };
      }
    }
    void (async () => {
      try {
        const vault = secretStoreOnDevice();
        for (const key of erased) await vault.forget(key).catch(() => undefined);
        await recoverWorkspaceSetup(ports); await resumeOwnerRecovery(ports);
        // A remembered member reopens only if business, device and member are still active with the same credential.
        let resumed: OperationContext | undefined;
        const remembered = memory.enabled() ? await memory.read() : undefined;
        if (remembered !== undefined) { try { resumed = resumeWorkspace(remembered, ports); } catch { await memory.write(undefined).catch(() => undefined); } }
        if (disposed) return;
        setBoot({ state: "ready", ports, files: opened.files, slots: opened.slots, installation: currentInstallation(database), authority });
        if (resumed !== undefined) { generation.current++; unlockedRef.current = true; setUnlocked({ context: resumed, generation: generation.current }); }
      } catch { if (!disposed) setBoot({ state: "failed" }); }
    })();
    return () => {
      disposed = true;
      if (activeDatabase.current !== undefined) { lockWorkspace(activeDatabase.current); if (activeDatabase.current !== database) activeDatabase.current.close(); activeDatabase.current = undefined; }
      database.close(); opened.close();
    };
  }, [bootRun]);

  // With "Stay signed in" off, leaving the app locks it at once. Android screens KOLO opened itself
  // (file and photo pickers, share, print) count as staying in the app and do not lock.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => { if (state !== "active" && !rememberRef.current && systemScreens.current === 0) lock(); });
    return () => subscription.remove();
  }, [lock]);

  // Commit-triggered, coalesced, single-flight sealing of unsigned events while unlocked, with a slow recovery retry.
  useEffect(() => {
    if (unlocked === undefined || boot.state !== "ready") return;
    const { context } = unlocked, database = activeDatabase.current!;
    let disposed = false, running = false, again = false, timer: ReturnType<typeof setTimeout> | undefined;
    const seal = async (): Promise<void> => {
      timer = undefined;
      if (disposed) return;
      if (running) { again = true; return; }
      running = true;
      try { await sealPendingEvents(context, exchangeCryptoOnDevice); }
      catch { /* Durable unsigned facts retry while unlocked; a committed sale stays recorded. */ }
      finally { running = false; if (again && !disposed) { again = false; schedule(); } }
    };
    const schedule = (): void => { if (timer === undefined && !disposed) timer = setTimeout(() => { void seal(); }, SEAL_DELAY_MS); };
    const unsubscribe = subscribeChanges(database, ALL_DOMAINS, schedule);
    const retry = setInterval(schedule, SEAL_RETRY_MS);
    schedule();
    return () => { disposed = true; unsubscribe(); clearInterval(retry); if (timer !== undefined) clearTimeout(timer); };
  }, [unlocked, boot.state]);

  // Optional server sync while signed in and in the foreground: every minute, soon after a local change and on return to
  // the app. It needs shop-settings access and does nothing until a server is connected or the owner shares one.
  useEffect(() => {
    if (unlocked === undefined || boot.state !== "ready") return;
    const { context } = unlocked, database = activeDatabase.current!;
    const scheduler = new ServerSyncScheduler(sealingCryptoOnDevice, syncTransportOnDevice);
    let disposed = false;
    const tick = (): void => { if (!disposed && AppState.currentState === "active") void scheduler.tick(context).catch(() => undefined); };
    const unsubscribe = subscribeChanges(database, ALL_DOMAINS, () => scheduler.soon());
    const appState = AppState.addEventListener("change", state => { if (state === "active") { scheduler.soon(); setTimeout(tick, 5_500); } });
    const timer = setInterval(tick, SYNC_TICK_MS);
    // Just joined by code: connect to the server the phone joined through, then sync as usual.
    const joined = takeJoinServer();
    if (joined !== undefined) void (async () => {
      const transport = syncTransportOnDevice(joined.url), fingerprint = joined.fingerprint ?? (await previewServer(transport, sealingCryptoOnDevice)).fingerprint;
      await connectServer(context, transport, { url: joined.url, fingerprint, source: "shop" }, sealingCryptoOnDevice);
    })().catch(() => undefined).finally(tick);
    else tick();
    return () => { disposed = true; unsubscribe(); appState.remove(); clearInterval(timer); };
  }, [unlocked, boot.state]);

  // A replaced database is closed only after the screens that used it have unmounted: a query on a closed
  // native handle corrupts memory in expo-sqlite and aborts the app.
  useEffect(() => {
    for (const database of retired.current.splice(0)) { try { database.close(); } catch { /* Already closed. */ } }
  }, [boot, unlocked]);
  const activate = useCallback((database: Database): void => {
    const previous = activeDatabase.current;
    void store(undefined);
    generation.current++; unlockedRef.current = false; activeDatabase.current = database; setUnlocked(undefined);
    setBoot(current => current.state === "ready" ? { ...current, ports: { ...current.ports, database }, installation: currentInstallation(database) } : current);
    if (previous !== undefined && previous !== database) retired.current.push(previous);
  }, [store]);
  const onUnlocked = useCallback((context: OperationContext): void => {
    if (!rememberRef.current && AppState.currentState !== "active" && systemScreens.current === 0) { lockWorkspace(activeDatabase.current!); refresh(); return; }
    const actor = unlockedActor(context);
    if (actor.isOwner) void resumeMemberProvisioning(context).catch(() => undefined);
    generation.current++; unlockedRef.current = true;
    setUnlocked({ context, generation: generation.current }); refresh();
    if (rememberRef.current) { try { void store(rememberMember(context), generation.current); } catch { /* Not remembered: next start is locked. */ } }
  }, [refresh, store]);
  /** The Lock button: locks now and forgets the remembered user, so the next start asks for a code. */
  const lockNow = useCallback((): void => { lock(); void store(undefined); }, [lock, store]);
  /** Erases every shop on this phone and its keystore entries, then boots empty; preferences stay. */
  const resetDevice = useCallback((): void => {
    resetting.current = true; void store(undefined); void biometric.forgetAll().catch(() => undefined);
    generation.current++; unlockedRef.current = false; setUnlocked(undefined); setBoot({ state: "opening" }); setBootRun(run => run + 1);
  }, [store, biometric]);
  const changeRemember = useCallback((context: OperationContext, enabled: boolean): void => {
    memory.setEnabled(enabled); setRemember(enabled);
    void store(enabled ? rememberMember(context) : undefined, generation.current);
  }, [memory, store]);

  /** Runs an Android screen KOLO opened (picker, share, print); the app stays signed in while it is open. */
  const entrySystemUi = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    systemScreens.current++;
    try { return await task(); } finally { systemScreens.current--; }
  }, []);

  const session = useMemo<Session | undefined>(() => {
    if (unlocked === undefined || boot.state !== "ready") return undefined;
    let actor: ReturnType<typeof unlockedActor>;
    try { actor = unlockedActor(unlocked.context); } catch { return undefined; }
    const database = boot.ports.database, context = unlocked.context;
    const canManageStaff = actor.isOwner && database.get(`SELECT authority_allowed FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`, [context.businessId, context.deviceId])?.["authority_allowed"] === 1;
    return {
      database, ports: boot.ports, files: boot.files, slots: boot.slots, context, generation: unlocked.generation, businessName: actor.businessName, userName: actor.userName,
      isOwner: actor.isOwner, branchId: actor.branchId, canManageStaff, lock: lockNow, activate,
      rememberSession: remember, setRememberSession: enabled => changeRemember(context, enabled), resetDevice, biometric,
      isCurrent: value => value === generation.current,
      systemUi: async task => {
        const owner = unlocked.generation, result = await entrySystemUi(task);
        // A result returned after a lock or session change is refused; the actor must still be active.
        if (generation.current !== owner) throw new WorkspaceError("locked");
        try { unlockedActor(context); } catch { lock(); throw new WorkspaceError("locked"); }
        return result;
      },
    };
  }, [unlocked, boot, lock, lockNow, activate, remember, changeRemember, entrySystemUi, resetDevice, biometric]);

  if (boot.state !== "ready") return <Page><View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.lg }}>
    {boot.state === "opening" ? <ActivityIndicator color={colors.primary} /> : <><LanguageControl /><Notice tone="error" text={t("bootFailed")} /></>}
  </View></Page>;
  return <>
    <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} backgroundColor={colors.surface} />
    {session === undefined
      ? <EntryScreen key={`${boot.installation.state}-${generation.current}`} ports={boot.ports} files={boot.files} slots={boot.slots} state={boot.installation} authority={boot.authority}
          onChanged={refresh} onUnlocked={onUnlocked} onActivated={activate} systemUi={entrySystemUi} biometric={biometric} />
      : <SessionProvider key={session.generation} session={session}><Shell /></SessionProvider>}
  </>;
}

/** Device language and appearance span entry, staff, transfer and operational screens and survive cold boot. */
export default function App(): React.JSX.Element {
  return <SafeAreaProvider><KeyboardProvider><PreferencesProvider storage={preferenceStorageOnDevice}><AppContent /></PreferencesProvider></KeyboardProvider></SafeAreaProvider>;
}
