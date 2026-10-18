import { useCallback, useEffect, useRef, useState } from "react";
import type { ShopService, WorkspaceView } from "../shared/service.ts";
import { Workspace } from "./components/Workspace.tsx";
import { Products } from "./components/Products.tsx";
import { Till } from "./components/Till.tsx";
import { Receipts } from "./components/Receipts.tsx";
import { Customers } from "./components/Customers.tsx";
import { Purchases } from "./components/Purchases.tsx";
import { Finance } from "./components/Finance.tsx";
import { Analytics } from "./components/Analytics.tsx";
import { Reports } from "./components/Reports.tsx";
import { Staff } from "./components/Staff.tsx";
import { Journal } from "./components/Journal.tsx";
import { Devices } from "./components/Transfer.tsx";
import { applyAppearance, Settings, storedAppearance, type Appearance } from "./components/Settings.tsx";
import { LegalDialog, LegalLinks } from "./components/Legal.tsx";
import type { LegalKind } from "./legal.ts";
import { call, ErrorText, Field, TextContext, useAction, useText, type Message } from "./components/ui.tsx";
import { text, type Language } from "./text.ts";
import { dropNav, saveNavOrder, storedNavOrder, type NavId } from "./nav-order.ts";
import { AlertsButton, AlertsPanel, useNotifications, type AlertTarget } from "./components/Notifications.tsx";

