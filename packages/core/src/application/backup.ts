import { canonicalJson } from "@kolo/contracts/canonical";
import type { SnapshotManifest, SignedSnapshot } from "@kolo/contracts/transfer";
import { authorizedOperation, nextId, timestamp, runtime } from "../identity/internal-authority.ts";
import { lockWorkspace, currentInstallation } from "../identity/workspace.ts";
import { validateLocalSecret } from "../identity/credentials.ts";
import type { OperationContext, WorkspacePorts, Installation } from "../identity/types.ts";
import { requireOwner, sealPendingEvents } from "./exchange.ts";
import { limitsOf, TransferError, type TransferCrypto, type SnapshotPort, type TransferDocument } from "../backup/types.ts";
import { encryptTransfer, decryptTransfer, validateTransferPassword } from "../backup/encryption.ts";
import { sanitizeSnapshot, snapshotBoundary, validateSnapshot, encodeSnapshot, decodeSnapshot } from "../backup/snapshot.ts";
import { backupPreviews } from "../backup/internal-preview.ts";
import type { Database } from "../data/database/driver.ts";

/** Verified snapshot summary; the native candidate is held privately and consumed at most once. */
export interface BackupPreview {
 readonly businessId:string;readonly businessName:string;readonly ownerName:string;readonly createdAt:string;
 readonly sourceDeviceId:string;readonly snapshotId:string;readonly schemaVersion:number;readonly appliedEvents:number;
}

/** @internal Captures, strips credentials (and product photos when asked), compacts and signs one coherent snapshot for backup or approved enrollment. */
export async function createSignedSnapshot(context:OperationContext,kind:SnapshotManifest["kind"],target:SnapshotManifest["target"],files:SnapshotPort,crypto:TransferCrypto,options:BackupOptions={}):Promise<{signed:SignedSnapshot;image:Uint8Array}>{
 const {ports,database}=authorizedOperation(context,["business.settings"],(database,tx,ports)=>{requireOwner(tx,context);return {ports,database};});
 for(let pass=0;pass<32;pass++){if(await sealPendingEvents(context,crypto,1000)<1000)break;if(pass===31)throw new TransferError("too_large");}
 const handle=await files.capture(database);
 try{
  const db=handle.database,install=db.get(`SELECT * FROM local_installation WHERE id=1`);
  if(install?.["business_id"]!==context.businessId||install["device_id"]!==context.deviceId||install["owner_id"]!==context.userId)throw new TransferError("scope_mismatch");
  const shop=db.get(`SELECT name,currency FROM businesses WHERE id=?`,[context.businessId])!,owner=db.get(`SELECT name FROM users WHERE id=? AND business_id=?`,[context.userId,context.businessId])!;
  if(db.get(`SELECT e.event_id FROM event_journal e LEFT JOIN event_signatures s ON s.event_id=e.event_id WHERE e.business_id=? AND e.origin_device_id=? AND s.event_id IS NULL LIMIT 1`,[context.businessId,context.deviceId])!==undefined)throw new TransferError("pairing_pending");
  const publicKey=String(install["public_key"]),keyReference=String(install["key_reference"]),boundary=snapshotBoundary(db,context.businessId);
  const schema=Number(db.get(`SELECT max(version) AS n FROM schema_migrations`)!["n"]);
  sanitizeSnapshot(db,context.deviceId);if(options.includePhotos===false)db.run(`DELETE FROM product_photos`);const image=await handle.bytes();
  const manifest:SnapshotManifest={format:"kolo.snapshot",format_version:1,snapshot_id:nextId(ports),kind,schema_version:schema,created_at:timestamp(ports),business:{id:context.businessId,name:String(shop["name"]),currency:"XAF"},owner:{id:context.userId,name:String(owner["name"])},source_device_id:context.deviceId,source_public_key:publicKey,snapshot_digest:await crypto.sha256Bytes(image),snapshot_bytes:image.byteLength,boundary,credential_policy:"device_local_credentials_excluded",target};
  const message=`kolo.snapshot.v1\u0000${canonicalJson(manifest)}`;
  if(ports.credentials.sign===undefined)throw new TransferError("authentication_failed");
  const digest=await crypto.sha256(message),signature=await ports.credentials.sign(keyReference,message);
  if(!await crypto.verify(publicKey,message,signature))throw new TransferError("authentication_failed");
  authorizedOperation(context,["business.settings"],(_database,tx)=>requireOwner(tx,context));
  return {signed:{manifest,digest,signature},image};
 }finally{await handle.discard();}
}

