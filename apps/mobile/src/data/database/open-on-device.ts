import { defaultDatabaseDirectory, openDatabaseSync } from "expo-sqlite";
import { Directory, File } from "expo-file-system";
import type { Database } from "@kolo/core/data/database/driver";
import { openNativeDatabase } from "@kolo/core/data/database/expo-sqlite";
import { migrate, type MigrationResult } from "@kolo/core/data/database/migrations";
import { MAX_SNAPSHOT_BYTES, TransferError, type SnapshotHandle, type SnapshotPort } from "@kolo/core/backup/types";
import { newIdOnDevice } from "../auth/local-credentials-on-device.ts";
import { sqlitePreferences, type LanguageStorage } from "./preferences.ts";

/** Opens only device preferences; business activation and restore cannot replace them. */
export const languageStorageOnDevice: LanguageStorage = {
 read() {
  const database = openNativeDatabase(openDatabaseSync("device-preferences.db", { useNewConnection: true }));
  try { return sqlitePreferences(database).read(); } finally { database.close(); }
 },
 write(language) {
  const database = openNativeDatabase(openDatabaseSync("device-preferences.db", { useNewConnection: true }));
  try { sqlitePreferences(database).write(language); } finally { database.close(); }
 },
};

/** Original business filename; a durable SQLite pointer selects replacements without overwriting it. */
export const DATABASE_NAME="kolo.db";
/** This is the sole Expo SQLite import boundary. Private staged images never enter a public export directory. */
export function openOnDevice():{readonly database:Database;readonly migration:MigrationResult;readonly files:SnapshotPort;readonly close:()=>void}{
 const open=(name:string):Database=>openNativeDatabase(openDatabaseSync(name,{useNewConnection:true}));
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
 return {database,migration,files,close:()=>control.close()};
}
