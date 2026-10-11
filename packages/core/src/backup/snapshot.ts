import { canonicalJson } from "@kolo/contracts/canonical";
import { signedSnapshotSchema, type SnapshotManifest, type SignedSnapshot } from "@kolo/contracts/transfer";
import type { Database, Queryable } from "../data/database/driver.ts";
import { MIGRATIONS, LATEST_VERSION, migrate, schemaVersion } from "../data/database/migrations.ts";
import { memberPermissions } from "../identity/internal-authority.ts";
import { STANDARD_TRANSFER_LIMITS, TransferError, type SnapshotPort, type TransferCrypto, type TransferLimits } from "./types.ts";

/** Current journal/legacy coverage derived from this exact snapshot, not a live database's later cursor. */
export function snapshotBoundary(tx:Queryable,businessId:string):SnapshotManifest["boundary"]{
 const origins=tx.all(`SELECT origin_device_id,max(origin_sequence) AS maximum FROM event_journal WHERE business_id=? GROUP BY origin_device_id ORDER BY origin_device_id`,[businessId]);
 return {audit_watermark:Number(tx.get(`SELECT coalesce(max(sequence),0) AS n FROM local_audit WHERE business_id=?`,[businessId])!["n"]),
 applied_count:Number(tx.get(`SELECT count(*) AS n FROM applied_events WHERE business_id=? AND status='applied'`,[businessId])!["n"]),
 origins:origins.map(row=>({device_id:String(row["origin_device_id"]),maximum_sequence:Number(row["maximum"]),next_local_sequence:(()=>{const local=tx.get(`SELECT next_sequence FROM journal_origins WHERE business_id=? AND device_id=?`,[businessId,row["origin_device_id"]!]);return local===undefined?null:Number(local["next_sequence"]);})()})),
 legacy:tx.all(`SELECT business_id,provenance,outbox_next,audit_watermark FROM legacy_baselines WHERE business_id=?`,[businessId]).map(row=>({business_id:String(row["business_id"]),provenance:"unsigned_v1_snapshot",outbox_next:Number(row["outbox_next"]),audit_watermark:Number(row["audit_watermark"])}))};
}

/** @internal Removes installation/cloud/provisioning references before native VACUUM physically purges deleted data. */
export function sanitizeSnapshot(database:Database,sourceDeviceId:string):void{
 database.run("PRAGMA secure_delete=ON");
 database.transaction(tx=>{
  // Server connections and opt-outs belong to the source till; a receiving till connects on its own (ADR-030).
  for(const table of ["device_session","local_credential_recovery","local_member_setup","workspace_setup","workspace_enrollment","pairing_invites","server_endpoints","server_endpoint_declined"])if(tx.get(`SELECT name FROM sqlite_schema WHERE type='table' AND name=?`,[table])!==undefined)tx.run(`DELETE FROM ${table}`);
  tx.run(`DELETE FROM local_installation`);
  tx.run(`UPDATE local_memberships SET credential_reference='remote.'||?||'.'||user_id,failures=0,next_attempt_at=NULL`,[sourceDeviceId]);
 });
}

