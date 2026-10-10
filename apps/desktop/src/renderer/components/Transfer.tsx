import { AuthPage } from "./AuthPage.tsx";
import { useEffect, useState } from "react";
import type { BackupFileView, BundleView, InviteView, PairingRequestView, ShopService } from "../../shared/service.ts";
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
  const check=async():Promise<void>=>{setPreview(undefined);const value=await action.run(()=>service.openBackup({password}));setPassword("");if(value!==undefined)setPreview(value);};
  const restore=async():Promise<void>=>{
    if(secret!==confirm){action.setError({code:"codesMismatch"});return;}
    const value=await action.run(()=>service.restoreBackup({...(sessionId===undefined?{}:{sessionId}),...(replacing===undefined?{}:{replace:true}),confirmedName:name,deviceLabel:device,secret}));
    setSecret("");setConfirm("");if(value!==undefined)onDone();
  };
  return <div className="transfer-step">{sessionId===undefined&&<h2>{t(preview===undefined?(chosen?"backupPasswordStep":"backupCheckStep"):(chosen?"backupConfirmChosenStep":"backupConfirmStep"))}</h2>}{sessionId!==undefined&&<p className="hint">{t("restoreReplaceHelp")}</p>}
    {preview===undefined?<form onSubmit={event=>{event.preventDefault();void check();}}><fieldset disabled={action.busy}><PasswordFields id="restore" value={password} onValue={setPassword}/></fieldset>
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
      <div className="panel"><h2>{t("backupTitle")}</h2><SaveBackup service={service} sessionId={sessionId}/></div>
      <div className="panel"><h2>{t("pairTitle")}</h2><Pair service={service} sessionId={sessionId}/></div>
      <div className="panel wide"><h2>{t("exchangeTitle")}</h2><Exchange service={service} sessionId={sessionId} revision={revision}/></div>
      <div className="panel wide"><h2>{t("restoreTitle")}</h2><Restore service={service} sessionId={sessionId} onDone={()=>undefined}/></div>
    </div>
  </section>;
}
function SaveBackup({service,sessionId}:{service:ShopService;sessionId:string}):React.JSX.Element{
  const {t}=useText(),action=useAction(),[password,setPassword]=useState(""),[confirm,setConfirm]=useState(""),[saved,setSaved]=useState<boolean>(),[includePhotos,setIncludePhotos]=useState(true);
  const submit=async():Promise<void>=>{
    setSaved(undefined);if(password!==confirm){action.setError({code:"passwordsMismatch"});return;}
    const value=await action.run(()=>service.saveBackup({sessionId,password,includePhotos}));setPassword("");setConfirm("");if(value!==undefined)setSaved(value.saved);
  };
  return <form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={action.busy}><PasswordFields id="backup" value={password} confirm={confirm} onValue={setPassword} onConfirm={setConfirm}/>
    <label className="check" htmlFor="backup-photos"><input id="backup-photos" type="checkbox" checked={includePhotos} onChange={event=>setIncludePhotos(event.target.checked)}/>{t("includePhotos")}</label>
    <p className="hint">{t("includePhotosHelp")}</p></fieldset>
    <ErrorText message={action.error}/><Saved saved={saved}/><button className="primary" type="submit" disabled={action.busy}>{action.busy?t("recording"):t("saveBackup")}</button></form>;
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
