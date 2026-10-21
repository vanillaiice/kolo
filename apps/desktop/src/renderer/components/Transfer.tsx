import { AuthPage } from "./AuthPage.tsx";
import { useEffect, useState } from "react";
import type { BackupFileView, BackupKeyView, BundleView, InviteView, JoinCodeView, JoinStatusView, PairingRequestView, ServerPreview, ServerSyncSummary, ServerView, ShopService } from "../../shared/service.ts";
import QRCode from "qrcode";
import type { TextKey } from "../text.ts";
import { ErrorText, Field, ReadState, useAction, useRead, useText } from "./ui.tsx";

/** Shows what a save dialog did: a cancelled dialog is not an error. */
function Saved({saved}:{saved:boolean|undefined}):React.JSX.Element|null{
  const {t}=useText();
  return saved===undefined?null:<p role="status" className={`notice ${saved?"success":""}`}>{t(saved?"fileSavedNotice":"fileNotSaved")}</p>;
}
function PasswordFields({id,value,confirm,onValue,onConfirm}:{id:string;value:string;confirm?:string;onValue:(value:string)=>void;onConfirm?:(value:string)=>void}):React.JSX.Element{
  const {t}=useText();
  return <><div className="two-fields"><Field id={`${id}-password`} label={t("filePassword")} value={value} onChange={onValue} secret maxLength={256}/>
    {onConfirm!==undefined&&<Field id={`${id}-confirm`} label={t("confirmFilePassword")} value={confirm??""} onChange={onConfirm} secret maxLength={256}/>}</div><p className="hint">{t("filePasswordHelp")}</p></>;
}

/**
 * Import screen, before anyone signs in: one file dialog, then the steps for what was chosen. A backup
 * restores this computer's shop (replacing the current one, kept as a safety copy, when `replacing`
 * names it). An invite joins another till's shop and needs a computer without a shop.
 */
