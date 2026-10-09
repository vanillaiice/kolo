import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, SafeAreaView, Text, View } from "react-native";
import { currentInstallation, recoverWorkspaceSetup, lockWorkspace, unlockedActor } from "@kolo/core/identity/workspace";
import { sealPendingEvents } from "@kolo/core/application/exchange";
import { resumeOwnerRecovery } from "@kolo/core/identity/recovery";
import { resumeMemberProvisioning } from "@kolo/core/identity/members";
import type { InstallationState, OperationContext, WorkspacePorts } from "@kolo/core/identity/types";
import { HttpAuthTransport, type AuthTransport } from "@kolo/core/data/auth/login";
import { PERMISSIONS } from "@kolo/core/identity/permissions";
import type { Database } from "@kolo/core/data/database/driver";
import { openOnDevice, languageStorageOnDevice } from "../data/database/open-on-device.ts";
import { localCredentialsOnDevice, newIdOnDevice, exchangeCryptoOnDevice } from "../data/auth/local-credentials-on-device.ts";
import { WorkspaceScreen } from "../features/workspace/WorkspaceScreen.tsx";
import { MembersScreen } from "../features/workspace/MembersScreen.tsx";
import { TransferScreen } from "../features/transfer/TransferScreen.tsx";
import type { SnapshotPort } from "@kolo/core/backup/types";
import { ShopScreen } from "../features/shop/ShopScreen.tsx";
import { LanguageProvider, useText, LanguageControl } from "./i18n.tsx";
import { colors, spacing } from "../components/theme.ts";
import { API_BASE_URL } from "./config.ts";
import { seedDemoShop } from "./dev-seed.ts";

type Boot = { state: "opening" } | { state: "failed" } |
  { state: "ready"; ports: WorkspacePorts; files:SnapshotPort; installation: InstallationState; authority: AuthTransport };

/** Mobile always boots locked; core operations use local authority, independent of cloud sessions. */
function AppContent(): React.JSX.Element {
  const { t } = useText();
  const [boot, setBoot] = useState<Boot>({ state: "opening" });
  const [context, setContext] = useState<OperationContext>();
  const [staff, setStaff] = useState(false);
  const [transfers,setTransfers]=useState(false);
  const activeDatabase=useRef<Database|undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    let opened: ReturnType<typeof openOnDevice>;
    let database: Database;
    try { opened=openOnDevice();database=opened.database;activeDatabase.current=database; }
    catch { setBoot({ state: "failed" }); return; }
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
        await recoverWorkspaceSetup(ports); await resumeOwnerRecovery(ports);
        if (!disposed) setBoot({ state: "ready", ports, files:opened.files, installation: currentInstallation(database), authority });
      } catch { if (!disposed) setBoot({ state: "failed" }); }
    })();
    const subscription = AppState.addEventListener("change", state => {
      if (state !== "active") {
        const currentDatabase=activeDatabase.current!;lockWorkspace(currentDatabase); setContext(undefined); setStaff(false);
        setBoot(current => current.state === "ready" ? { ...current, installation: currentInstallation(currentDatabase) } : current);
      }
    });
    return () => { disposed = true; subscription.remove(); if(activeDatabase.current!==undefined){lockWorkspace(activeDatabase.current);activeDatabase.current.close();activeDatabase.current=undefined;}opened.close(); };
  }, []);
  useEffect(() => {
    if (context === undefined) return;
    let disposed = false, running = false;
    const seal = async (): Promise<void> => {
      if (disposed || running) return;
      running = true;
      try { await sealPendingEvents(context, exchangeCryptoOnDevice); }
      catch { /* Durable unsigned facts retry while unlocked; a sale already committed stays recorded. */ }
      finally { running = false; }
    };
    void seal();
    const interval = setInterval(() => { void seal(); }, 3000);
    return () => { disposed = true; clearInterval(interval); };
  }, [context]);
  const refresh = (): void => setBoot(current => current.state === "ready" ? { ...current, installation: currentInstallation(current.ports.database) } : current);
  const locked = (): void => {
    if (boot.state !== "ready") return;
    lockWorkspace(boot.ports.database); setContext(undefined); setStaff(false); refresh();
  };
  if (boot.state !== "ready") return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl }}>
    {boot.state === "opening" ? <ActivityIndicator color={colors.accent} /> : <><LanguageControl /><Text>{t("bootFailed")}</Text></>}
  </View></SafeAreaView>;
  if(transfers)return <TransferScreen ports={boot.ports} files={boot.files} context={context} onBack={()=>{setTransfers(false);refresh();}} onUnlocked={setContext} onActivated={database=>{
    const previous=activeDatabase.current;activeDatabase.current=database;setContext(undefined);setStaff(false);setTransfers(false);
    setBoot({...boot,ports:{...boot.ports,database},installation:currentInstallation(database)});if(previous!==undefined&&previous!==database)previous.close();
  }}/>;
  if (context === undefined) return <WorkspaceScreen key={boot.installation.state} ports={boot.ports} state={boot.installation} authority={boot.authority} onTransfer={()=>setTransfers(true)} onChanged={refresh} onUnlocked={unlocked => {
    if (AppState.currentState !== "active") { locked(); return; }
    const actor = unlockedActor(unlocked);
    if (actor.isOwner) void resumeMemberProvisioning(unlocked).catch(() => undefined);
    setContext(unlocked); refresh();
  }} />;
  const actor = unlockedActor(context);
  const canManageUsers=actor.isOwner&&boot.ports.database.get(`SELECT authority_allowed FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`,[context.businessId,context.deviceId])?.["authority_allowed"]===1;
  if (staff && canManageUsers) return <MembersScreen context={context} onBack={() => setStaff(false)} />;
  return <ShopScreen database={boot.ports.database} context={context} businessName={actor.businessName} userName={actor.userName} branchId={actor.branchId}
    onLock={locked} onTransfer={actor.isOwner?()=>setTransfers(true):undefined} onStaff={canManageUsers ? () => setStaff(true) : undefined} />;
}

/** Device language spans setup, staff, transfer and operational screens and survives cold boot. */
export default function App(): React.JSX.Element {
  return <LanguageProvider storage={languageStorageOnDevice}><AppContent /></LanguageProvider>;
}