/** Backup choices. Photos are included unless `includePhotos` is false; a backup without them restores products with no photo. */
export interface BackupOptions { readonly includePhotos?: boolean }

/** Consistent encrypted backup excluding credentials, cloud sessions and installation private keys, and optionally product photos. */
export async function createBackup(context:OperationContext,password:string,files:SnapshotPort,crypto:TransferCrypto,options:BackupOptions={}):Promise<TransferDocument>{
 validateTransferPassword(password);
 const {signed,image}=await createSignedSnapshot(context,"backup",null,files,crypto,options);
 const limits=limitsOf(files),plain=encodeSnapshot(signed,image,crypto,limits);
 try{const text=await encryptTransfer(plain,"backup",signed.manifest.snapshot_id,password,crypto,limits);authorizedOperation(context,["business.settings"],(_db,tx)=>requireOwner(tx,context));return {filename:`${signed.manifest.snapshot_id}.kolo-backup.json`,text};}finally{plain.fill(0);image.fill(0);}
}

/** Authenticates password/image/manifest and validates schema, integrity, scope, foreign keys and replay boundary in isolation. */
export async function previewBackup(text:string,password:string,files:SnapshotPort,crypto:TransferCrypto):Promise<BackupPreview>{
 const limits=limitsOf(files),plain=await decryptTransfer(text,"backup",password,crypto,limits);
 try{
  const {signed,image}=decodeSnapshot(plain,crypto,limits),m=signed.manifest;
  if(m.kind!=="backup"||m.target!==null||image.length!==m.snapshot_bytes||await crypto.sha256Bytes(image)!==m.snapshot_digest)throw new TransferError("invalid_snapshot");
  const message=`kolo.snapshot.v1\u0000${canonicalJson(m)}`;
  if(await crypto.sha256(message)!==signed.digest||!await crypto.verify(m.source_public_key,message,signed.signature))throw new TransferError("authentication_failed");
  const handle=await files.open(image);image.fill(0);
  try{await validateSnapshot(handle.database,m,files);}catch(error){await handle.discard();throw error;}
  const preview:BackupPreview=Object.freeze({businessId:m.business.id,businessName:m.business.name,ownerName:m.owner.name,createdAt:m.created_at,sourceDeviceId:m.source_device_id,snapshotId:m.snapshot_id,schemaVersion:m.schema_version,appliedEvents:m.boundary.applied_count});
  backupPreviews.set(preview,{signed,handle,files,crypto,state:"ready"});return preview;
 }finally{plain.fill(0);}
}

/** Releases an unused private candidate; cannot remove an activated business database. */
export async function cancelBackupPreview(preview:BackupPreview):Promise<void>{const material=backupPreviews.get(preview);if(material===undefined||material.state!=="ready")return;material.state="consumed";await material.handle.discard();}