export function ImportFile({service,replacing,onDone,onBack}:{readonly service:ShopService;readonly replacing?:string;readonly onDone:()=>void;readonly onBack:()=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [kind,setKind]=useState<"backup"|"invite">(),[operationBusy,setOperationBusy]=useState(false);
  const busy=operationBusy||action.busy;
  const choose=():void=>{void action.run(()=>service.chooseImportFile()).then(value=>{if(value!==undefined)setKind(value.kind);});};
  const back=():void=>{void action.run(()=>service.discardFile()).then(result=>{if(result!==undefined)onBack();});};
  const chooseAgain=<button type="button" className="text-button" disabled={busy} onClick={()=>{setKind(undefined);action.setError(undefined);choose();}}>{t("chooseOtherFile")}</button>;
  return <AuthPage title={t(replacing===undefined?"importFile":"importBackup")} description={t(replacing===undefined?"importHelp":"importReplaceHelp")} context={replacing??t("onThisComputer")} busy={busy} onBack={back}
    aside={kind==="invite"?<><p className="eyebrow">{t("beforeYouStart")}</p><h2>{t("joinGuideTitle")}</h2><p>{t("joinGuideHelp")}</p></>
      :<><p className="eyebrow">{t("beforeYouStart")}</p><h2>{t("importGuideTitle")}</h2><p>{t(replacing===undefined?"importGuideHelp":"importReplaceGuideHelp")}</p><p>{t("restoreGuideLogin")}</p></>}>
    {kind===undefined?<div className="transfer-step"><h2>{t("chooseFileStep")}</h2><button id="choose-import-file" className="primary" disabled={busy} onClick={choose}>{t("chooseFile")}</button></div>
      :kind==="backup"?<><Restore service={service} chosen {...(replacing===undefined?{}:{replacing})} onDone={onDone} onBusy={setOperationBusy}/>{chooseAgain}</>
      :replacing!==undefined?<div className="transfer-step"><p className="notice error" role="alert">{t("inviteNeedsEmpty")}</p>{chooseAgain}</div>
      :<><Join service={service} autoOpen onDone={onDone} onBusy={setOperationBusy}/>{chooseAgain}</>}
    <ErrorText message={action.error}/>
  </AuthPage>;
}
/** Checks a backup, then restores it after the shop name is typed back. With a session, it replaces this shop. */
function Restore({service,sessionId,chosen=false,replacing,onDone,onBusy}:{service:ShopService;sessionId?:string;chosen?:boolean;replacing?:string;onDone:()=>void;onBusy?:(busy:boolean)=>void}):React.JSX.Element{
  const {t,language}=useText(),action=useAction();
  useEffect(()=>{onBusy?.(action.busy);},[action.busy,onBusy]);
  const [password,setPassword]=useState(""),[preview,setPreview]=useState<BackupFileView>(),[name,setName]=useState(""),[device,setDevice]=useState(()=>t("defaultTill")),[secret,setSecret]=useState(""),[confirm,setConfirm]=useState("");
  const [withKey,setWithKey]=useState(false),[recoveryKey,setRecoveryKey]=useState("");
  const check=async():Promise<void>=>{setPreview(undefined);const value=await action.run(()=>service.openBackup(withKey?{recoveryKey}:{password}));setPassword("");setRecoveryKey("");if(value!==undefined)setPreview(value);};
  const restore=async():Promise<void>=>{
    if(secret!==confirm){action.setError({code:"codesMismatch"});return;}
    const value=await action.run(()=>service.restoreBackup({...(sessionId===undefined?{}:{sessionId}),...(replacing===undefined?{}:{replace:true}),confirmedName:name,deviceLabel:device,secret}));
    setSecret("");setConfirm("");if(value!==undefined)onDone();
  };
  return <div className="transfer-step">{sessionId===undefined&&<h2>{t(preview===undefined?(chosen?"backupPasswordStep":"backupCheckStep"):(chosen?"backupConfirmChosenStep":"backupConfirmStep"))}</h2>}{sessionId!==undefined&&<p className="hint">{t("restoreReplaceHelp")}</p>}
    {preview===undefined?<form onSubmit={event=>{event.preventDefault();void check();}}><fieldset disabled={action.busy}>
      {withKey?<Field id="restore-recovery-key" label={t("recoveryKeyField")} value={recoveryKey} onChange={setRecoveryKey} maxLength={200}/>:<PasswordFields id="restore" value={password} onValue={setPassword}/>}
      <label className="check" htmlFor="restore-with-key"><input id="restore-with-key" type="checkbox" checked={withKey} onChange={event=>{setWithKey(event.target.checked);action.setError(undefined);}}/>{t("useRecoveryKey")}</label></fieldset>
      <button className={chosen?"primary":"secondary"} type="submit" disabled={action.busy}>{t(chosen?"openBackupNow":"chooseBackup")}</button></form>
    :<form onSubmit={event=>{event.preventDefault();void restore();}}><div className="file-summary"><strong>{t("backupFrom")} {preview.businessName}</strong><span>{preview.ownerName} · {new Date(preview.createdAt).toLocaleString(language==="fr"?"fr-FR":"en-GB")} · {preview.appliedEvents} {t("savedOperations")}</span></div>
      <fieldset disabled={action.busy}><Field id="restore-name" label={t("typeShopName")} value={name} onChange={setName}/><Field id="restore-device" label={t("deviceName")} value={device} onChange={setDevice}/>
        {replacing!==undefined&&<p className="notice error" role="note">{t("replaceWarning")} <strong>{replacing}</strong>. {t("replaceKept")}</p>}
        <div className="two-fields"><Field id="restore-secret" label={t("codeAfterRestore")} value={secret} onChange={setSecret} secret maxLength={256}/><Field id="restore-confirm" label={t("confirmSecret")} value={confirm} onChange={setConfirm} secret maxLength={256}/></div><p className="hint">{t("secretHelp")}</p></fieldset>
      <button className="primary" type="submit" disabled={action.busy||name!==preview.businessName}>{action.busy?t("recording"):t("restoreNow")}</button></form>}
    <ErrorText message={action.error} inputMessage="identityInput"/></div>;
}
/** New till: check the invite, accept with the compared fingerprint, then complete with the activation file. */
function Join({service,autoOpen=false,onDone,onBusy}:{service:ShopService;autoOpen?:boolean;onDone:()=>void;onBusy?:(busy:boolean)=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  useEffect(()=>{onBusy?.(action.busy);},[action.busy,onBusy]);
  const [invite,setInvite]=useState<InviteView>(),[fingerprint,setFingerprint]=useState(""),[device,setDevice]=useState(()=>t("defaultTill")),[secret,setSecret]=useState(""),[confirm,setConfirm]=useState("");
  const [code,setCode]=useState<string>(),[password,setPassword]=useState(""),[typedCode,setTypedCode]=useState("");
  const accept=async():Promise<void>=>{
    if(secret!==confirm){action.setError({code:"codesMismatch"});return;}
    const value=await action.run(()=>service.acceptInvite({confirmedFingerprint:fingerprint.trim(),deviceLabel:device,secret}));
    setSecret("");setConfirm("");if(value!==undefined){setCode(value.verificationCode);setTypedCode(value.verificationCode);}
  };
  const complete=async():Promise<void>=>{const value=await action.run(()=>service.completePairing({password,confirmedCode:typedCode.trim()}));setPassword("");if(value!==undefined)onDone();};
  const [opened,setOpened]=useState(false);
  useEffect(()=>{if(!autoOpen||opened)return;setOpened(true);void action.run(()=>service.openInvite()).then(value=>{if(value!==undefined)setInvite(value);});},[autoOpen,opened,action,service]);
  return <div className="transfer-step"><h2>{t(code!==undefined?"joinActivationStep":invite===undefined?"joinInviteStep":"joinRequestStep")}</h2>
    {code===undefined?invite===undefined?<button className="secondary" disabled={action.busy} onClick={()=>{void action.run(()=>service.openInvite()).then(value=>{if(value!==undefined)setInvite(value);});}}>{t("chooseInvite")}</button>
      :<form onSubmit={event=>{event.preventDefault();void accept();}}><div className="file-summary"><strong>{t("inviteFrom")} {invite.businessName}</strong><span>{invite.ownerName}</span></div>
        <fieldset disabled={action.busy}><Field id="join-fingerprint" label={t("typeFingerprint")} value={fingerprint} onChange={setFingerprint} maxLength={64}/><Field id="join-device" label={t("deviceName")} value={device} onChange={setDevice}/>
          <div className="two-fields"><Field id="join-secret" label={t("secret")} value={secret} onChange={setSecret} secret maxLength={256}/><Field id="join-confirm" label={t("confirmSecret")} value={confirm} onChange={setConfirm} secret maxLength={256}/></div><p className="hint">{t("secretHelp")}</p></fieldset>
        <button className="primary" type="submit" disabled={action.busy}>{t("acceptInvite")}</button></form>
    :<form onSubmit={event=>{event.preventDefault();void complete();}}><p className="notice success">{t("tellOwnerCode")} <code className="pair-code">{code}</code></p>
      <fieldset disabled={action.busy}><Field id="join-code" label={t("pairingCode")} value={typedCode} onChange={setTypedCode} maxLength={64}/><PasswordFields id="join" value={password} onValue={setPassword}/></fieldset>
      <button className="primary" type="submit" disabled={action.busy}>{t("chooseActivation")}</button></form>}
    <ErrorText message={action.error} inputMessage="identityInput"/>
    <button className="text-button" disabled={action.busy} onClick={()=>{void action.run(()=>service.cancelPairing()).then(()=>{setInvite(undefined);setCode(undefined);});}}>{t("cancelPairing")}</button></div>;
}
/** Owner tools for a configured shop: backup, restore, pairing and file exchange. */
export function Devices({service,sessionId,revision}:{readonly service:ShopService;readonly sessionId:string;readonly revision:number}):React.JSX.Element{
  const {t}=useText();
  return <section className="workspace-content">
    <div className="section-heading"><div><p className="eyebrow">{t("devices")}</p><h1>{t("devicesHelp")}</h1></div></div>
    <div className="devices-grid">
      <div className="panel"><h2>{t("backupTitle")}</h2><SaveBackup service={service} sessionId={sessionId} revision={revision}/></div>
      <div className="panel"><h2>{t("recoveryKeyTitle")}</h2><RecoveryKey service={service} sessionId={sessionId}/></div>
      <div className="panel wide"><h2>{t("pairTitle")}</h2><AddTill service={service} sessionId={sessionId} revision={revision}/></div>
      <div className="panel wide"><h2>{t("exchangeTitle")}</h2><Exchange service={service} sessionId={sessionId} revision={revision}/></div>
      <div className="panel wide" id="sync-server-panel"><h2>{t("syncTitle")}</h2><SyncServer service={service} sessionId={sessionId} revision={revision}/></div>
      <div className="panel wide"><h2>{t("restoreTitle")}</h2><Restore service={service} sessionId={sessionId} onDone={()=>undefined}/></div>
    </div>
  </section>;
}
function SaveBackup({service,sessionId,revision}:{service:ShopService;sessionId:string;revision:number}):React.JSX.Element{
  const {t}=useText(),action=useAction(),[password,setPassword]=useState(""),[confirm,setConfirm]=useState(""),[saved,setSaved]=useState<boolean>(),[includePhotos,setIncludePhotos]=useState(true);
  const keys=useRead(()=>service.backupKeys({sessionId}),[service,sessionId,revision]);
  const submit=async():Promise<void>=>{
    setSaved(undefined);if(password!==confirm){action.setError({code:"passwordsMismatch"});return;}
    const value=await action.run(()=>service.saveBackup({sessionId,password,includePhotos}));setPassword("");setConfirm("");if(value!==undefined)setSaved(value.saved);
  };
  return <form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={action.busy}><PasswordFields id="backup" value={password} confirm={confirm} onValue={setPassword} onConfirm={setConfirm}/>
    <label className="check" htmlFor="backup-photos"><input id="backup-photos" type="checkbox" checked={includePhotos} onChange={event=>setIncludePhotos(event.target.checked)}/>{t("includePhotos")}</label>
    <p className="hint">{t("includePhotosHelp")}</p>{(keys.data?.length??0)>0&&<p className="hint">{t("backupAlsoKey")}</p>}</fieldset>
    <ErrorText message={action.error}/><Saved saved={saved}/><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):t("saveBackup")}</button></form>;
}
/**
 * The shop's backup recovery key (ADR-036): create it after the owner code, show the 14 groups once with a printable
 * sheet, then pin it once three groups are typed back. Earlier keys stay listed for the backups that need them.
 */
