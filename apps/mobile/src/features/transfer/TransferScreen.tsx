import { useText, LanguageControl } from "../../app/i18n.tsx";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createBackup, previewBackup, restoreWorkspace, cancelBackupPreview, type BackupPreview } from "@kolo/core/application/backup";
import { createPairingInvite, previewPairingInvite, acceptPairingInvite, previewPairingRequest, confirmPairing, completePairing, cancelPairing } from "@kolo/core/application/pairing";
import { exportBundle, previewBundle, importBundle, exportReceipt, importReceipt, exchangeDestinations, exchangeDiagnostics, receivedBatches, type BundlePreview } from "@kolo/core/application/file-exchange";
import { exchangeStatus } from "@kolo/core/application/event-delivery";
import { retryDeferred } from "@kolo/core/application/event-application";
import { ownerRecoveryCode } from "@kolo/core/identity/recovery";
import { currentInstallation, unlockWorkspace, unlockedActor } from "@kolo/core/identity/workspace";
import type { OperationContext, WorkspacePorts } from "@kolo/core/identity/types";
import type { Database } from "@kolo/core/data/database/driver";
import type { SnapshotPort, TransferDocument } from "@kolo/core/backup/types";
import { transferCryptoOnDevice as crypto } from "../../data/auth/local-credentials-on-device.ts";
import { pickTransferFile, saveTransferFile } from "../../data/transfer/files-on-device.ts";
import { transferErrorKey } from "../../app/identity-errors.ts";
import type { LocalizedMessage } from "../../app/strings.ts";
import { colors, spacing, TOUCH_TARGET } from "../../components/theme.ts";

