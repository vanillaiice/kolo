import { canonicalJson } from "@kolo/contracts/canonical";
import { MAX_JOURNAL_BATCH_BYTES, signedPeerReceiptSchema } from "@kolo/contracts/delivery";
import { TransferError, type TransferCrypto, type TransferDocument } from "../backup/types.ts";
import { encryptTransfer, decryptTransfer, validateTransferPassword } from "../backup/encryption.ts";
import { createJournalBatch, verifyJournalBatch, importJournalBatch, createPeerReceipt, acknowledgeDelivery } from "./event-delivery.ts";
import { authorizedOperation, memberPermissions } from "../identity/internal-authority.ts";
import { eventModel } from "../data/exchange/model.ts";
import { bundlePreviews } from "../exchange/internal-files.ts";
import type { OperationContext } from "../identity/types.ts";
import type { ImportOutcome } from "./event-delivery.ts";
async function encryptObject(value:unknown,purpose:"exchange"|"receipt",id:string,password:string,crypto:TransferCrypto):Promise<string>{const bytes=crypto.encodeText(canonicalJson(value,MAX_JOURNAL_BATCH_BYTES));try{return await encryptTransfer(bytes,purpose,id,password,crypto);}finally{bytes.fill(0);}}
/** Read-only import summary. Authority/dependencies are checked again at application time. */
export interface BundlePreview {readonly batchId:string;readonly businessId:string;readonly senderDeviceId:string;readonly events:readonly {readonly eventId:string;readonly type:string;readonly assessment:"ready"|"duplicate"|"deferred"|"review"|"unsupported"}[];}
/** Encrypts one bounded signed batch; exported facts are offered until a receiver receipt is imported. */
export async function exportBundle(context:OperationContext,destinationId:string,password:string,crypto:TransferCrypto,limit=200):Promise<TransferDocument|undefined>{validateTransferPassword(password);const signed=await createJournalBatch(context,destinationId,crypto,limit);if(signed===undefined)return undefined;const text=await encryptObject(signed,"exchange",signed.batch.batch_id,password,crypto);authorizedOperation(context,["business.settings"],()=>undefined);return {filename:`${signed.batch.batch_id}.kolo-exchange.json`,text};}
/** Decrypts bounded bytes and authenticates shop, destination, forwarder and all origins without applying facts. */
export async function previewBundle(context:OperationContext,text:string,password:string,crypto:TransferCrypto):Promise<BundlePreview>{
 const bytes=await decryptTransfer(text,"exchange",password,crypto);
 try{
  if(bytes.length>MAX_JOURNAL_BATCH_BYTES)throw new TransferError("too_large");let value:unknown;try{value=JSON.parse(crypto.decodeText(bytes));}catch{throw new TransferError("invalid_file");}
  const signed=await verifyJournalBatch(context,value,crypto);
  const events=authorizedOperation(context,["business.settings"],(_db,tx)=>signed.batch.events.map(({envelope:e,digest})=>{
   let assessment:BundlePreview["events"][number]["assessment"]="ready";
   const old=tx.get(`SELECT s.digest,a.status FROM applied_events a JOIN event_signatures s ON s.event_id=a.event_id WHERE a.event_id=?`,[e.event_id]);
   if(old!==undefined&&old["digest"]!==digest)assessment="review";
   else if(old?.["status"]==="applied")assessment="duplicate";
   else try{const model=eventModel(e),actor=tx.get(`SELECT m.*,u.active AS user_active FROM local_memberships m JOIN users u ON u.id=m.user_id AND u.business_id=m.business_id WHERE m.business_id=? AND m.user_id=?`,[context.businessId,e.actor_id]);
    if(actor===undefined||e.authority_revision>Number(actor["revision"]))assessment="deferred";
    else if(actor["active"]!==1||actor["user_active"]!==1||e.authority_revision!==actor["revision"]||![...model.permissions,...e.required_permissions].every(p=>memberPermissions(actor).includes(p)))assessment="review";
    else if(model.references.some(ref=>tx.get(`SELECT id FROM ${ref.table} WHERE id=? AND business_id=?`,[ref.id,context.businessId])===undefined))assessment="deferred";
   }catch(error){assessment=error instanceof Error&&"code" in error&&error.code==="unsupported_event"?"unsupported":"review";}
   return Object.freeze({eventId:e.event_id,type:e.event_type,assessment});
  }));
  const preview:BundlePreview=Object.freeze({batchId:signed.batch.batch_id,businessId:context.businessId,senderDeviceId:signed.batch.sender_device_id,events:Object.freeze(events)});bundlePreviews.set(preview,{context,signed});return preview;
 }finally{bytes.fill(0);}
}
/** Imports only an opaque authenticated preview and rechecks current trust/authority before any effects. */
export async function importBundle(context:OperationContext,preview:BundlePreview,crypto:TransferCrypto):Promise<readonly {eventId:string;outcome:ImportOutcome}[]>{const material=bundlePreviews.get(preview);if(material===undefined||material.context!==context)throw new TransferError("confirmation_required");return importJournalBatch(context,material.signed,crypto);}
/** Regenerates an encrypted durable receipt, including after a lost/cancelled file save. */
export async function exportReceipt(context:OperationContext,batchId:string,password:string,crypto:TransferCrypto):Promise<TransferDocument|undefined>{validateTransferPassword(password);const signed=await createPeerReceipt(context,batchId,crypto);if(signed===undefined)return undefined;const text=await encryptObject(signed,"receipt",signed.receipt.receipt_id,password,crypto);authorizedOperation(context,["business.settings"],()=>undefined);return {filename:`${signed.receipt.receipt_id}.kolo-receipt.json`,text};}
/** Decrypts and applies exact digest acknowledgments to the expected destination only. */
export async function importReceipt(context:OperationContext,destinationId:string,text:string,password:string,crypto:TransferCrypto):Promise<number>{const bytes=await decryptTransfer(text,"receipt",password,crypto);try{if(bytes.length>MAX_JOURNAL_BATCH_BYTES)throw new TransferError("too_large");let value:unknown;try{value=JSON.parse(crypto.decodeText(bytes));}catch{throw new TransferError("invalid_file");}const parsed=signedPeerReceiptSchema.safeParse(value);if(!parsed.success)throw new TransferError("invalid_file");return acknowledgeDelivery(context,destinationId,parsed.data,crypto);}finally{bytes.fill(0);}}
/** Known peer selection resolved from current SQLite state. */
export function exchangeDestinations(context:OperationContext):readonly {id:string;label:string;deviceId:string}[]{return authorizedOperation(context,["business.settings"],(_db,tx)=>tx.all(`SELECT x.id,x.label,x.receiver_device_id FROM exchange_destinations x JOIN trusted_exchange_devices t ON t.device_id=x.receiver_device_id AND t.business_id=x.business_id JOIN devices d ON d.id=t.device_id WHERE x.business_id=? AND x.kind='peer' AND x.active=1 AND t.active=1 AND d.active=1 AND x.receiver_device_id<>? ORDER BY x.label,x.id`,[context.businessId,context.deviceId]).map(r=>({id:String(r["id"]),label:String(r["label"]),deviceId:String(r["receiver_device_id"])})));}
/** Durable imports available for receipt regeneration, newest first. */
export function receivedBatches(context:OperationContext):readonly {batchId:string;senderDeviceId:string;createdAt:string}[]{return authorizedOperation(context,["business.settings"],(_db,tx)=>tx.all(`SELECT batch_id,sender_device_id,created_at FROM import_batches WHERE business_id=? AND receiver_device_id=? AND status='complete' ORDER BY created_at DESC,batch_id DESC LIMIT 100`,[context.businessId,context.deviceId]).map(r=>({batchId:String(r["batch_id"]),senderDeviceId:String(r["sender_device_id"]),createdAt:String(r["created_at"])})));}
/** Localized diagnostics identify the exact fact and an actionable recovery path, without exposing financial payloads. */
export function exchangeDiagnostics(context:OperationContext,locale:"fr"|"en"="fr"):readonly {eventId:string;code:string;description:string;action:string}[]{
 const words=locale==="fr"?{deferred:["En attente d’une dépendance ou d’une nouvelle tentative.","Importer les fichiers manquants puis réessayer."],unsupported:["Format non pris en charge.","Mettre à jour KOLO puis réessayer."],quarantined:["Événement bloqué par les contrôles de validité ou d’autorisation.","Demander au propriétaire de vérifier cet événement."],return_conflict:["Un autre retour a déjà utilisé ce point de départ.","Le propriétaire doit comparer les marchandises et remboursements sur les deux caisses avant une correction."],conflict:["Identité réutilisée avec un contenu différent.","Conserver les fichiers et contacter le propriétaire."]}: {deferred:["Waiting for dependencies or a retry.","Import missing files, then retry."],unsupported:["Unsupported event format.","Update KOLO, then retry."],quarantined:["Event blocked by validity or authority checks.","Ask the owner to review this event."],return_conflict:["Another return already used this predecessor.","The owner must compare goods and refunds on both tills before making a correction."],conflict:["Identity reused with different content.","Keep the files and contact the owner."]};
 return authorizedOperation(context,["business.settings"],(_db,tx)=>[...tx.all(`SELECT event_id,status,reason FROM applied_events WHERE business_id=? AND status IN ('deferred','unsupported','quarantined') ORDER BY updated_at DESC LIMIT 200`,[context.businessId]),...tx.all(`SELECT event_id,'conflict' AS status,'conflict' AS reason FROM exchange_conflicts WHERE business_id=? ORDER BY detected_at DESC LIMIT 200`,[context.businessId])].map(r=>{const text=words[(r["reason"] === "return_conflict" ? "return_conflict" : String(r["status"])) as keyof typeof words];return {eventId:String(r["event_id"]),code:String(r["reason"]??r["status"]),description:text[0]!,action:text[1]!};}));
}