function RecoveryKey({service,sessionId}:{service:ShopService;sessionId:string}):React.JSX.Element{
  const {t,language}=useText(),action=useAction(),keys=useRead(()=>service.backupKeys({sessionId}),[service,sessionId]);
  const [step,setStep]=useState<"idle"|"pin"|"show"|"confirm">("idle"),[pin,setPin]=useState(""),[pending,setPending]=useState<{text:string;keyId:string;confirm:readonly number[]}>(),[groups,setGroups]=useState(["","",""]),[done,setDone]=useState(false);
  const day=(at:string):string=>new Date(at).toLocaleDateString(language==="fr"?"fr-FR":"en-GB");
  const current:BackupKeyView|undefined=keys.data?.find(key=>key.current),older=(keys.data?.length??0)-(current===undefined?0:1);
  const prepare=async():Promise<void>=>{setDone(false);const value=await action.run(()=>service.prepareBackupKey({sessionId,secret:pin}));setPin("");if(value!==undefined){setPending(value);setGroups(["","",""]);setStep("show");}};
  const confirm=async():Promise<void>=>{const value=await action.run(()=>service.confirmBackupKey({sessionId,groups}));if(value!==undefined){setPending(undefined);setStep("idle");setDone(true);keys.retry();}};
  if(pending!==undefined&&step==="show")return <div className="transfer-step">
    <p className="notice error" role="note">{t("recoveryKeyShowOnce")}</p>
    <div className="recovery-sheet"><h2>{t("recoveryKeySheet")}</h2>
      <ol className="recovery-groups">{pending.text.split("-").map((group,index)=><li key={index}><span>{index+1}</span><code>{group}</code></li>)}</ol>
      <p className="hint">{t("recoveryKeyId")} {pending.keyId.slice(0,8)} · {t("recoveryKeyCreated")} {day(new Date().toISOString())}</p><p className="hint">{t("recoveryKeySheetHelp")}</p></div>
    <div className="row"><button type="button" className="secondary" onClick={()=>window.print()}>{t("recoveryKeyPrint")}</button><button type="button" className="primary" onClick={()=>setStep("confirm")}>{t("recoveryKeyWritten")}</button></div></div>;
  if(pending!==undefined&&step==="confirm")return <form className="transfer-step" onSubmit={event=>{event.preventDefault();void confirm();}}>
    <p className="hint">{t("recoveryKeyConfirm")}</p>
    <fieldset disabled={action.busy}><div className="three-fields">{pending.confirm.map((index,i)=><Field key={index} id={`recovery-group-${index}`} label={`${t("recoveryKeyGroup")} ${index+1}`} value={groups[i]!} maxLength={8}
      onChange={value=>setGroups(list=>list.map((item,j)=>j===i?value:item))}/>)}</div></fieldset>
    <ErrorText message={action.error}/>
    <div className="row"><button type="button" className="text-button" onClick={()=>setStep("show")}>{t("back")}</button><button className="primary" type="submit" disabled={action.busy||groups.some(group=>group.trim()==="")}>{t("recoveryKeyWritten")}</button></div></form>;
  return <div className="transfer-step"><p className="hint">{t("recoveryKeyHelp")}</p>
    <ErrorText message={keys.error}/>
    {keys.data!==undefined&&(current===undefined?<p>{t("recoveryKeyNone")}</p>:<div className="file-summary"><strong>{t("recoveryKeyCurrent")} · {t("recoveryKeyId")} {current.keyId.slice(0,8)}</strong>
      <span>{t("recoveryKeyCreated")} {day(current.createdAt)}{older>0?` · ${older} ${t("recoveryKeyOlder")}`:""}</span></div>)}
    {done&&<p role="status" className="notice success">{t("recoveryKeyDone")}</p>}
    {step==="pin"?<form onSubmit={event=>{event.preventDefault();void prepare();}}><fieldset disabled={action.busy}><Field id="recovery-pin" label={t("recoveryKeyPin")} value={pin} onChange={setPin} secret maxLength={256}/></fieldset>
      <ErrorText message={action.error}/><button className="primary" type="submit" disabled={action.busy||pin===""}>{t(current===undefined?"recoveryKeyCreate":"recoveryKeyRotate")}</button></form>
      :<button className="secondary" onClick={()=>{setStep("pin");setDone(false);action.setError(undefined);}}>{t(current===undefined?"recoveryKeyCreate":"recoveryKeyRotate")}</button>}
  </div>;
}
/** Adding a till: by code through the connected server, or by files when there is no server. */
function AddTill({service,sessionId,revision}:{service:ShopService;sessionId:string;revision:number}):React.JSX.Element{
  const {t}=useText(),state=useRead(()=>service.serverState({sessionId}),[service,sessionId,revision]);
  const [remoteAvailable,setRemoteAvailable]=useState(false);
  useEffect(()=>{if(state.data!==undefined)setRemoteAvailable(state.data.servers.length>0);},[state.data]);
  return <div className="add-till"><JoinByCode service={service} sessionId={sessionId} local/>
    {remoteAvailable&&<details className="support"><summary>{t("joinThroughServer")}</summary><JoinByCode service={service} sessionId={sessionId}/></details>}
    <details className="support"><summary>{t("pairByFiles")}</summary><Pair service={service} sessionId={sessionId}/></details>
    <LocalNetworkStatus service={service} sessionId={sessionId} revision={revision}/></div>;
}
/**
 * Empty computer joins a shop: the owner's code with the server address shown beside it, or a copied join link
 * (server or same Wi-Fi). The owner must still allow it on the main till.
 */