/** Reusable DOM application: platform operations enter only through the injected service. */
export function App({service}:{readonly service:ShopService}):React.JSX.Element{
  const [language,setLanguage]=useState<Language>(()=>{try{return localStorage.getItem("kolo.language")==="en"?"en":"fr";}catch{return "fr";}});
  const [appearance,setAppearance]=useState<Appearance>(storedAppearance),[legal,setLegal]=useState<LegalKind>();
  const [navOrder,setNavOrder]=useState<NavId[]>(storedNavOrder);
  // Saved only when the person reorders, so a later default reaches computers that never chose their own.
  const changeNavOrder=useCallback((order:NavId[]):void=>{setNavOrder(order);saveNavOrder(order);},[]);
  const [view,setView]=useState<WorkspaceView>(),[error,setError]=useState<Message>(),[revision,setRevision]=useState(0);
  const [recovery,setRecovery]=useState<{key:string;sessionId:string}>();
  const refreshSequence=useRef(0),mounted=useRef(false);
  const refresh=useCallback(()=>{
    const sequence=++refreshSequence.current;
    void call(()=>service.getWorkspace()).then(result=>{if(!mounted.current||sequence!==refreshSequence.current)return;if(result.ok){setView(result.value);setError(undefined);}else setError(result.error);});
  },[service]);
  useEffect(()=>{mounted.current=true;refresh();const unsubscribe=service.onChanged(()=>{setRevision(value=>value+1);refresh();});
    const focused=():void=>refresh();window.addEventListener("focus",focused);
    return()=>{mounted.current=false;refreshSequence.current++;unsubscribe();window.removeEventListener("focus",focused);};
  },[service,refresh]);
  useEffect(()=>{document.documentElement.lang=language;try{localStorage.setItem("kolo.language",language);}catch{/* The selected language remains usable for the current session. */}},[language]);
  useEffect(()=>{applyAppearance(appearance);},[appearance]);
  useEffect(()=>{setRecovery(current=>current!==undefined&&current.sessionId!==view?.sessionId?undefined:current);},[view?.sessionId]);
  const t=(key:Parameters<typeof text>[1]):string=>text(language,key);
  return <TextContext.Provider value={language}>
    <a className="skip-link" href="#main-content" onClick={event=>{event.preventDefault();document.getElementById("main-content")?.focus();}}>{t("skipContent")}</a>
    <div className={view?.state==="unlocked"?"app-shell":"welcome-shell"}>
      <div className="language-switch" role="group" aria-label={language==="fr"?"Langue":"Language"}><button aria-pressed={language==="fr"} onClick={()=>setLanguage("fr")}>FR</button><button aria-pressed={language==="en"} onClick={()=>setLanguage("en")}>EN</button></div>
      {view===undefined?<main id="main-content" tabIndex={-1} className="auth-card"><p className="brand">KOLO</p><h1>{t("opening")}</h1><ErrorText message={error}/>{error&&<button className="secondary" onClick={refresh}>{t("retry")}</button>}</main>:
        view.state!=="unlocked"||view.sessionId===null||view.actor===null?<main id="main-content" tabIndex={-1} className="auth-layout"><header className="entry-header"><span className="brand">KOLO<span className="brand-mark" aria-hidden="true">.</span></span><span className="entry-offline"><span className="status-dot"/>{t("offline")}</span></header>
          <Workspace service={service} view={view} refresh={refresh} onRecoveryKey={(key,sessionId)=>setRecovery({key,sessionId})} onLegal={setLegal}/>
          <footer className="entry-legal"><span>kolo {__KOLO_VERSION__} · made by hblabs</span><LegalLinks onOpen={setLegal}/></footer></main>:
          <Shop key={view.sessionId} service={service} view={view} sessionId={view.sessionId} revision={revision} refresh={refresh} onRecoveryKey={(key,sessionId)=>setRecovery({key,sessionId})}
            preferences={{appearance,onAppearance:setAppearance,language,onLanguage:setLanguage,onLegal:setLegal,navOrder,onNavOrder:changeNavOrder}}/>
      }
      {view!==undefined&&error&&<div className="connection-error"><ErrorText message={error}/><button className="secondary" onClick={refresh}>{t("retry")}</button></div>}
      {legal!==undefined&&<LegalDialog key={legal} initial={legal} onClose={()=>setLegal(undefined)}/>}
      {recovery!==undefined&&view?.sessionId===recovery.sessionId&&<RecoveryDialog recoveryKey={recovery.key} onClose={()=>setRecovery(undefined)}/>}
    </div>
  </TextContext.Provider>;
}
function Shop({service,view,sessionId,revision,refresh,onRecoveryKey,preferences}:{service:ShopService;view:WorkspaceView;sessionId:string;revision:number;refresh:()=>void;onRecoveryKey:(key:string,sessionId:string)=>void;preferences:Omit<React.ComponentProps<typeof Settings>,"service"|"sessionId"|"canChangeFiles"|"canShopSettings"|"canViewProducts">}):React.JSX.Element{
  const {t}=useText(),action=useAction(),[dragging,setDragging]=useState<NavId>();
  const permissions=view.actor!.permissions,canTill=permissions.includes("sales.create")&&permissions.includes("products.view"),canProducts=permissions.includes("products.view"),canReceipts=permissions.includes("sales.view")||permissions.includes("sales.view_own"),canCustomers=permissions.includes("customers.view"),canPurchases=permissions.includes("purchases.view")||permissions.includes("suppliers.view"),canFinance=permissions.includes("finance.accounts.view")&&permissions.includes("cash.view")||permissions.includes("expenses.view"),canReports=permissions.some(permission=>permission.startsWith("reports.")),canAnalytics=permissions.includes("reports.sales"),canStaff=permissions.includes("users.view"),canJournal=permissions.includes("audit.view"),canDevices=view.actor!.isOwner&&permissions.includes("business.settings");
  const [selected,setSelected]=useState<"till"|"products"|"customers"|"purchases"|"finance"|"analytics"|"reports"|"journal"|"staff"|"devices"|"receipts"|"settings">(canTill?"till":canProducts?"products":"receipts"),[receiptId,setReceiptId]=useState<string>(),[keyForm,setKeyForm]=useState(false),[secret,setSecret]=useState("");
  const [alertsOpen,setAlertsOpen]=useState(false);
  const openAlert=useCallback((target:AlertTarget):void=>{setSelected(target);setAlertsOpen(false);},[]);
  const alerts=useNotifications(service,sessionId,revision,openAlert);
  const section=selected==="till"&&canTill||selected==="products"&&canProducts||selected==="customers"&&canCustomers||selected==="purchases"&&canPurchases||selected==="finance"&&canFinance||selected==="analytics"&&canAnalytics||selected==="reports"&&canReports||selected==="journal"&&canJournal||selected==="staff"&&canStaff||selected==="devices"&&canDevices||selected==="receipts"&&canReceipts||selected==="settings"?selected:canTill?"till":canProducts?"products":canReceipts?"receipts":undefined;
  return <>
    <aside className="sidebar"><div className="brand">KOLO<span className="brand-mark" aria-hidden="true">.</span></div><div className="shop-label"><span className="eyebrow">{t("local")}</span><strong>{view.shopName}</strong></div>
      <nav aria-label="KOLO">{([{id:"till",allowed:canTill,mark:"▦"},{id:"products",allowed:canProducts,mark:"▤"},{id:"customers",allowed:canCustomers,mark:"◍"},{id:"purchases",allowed:canPurchases,mark:"⬓"},{id:"finance",allowed:canFinance,mark:"◈"},{id:"analytics",allowed:canAnalytics,mark:"◐"},{id:"reports",allowed:canReports,mark:"▥"},{id:"journal",allowed:canJournal,mark:"≣"},{id:"staff",allowed:canStaff,mark:"◎"},{id:"devices",allowed:canDevices,mark:"⇄"},{id:"receipts",allowed:canReceipts,mark:"▧"},{id:"settings",allowed:true,mark:"⚙"}] as const).filter(item=>item.allowed).sort((left,right)=>preferences.navOrder.indexOf(left.id)-preferences.navOrder.indexOf(right.id)).map(item=><button className={`nav-item ${section===item.id?"selected":""} ${dragging===item.id?"dragging":""}`} aria-current={section===item.id?"page":undefined} key={item.id}
        draggable onDragStart={event=>{setDragging(item.id);event.dataTransfer.effectAllowed="move";}} onDragEnd={()=>setDragging(undefined)}
        onDragOver={event=>{if(dragging!==undefined){event.preventDefault();event.dataTransfer.dropEffect="move";}}} onDrop={event=>{event.preventDefault();if(dragging!==undefined)preferences.onNavOrder(dropNav(preferences.navOrder,dragging,item.id));setDragging(undefined);}}
        onClick={()=>{setSelected(item.id);if(item.id==="receipts")setReceiptId(undefined);}}><span aria-hidden="true">{item.mark}</span>{t(item.id)}</button>)}</nav>
      <div className="sidebar-footer"><span className="status-dot"/>{t("offline")}</div>
    </aside>
    <main id="main-content" tabIndex={-1} className="main-content"><header className="topbar"><span>{view.shopName}</span><div className="topbar-actions"><AlertsButton unread={alerts.data?.unread??0} expanded={alertsOpen} onToggle={()=>setAlertsOpen(!alertsOpen)}/><span className="user-name">{view.actor?.name}</span>{view.actor?.isOwner&&<button className="text-button" onClick={()=>setKeyForm(!keyForm)}>{t("viewKey")}</button>}<button className="secondary" disabled={action.busy} onClick={()=>{void action.run(()=>service.lock()).then(()=>refresh());}}>{t("lock")}</button></div></header>
      <ErrorText message={action.error}/>
      {alertsOpen&&<AlertsPanel view={alerts.data} error={alerts.error} permissions={permissions} onOpen={openAlert} onMarkAll={()=>{void alerts.markAll();}} onClose={()=>setAlertsOpen(false)}/>}
      {keyForm&&<div className="panel recovery-form"><form onSubmit={event=>{event.preventDefault();void action.run(()=>service.recoveryKey({sessionId,secret})).then(value=>{setSecret("");if(value===null)action.setError({code:"keyUnavailable"});else if(value!==undefined){setKeyForm(false);onRecoveryKey(value,sessionId);}});}}><Field id="owner-proof" label={t("secret")} value={secret} onChange={setSecret} secret maxLength={256} disabled={action.busy}/><div className="actions"><button type="submit" className="primary" disabled={action.busy}>{t("showKey")}</button><button type="button" className="secondary" onClick={()=>{setKeyForm(false);setSecret("");}}>{t("cancel")}</button></div></form></div>}
      {canTill&&<div hidden={section!=="till"}><Till service={service} sessionId={sessionId} revision={revision} permissions={permissions} onReceipt={id=>{setReceiptId(id);if(canReceipts)setSelected("receipts");}}/></div>}
      {canProducts&&<div hidden={section!=="products"}><Products service={service} sessionId={sessionId} revision={revision} permissions={permissions}/></div>}
      {canCustomers&&<div hidden={section!=="customers"}><Customers service={service} sessionId={sessionId} revision={revision} permissions={permissions}/></div>}
      {canPurchases&&<div hidden={section!=="purchases"}><Purchases service={service} sessionId={sessionId} revision={revision} permissions={permissions}/></div>}
      {canFinance&&<div hidden={section!=="finance"}><Finance service={service} sessionId={sessionId} revision={revision} permissions={permissions}/></div>}
      {section==="journal"&&<Journal service={service} sessionId={sessionId} revision={revision}/>}
      {section==="analytics"&&<Analytics service={service} sessionId={sessionId} revision={revision} permissions={permissions}/>}
      {section==="reports"&&<Reports service={service} sessionId={sessionId} revision={revision} permissions={permissions}/>}
      {section==="staff"&&<Staff service={service} sessionId={sessionId} revision={revision} isOwner={view.actor?.isOwner===true}/>}
      {canDevices&&<div hidden={section!=="devices"}><Devices service={service} sessionId={sessionId} revision={revision}/></div>}
      {section==="receipts"&&<Receipts key={receiptId??"history"} service={service} sessionId={sessionId} revision={revision} initialId={receiptId} canReturn={permissions.includes("sales.refund")} shopName={view.shopName} onNewSale={()=>setSelected(canTill?"till":"products")}/>}
      {section==="settings"&&<Settings service={service} sessionId={sessionId} canChangeFiles={view.actor!.isOwner&&permissions.includes("business.settings")} canShopSettings={permissions.includes("business.settings")} canViewProducts={canProducts} {...preferences}/>}
      {section===undefined&&<p className="notice error">{t("noAccess")}</p>}
    </main>
  </>;
}
function RecoveryDialog({recoveryKey,onClose}:{recoveryKey:string;onClose:()=>void}):React.JSX.Element{
  const {t}=useText(),dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();},[]);
  return <dialog ref={dialog} className="recovery-dialog" aria-labelledby="key-title" onCancel={onClose}><p className="eyebrow">{t("keyReady")}</p><h2 id="key-title">{t("keyTitle")}</h2><p className="muted">{t("keyHelp")}</p><code className="recovery-code">{recoveryKey.match(/.{1,8}/g)?.join("-")??recoveryKey}</code><p className="hint">{t("keySelectHelp")}</p><button autoFocus className="primary" onClick={onClose}>{t("keySaved")}</button></dialog>;
}
