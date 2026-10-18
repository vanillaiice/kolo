import { canonicalJson, utf8Length } from "@kolo/contracts/canonical";
import { signedPairingInviteSchema, signedPairingRequestSchema, type SignedPairingInvite, type SignedPairingRequest } from "@kolo/contracts/transfer";
import { authorizedOperation, nextId, timestamp, runtime } from "../identity/internal-authority.ts";
import { currentInstallation, lockWorkspace } from "../identity/workspace.ts";
import { validateLocalSecret } from "../identity/credentials.ts";
import type { OperationContext, WorkspacePorts, Installation, ProvisionedIdentity } from "../identity/types.ts";
import type { Database } from "../data/database/driver.ts";
import { TransferError, type TransferCrypto, type SnapshotPort, type TransferDocument } from "../backup/types.ts";
import { createSignedSnapshot, initializeSnapshot } from "./backup.ts";
import { encodeSnapshot, decodeSnapshot, validateSnapshot } from "../backup/snapshot.ts";
import { encryptTransfer, decryptTransfer, validateTransferPassword } from "../backup/encryption.ts";
import { pinnedDevice, registerExchangeDestination, requireOwner } from "./exchange.ts";

type Intent = { mode:"fresh"|"existing"; invite:SignedPairingInvite; installationId:string; deviceId:string; requestId:string; label:string; platform:"ANDROID"|"IOS"|"DESKTOP"; at:string; signed?:SignedPairingRequest };
const enrollmentBusy=new WeakSet<Database>();
/** Invitations and requests are plaintext UTF-8 JSON files of at most 64 KiB. */
function parseFile(file:Uint8Array,crypto:TransferCrypto):unknown {try{if(!(file instanceof Uint8Array)||file.byteLength>64*1024)throw new Error();const text=crypto.decodeText(file);if(utf8Length(text)>64*1024)throw new Error();const value:unknown=JSON.parse(text);canonicalJson(value,64*1024);return value;}catch{throw new TransferError("invalid_pairing");}}
function intentOf(db:Database):Intent|undefined {const row=db.get(`SELECT intent FROM workspace_enrollment WHERE id=1`);return row===undefined?undefined:JSON.parse(String(row["intent"])) as Intent;}
function checkExpiry(invite:SignedPairingInvite,ports:WorkspacePorts):void {if(invite.invite.expires_at<=timestamp(ports)||Date.parse(invite.invite.expires_at)-Date.parse(invite.invite.created_at)>24*60*60*1000||invite.invite.expires_at<=invite.invite.created_at)throw new TransferError("pairing_expired");}
function primary(context:OperationContext):WorkspacePorts {return authorizedOperation(context,["business.settings","users.manage"],(_db,tx,ports)=>{requireOwner(tx,context);if(pinnedDevice(tx,context.businessId,context.deviceId)["authority_allowed"]!==1)throw new TransferError("invalid_pairing");return ports;});}
async function signedProof(message:string,key:string,reference:string,ports:WorkspacePorts,crypto:TransferCrypto):Promise<{digest:string;signature:string}>{if(ports.credentials.sign===undefined)throw new TransferError("authentication_failed");const digest=await crypto.sha256(message),signature=await ports.credentials.sign(reference,message);if(!await crypto.verify(key,message,signature))throw new TransferError("authentication_failed");return {digest,signature};}
async function verifyInvite(input:unknown,crypto:TransferCrypto):Promise<SignedPairingInvite>{const parsed=signedPairingInviteSchema.safeParse(input);if(!parsed.success)throw new TransferError("invalid_pairing");const signed=parsed.data,message=`kolo.pairing-invite.v1\u0000${canonicalJson(signed.invite)}`;if(await crypto.sha256(message)!==signed.digest||!await crypto.verify(signed.invite.source_public_key,message,signed.signature))throw new TransferError("authentication_failed");return signed;}
async function verifyRequest(input:unknown,crypto:TransferCrypto):Promise<SignedPairingRequest>{const parsed=signedPairingRequestSchema.safeParse(input);if(!parsed.success)throw new TransferError("invalid_pairing");const signed=parsed.data;await verifyInvite(signed.request.invite,crypto);const message=`kolo.pairing-request.v1\u0000${canonicalJson(signed.request)}`;if(await crypto.sha256(message)!==signed.digest||!await crypto.verify(signed.request.public_key,message,signed.signature))throw new TransferError("authentication_failed");return signed;}
/** 128-bit comparison fingerprint. Compare directly with the owner through an independent channel. */
export async function pairingFingerprint(publicKey:string,crypto:TransferCrypto):Promise<string>{return (await crypto.sha256(`kolo.pairing-key.v1\u0000${publicKey}`)).slice(0,32);}
/** Both installations display this exact request-bound comparison code before owner approval. */
export async function pairingVerificationCode(request:SignedPairingRequest,crypto:TransferCrypto):Promise<string>{return (await crypto.sha256(`kolo.pairing-code.v1\u0000${request.request.invite.digest}\u0000${request.digest}`)).slice(0,32);}
/** Issues an identity-only, expiring invitation. It grants no authority until owner confirmation. */
export async function createPairingInvite(context:OperationContext,crypto:TransferCrypto,authorityAllowed=false):Promise<TransferDocument>{
 if(typeof authorityAllowed!=="boolean")throw new TransferError("invalid_pairing");const ports=primary(context);
 const material=authorizedOperation(context,[],(_db,tx)=>{const i=tx.get(`SELECT * FROM local_installation WHERE id=1`)!,b=tx.get(`SELECT name FROM businesses WHERE id=?`,[context.businessId])!,u=tx.get(`SELECT name FROM users WHERE id=?`,[context.userId])!;return {key:String(i["public_key"]),reference:String(i["key_reference"]),shop:String(b["name"]),owner:String(u["name"])};});
 const at=timestamp(ports),invite:SignedPairingInvite["invite"]={format:"kolo.pairing-invite",format_version:1,invite_id:nextId(ports),business_id:context.businessId,business_name:material.shop,owner_id:context.userId,owner_name:material.owner,source_device_id:context.deviceId,source_public_key:material.key,created_at:at,expires_at:new Date(Date.parse(at)+24*60*60*1000).toISOString(),nonce:crypto.randomHex(32),authority_allowed:authorityAllowed};
 const proof=await signedProof(`kolo.pairing-invite.v1\u0000${canonicalJson(invite)}`,material.key,material.reference,ports,crypto),signed={invite,...proof};primary(context);
 authorizedOperation(context,[],(_db,tx)=>tx.run(`INSERT INTO pairing_invites(invite_id,business_id,digest,canonical,expires_at,state) VALUES(?,?,?,?,?,'issued')`,[invite.invite_id,context.businessId,proof.digest,canonicalJson(signed),invite.expires_at]));return {filename:`${invite.invite_id}.kolo-invite.json`,bytes:crypto.encodeText(canonicalJson(signed))};
}
/** Authenticated invitation summary for independent fingerprint comparison; does not initialize a shop. */
export async function previewPairingInvite(file:Uint8Array,crypto:TransferCrypto):Promise<{businessName:string;ownerName:string;fingerprint:string;authorityAllowed:boolean}>{const signed=await verifyInvite(parseFile(file,crypto),crypto);return {businessName:signed.invite.business_name,ownerName:signed.invite.owner_name,fingerprint:await pairingFingerprint(signed.invite.source_public_key,crypto),authorityAllowed:signed.invite.authority_allowed};}
/** Reserves fresh IDs durably before native provisioning. Repeating an interrupted acceptance reuses those IDs. */
export async function acceptPairingInvite(file:Uint8Array,input:{confirmedFingerprint:string;label:string;platform:"ANDROID"|"IOS"|"DESKTOP";secret:string;existingContext?:OperationContext},ports:WorkspacePorts,crypto:TransferCrypto):Promise<{document:TransferDocument;verificationCode:string}>{
 if(enrollmentBusy.has(ports.database)||runtime(ports.database).replacing===true)throw new TransferError("pairing_pending");enrollmentBusy.add(ports.database);
 try{
  validateLocalSecret(input.secret);const invite=await verifyInvite(parseFile(file,crypto),crypto);checkExpiry(invite,ports);
  if(input.confirmedFingerprint!==await pairingFingerprint(invite.invite.source_public_key,crypto))throw new TransferError("confirmation_required");
  if(input.label.trim().length===0||input.label.length>120||!["ANDROID","IOS","DESKTOP"].includes(input.platform))throw new TransferError("invalid_pairing");
  const check=():void=>{if(runtime(ports.database).replacing===true)throw new TransferError("pairing_pending");if(input.existingContext!==undefined){authorizedOperation(input.existingContext,["business.settings"],(db,tx)=>{requireOwner(tx,input.existingContext!);if(db!==ports.database||input.existingContext!.businessId!==invite.invite.business_id||input.existingContext!.userId!==invite.invite.owner_id)throw new TransferError("scope_mismatch");});}else if(currentInstallation(ports.database).state!=="empty")throw new TransferError("not_empty");};check();
  const old=intentOf(ports.database),existing=input.existingContext===undefined?undefined:ports.database.get(`SELECT * FROM local_installation WHERE id=1`)!;
  const intent:Intent=old??{mode:existing===undefined?"fresh":"existing",invite,installationId:existing===undefined?nextId(ports):String(existing["installation_id"]),deviceId:existing===undefined?nextId(ports):String(existing["device_id"]),requestId:nextId(ports),label:input.label.trim(),platform:input.platform,at:timestamp(ports)};
  if(intent.invite.digest!==invite.digest||intent.mode!==(existing===undefined?"fresh":"existing"))throw new TransferError("pairing_conflict");
  if(old===undefined)ports.database.transaction(tx=>{check();tx.run(`INSERT INTO workspace_enrollment VALUES(1,?)`,[canonicalJson(intent)]);});
  let native:ProvisionedIdentity;
  if(intent.mode==="existing"){
   const identity=ports.database.get(`SELECT public_key,key_reference FROM local_installation WHERE id=1`)!,member=ports.database.get(`SELECT credential_reference FROM local_memberships WHERE business_id=? AND user_id=?`,[invite.invite.business_id,invite.invite.owner_id])!;
   const credentialReference=String(member["credential_reference"]);
   if(!await ports.credentials.verify(credentialReference,input.secret))throw new TransferError("authentication_failed");
   native={publicKey:String(identity["public_key"]),keyReference:String(identity["key_reference"]),credentialReference};
  }else native=await ports.credentials.provision({installationId:intent.installationId,businessId:invite.invite.business_id,userId:invite.invite.owner_id,deviceId:intent.deviceId,secret:input.secret});check();checkExpiry(invite,ports);
  const request:SignedPairingRequest["request"]={format:"kolo.pairing-request",format_version:1,request_id:intent.requestId,invite,installation_id:intent.installationId,device_id:intent.deviceId,public_key:native.publicKey,label:intent.label,platform:intent.platform,created_at:intent.at};
  const signed:SignedPairingRequest={request,...await signedProof(`kolo.pairing-request.v1\u0000${canonicalJson(request)}`,native.publicKey,native.keyReference,ports,crypto)};check();
  ports.database.transaction(tx=>{if(intentOf(ports.database)?.requestId!==intent.requestId)throw new TransferError("pairing_conflict");tx.run(`UPDATE workspace_enrollment SET intent=? WHERE id=1`,[canonicalJson({...intent,signed})]);});
  return {document:{filename:`${request.request_id}.kolo-request.json`,bytes:crypto.encodeText(canonicalJson(signed))},verificationCode:await pairingVerificationCode(signed,crypto)};
 }finally{enrollmentBusy.delete(ports.database);}
}
/** Verifies the native-key possession request for independent code comparison; has no trust effects. */
export async function previewPairingRequest(file:Uint8Array,crypto:TransferCrypto):Promise<{deviceLabel:string;businessName:string;verificationCode:string;authorityAllowed:boolean}>{const signed=await verifyRequest(parseFile(file,crypto),crypto);return {deviceLabel:signed.request.label,businessName:signed.request.invite.invite.business_name,verificationCode:await pairingVerificationCode(signed,crypto),authorityAllowed:signed.request.invite.invite.authority_allowed};}
/** Owner confirmation pins the exact fresh key and emits an encrypted recipient-bound sanitized baseline. */
export async function confirmPairing(context:OperationContext,file:Uint8Array,confirmedCode:string,password:string,files:SnapshotPort,crypto:TransferCrypto):Promise<TransferDocument>{
 validateTransferPassword(password);
 const ports=primary(context),signed=await verifyRequest(parseFile(file,crypto),crypto),r=signed.request,i=r.invite.invite;checkExpiry(r.invite,ports);
 if(confirmedCode!==await pairingVerificationCode(signed,crypto))throw new TransferError("confirmation_required");
 authorizedOperation(context,["users.manage"],(_db,tx)=>{primary(context);const record=tx.get(`SELECT * FROM pairing_invites WHERE invite_id=? AND business_id=?`,[i.invite_id,context.businessId]),install=tx.get(`SELECT public_key FROM local_installation WHERE id=1`)!;
  if(record===undefined||record["digest"]!==r.invite.digest||record["canonical"]!==canonicalJson(r.invite)||record["state"]==="cancelled"||i.business_id!==context.businessId||i.owner_id!==context.userId||i.source_device_id!==context.deviceId||i.source_public_key!==install["public_key"]||r.device_id===context.deviceId||r.installation_id===tx.get(`SELECT installation_id FROM local_installation WHERE id=1`)!["installation_id"])throw new TransferError("invalid_pairing");
  if(record["state"]==="confirmed"&&record["request_digest"]!==signed.digest)throw new TransferError("pairing_conflict");
  registerExchangeDestination(context,{deviceId:r.device_id,publicKey:r.public_key,label:r.label,platform:r.platform,kind:"peer",authorityAllowed:i.authority_allowed});
  tx.run(`UPDATE pairing_invites SET state='confirmed',request_digest=?,recipient_device_id=? WHERE invite_id=?`,[signed.digest,r.device_id,i.invite_id]);
 });
 const {signed:snapshot,image}=await createSignedSnapshot(context,"enrollment",{installation_id:r.installation_id,device_id:r.device_id,public_key:r.public_key,label:r.label,platform:r.platform,authority_allowed:i.authority_allowed,invite_id:i.invite_id,request_id:r.request_id,request_digest:signed.digest},files,crypto);
 const plain=encodeSnapshot(snapshot,image,crypto);
 try{const bytes=await encryptTransfer(plain,"enrollment",snapshot.manifest.snapshot_id,password,crypto);primary(context);return {filename:`${r.request_id}.kolo-enrollment`,bytes};}finally{plain.fill(0);image.fill(0);}
}
/** Finishes only the exact approved enrollment. Existing recovery re-pairing adds trust while preserving newer local history. */
export async function completePairing(file:Uint8Array,password:string,confirmedCode:string,ports:WorkspacePorts,files:SnapshotPort,crypto:TransferCrypto,existingContext?:OperationContext):Promise<{database:Database;installation:Installation}>{
 if(enrollmentBusy.has(ports.database)||runtime(ports.database).replacing===true)throw new TransferError("pairing_pending");enrollmentBusy.add(ports.database);
 let plain:Uint8Array|undefined;
 try{
  const intent=intentOf(ports.database);if(intent?.signed===undefined)throw new TransferError("pairing_pending");
  const check=():void=>{if(runtime(ports.database).replacing===true)throw new TransferError("pairing_pending");if(intentOf(ports.database)?.signed?.digest!==intent.signed!.digest)throw new TransferError("pairing_conflict");if(intent.mode==="fresh"){if(currentInstallation(ports.database).state!=="empty")throw new TransferError("not_empty");}else {if(existingContext===undefined)throw new TransferError("confirmation_required");authorizedOperation(existingContext,["business.settings"],(db,tx)=>{requireOwner(tx,existingContext);if(db!==ports.database||existingContext.businessId!==intent.invite.invite.business_id)throw new TransferError("scope_mismatch");});}};check();
  if(confirmedCode!==await pairingVerificationCode(intent.signed,crypto))throw new TransferError("confirmation_required");
  const native:ProvisionedIdentity|undefined=await ports.credentials.inspect(intent.installationId);if(native===undefined||native.publicKey!==intent.signed.request.public_key)throw new TransferError("authentication_failed");
  plain=await decryptTransfer(file,"enrollment",password,crypto);const {signed,image}=decodeSnapshot(plain,crypto),m=signed.manifest,t=m.target,i=intent.invite.invite;
  if(m.kind!=="enrollment"||t===null||m.business.id!==i.business_id||m.owner.id!==i.owner_id||m.source_device_id!==i.source_device_id||m.source_public_key!==i.source_public_key||t.installation_id!==intent.installationId||t.device_id!==intent.deviceId||t.public_key!==native.publicKey||t.request_id!==intent.requestId||t.request_digest!==intent.signed.digest||t.invite_id!==i.invite_id||t.authority_allowed!==i.authority_allowed||m.snapshot_bytes!==image.length||await crypto.sha256Bytes(image)!==m.snapshot_digest)throw new TransferError("invalid_pairing");
  const message=`kolo.snapshot.v1\u0000${canonicalJson(m)}`;if(await crypto.sha256(message)!==signed.digest||!await crypto.verify(i.source_public_key,message,signed.signature))throw new TransferError("authentication_failed");
  const candidate=await files.open(image);image.fill(0);
  try{
   await validateSnapshot(candidate.database,m,files);check();
   if(intent.mode==="existing"){
    // This proof-backed handshake may re-pair a secondary device. Arbitrary manual pin registration still requires primary authority.
    ports.database.transaction(tx=>{
     check();const previous=tx.get(`SELECT business_id FROM devices WHERE id=?`,[i.source_device_id]),pin=tx.get(`SELECT public_key FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`,[i.business_id,i.source_device_id]);
     if(previous!==undefined&&previous["business_id"]!==i.business_id||pin!==undefined&&pin["public_key"]!==i.source_public_key)throw new TransferError("pairing_conflict");
     const source=candidate.database.get(`SELECT * FROM devices WHERE id=?`,[i.source_device_id])!;
     tx.run(`INSERT OR IGNORE INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES(?,?,?,?,?,?,?)`,[i.source_device_id,i.business_id,String(source["label"]),String(source["platform"]),timestamp(ports),timestamp(ports),timestamp(ports)]);
     tx.run(`INSERT INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES(?,?,?,1,?) ON CONFLICT(business_id,device_id) DO UPDATE SET active=1,authority_allowed=1,revision=revision+1`,[i.business_id,i.source_device_id,i.source_public_key,i.owner_id]);
     tx.run(`UPDATE trusted_exchange_devices SET authority_allowed=?,revision=revision+1 WHERE business_id=? AND device_id=? AND public_key=?`,[i.authority_allowed?1:0,i.business_id,intent.deviceId,native.publicKey]);
     if(tx.get(`SELECT id FROM exchange_destinations WHERE business_id=? AND receiver_device_id=? AND kind='peer'`,[i.business_id,i.source_device_id])===undefined)tx.run(`INSERT INTO exchange_destinations(id,business_id,receiver_device_id,kind,label) VALUES(?,?,?,'peer','Owner')`,[nextId(ports),i.business_id,i.source_device_id]);
     tx.run(`DELETE FROM workspace_enrollment WHERE id=1`);
    });const state=currentInstallation(ports.database);if(state.state!=="unlocked"&&state.state!=="locked")throw new TransferError("invalid_pairing");return {database:ports.database,installation:state.installation};
   }
   initializeSnapshot(candidate.database,m,{installationId:intent.installationId,deviceId:intent.deviceId,label:intent.label,platform:intent.platform,publicKey:native.publicKey,keyReference:native.keyReference,credentialReference:native.credentialReference,at:timestamp(ports),authorityAllowed:i.authority_allowed});
   // The source is already authenticated; enroll it as a destination without inventing a business event.
   if(candidate.database.get(`SELECT id FROM exchange_destinations WHERE business_id=? AND receiver_device_id=? AND kind='peer'`,[i.business_id,i.source_device_id])===undefined)candidate.database.run(`INSERT INTO exchange_destinations(id,business_id,receiver_device_id,kind,label) VALUES(?,?,?,'peer','Owner')`,[nextId(ports),i.business_id,i.source_device_id]);
   check();runtime(ports.database).replacing=true;lockWorkspace(ports.database);
   let activated=false;
   try{const database=await candidate.activate(ports.database);activated=true;return {database,installation:{installationId:intent.installationId,businessId:m.business.id,businessName:m.business.name,ownerId:m.owner.id,deviceId:intent.deviceId,publicKey:native.publicKey,configuredAt:timestamp(ports)}};}catch{throw new TransferError("activation_failed");}finally{runtime(ports.database).replacing=activated;}
  }finally{await candidate.discard();}
 }finally{plain?.fill(0);enrollmentBusy.delete(ports.database);}
}
/** Removes only pending public enrollment state. No initialized business/history is deleted. */
export function cancelPairing(ports:WorkspacePorts):void{if(enrollmentBusy.has(ports.database)||runtime(ports.database).replacing===true)throw new TransferError("pairing_pending");ports.database.run(`DELETE FROM workspace_enrollment WHERE id=1`);}
/** Cancels an unused source invitation. A confirmed pin must be revoked explicitly. */
export function cancelPairingInvite(context:OperationContext,inviteId:string):void{primary(context);authorizedOperation(context,[],(_db,tx)=>tx.run(`UPDATE pairing_invites SET state='cancelled' WHERE invite_id=? AND business_id=? AND state='issued'`,[inviteId,context.businessId]));}