export function JoinLocalComputer({service,onDone,onBack}:{service:ShopService;onDone:()=>void;onBack:()=>void}):React.JSX.Element{
  const {t}=useText(),action=useAction(),[link,setLink]=useState(""),[address,setAddress]=useState(""),[shop,setShop]=useState<string>(),[label,setLabel]=useState(t("defaultTill")),[secret,setSecret]=useState(""),[confirm,setConfirm]=useState(""),[waiting,setWaiting]=useState(false);
  // A pasted link carries its own address; a typed code needs the one shown under it.
  const typedCode=!/^\s*kolo:/i.test(link),target={link,...(typedCode&&address.trim()!==""?{url:address}:{})};
  useEffect(()=>{if(!waiting)return;let live=true,running=false;const timer=setInterval(()=>{if(running)return;running=true;void service.finishLocalJoin(target).then(result=>{if(!live)return;if(!result.ok){action.setError(result.error);return;}if(result.value?.activated){live=false;onDone();}}).catch(()=>{if(live)action.setError({code:"local_network_unavailable"});}).finally(()=>{running=false;});},2000);return()=>{live=false;clearInterval(timer);};},[service,link,address,waiting,onDone]);
  return <AuthPage title={t("joinLocalShop")} description={t("joinLocalEntryHelp")} context="KOLO" onBack={onBack} busy={action.busy} aside={<p>{t("joinEntryAside")}</p>}>
    {waiting?<><p className="notice">{t("joinWaiting")}</p><button className="secondary" disabled={action.busy} onClick={()=>{void action.run(()=>service.cancelPairing()).then(()=>{setWaiting(false);setShop(undefined);});}}>{t("cancelPairing")}</button></>:<form onSubmit={event=>{event.preventDefault();void (async()=>{if(shop===undefined){const result=await action.run(()=>service.lookupLocalJoin(target));if(result!==undefined)setShop(result.businessName);return;}if(secret!==confirm){action.setError({code:"codesMismatch"});return;}const result=await action.run(()=>service.requestLocalJoin({...target,deviceLabel:label,secret}));if(result!==undefined){setSecret("");setConfirm("");setWaiting(true);}})();}}><fieldset disabled={action.busy}>
      <Field id="local-pairing-link" label={t("pairingLink")} value={link} onChange={value=>{setLink(value);setShop(undefined);}} maxLength={4096}/>
      {typedCode&&<Field id="join-server-address" label={t("joinServerAddress")} value={address} onChange={value=>{setAddress(value);setShop(undefined);}} maxLength={2048}/>}
      {shop!==undefined&&<><h2>{shop}</h2><Field id="local-join-label" label={t("deviceName")} value={label} onChange={setLabel}/><Field id="local-join-secret" label={t("newSecret")} value={secret} onChange={setSecret} secret/><Field id="local-join-confirm" label={t("confirmSecret")} value={confirm} onChange={setConfirm} secret/></>}
      <button className="primary" type="submit" disabled={link.trim()===""}>{t(shop===undefined?"continueSetup":"askLocalJoin")}</button>
    </fieldset></form>}<ErrorText message={action.error}/>
  </AuthPage>;
}
function LocalNetworkStatus({service,sessionId,revision}:{service:ShopService;sessionId:string;revision:number}):React.JSX.Element{
  const {t,language}=useText(),action=useAction(),[refresh,setRefresh]=useState(0),[notice,setNotice]=useState<string>();
  const state=useRead(()=>service.localNetworkState({sessionId}),[service,sessionId,revision,refresh]);
  return <div className="transfer-step"><ReadState loading={state.loading} error={state.error} empty={false} emptyText="" retry={state.retry}>
    {state.data?.running&&<><p className="hint">{t("localSyncRunning")}</p>{state.data.urls.map(url=><code key={url}>{url}</code>)}<button className="text-button" disabled={action.busy} onClick={()=>{void action.run(()=>service.stopLocalNetwork({sessionId})).then(()=>setRefresh(x=>x+1));}}>{t("stopLocalSync")}</button></>}
    {state.data?.connections.map(peer=><div className="file-summary" key={peer.deviceId}><strong>{peer.label}</strong><span>{peer.url}</span><span>{peer.lastError===null?t("lastSync"):t("local_network_unavailable")} {peer.lastSuccessAt===null?t("neverSynced"):new Date(peer.lastSuccessAt).toLocaleString(language==="fr"?"fr-FR":"en-GB")}</span></div>)}
    {(state.data?.connections.length??0)>0&&<button className="secondary" disabled={action.busy} onClick={()=>{void action.run(()=>service.syncLocalNetwork({sessionId})).then(result=>{setRefresh(x=>x+1);if(result!==undefined)setNotice(`${t("syncDone")} · ${result.sent} ${t("sentCount")} · ${result.received} ${t("receivedCount")}`);});}}>{t("syncNow")}</button>}
  </ReadState>{notice!==undefined&&<p role="status" className="notice success">{notice}</p>}<ErrorText message={action.error}/></div>;
}
/**
 * The owner's side of joining by code (ADR-032): a short code and its QR code, then the new till's name to allow.
 * Nothing to compare or type on this computer.
 */