/** Owner file workflows; system file dialogs may lock the app, so local proof can be renewed here. */
export function TransferScreen({ports,files,context,onActivated,onUnlocked,onBack}:{ports:WorkspacePorts;files:SnapshotPort;context:OperationContext|undefined;onActivated:(database:Database)=>void;onUnlocked:(context:OperationContext)=>void;onBack:()=>void}):React.JSX.Element{
 const { t, language }=useText();
 const [busy,setBusy]=useState(false),[message,setMessage]=useState<LocalizedMessage>(),[password,setPassword]=useState(""),[pin,setPin]=useState(""),[confirmPin,setConfirmPin]=useState(""),[label,setLabel]=useState(() => t("defaultSecondTill")),[code,setCode]=useState(""),[confirmation,setConfirmation]=useState("");
 const [authorityAllowed,setAuthorityAllowed]=useState(false);
 const [document,setDocument]=useState<TransferDocument>(),[picked,setPicked]=useState<string>(),[backup,setBackup]=useState<BackupPreview>(),[bundle,setBundle]=useState<BundlePreview>(),[invite,setInvite]=useState<Awaited<ReturnType<typeof previewPairingInvite>>>(),[request,setRequest]=useState<Awaited<ReturnType<typeof previewPairingRequest>>>(),[destination,setDestination]=useState<string>(),[revision,setRevision]=useState(0);
 useEffect(()=>{if(context===undefined)setBundle(undefined);},[context]);
 const staged=useRef<BackupPreview|undefined>(undefined);const mounted=useRef(true);useEffect(()=>()=>{mounted.current=false;if(staged.current!==undefined)void cancelBackupPreview(staged.current);},[]);
 const state=currentInstallation(ports.database),configured=state.state==="locked"||state.state==="unlocked",empty=state.state==="empty";
 let active:OperationContext|undefined;try{if(context!==undefined&&unlockedActor(context).isOwner)active=context;}catch{/* Native file dialogs/background lock require fresh proof. */}
 const peers=active===undefined?[]:exchangeDestinations(active),diagnostics=active===undefined?[]:exchangeDiagnostics(active,language),batches=active===undefined?[]:receivedBatches(active);
 const chosen=destination??peers[0]?.id;void revision;
 const authority=async():Promise<OperationContext>=>{try{if(context!==undefined&&unlockedActor(context).isOwner)return context;}catch{}const installation=currentInstallation(ports.database);if(installation.state!=="locked"&&installation.state!=="unlocked")throw new Error("locked");const fresh=await unlockWorkspace({userId:installation.installation.ownerId,secret:pin},ports);onUnlocked(fresh);return fresh;};
 const run=async(work:()=>Promise<void>):Promise<void>=>{if(busy)return;setBusy(true);setMessage(undefined);try{await work();if(mounted.current)setRevision(n=>n+1);}catch(e){if(mounted.current){setMessage({ key: transferErrorKey(e) });}}finally{if(mounted.current)setBusy(false);}};
 const pick=async():Promise<void>=>{const text=await pickTransferFile();if(text===undefined)return;if(staged.current!==undefined)await cancelBackupPreview(staged.current);staged.current=undefined;setBackup(undefined);setBundle(undefined);setInvite(undefined);setRequest(undefined);setPicked(text);setMessage({ key: "filePicked" });};
 const needFile=():string=>{if(picked===undefined)throw new Error("invalid_file");return picked;};
 const emit=async(doc:TransferDocument|undefined):Promise<void>=>{if(doc===undefined){setMessage({ key: "nothingToExport" });return;}setDocument(doc);setMessage({ key: "filePrepared" });};
 const platform=Platform.OS==="ios"?"IOS":"ANDROID";
 const field=(title:string,value:string,set:(v:string)=>void,secure=false)=><View><Text style={styles.label}>{title}</Text><TextInput editable={!busy} accessibilityLabel={title} value={value} onChangeText={set} secureTextEntry={secure} autoCapitalize="none" autoCorrect={false} style={styles.input}/></View>;
 const button=(title:string,work:()=>Promise<void>)=><Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={[styles.button,busy&&{opacity:0.5}]} onPress={()=>{void run(work);}}><Text style={styles.buttonText}>{title}</Text></Pressable>;
 return <SafeAreaView style={styles.screen}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
  <LanguageControl disabled={busy} /><Text style={styles.title}>{t("transferTitle")}</Text><Text>{t("transferHelp")}</Text>
  {field(t("filePassword"),password,setPassword,true)}{field(configured?t("localUnlockCode"):t("newLocalCode"),pin,setPin,true)}
  {empty?field(t("confirmLocalCode"),confirmPin,setConfirmPin,true):null}{field(t("deviceName"),label,setLabel)}
  {busy?<ActivityIndicator color={colors.accent}/>:null}{message?<Text accessibilityLiveRegion="polite" style={styles.message}>{t(message.key, message.values)}</Text>:null}
  {button(t("pickFile"),pick)}
  {document===undefined?null:<><Text selectable>{t("readyFilename", { filename: document.filename })}</Text>{button(t("saveReadyFile"),async()=>{await saveTransferFile(document);setMessage({ key: "fileSaved" });})}</>}
  {configured?<><Text style={styles.title}>{t("backupTitle")}</Text>{button(t("viewLocalRecoveryKey"),async()=>{const recovery=await ownerRecoveryCode(await authority(),pin);setMessage(recovery===undefined?{ key: "localKeyUnavailable" }:{ key: "keepRecoveryKey", values: { key: recovery } });})}{button(t("createEncryptedBackup"),async()=>emit(await createBackup(await authority(),password,files,crypto)))}</>:null}
  {empty||configured?<><Text style={styles.title}>{configured?t("explicitRecovery"):t("restoreShop")}</Text>
   {configured?<Text>{t("replaceShopHelp")}</Text>:null}
   {button(t("checkBackup"),async()=>{if(staged.current!==undefined)await cancelBackupPreview(staged.current);const preview=await previewBackup(needFile(),password,files,crypto);staged.current=preview;setBackup(preview);})}
   {backup===undefined?null:<><Text selectable>{backup.businessName} — {backup.ownerName}{"\n"}{backup.createdAt}{"\n"}{t("savedEventCount", { count: backup.appliedEvents })}</Text>{field(t("confirmShopName"),confirmation,setConfirmation)}{button(t("confirmRestore"),async()=>{if(confirmation!==backup.businessName)throw new Error("confirmation_required");if(empty&&pin!==confirmPin)throw new Error("invalid_input");const result=await restoreWorkspace(backup,{confirmedBusinessId:backup.businessId,deviceLabel:label,platform,secret:pin,...(configured?{recoveryContext:await authority()}: {})},ports);staged.current=undefined;onActivated(result.database);})}</>}
  </>:null}
  {empty||configured?<><Text style={styles.title}>{t("pairDevices")}</Text><Text>{t("pairHelp")}</Text>
   {configured?<View><Text>{t("allowStaffManagement")}</Text><Switch accessibilityLabel={t("allowStaffManagement")} disabled={busy} value={authorityAllowed} onValueChange={setAuthorityAllowed}/></View>:null}
   {configured?button(t("createInvite"),async()=>{const doc=await createPairingInvite(await authority(),crypto,authorityAllowed);await emit(doc);const data=await previewPairingInvite(doc.text,crypto);setMessage({ key: "compareFingerprint", values: { fingerprint: data.fingerprint } });}):null}
   {button(t("checkInvite"),async()=>{setInvite(await previewPairingInvite(needFile(),crypto));})}
   {invite===undefined?null:<><Text selectable>{invite.businessName} — {invite.ownerName}{"\n"}{t("fingerprintValue", { fingerprint: invite.fingerprint })}</Text>{field(t("ownerFingerprint"),code,setCode)}{button(configured?t("repairWithoutReplacing"):t("acceptInvite"),async()=>{if(empty&&pin!==confirmPin)throw new Error("invalid_input");const result=await acceptPairingInvite(needFile(),{confirmedFingerprint:code.trim(),label,platform,secret:pin,...(configured?{existingContext:await authority()}: {})},ports,crypto);await emit(result.document);setMessage({ key: "comparePairingCode", values: { code: result.verificationCode } });})}</>}
   {configured?button(t("checkRequest"),async()=>setRequest(await previewPairingRequest(needFile(),crypto))):null}
   {request===undefined?null:<><Text selectable>{request.deviceLabel} — {request.businessName}{"\n"}{t("pairingCodeValue", { code: request.verificationCode })}</Text>{field(t("newTillCode"),code,setCode)}{button(t("approvePairing"),async()=>emit(await confirmPairing(await authority(),needFile(),code.trim(),password,files,crypto)))}</>}
   {field(t("savedPairingCode"),code,setCode)}{button(t("completePairing"),async()=>{const result=await completePairing(needFile(),password,code.trim(),ports,files,crypto,configured?await authority():undefined);if(result.database!==ports.database)onActivated(result.database);else setMessage({ key: "paired" });})}
   {button(t("cancelPairing"),async()=>{cancelPairing(ports);setMessage({ key: "pairCancelled" });})}
  </>:null}
  {configured?<><Text style={styles.title}>{t("exchangeTitle")}</Text>
   {peers.length===0?<Text>{t("unlockPairHelp")}</Text>:peers.map(peer=><Pressable accessibilityRole="radio" accessibilityState={{ selected: chosen === peer.id, disabled: busy }} key={peer.id} disabled={busy} onPress={()=>setDestination(peer.id)} style={styles.choice}><Text>{chosen===peer.id?"● ":"○ "}{peer.label}</Text><Text>{active===undefined?"":t("pendingEventCount", { count: exchangeStatus(active,peer.id)["pending"] ?? 0 })}</Text></Pressable>)}
   {button(t("exportToPeer"),async()=>{if(chosen===undefined)throw new Error("invalid_destination");await emit(await exportBundle(await authority(),chosen,password,crypto));})}
   {button(t("previewEvents"),async()=>setBundle(await previewBundle(await authority(),needFile(),password,crypto)))}
   {bundle===undefined?null:<><Text>{t("eventPreviewSummary", { total: bundle.events.length, duplicates: bundle.events.filter(e=>e.assessment==="duplicate").length, deferred: bundle.events.filter(e=>e.assessment==="deferred").length, review: bundle.events.filter(e=>e.assessment==="review").length })}</Text>{button(t("importEvents"),async()=>{const outcomes=await importBundle(await authority(),bundle,crypto);setMessage({ key: "eventsProcessed", values: { count: outcomes.length } });})}</>}
   {button(t("importReceipt"),async()=>{if(chosen===undefined)throw new Error("invalid_destination");const n=await importReceipt(await authority(),chosen,needFile(),password,crypto);setMessage({ key: "receiptsRecorded", values: { count: n } });})}
   {batches.map(batch=><View key={batch.batchId}><Text selectable>{batch.createdAt}{"\n"}{batch.batchId}</Text>{button(t("createImportReceipt"),async()=>emit(await exportReceipt(await authority(),batch.batchId,password,crypto)))}</View>)}
   {button(t("retryEvents"),async()=>{const n=retryDeferred(await authority());setMessage({ key: "eventsApplied", values: { count: n } });})}
   {diagnostics.map((d,i)=><View key={`${d.eventId}-${i}`} style={styles.choice}><Text selectable>{d.eventId} — {d.code}</Text><Text>{d.description}</Text><Text>{d.action}</Text></View>)}
  </>:null}
  <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onBack} style={styles.choice}><Text>{t("back")}</Text></Pressable>
 </ScrollView></SafeAreaView>;
}
const styles=StyleSheet.create({screen:{flex:1,backgroundColor:colors.background},content:{padding:spacing.xl,gap:spacing.md},title:{fontSize:21,fontWeight:"600",marginTop:spacing.lg},label:{fontSize:14,marginBottom:spacing.xs},input:{minHeight:TOUCH_TARGET,borderWidth:1,borderColor:colors.border,borderRadius:6,padding:spacing.md},button:{minHeight:TOUCH_TARGET,justifyContent:"center",padding:spacing.md,backgroundColor:colors.accent,borderRadius:6},buttonText:{color:colors.accentText,fontSize:16},choice:{minHeight:TOUCH_TARGET,padding:spacing.md,backgroundColor:colors.surface,gap:spacing.sm},message:{color:colors.warning,fontSize:16}});