/** Explicit owner-confirmed replacement: fresh native identity, preserved history, atomic active-slot switch and old file retained. */
export async function restoreWorkspace(preview:BackupPreview,input:{readonly confirmedBusinessId:string;readonly deviceLabel:string;readonly platform:"ANDROID"|"IOS"|"DESKTOP";readonly secret:string;readonly recoveryContext?:OperationContext},ports:WorkspacePorts):Promise<{database:Database;installation:Installation}>{
 const material=backupPreviews.get(preview);
 if(material===undefined||material.state!=="ready"||input.confirmedBusinessId!==preview.businessId)throw new TransferError("confirmation_required");
 validateLocalSecret(input.secret);
 if(input.deviceLabel.trim().length===0||input.deviceLabel.length>120||!["ANDROID","IOS","DESKTOP"].includes(input.platform))throw new TransferError("invalid_file");
 const checkTarget=():void=>{
  if(runtime(ports.database).replacing===true)throw new TransferError("pairing_pending");
  if(input.recoveryContext!==undefined){authorizedOperation(input.recoveryContext,["business.settings"],(database,tx)=>{if(database!==ports.database||input.recoveryContext!.businessId!==preview.businessId)throw new TransferError("scope_mismatch");requireOwner(tx,input.recoveryContext!);});}
  else if(currentInstallation(ports.database).state!=="empty"||ports.database.get(`SELECT id FROM workspace_enrollment WHERE id=1`)!==undefined)throw new TransferError("not_empty");
 };
 checkTarget();
 const installationId=nextId(ports),deviceId=nextId(ports),at=timestamp(ports),m=material.signed.manifest;
 material.state="restoring";
 let native;
 try { native=await ports.credentials.provision({installationId,businessId:m.business.id,userId:m.owner.id,deviceId,secret:input.secret});checkTarget(); }
 catch(error){material.state="ready";throw error;}
 try { initializeSnapshot(material.handle.database,m,{installationId,deviceId,label:input.deviceLabel,platform:input.platform,publicKey:native.publicKey,keyReference:native.keyReference,credentialReference:native.credentialReference,at,authorityAllowed:true}); }
 catch(error){material.state="ready";throw error;}
 material.state="consumed";runtime(ports.database).replacing=true;lockWorkspace(ports.database);
 let activated=false;
 try{const database=await material.handle.activate(ports.database);activated=true;return {database,installation:{installationId,businessId:m.business.id,businessName:m.business.name,ownerId:m.owner.id,deviceId,publicKey:native.publicKey,configuredAt:at}};}
 catch{await material.handle.discard();throw new TransferError("activation_failed");}
 finally{runtime(ports.database).replacing=activated;}
}

/** @internal Initializes a validated sanitized snapshot with a fresh writable installation; historical facts retain original origins. */
export function initializeSnapshot(database:Database,m:SnapshotManifest,input:{installationId:string;deviceId:string;label:string;platform:"ANDROID"|"IOS"|"DESKTOP";publicKey:string;keyReference:string;credentialReference:string;at:string;authorityAllowed:boolean}):void{
 database.transaction(tx=>{
  const old=tx.get(`SELECT business_id FROM devices WHERE id=?`,[input.deviceId]);if(old!==undefined&&old["business_id"]!==m.business.id)throw new TransferError("scope_mismatch");
  tx.run(`INSERT OR IGNORE INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES(?,?,?,?,?,?,?)`,[input.deviceId,m.business.id,input.label,input.platform,input.at,input.at,input.at]);
  tx.run(`INSERT INTO local_installation(id,installation_id,business_id,owner_id,device_id,public_key,key_reference,configured_at) VALUES(1,?,?,?,?,?,?,?)`,[input.installationId,m.business.id,m.owner.id,input.deviceId,input.publicKey,input.keyReference,input.at]);
  tx.run(`UPDATE local_memberships SET credential_reference=?,failures=0,next_attempt_at=NULL WHERE business_id=? AND user_id=?`,[input.credentialReference,m.business.id,m.owner.id]);
  const pin=tx.get(`SELECT public_key,authority_allowed FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`,[m.business.id,input.deviceId]);
  if(pin!==undefined&&(pin["public_key"]!==input.publicKey||pin["authority_allowed"]!==(input.authorityAllowed?1:0)))throw new TransferError("pairing_conflict");
  tx.run(`INSERT OR IGNORE INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES(?,?,?,?,?)`,[m.business.id,input.deviceId,input.publicKey,input.authorityAllowed?1:0,m.owner.id]);
  if(tx.get(`SELECT device_id FROM journal_origins WHERE business_id=? AND device_id=?`,[m.business.id,input.deviceId])!==undefined)throw new TransferError("pairing_conflict");
  tx.run(`INSERT INTO journal_origins(business_id,device_id,next_sequence) VALUES(?,?,1)`,[m.business.id,input.deviceId]);
  tx.run(`INSERT INTO local_audit(event_id,business_id,user_id,device_id,action,entity_id,authority_revision,occurred_at,payload) VALUES(?,?,?,?,?,?,?,?,?)`,[input.installationId,m.business.id,m.owner.id,input.deviceId,m.kind==="backup"?"WORKSPACE_RESTORED":"WORKSPACE_PAIRED",m.snapshot_id,Number(tx.get(`SELECT revision FROM local_memberships WHERE business_id=? AND user_id=?`,[m.business.id,m.owner.id])!["revision"]),input.at,JSON.stringify({sourceDeviceId:m.source_device_id,snapshotDigest:m.snapshot_digest})]);
 });
}