function JoinByCode({service,sessionId,local=false}:{service:ShopService;sessionId:string;local?:boolean}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [authority,setAuthority]=useState(false),[join,setJoin]=useState<JoinCodeView>(),[status,setStatus]=useState<JoinStatusView>(),[qr,setQr]=useState<string>(),[done,setDone]=useState<string>();
  const [qrFailed,setQrFailed]=useState(false);
  useEffect(()=>{setQr(undefined);setQrFailed(false);if(join===undefined)return;let live=true;void QRCode.toString(join.link,{type:"svg",margin:1,errorCorrectionLevel:"M"}).then(svg=>{if(live)setQr(`data:image/svg+xml;base64,${btoa(svg)}`);}).catch(()=>{if(live)setQrFailed(true);});return()=>{live=false;};},[join]);
  // Ask the server every two seconds until the new till asks, the code expires or the owner answers.
  useEffect(()=>{
    if(join===undefined||status?.state==="requested"||status?.state==="expired")return;
    const timer=setInterval(()=>{void (local?service.pollLocalJoin({sessionId,joinId:join.joinId}):service.pollJoinCode({sessionId,joinId:join.joinId})).then(result=>{if(result.ok)setStatus(result.value);else{setStatus({state:"expired"});}}).catch(()=>setStatus({state:"expired"}));},2000);
    return()=>clearInterval(timer);
  },[service,sessionId,join,status,local]);
  const start=():void=>{setDone(undefined);setStatus(undefined);void action.run(()=>local?service.startLocalJoin({sessionId,authorityAllowed:authority}):service.startJoinCode({sessionId,authorityAllowed:authority})).then(value=>{if(value!==undefined)setJoin(value);});};
  const stop=(refused:boolean):void=>{const current=join;setJoin(undefined);setStatus(undefined);if(current!==undefined)void (local?service.cancelLocalJoin({sessionId,joinId:current.joinId}):service.cancelJoinCode({sessionId,joinId:current.joinId}));if(refused)setDone(undefined);};
  const allow=():void=>{if(join===undefined||status?.state!=="requested")return;const label=status.label;void action.run(()=>local?service.approveLocalJoin({sessionId,joinId:join.joinId}):service.approveJoinCode({sessionId,joinId:join.joinId})).then(value=>{if(value!==undefined){setJoin(undefined);setStatus(undefined);setDone(label);}});};
  if(join===undefined)return <div className="transfer-step">
    <p className="hint">{t(local?"localJoinHelp":"joinCodeHelp")}</p>
    <label className="check"><input type="checkbox" checked={authority} onChange={event=>setAuthority(event.target.checked)}/>{t("allowStaff")}</label>
    <button className="primary" id={local?"show-local-join":undefined} disabled={action.busy} onClick={start}>{t(action.busy?"preparing":"showJoinCode")}</button>
    {done!==undefined&&<p role="status" className="notice success">{t("tillJoined")} {done}</p>}
    <ErrorText message={action.error}/></div>;
  return <div className="transfer-step join-code">
    {status?.state==="requested"?<>
      <p className="notice">{t("allowTillQuestion")} <strong>{status.label}</strong> ({status.platform==="DESKTOP"?t("computer"):t("phone")})</p>
      <div className="actions"><button className="primary" disabled={action.busy} onClick={allow}>{t(action.busy?"preparing":"allowTill")}</button>
        <button className="secondary" disabled={action.busy} onClick={()=>stop(true)}>{t("refuseTill")}</button></div>
      {action.busy&&<p className="hint">{t("preparingShopHelp")}</p>}
    </>:status?.state==="expired"?<><p className="notice error">{t("joinExpired")}</p><button className="secondary" onClick={()=>{stop(false);}}>{t("close")}</button></>:<>
      <p className="hint">{t("joinScanHelp")}</p>
      {qr!==undefined&&<img className="join-qr" src={qr} alt={t("joinQrAlt")}/>}
      {qrFailed&&<p role="alert" className="notice error">{t("joinQrFailed")}</p>}
      <code className="join-big-code">{join.code}</code>
      <p className="hint">{t("joinAddress")} <code>{join.url}</code></p>
      {local&&<><p className="hint">{t("localJoinHelp")}</p><button className="secondary" onClick={()=>{void navigator.clipboard.writeText(join.link);}}>{t("copyPairingLink")}</button><code className="share-code">{join.link}</code></>}
      <p className="hint">{t("joinWaiting")}</p>
      <button className="text-button" onClick={()=>stop(true)}>{t("cancel")}</button>
    </>}
    <ErrorText message={action.error}/></div>;
}
function Pair({service,sessionId}:{service:ShopService;sessionId:string}):React.JSX.Element{
  const {t}=useText(),action=useAction();
  const [authority,setAuthority]=useState(false),[fingerprint,setFingerprint]=useState<string>(),[request,setRequest]=useState<PairingRequestView>(),[code,setCode]=useState(""),[password,setPassword]=useState(""),[approved,setApproved]=useState<boolean>();
  const approve=async():Promise<void>=>{const value=await action.run(()=>service.approvePairingRequest({sessionId,confirmedCode:code.trim(),password}));setPassword("");if(value!==undefined){setApproved(value.saved);setRequest(undefined);setCode("");}};
  return <div className="transfer-step">
    <label className="check"><input type="checkbox" checked={authority} disabled={action.busy} onChange={event=>setAuthority(event.target.checked)}/>{t("allowStaff")}</label>
    <button className="secondary" disabled={action.busy} onClick={()=>{void action.run(()=>service.saveInvite({sessionId,authorityAllowed:authority})).then(value=>{if(value!==undefined)setFingerprint(value.fingerprint);});}}>{t("saveInvite")}</button>
    {fingerprint!==undefined&&<p className="notice">{t("fingerprintToCompare")} <code className="pair-code">{fingerprint}</code></p>}
    <button className="secondary" disabled={action.busy} onClick={()=>{setApproved(undefined);void action.run(()=>service.openPairingRequest({sessionId})).then(value=>{if(value!==undefined)setRequest(value);});}}>{t("checkRequest")}</button>
    {request!==undefined&&<form onSubmit={event=>{event.preventDefault();void approve();}}><div className="file-summary"><strong>{t("requestFrom")} {request.deviceLabel}</strong><span>{t("codeToCompare")} <code className="pair-code">{request.verificationCode}</code></span></div>
      <fieldset disabled={action.busy}><Field id="pair-code" label={t("typeCode")} value={code} onChange={setCode} maxLength={64}/><PasswordFields id="pair" value={password} onValue={setPassword}/></fieldset>
      <button className="primary" type="submit" disabled={action.busy}>{t("approve")}</button></form>}
    {approved===true&&<p role="status" className="notice success">{t("approved")}</p>}<Saved saved={approved===false?false:undefined}/>
    <ErrorText message={action.error}/></div>;
}
function Exchange({service,sessionId,revision}:{service:ShopService;sessionId:string;revision:number}):React.JSX.Element{
  const {t,language}=useText(),action=useAction();
  const [refresh,setRefresh]=useState(0),[password,setPassword]=useState(""),[bundle,setBundle]=useState<BundleView>(),[notice,setNotice]=useState<string>();
  const state=useRead(()=>service.exchangeState({sessionId,language}),[service,sessionId,language,revision,refresh]);
  const done=(text:string):void=>{setNotice(text);setRefresh(value=>value+1);};
  const counted=(count:number,key:TextKey):string=>`${count} ${t(key)}`;
  return <div className="transfer-step"><PasswordFields id="exchange" value={password} onValue={setPassword}/>
    <ReadState loading={state.loading&&state.data===undefined} error={state.error} empty={false} emptyText="" retry={state.retry}>
      {state.data?.destinations.length===0?<p className="muted">{t("noDestinations")}</p>:<div className="table-wrap"><table><tbody>{state.data?.destinations.map(item=><tr key={item.id}><td><strong>{item.label}</strong><small>{item.pending} {t("pendingEvents")}</small></td>
        <td className="row-actions"><button className="text-button" disabled={action.busy} onClick={()=>{setNotice(undefined);void action.run(()=>service.saveExchange({sessionId,destinationId:item.id,password})).then(value=>{if(value!==undefined)done(value.empty?t("nothingToSend"):t(value.saved?"fileSavedNotice":"fileNotSaved"));});}}>{t("saveEvents")}</button>
          <button className="text-button" disabled={action.busy} onClick={()=>{setNotice(undefined);void action.run(()=>service.openImportReceipt({sessionId,destinationId:item.id,password})).then(value=>{if(value!==undefined)done(counted(value.recorded,"receiptsRecorded"));});}}>{t("openReceipt")}</button></td></tr>)}</tbody></table></div>}
      <div className="actions"><button className="secondary" disabled={action.busy} onClick={()=>{setNotice(undefined);void action.run(()=>service.openExchange({sessionId,password})).then(value=>{if(value!==undefined)setBundle(value);});}}>{t("openEvents")}</button>
        <button className="secondary" disabled={action.busy} onClick={()=>{setNotice(undefined);void action.run(()=>service.retryExchange({sessionId})).then(value=>{if(value!==undefined)done(counted(value.applied,"applied"));});}}>{t("retryDeferred")}</button></div>
      {bundle!==undefined&&<div className="file-summary"><span>{bundle.total} {t("eventsSummary")} {bundle.ready} · {t("duplicates")} {bundle.duplicate} · {t("deferred")} {bundle.deferred} · {t("toReview")} {bundle.review}</span>
        <button className="primary" disabled={action.busy} onClick={()=>{void action.run(()=>service.importExchange({sessionId})).then(value=>{if(value!==undefined){setBundle(undefined);done(counted(value.processed,"eventsImported"));}});}}>{t("importEvents")}</button></div>}
      {(state.data?.batches.length??0)>0&&<><h3>{t("receivedBatches")}</h3><ul className="plain-list">{state.data!.batches.map(batch=><li key={batch.batchId}><span>{new Date(batch.createdAt).toLocaleString(language==="fr"?"fr-FR":"en-GB")}</span>
        <button className="text-button" disabled={action.busy} onClick={()=>{setNotice(undefined);void action.run(()=>service.saveImportReceipt({sessionId,batchId:batch.batchId,password})).then(value=>{if(value!==undefined)done(t(value.saved?"fileSavedNotice":"fileNotSaved"));});}}>{t("saveReceipt")}</button></li>)}</ul></>}
      {(state.data?.diagnostics.length??0)>0&&<><h3>{t("diagnostics")}</h3><ul className="plain-list diagnostics">{state.data!.diagnostics.map((item,index)=><li key={`${item.eventId}-${index}`}><strong>{item.description}</strong><span>{item.action}</span><small>{item.code}</small></li>)}</ul></>}
    </ReadState>
    {notice!==undefined&&<p role="status" className="notice success">{notice}</p>}<ErrorText message={action.error}/></div>;
}
/** Optional sync server: paste a connection code, check it, connect, then see and drive the automatic exchange. */
function SyncServer({service,sessionId,revision}:{service:ShopService;sessionId:string;revision:number}):React.JSX.Element{
  const {t,language}=useText(),action=useAction();
  const [refresh,setRefresh]=useState(0),[code,setCode]=useState(""),[preview,setPreview]=useState<ServerPreview>(),[notice,setNotice]=useState<string>(),[copied,setCopied]=useState(false);
  const state=useRead(()=>service.serverState({sessionId}),[service,sessionId,revision,refresh]);
  const when=(value:string|null):string=>value===null?t("neverSynced"):new Date(value).toLocaleString(language==="fr"?"fr-FR":"en-GB");
  const grouped=(value:string):string=>value.replace(/(.{4})(?!$)/g,"$1 ");
  const check=async():Promise<void>=>{setPreview(undefined);setNotice(undefined);const value=await action.run(()=>service.checkServer({sessionId,code}));if(value!==undefined)setPreview(value);};
  const connect=async():Promise<void>=>{
    if(preview===undefined)return;
    const value=await action.run(()=>service.connectServer({sessionId,code}));
    if(value!==undefined){setPreview(undefined);setCode("");setRefresh(item=>item+1);}
  };
  const share=async(text:string):Promise<void>=>{try{await navigator.clipboard.writeText(text);setCopied(true);}catch{setCopied(false);}};
  // Plain facts an operator needs to help; no keys, codes or business data.
  const supportText=(server:ServerView):string=>[`kolo ${__KOLO_VERSION__}`,`server ${server.url}`,`fingerprint ${server.fingerprint}`,`connected ${server.connectedAt}${server.automatic?" (shop address)":""}`,
    `last success ${server.lastSuccessAt??"never"}`,`last attempt ${server.lastAttemptAt??"never"}`,`last error ${server.lastError??"none"}`,`waiting ${server.pending}`,`service ${server.service??"unknown"}${server.paidUntil===null?"":` until ${server.paidUntil}`}`].join("\n");
  const summary=(value:ServerSyncSummary):string=>`${t("syncDone")} · ${value.pushed} ${t("sentCount")} · ${value.pulled} ${t("receivedCount")}${value.untrusted>0?` · ${value.untrusted} ${t("waitingApprovalCount")}`:""}${value.locked>0?` · ${value.locked} ${t("waitingKeyCount")}`:""}`;
  return <div className="transfer-step"><p className="hint">{t("syncHelp")}</p><p className="hint">{t("syncPrivacy")}</p>
    <ReadState loading={state.loading&&state.data===undefined} error={state.error} empty={false} emptyText="" retry={state.retry}>
      {(state.data?.servers.length??0)>0?<><div className="table-wrap"><table><tbody>{state.data!.servers.map(server=><tr key={server.destinationId}>
        <td><strong>{server.url}</strong><small><code>{grouped(server.fingerprint)}</code></small>
          {server.automatic&&<small>{t("connectedAutomatically")}</small>}
          {server.service==="active"&&server.paidUntil!==null&&<small>{t("servicePaidUntil")} {when(server.paidUntil)}</small>}
          {server.service==="grace"&&<small className="error">{t("serviceGrace")} {when(server.graceUntil)}</small>}
          {server.service==="inactive"&&<small className="error">{t("serviceInactive")}</small>}
          <small>{t("lastSync")} {when(server.lastSuccessAt)} · {server.pending} {t("waitingOperations")}</small>
          {server.lastError!==null&&<small className="error">{t("lastSyncError")} {when(server.lastAttemptAt)}</small>}</td>
        <td className="row-actions" aria-busy={action.busy}><button className="text-button" disabled={action.busy} onClick={()=>{setNotice(undefined);void action.run(()=>service.syncServer({sessionId,destinationId:server.destinationId})).then(value=>{setRefresh(item=>item+1);if(value!==undefined)setNotice(summary(value));});}}>{t(action.busy?"syncingServer":"syncNow")}</button>
          <button className="text-button" disabled={action.busy} onClick={()=>{setNotice(undefined);void action.run(()=>service.disconnectServer({sessionId,destinationId:server.destinationId})).then(()=>setRefresh(item=>item+1));}}>{t("disconnectServer")}</button></td></tr>)}</tbody></table></div>
        {state.data!.servers.slice(0,1).map(server=><details key={`support-${server.destinationId}`} className="support"><summary>{t("supportDetails")}</summary>
          <code className="share-code">{supportText(server)}</code><button className="text-button" onClick={()=>{void share(supportText(server));}}>{t("copySupport")}</button></details>)}
        {state.data!.servers.filter(server=>server.shareCode!==null).slice(0,1).map(server=><div key={server.destinationId} className="file-summary"><strong>{t("shareServerTitle")}</strong><span>{t("shareServerHelp")}</span>
          <code className="share-code">{server.shareCode}</code><button className="secondary" onClick={()=>{void share(server.shareCode!);}}>{t(copied?"copied":"copyCode")}</button></div>)}</>
      :<form onSubmit={event=>{event.preventDefault();void (preview===undefined?check():connect());}}><fieldset disabled={action.busy}>
        <label className="field" htmlFor="sync-code">{t("connectionCode")}<textarea id="sync-code" rows={3} value={code} maxLength={8192} spellCheck={false} autoComplete="off" onChange={event=>{setCode(event.target.value);setPreview(undefined);}}/></label>
        <p className="hint">{t(state.data?.canEnroll===true?"connectionCodeOwnerHelp":"connectionCodeTillHelp")}</p>
        {preview!==undefined&&<div className="file-summary"><strong>{t("serverChecked")}</strong><span>{preview.url}</span><span>{t("serverFingerprintShown")} <code>{grouped(preview.fingerprint)}</code></span>
          {preview.canEnroll&&!preview.hasToken&&!preview.attached&&<span className="error">{t("codeNeedsToken")}</span>}
          {!preview.canEnroll&&<span>{t("secondaryServerHelp")}</span>}</div>}
      </fieldset><button className={preview===undefined?"secondary":"primary"} type="submit" disabled={action.busy||code.trim()===""}>{t(action.busy?(preview===undefined?"checkingServer":"connectingServer"):(preview===undefined?"checkServer":"connectServer"))}</button></form>}
    </ReadState>
    {notice!==undefined&&<p role="status" className="notice success">{notice}</p>}<ErrorText message={action.error}/></div>;
}
