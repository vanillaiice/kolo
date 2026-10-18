import { canonicalJson } from "@kolo/contracts/canonical";
import { rebuildFullText } from "../data/database/full-text-migration.ts";
/** The word-search index is derived; snapshots leave it out and the receiver rebuilds it. */
function dropFullText(db:Database):void{if(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='catalogue_search'`)!==undefined)db.run(`DELETE FROM catalogue_search`);}
import { signedSnapshotSchema, type SnapshotManifest, type SignedSnapshot } from "@kolo/contracts/transfer";
import { authorizedOperation, nextId, timestamp, runtime } from "../identity/internal-authority.ts";
import { lockWorkspace, currentInstallation } from "../identity/workspace.ts";
import { validateLocalSecret } from "../identity/credentials.ts";
import type { OperationContext, WorkspacePorts, Installation } from "../identity/types.ts";
import { eventSigningMessage, requireOwner, sealPendingEvents } from "./exchange.ts";
import { parseJournalEnvelope } from "@kolo/contracts/events";
import { MAX_SNAPSHOT_BYTES, TransferError, type ByteSink, type ImageReader, type ImageWriter, type SnapshotHandle, type SnapshotPort, type TransferCrypto, type TransferDocument } from "../backup/types.ts";
import { memoryReader, openStream, sealStream, validateTransferPassword, type ByteReader, type OpenKey } from "../backup/encryption.ts";
import { sanitizeSnapshot, snapshotBoundary, validateSnapshot } from "../backup/snapshot.ts";
import { backupPreviews } from "../backup/internal-preview.ts";
import { deriveRecoveryKey, parseRecoveryKey, type RecoveryKeyPair } from "../backup/recovery-key.ts";
import { currentBackupRecipient } from "./backup-key.ts";
import { shopKeyCoverage, sealToDevice, type SealedKey, type SealingCrypto, type ShopKey } from "./sealed-sync.ts";
import { sealedKeyAad } from "@kolo/contracts/sync";
import { captureAuthorityFact } from "../data/exchange/authority.ts";
import type { Database } from "../data/database/driver.ts";

/** Verified snapshot summary; the native candidate is held privately and consumed at most once. */
export interface BackupPreview {
 readonly businessId:string;readonly businessName:string;readonly ownerName:string;readonly createdAt:string;
 readonly sourceDeviceId:string;readonly snapshotId:string;readonly schemaVersion:number;readonly appliedEvents:number;
}

const READ_CHUNK=1024*1024;
/** Hashes a compacted image chunk by chunk with the native incremental SHA-256. */
async function digestOf(image:ImageReader,crypto:TransferCrypto):Promise<string>{
 const hash=crypto.createSha256();
 for(let at=0;at<image.size;at+=READ_CHUNK){const chunk=await image.read(at,Math.min(READ_CHUNK,image.size-at));if(chunk.byteLength===0)throw new TransferError("invalid_snapshot");hash.update(chunk);}
 return hash.digest();
}

/**
 * @internal Captures, strips credentials (and product photos when asked), compacts and signs one coherent snapshot, and
 * returns the signed manifest with a reader over the compacted image on private storage (closing it deletes the image).
 */
export async function signedImage(context:OperationContext,kind:SnapshotManifest["kind"],target:SnapshotManifest["target"],files:SnapshotPort,crypto:TransferCrypto,options:BackupOptions&{readonly shopKeys?:readonly ShopKey[]}={}):Promise<{signed:SignedSnapshot;image:ImageReader}>{
 const {ports,database}=authorizedOperation(context,["business.settings"],(database,tx,ports)=>{requireOwner(tx,context);return {ports,database};});
 for(let pass=0;pass<32;pass++){if(await sealPendingEvents(context,crypto,1000)<1000)break;if(pass===31)throw new TransferError("too_large");}
 const handle=await files.capture(database);
 let image:ImageReader|undefined;
 try{
  const db=handle.database,install=db.get(`SELECT * FROM local_installation WHERE id=1`);
  if(install?.["business_id"]!==context.businessId||install["device_id"]!==context.deviceId||install["owner_id"]!==context.userId)throw new TransferError("scope_mismatch");
  const shop=db.get(`SELECT name,currency FROM businesses WHERE id=?`,[context.businessId])!,owner=db.get(`SELECT name FROM users WHERE id=? AND business_id=?`,[context.userId,context.businessId])!;
  const publicKey=String(install["public_key"]),keyReference=String(install["key_reference"]);
  // The till keeps selling while the copy is made, so facts written after the signing pass above can be in it unsigned.
  // Ed25519 is deterministic: signing them in the copy writes exactly the rows the till itself writes moments later.
  await signLateFacts(db,context,keyReference,publicKey,ports,crypto);
  const boundary=snapshotBoundary(db,context.businessId);
  const schema=Number(db.get(`SELECT max(version) AS n FROM schema_migrations`)!["n"]);
  sanitizeSnapshot(db,context.deviceId);dropFullText(db);if(options.includePhotos===false)db.run(`DELETE FROM product_photos`);
  image=await handle.image();
  const manifest:SnapshotManifest={format:"kolo.snapshot",format_version:1,snapshot_id:nextId(ports),kind,schema_version:schema,created_at:timestamp(ports),business:{id:context.businessId,name:String(shop["name"]),currency:"XAF"},owner:{id:context.userId,name:String(owner["name"])},source_device_id:context.deviceId,source_public_key:publicKey,snapshot_digest:await digestOf(image,crypto),snapshot_bytes:image.size,boundary,credential_policy:"device_local_credentials_excluded",target,
   ...(kind==="backup"&&options.shopKeys!==undefined&&options.shopKeys.length>0?{shop_keys:options.shopKeys.map(key=>({key_id:key.keyId,epoch:key.epoch,key:key.key}))}:{})};
  const message=`kolo.snapshot.v1\u0000${canonicalJson(manifest)}`;
  if(ports.credentials.sign===undefined)throw new TransferError("authentication_failed");
  const digest=await crypto.sha256(message),signature=await ports.credentials.sign(keyReference,message);
  if(!await crypto.verify(publicKey,message,signature))throw new TransferError("authentication_failed");
  authorizedOperation(context,["business.settings"],(_database,tx)=>requireOwner(tx,context));
  return {signed:{manifest,digest,signature},image};
 }catch(error){await image?.close();throw error;}
 finally{await handle.discard();}
}

/** Signs this device's own unsigned facts inside a snapshot copy, bounded so a corrupted journal cannot run away. */
async function signLateFacts(db:Database,context:OperationContext,reference:string,key:string,ports:WorkspacePorts,crypto:TransferCrypto):Promise<void>{
 const rows=db.all(`SELECT e.canonical FROM event_journal e LEFT JOIN event_signatures s ON s.event_id=e.event_id
  WHERE e.business_id=? AND e.origin_device_id=? AND e.provenance='local' AND s.event_id IS NULL ORDER BY e.origin_sequence LIMIT 10001`,[context.businessId,context.deviceId]);
 if(rows.length>10_000)throw new TransferError("pairing_pending");
 if(rows.length===0)return;
 if(ports.credentials.sign===undefined)throw new TransferError("authentication_failed");
 for(const row of rows){
  const envelope=parseJournalEnvelope(JSON.parse(String(row["canonical"]))),message=eventSigningMessage(envelope);
  const digest=await crypto.sha256(message),signature=await ports.credentials.sign(reference,message);
  if(!/^[a-f0-9]{64}$/.test(digest)||!/^[a-f0-9]{128}$/.test(signature)||!await crypto.verify(key,message,signature))throw new TransferError("authentication_failed");
  db.run(`INSERT OR IGNORE INTO event_signatures(event_id,digest,signature,public_key) VALUES (?,?,?,?)`,[envelope.event_id,digest,signature,key]);
 }
}

/** @internal {@link signedImage} with the image read into memory: for enrollment snapshots, which travel whole. */
export async function createSignedSnapshot(context:OperationContext,kind:SnapshotManifest["kind"],target:SnapshotManifest["target"],files:SnapshotPort,crypto:TransferCrypto,options:BackupOptions&{readonly shopKeys?:readonly ShopKey[]}={}):Promise<{signed:SignedSnapshot;image:Uint8Array}>{
 const {signed,image}=await signedImage(context,kind,target,files,crypto,options);
 try{const bytes=await image.read(0,image.size);if(bytes.byteLength!==image.size)throw new TransferError("invalid_snapshot");return {signed,image:bytes};}finally{await image.close();}
}

/** Backup choices. Photos are included unless `includePhotos` is false; a backup without them restores products with no photo. */
export interface BackupOptions { readonly includePhotos?: boolean }

/** True for the platform crypto that can open this till's shop-key grants (ADR-030). */
function isSealing(crypto:TransferCrypto):crypto is SealingCrypto{return typeof (crypto as Partial<SealingCrypto>).hkdf==="function"&&typeof (crypto as Partial<SealingCrypto>).ephemeralAgreement==="function";}

/**
 * Streams a consistent encrypted backup into `sink` (a private temporary file on a till), chunk by chunk, so memory stays a
 * few MiB whatever the shop size (ADR-035). It excludes credentials, cloud sessions and installation private keys, and
 * optionally product photos. It opens with `password` and, once the owner pinned one, with the shop's backup recovery key;
 * `password` null makes a recovery-key-only backup (automatic backups), which needs a pinned key. It carries the shop data
 * keys this till holds, so a restore can resume sync with no other till (ADR-036); when a granted key cannot be opened
 * (a vault failure) it writes nothing and fails with `sync_keys_unavailable`. Returns the file name to offer.
 */
export async function writeBackup(context:OperationContext,password:string|null,files:SnapshotPort,crypto:TransferCrypto,sink:ByteSink,options:BackupOptions={}):Promise<{readonly filename:string}>{
 if(password!==null)validateTransferPassword(password);
 const recipient=await currentBackupRecipient(context,crypto);
 if(password===null&&recipient===undefined)throw new TransferError("recovery_key_required");
 // Every key granted to this till, or no backup: one that silently lacked them could not reopen later sync history (ADR-036).
 const {keys,missing}=await shopKeyCoverage(context,isSealing(crypto)?crypto:undefined);
 if(missing>0)throw new TransferError("sync_keys_unavailable");
 const {signed,image}=await signedImage(context,"backup",null,files,crypto,{...options,shopKeys:keys});
 try{
  const metadata=crypto.encodeText(canonicalJson(signed));
  if(metadata.length>1024*1024)throw new TransferError("too_large");
  async function* content():AsyncGenerator<Uint8Array>{
   const head=new Uint8Array(4+metadata.length);new DataView(head.buffer).setUint32(0,metadata.length,false);head.set(metadata,4);yield head;
   for(let at=0;at<image!.size;at+=READ_CHUNK){const chunk=await image!.read(at,Math.min(READ_CHUNK,image!.size-at));if(chunk.byteLength===0)throw new TransferError("invalid_snapshot");try{yield chunk;}finally{chunk.fill(0);}}
  }
  const keysFor={...(password===null?{}:{password}),recipients:recipient===undefined?[]:[recipient]};
  for await (const part of sealStream(content(),4+metadata.length+image.size,"backup",signed.manifest.snapshot_id,keysFor,crypto))await sink.write(part);
  authorizedOperation(context,["business.settings"],(_db,tx)=>requireOwner(tx,context));
  return {filename:`${signed.manifest.snapshot_id}.kolo-backup`};
 }finally{await image.close();}
}

/** {@link writeBackup} into memory, for callers that hand the whole file to a dialog or a test. */
export async function createBackup(context:OperationContext,password:string|null,files:SnapshotPort,crypto:TransferCrypto,options:BackupOptions={}):Promise<TransferDocument>{
 const parts:Uint8Array[]=[];let total=0;
 const {filename}=await writeBackup(context,password,files,crypto,{write:async bytes=>{parts.push(bytes);total+=bytes.byteLength;}},options);
 const bytes=new Uint8Array(total);let at=0;for(const part of parts){bytes.set(part,at);at+=part.byteLength;}
 return {filename,bytes};
}

/** How a backup is opened: its password, or the shop's backup recovery key as the owner typed it (ADR-036). */
export type BackupSecret = string | { readonly recoveryKey: string };

/**
 * Opens a backup from a reader (a selected file read in chunks), with its password or typed recovery key. The image is
 * decrypted and decompressed straight into a private staging file, never whole in memory, then the slot, image digest
 * and signed manifest are authenticated and the database is validated (schema, integrity, scope, foreign keys, replay
 * boundary) in isolation. Anything that fails discards the staging file.
 */
export async function previewBackupFile(reader:ByteReader,secret:BackupSecret,files:SnapshotPort,crypto:TransferCrypto):Promise<BackupPreview>{
 let key:OpenKey,pair:RecoveryKeyPair|undefined;
 if(typeof secret==="string")key={password:secret};
 else{const raw=await parseRecoveryKey(secret.recoveryKey,crypto);try{pair=await deriveRecoveryKey(raw,crypto);}finally{raw.fill(0);}key={recoveryKey:pair};}
 let writer:ImageWriter|undefined,handle:SnapshotHandle|undefined;
 try{
  // The content is a 4-byte manifest length, the signed manifest, then the raw image (ADR-022).
  const head:Uint8Array[]=[];let headBytes=0,metadataLength=-1,signed:SignedSnapshot|undefined,imageBytes=0;
  const hash=crypto.createSha256();
  const image=async(bytes:Uint8Array):Promise<void>=>{if(bytes.byteLength===0)return;imageBytes+=bytes.byteLength;if(imageBytes>MAX_SNAPSHOT_BYTES)throw new TransferError("too_large");hash.update(bytes);await writer!.write(bytes);};
  for await (const chunk of openStream(reader,"backup",key,crypto)){
   let rest=chunk;
   if(signed===undefined){
    head.push(rest);headBytes+=rest.byteLength;
    if(metadataLength<0&&headBytes>=4){const first=concatAll(head);metadataLength=new DataView(first.buffer,first.byteOffset,4).getUint32(0,false);if(metadataLength<1||metadataLength>1024*1024)throw new TransferError("invalid_snapshot");head.length=0;head.push(first);}
    if(metadataLength<0||headBytes<4+metadataLength)continue;
    const all=concatAll(head);head.length=0;
    let value:unknown;try{value=JSON.parse(crypto.decodeText(all.subarray(4,4+metadataLength)));canonicalJson(value);}catch{throw new TransferError("invalid_snapshot");}
    const parsed=signedSnapshotSchema.safeParse(value);if(!parsed.success)throw new TransferError("invalid_snapshot");
    signed=parsed.data;writer=await files.receive();rest=all.subarray(4+metadataLength);
   }
   await image(rest);
  }
  if(signed===undefined)throw new TransferError("invalid_snapshot");
  const m=signed.manifest;
  if(m.kind!=="backup"||m.target!==null||imageBytes!==m.snapshot_bytes||hash.digest()!==m.snapshot_digest)throw new TransferError("invalid_snapshot");
  const message=`kolo.snapshot.v1\u0000${canonicalJson(m)}`;
  if(await crypto.sha256(message)!==signed.digest||!await crypto.verify(m.source_public_key,message,signed.signature))throw new TransferError("authentication_failed");
  handle=await writer!.open();writer=undefined;
  await validateSnapshot(handle.database,m,files);
  const preview:BackupPreview=Object.freeze({businessId:m.business.id,businessName:m.business.name,ownerName:m.owner.name,createdAt:m.created_at,sourceDeviceId:m.source_device_id,snapshotId:m.snapshot_id,schemaVersion:m.schema_version,appliedEvents:m.boundary.applied_count});
  backupPreviews.set(preview,{signed,handle,files,crypto,state:"ready"});handle=undefined;return preview;
 }finally{
  pair?.privateKey.fill(0);
  await writer?.discard();await handle?.discard();
 }
}

/** {@link previewBackupFile} for a backup already in memory. */
export async function previewBackup(file:Uint8Array,secret:BackupSecret,files:SnapshotPort,crypto:TransferCrypto):Promise<BackupPreview>{
 if(!(file instanceof Uint8Array))throw new TransferError("invalid_file");
 return previewBackupFile(memoryReader(file),secret,files,crypto);
}

function concatAll(parts:readonly Uint8Array[]):Uint8Array{let total=0;for(const part of parts)total+=part.byteLength;const out=new Uint8Array(total);let at=0;for(const part of parts){out.set(part,at);at+=part.byteLength;}return out;}

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
  if(input.recoveryContext!==undefined){authorizedOperation(input.recoveryContext,["business.settings"],(database,tx)=>{if(database!==ports.database||input.recoveryContext!.businessId!==preview.businessId)throw new TransferError("scope_mismatch");requireOwner(tx,input.recoveryContext!);
   // A recipient slot proves nothing about who made the file (ADR-035): on a till that knows the shop, its signer must be one this till trusts.
   const manifest=material.signed.manifest;if(tx.get(`SELECT public_key FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`,[manifest.business.id,manifest.source_device_id])?.["public_key"]!==manifest.source_public_key)throw new TransferError("untrusted_backup");});}
  else if(currentInstallation(ports.database).state!=="empty"||ports.database.get(`SELECT id FROM workspace_enrollment WHERE id=1`)!==undefined)throw new TransferError("not_empty");
 };
 checkTarget();
 const installationId=nextId(ports),deviceId=nextId(ports),at=timestamp(ports),m=material.signed.manifest;
 material.state="restoring";
 let native;
 try { native=await ports.credentials.provision({installationId,businessId:m.business.id,userId:m.owner.id,deviceId,secret:input.secret});checkTarget(); }
 catch(error){material.state="ready";throw error;}
 let continuity:SyncContinuity|undefined;
 try { continuity=await resumeShopKeys(material.handle.database,m,deviceId,native.keyReference,material.crypto,ports); }
 catch(error){material.state="ready";throw error;}
 try { initializeSnapshot(material.handle.database,m,{installationId,deviceId,label:input.deviceLabel,platform:input.platform,publicKey:native.publicKey,keyReference:native.keyReference,credentialReference:native.credentialReference,at,authorityAllowed:true,...(continuity===undefined?{}:{continuity})}); }
 catch(error){material.state="ready";throw error;}
 material.state="consumed";runtime(ports.database).replacing=true;lockWorkspace(ports.database);
 let activated=false;
 try{const database=await material.handle.activate(ports.database);activated=true;return {database,installation:{installationId,businessId:m.business.id,businessName:m.business.name,ownerId:m.owner.id,deviceId,publicKey:native.publicKey,configuredAt:at}};}
 catch{await material.handle.discard();throw new TransferError("activation_failed");}
 finally{runtime(ports.database).replacing=activated;}
}

/** Owner facts a restore records so the new device can resume sync: its own encryption key and grants of every carried key plus a new epoch. */
interface SyncContinuity { readonly encryption:{readonly eventId:string;readonly publicKey:string}; readonly grants:readonly {readonly eventId:string;readonly keyId:string;readonly epoch:number;readonly sealed:SealedKey}[] }

/**
 * ADR-036: a backup carries the shop data keys its till held. The restored device re-grants them to its own new encryption
 * key and opens a new epoch for future traffic, so it can read facts other tills synced after the backup and seal new ones,
 * with no original till. The plain keys never enter the database. Nothing happens on a platform without an encryption key.
 */
async function resumeShopKeys(candidate:Database,m:SnapshotManifest,deviceId:string,keyReference:string,crypto:TransferCrypto,ports:WorkspacePorts):Promise<SyncContinuity|undefined>{
 if(m.kind!=="backup"||m.shop_keys===undefined||m.shop_keys.length===0||!isSealing(crypto)||ports.credentials.encryptionKey===undefined)return undefined;
 const own=await ports.credentials.encryptionKey(keyReference);
 const highest=Number(candidate.get(`SELECT coalesce(max(epoch),0) AS n FROM shop_key_grants WHERE business_id=?`,[m.business.id])!["n"]);
 const fresh={key_id:nextId(ports),epoch:Math.max(highest,...m.shop_keys.map(key=>key.epoch))+1,key:crypto.randomHex(32)},grants=[];
 for(const key of [...m.shop_keys,fresh])grants.push({eventId:nextId(ports),keyId:key.key_id,epoch:key.epoch,sealed:await sealToDevice(crypto,own,key.key,sealedKeyAad(m.business.id,key.key_id,key.epoch,deviceId))});
 return {encryption:{eventId:nextId(ports),publicKey:own},grants};
}

/** @internal Initializes a validated sanitized snapshot with a fresh writable installation; historical facts retain original origins. */
export function initializeSnapshot(database:Database,m:SnapshotManifest,input:{installationId:string;deviceId:string;label:string;platform:"ANDROID"|"IOS"|"DESKTOP";publicKey:string;keyReference:string;credentialReference:string;at:string;authorityAllowed:boolean;continuity?:SyncContinuity}):void{
 database.transaction(tx=>{
  rebuildFullText(tx);
  const old=tx.get(`SELECT business_id FROM devices WHERE id=?`,[input.deviceId]);if(old!==undefined&&old["business_id"]!==m.business.id)throw new TransferError("scope_mismatch");
  tx.run(`INSERT OR IGNORE INTO devices(id,business_id,label,platform,created_at,updated_at,last_seen_at) VALUES(?,?,?,?,?,?,?)`,[input.deviceId,m.business.id,input.label,input.platform,input.at,input.at,input.at]);
  tx.run(`INSERT INTO local_installation(id,installation_id,business_id,owner_id,device_id,public_key,key_reference,configured_at) VALUES(1,?,?,?,?,?,?,?)`,[input.installationId,m.business.id,m.owner.id,input.deviceId,input.publicKey,input.keyReference,input.at]);
  tx.run(`UPDATE local_memberships SET credential_reference=?,failures=0,next_attempt_at=NULL WHERE business_id=? AND user_id=?`,[input.credentialReference,m.business.id,m.owner.id]);
  const pin=tx.get(`SELECT public_key,authority_allowed FROM trusted_exchange_devices WHERE business_id=? AND device_id=?`,[m.business.id,input.deviceId]);
  if(pin!==undefined&&(pin["public_key"]!==input.publicKey||pin["authority_allowed"]!==(input.authorityAllowed?1:0)))throw new TransferError("pairing_conflict");
  tx.run(`INSERT OR IGNORE INTO trusted_exchange_devices(business_id,device_id,public_key,authority_allowed,approved_by) VALUES(?,?,?,?,?)`,[m.business.id,input.deviceId,input.publicKey,input.authorityAllowed?1:0,m.owner.id]);
  if(tx.get(`SELECT device_id FROM journal_origins WHERE business_id=? AND device_id=?`,[m.business.id,input.deviceId])!==undefined)throw new TransferError("pairing_conflict");
  tx.run(`INSERT INTO journal_origins(business_id,device_id,next_sequence) VALUES(?,?,1)`,[m.business.id,input.deviceId]);
  const revision=Number(tx.get(`SELECT revision FROM local_memberships WHERE business_id=? AND user_id=?`,[m.business.id,m.owner.id])!["revision"]);
  tx.run(`INSERT INTO local_audit(event_id,business_id,user_id,device_id,action,entity_id,authority_revision,occurred_at,payload) VALUES(?,?,?,?,?,?,?,?,?)`,[input.installationId,m.business.id,m.owner.id,input.deviceId,m.kind==="backup"?"WORKSPACE_RESTORED":"WORKSPACE_PAIRED",m.snapshot_id,revision,input.at,JSON.stringify({sourceDeviceId:m.source_device_id,snapshotDigest:m.snapshot_digest})]);
  if(input.continuity!==undefined){
   const fact=(eventId:string,action:string,entityId:string,payload:Record<string,unknown>):void=>{
    tx.run(`INSERT INTO local_audit(event_id,business_id,user_id,device_id,action,entity_id,authority_revision,occurred_at,payload) VALUES(?,?,?,?,?,?,?,?,?)`,[eventId,m.business.id,m.owner.id,input.deviceId,action,entityId,revision,input.at,JSON.stringify(payload)]);
    captureAuthorityFact(tx,{eventId,businessId:m.business.id,userId:m.owner.id,deviceId:input.deviceId,action,entityId,at:input.at,payload,actorRevision:revision});
   };
   const {encryption,grants}=input.continuity;
   fact(encryption.eventId,"DEVICE_ENCRYPTION_KEY",input.deviceId,{device_id:input.deviceId,public_key:encryption.publicKey});
   tx.run(`INSERT INTO device_encryption_keys(business_id,device_id,public_key,event_id) VALUES (?,?,?,?)`,[m.business.id,input.deviceId,encryption.publicKey,encryption.eventId]);
   for(const grant of grants){
    fact(grant.eventId,"SHOP_KEY_GRANTED",input.deviceId,{key_id:grant.keyId,epoch:grant.epoch,device_id:input.deviceId,sealed:grant.sealed});
    tx.run(`INSERT INTO shop_key_grants(business_id,key_id,epoch,device_id,sealed,event_id) VALUES (?,?,?,?,?,?)`,[m.business.id,grant.keyId,grant.epoch,input.deviceId,JSON.stringify(grant.sealed),grant.eventId]);
   }
  }
 });
}
