import { defaultDatabaseDirectory, openDatabaseSync } from "expo-sqlite";
import { Directory, File } from "expo-file-system";
import type { Database } from "@kolo/core/data/database/driver";
import { openNativeDatabase } from "@kolo/core/data/database/expo-sqlite";
import { migrate, type MigrationResult } from "@kolo/core/data/database/migrations";
import { MAX_SNAPSHOT_BYTES, TransferError, type SnapshotHandle, type SnapshotPort } from "@kolo/core/backup/types";
import { newIdOnDevice } from "../auth/local-credentials-on-device.ts";
import { sqlitePreferences, type PreferenceStorage } from "./preferences.ts";
import { localSecretKeys } from "@kolo/core/identity/device-reset";

/**
 * Every connection opens through here. expo-sqlite's close finalizes every statement still linked to
 * the connection by default, including the FTS5 search index's own internal statements, which FTS5
 * frees again when it disconnects: a double free that aborts the app (Scudo) on any close after a
 * search or migration 24's index rebuild. The adapter finalizes its statements itself (the
 * `getAllSync`/`runSync` helpers do), so the blanket finalize is turned off.
 */
function openConnection(name:string):Database{return openNativeDatabase(openDatabaseSync(name,{useNewConnection:true,finalizeUnusedStatementsBeforeClosing:false}));}

/** Opens only device preferences; business activation and restore cannot replace them. */
export const preferenceStorageOnDevice: PreferenceStorage = {
 read(key) {
  const database = openConnection("device-preferences.db");
  try { return sqlitePreferences(database).read(key); } finally { database.close(); }
 },
 write(key, value) {
  const database = openConnection("device-preferences.db");
  try { sqlitePreferences(database).write(key, value); } finally { database.close(); }
 },
};