/** Checks the exact shipped SQLite schema before executing any imported schema-triggered mutation. */
export async function validateSnapshot(database:Database,manifest:SnapshotManifest,files:SnapshotPort):Promise<void>{
 if(manifest.schema_version>LATEST_VERSION||manifest.schema_version<17)throw new TransferError("unsupported_version");
 const reference=await files.empty();
 try{
  const expected=reference.database;
  expected.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT    NOT NULL,
       applied_at TEXT    NOT NULL
     ) STRICT`);
  for(const migration of MIGRATIONS.filter(m=>m.version<=manifest.schema_version))expected.transaction(tx=>{for(const statement of migration.statements)tx.run(statement);tx.run(`INSERT INTO schema_migrations VALUES(?,?,?)`,[migration.version,migration.name,manifest.created_at]);});
  const catalog=(db:Database)=>db.all(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name`);
  if(canonicalJson(catalog(database))!==canonicalJson(catalog(expected))||schemaVersion(database)!==manifest.schema_version)throw new TransferError("invalid_snapshot");
 }finally{await reference.discard();}
 if(database.all("PRAGMA integrity_check").some(row=>Object.values(row)[0]!=="ok")||database.all("PRAGMA foreign_key_check").length!==0)throw new TransferError("invalid_snapshot");
 const shop=database.get(`SELECT * FROM businesses WHERE id=?`,[manifest.business.id]),owner=database.get(`SELECT * FROM users WHERE id=? AND business_id=?`,[manifest.owner.id,manifest.business.id]);
 if(database.get(`SELECT count(*) AS n FROM businesses`)?.["n"]!==1||shop?.["name"]!==manifest.business.name||shop["currency"]!=="XAF"||shop["active"]!==1||owner?.["name"]!==manifest.owner.name||owner["role"]!=="OWNER"||owner["active"]!==1)throw new TransferError("scope_mismatch");
 const member=database.get(`SELECT * FROM local_memberships WHERE business_id=? AND user_id=?`,[manifest.business.id,manifest.owner.id]);
 if(member===undefined||member["role"]!=="OWNER"||member["active"]!==1||!memberPermissions(member).includes("users.manage"))throw new TransferError("invalid_snapshot");
 for(const {name} of database.all(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`)){
  const table=String(name);if(!/^[a-z_]+$/.test(table))throw new TransferError("invalid_snapshot");
  if(database.all(`PRAGMA table_info(${table})`).some(row=>row["name"]==="business_id")&&database.get(`SELECT 1 AS mismatch FROM ${table} WHERE business_id<>? OR business_id IS NULL LIMIT 1`,[manifest.business.id])!==undefined)throw new TransferError("scope_mismatch");
 }
 for(const table of ["local_installation","device_session","workspace_setup","local_credential_recovery","local_member_setup",...(manifest.schema_version>=18?["workspace_enrollment","pairing_invites"]:[])])if(database.get(`SELECT count(*) AS n FROM ${table}`)?.["n"]!==0)throw new TransferError("invalid_snapshot");
 if(database.get(`SELECT user_id FROM local_memberships WHERE credential_reference NOT LIKE 'remote.%' LIMIT 1`)!==undefined)throw new TransferError("invalid_snapshot");
 if(canonicalJson(snapshotBoundary(database,manifest.business.id))!==canonicalJson(manifest.boundary))throw new TransferError("invalid_snapshot");
 const origin=database.get(`SELECT t.public_key,d.active FROM trusted_exchange_devices t JOIN devices d ON d.id=t.device_id AND d.business_id=t.business_id WHERE t.business_id=? AND t.device_id=?`,[manifest.business.id,manifest.source_device_id]);
 if(origin?.["public_key"]!==manifest.source_public_key)throw new TransferError("invalid_snapshot");
 migrate(database);
}

/** Packs a small signed manifest plus raw SQLite bytes, avoiding double-base64 expansion. */
export function encodeSnapshot(signed:SignedSnapshot,bytes:Uint8Array,crypto:TransferCrypto,limits:TransferLimits=STANDARD_TRANSFER_LIMITS):Uint8Array{
 const metadata=crypto.encodeText(canonicalJson(signed)),result=new Uint8Array(4+metadata.length+bytes.length);
 if(metadata.length>1024*1024||bytes.length>limits.snapshotBytes)throw new TransferError("too_large");
 new DataView(result.buffer).setUint32(0,metadata.length,false);result.set(metadata,4);result.set(bytes,4+metadata.length);return result;
}
/** Bounds metadata/image independently before schema parsing or opening SQLite. */
export function decodeSnapshot(bytes:Uint8Array,crypto:TransferCrypto,limits:TransferLimits=STANDARD_TRANSFER_LIMITS):{signed:SignedSnapshot;image:Uint8Array}{
 if(bytes.byteLength<104)throw new TransferError("invalid_snapshot");
 const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,false);
 if(length<1||length>1024*1024||length+104>bytes.byteLength||bytes.byteLength-4-length>limits.snapshotBytes)throw new TransferError("invalid_snapshot");
 let input:unknown;try{input=JSON.parse(crypto.decodeText(bytes.subarray(4,4+length)));canonicalJson(input);}catch{throw new TransferError("invalid_snapshot");}
 const parsed=signedSnapshotSchema.safeParse(input);if(!parsed.success)throw new TransferError("invalid_snapshot");
 return {signed:parsed.data,image:bytes.slice(4+length)};
}