/** Original business filename; a durable SQLite pointer selects replacements without overwriting it. */
export const DATABASE_NAME="kolo.db";
/** This is the sole Expo SQLite import boundary. Private staged images never enter a public export directory. */
/** Lets a staged empty database stand in for the active shop as a restore target. */
export interface SlotControl {
 /**
  * Binds `stage` to `current`'s active slot, so restoring into the empty stage swaps the durable
  * pointer straight from the current shop to the restored one. A failed restore never moved the
  * pointer, and the previous shop's file and credentials stay on disk.
  */
 alias(stage:Database,current:Database):void;
}
export function openOnDevice():{readonly database:Database;readonly migration:MigrationResult;readonly files:SnapshotPort;readonly slots:SlotControl;readonly close:()=>void}{
 const open=(name:string):Database=>openConnection(name);
 const path=(name:string):string=>`${defaultDatabaseDirectory.replace(/^file:\/\//,"").replace(/\/$/,"")}/${name}`;
 const file=(name:string):File=>new File(`file://${path(name)}`);
 const control=open("workspace-slots.db");control.run("PRAGMA synchronous=FULL");
 control.run(`CREATE TABLE IF NOT EXISTS active_slot(id INTEGER PRIMARY KEY CHECK(id=1),filename TEXT NOT NULL,generation INTEGER NOT NULL) STRICT`);control.run(`INSERT OR IGNORE INTO active_slot VALUES(1,'kolo.db',1)`);
 const bindings=new WeakMap<Database,{filename:string;generation:number}>();
 const row=control.get(`SELECT * FROM active_slot WHERE id=1`)!,filename=String(row["filename"]);
 if(!/^(kolo\.db|workspace-[0-9a-f-]+\.db)$/.test(filename)||filename!==DATABASE_NAME&&!file(filename).exists){control.close();throw new TransferError("activation_failed");}
 // Only application-owned staging files can be removed after a process crash.
 const privateDirectory=new Directory(`file://${defaultDatabaseDirectory.replace(/^file:\/\//,"")}`);
 for(const entry of privateDirectory.list())if(entry instanceof File&&/^stage-[0-9a-f-]+\.db(?:-wal|-shm)?$/.test(entry.name))entry.delete();
 const database=open(filename);bindings.set(database,{filename,generation:Number(row["generation"])});
 const migration=migrate(database);
 const allocate=():string=>`stage-${newIdOnDevice()}.db`;
 const remove=(name:string):void=>{for(const suffix of ["","-wal","-shm"]){const owned=file(name+suffix);if(owned.exists)owned.delete();}};
 function handle(name:string,db:Database):SnapshotHandle{
  let closed=false,activated=false;
  return {database:db,
   async bytes(){if(closed)throw new TransferError("invalid_snapshot");const copy=allocate();try{db.run("VACUUM INTO ?",[path(copy)]);const owned=file(copy);if(owned.size>MAX_SNAPSHOT_BYTES)throw new TransferError("too_large");return owned.bytesSync();}finally{remove(copy);}},
   async discard(){if(activated)return;if(!closed){db.close();closed=true;}remove(name);},
   async activate(target){
    const binding=bindings.get(target);if(binding===undefined||closed)throw new TransferError("activation_failed");
    // SQLite syncs the finalized copy; only the FULL-synchronous pointer transaction activates it.
    const finalName=`workspace-${newIdOnDevice()}.db`;db.run("PRAGMA synchronous=FULL");db.run("VACUUM INTO ?",[path(finalName)]);db.close();closed=true;
    const next=open(finalName);next.run("PRAGMA synchronous=FULL");next.all("PRAGMA wal_checkpoint(TRUNCATE)");
    try{control.transaction(tx=>{const active=tx.get(`SELECT * FROM active_slot WHERE id=1`)!;if(active["filename"]!==binding.filename||active["generation"]!==binding.generation)throw new TransferError("activation_failed");tx.run(`UPDATE active_slot SET filename=?,generation=generation+1 WHERE id=1`,[finalName]);});}
    catch(error){next.close();remove(finalName);throw error;}
    activated=true;bindings.set(next,{filename:finalName,generation:binding.generation+1});try{remove(name);}catch{/* An owned orphan may remain; the committed active slot must still be returned. */}return next;
   },
  };
 }
 const files:SnapshotPort={
  async capture(source){const name=allocate();try{source.run("VACUUM INTO ?",[path(name)]);if(file(name).size>MAX_SNAPSHOT_BYTES)throw new TransferError("too_large");return handle(name,open(name));}catch(error){remove(name);throw error;}},
  async open(bytes){if(bytes.length<100||bytes.length>MAX_SNAPSHOT_BYTES)throw new TransferError("invalid_snapshot");const name=allocate(),owned=file(name);owned.create();owned.write(bytes);try{return handle(name,open(name));}catch{remove(name);throw new TransferError("invalid_snapshot");}},
  async empty(){const name=allocate();return handle(name,open(name));},
 };
 const slots:SlotControl={alias(stage,current){const binding=bindings.get(current);if(binding===undefined)throw new TransferError("activation_failed");bindings.set(stage,binding);}};
 return {database,migration,files,slots,close:()=>control.close()};
}

/**
 * Device reset: deletes every shop database on this phone (the active one, safety copies, staged
 * files and the slot pointer) and returns the protected-store keys they referred to, for the caller to
 * forget. Device preferences (language, appearance) are kept. Every handle must already be closed.
 */
export function eraseShopsOnDevice():string[]{
 const root=defaultDatabaseDirectory.replace(/^file:\/\//,"").replace(/\/$/,"");
 const directory=new Directory(`file://${root}`),keys=new Set<string>();
 const names=directory.list().filter((entry):entry is File=>entry instanceof File).map(entry=>entry.name);
 for(const name of names.filter(item=>/^(kolo\.db|workspace-[0-9a-f-]+\.db)$/.test(item))){
  try{const database=openConnection(name);try{for(const key of localSecretKeys(database))keys.add(key);}finally{database.close();}}
  catch{/* An unreadable file still gets deleted; its keys cannot be named. */}
 }
 // List again: closing a database above removes its -wal/-shm files, and deleting a vanished file throws, which used
 // to fail the boot right after "Reset this phone" (a restart then worked).
 for(const entry of directory.list()){
  if(!(entry instanceof File)||!/^(kolo\.db|workspace-[0-9a-f-]+\.db|stage-[0-9a-f-]+\.db|workspace-slots\.db)(?:-wal|-shm|-journal)?$/.test(entry.name))continue;
  if(entry.exists)entry.delete();
 }
 return [...keys];
}
