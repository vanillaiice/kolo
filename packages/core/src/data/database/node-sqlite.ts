import { domainsForWrite, publishChanges, type ChangedDomain } from "./changes.ts";
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync, renameSync, openSync, fsyncSync, closeSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { STANDARD_TRANSFER_LIMITS, TransferError, type SnapshotPort, type SnapshotHandle, type TransferLimits } from "../../backup/types.ts";
/**
 * A {@link Database} backed by Node's built-in SQLite.
 *
 * This is what tests run against. It is real SQLite — the same engine the
 * device uses — so the schema, the constraints, and every query are exercised
 * rather than simulated. What it does not cover is the native module the app
 * loads, which needs a device.
 */

import { DatabaseSync } from "node:sqlite";

import {
  DatabaseError,
  type Database,
  type Queryable,
  type Row,
  type SqlValue,
  type WriteResult,
} from "./driver.ts";

/** Options for opening a database. */
export interface OpenOptions {
  /** Offline inspection: never creates a file or changes journal settings. */
  readonly readOnly?: boolean;
  /**
   * Where the file lives. Defaults to `:memory:`, which is what tests want:
   * each one gets a database of its own and nothing survives between them.
   */
  readonly location?: string;
}

/**
 * Opens a SQLite database with the settings this application needs.
 */
export function openDatabase(options: OpenOptions = {}): Database {
  const connection = new DatabaseSync(options.location ?? ":memory:", { readOnly: options.readOnly ?? false });

  if (options.readOnly) {
    connection.exec("PRAGMA query_only = ON");
    connection.exec("PRAGMA busy_timeout = 5000");
    return new NodeSqliteDatabase(connection, true);
  }

  // Foreign keys are off by default in SQLite, which would silently disable
  // every relationship the schema declares. Nothing else here matters if this
  // is missed.
  connection.exec("PRAGMA foreign_keys = ON");

  // Write-ahead logging lets a read run while a write is in flight. On a till
  // that means a product search does not block behind a sale being recorded.
  connection.exec("PRAGMA journal_mode = WAL");

  // NORMAL rather than FULL: with WAL this still survives a process crash, and
  // only loses the last transactions if the whole device loses power. The
  // alternative is an fsync per commit, which on cheap Android storage is the
  // difference between a till that feels instant and one that does not.
  connection.exec("PRAGMA synchronous = NORMAL");

  // Wait rather than fail immediately if another connection holds a write lock.
  connection.exec("PRAGMA busy_timeout = 5000");

  return new NodeSqliteDatabase(connection);
}

class NodeSqliteDatabase implements Database {
  #connection: DatabaseSync;
  /** Depth of nested transaction calls; only the outermost commits. */
  #depth = 0;
  #changed = new Set<ChangedDomain>();
  #readOnly: boolean;

  constructor(connection: DatabaseSync, readOnly = false) {
    this.#connection = connection;
    this.#readOnly = readOnly;
  }

  run(sql: string, parameters: readonly SqlValue[] = []): WriteResult {
    try {
      const statement = this.#connection.prepare(sql);
      const result = statement.run(...(parameters as SqlValue[]));
      if (Number(result.changes) > 0) {
        const domains = domainsForWrite(sql);
        if (this.#depth > 0) for (const domain of domains) this.#changed.add(domain);
        else publishChanges(this, new Set(domains));
      }
      return { changes: Number(result.changes) };
    } catch (cause) {
      throw new DatabaseError(describe(cause), sql, { cause });
    }
  }

  all(sql: string, parameters: readonly SqlValue[] = []): Row[] {
    try {
      const statement = this.#connection.prepare(sql);
      return statement.all(...(parameters as SqlValue[])) as Row[];
    } catch (cause) {
      throw new DatabaseError(describe(cause), sql, { cause });
    }
  }

  get(sql: string, parameters: readonly SqlValue[] = []): Row | undefined {
    try {
      const statement = this.#connection.prepare(sql);
      return statement.get(...(parameters as SqlValue[])) as Row | undefined;
    } catch (cause) {
      throw new DatabaseError(describe(cause), sql, { cause });
    }
  }

  transaction<T>(work: (tx: Queryable) => T): T {
    // A nested call joins the outer transaction. Starting a real inner one
    // would mean an inner rollback could leave the outer half-applied, which is
    // precisely what ADR-014 forbids: a business write and its outbox event
    // must be all or nothing together.
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return work(this);
      } finally {
        this.#depth -= 1;
      }
    }

    this.#connection.exec(this.#readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    let committed = false;
    this.#changed.clear();
    this.#depth = 1;
    try {
      const result = work(this);
      this.#connection.exec("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      // Rolling back must not mask the error that caused it. If the rollback
      // itself fails there is nothing useful left to do, and the original
      // failure is the one worth reporting.
      try {
        this.#connection.exec("ROLLBACK");
      } catch {
        // Intentionally ignored; see above.
      }
      throw error;
    } finally {
      this.#depth = 0;
      const changed = new Set(this.#changed); this.#changed.clear();
      if (committed) publishChanges(this, changed);
    }
  }

  close(): void {
    this.#connection.close();
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Native file slots and private SQLite staging, shared by desktop and real-database recovery tests. */
export function nodeWorkspaceFiles(directory:string,options:{readonly limits?:()=>TransferLimits}={}): SnapshotPort & { limits():TransferLimits; openActive():Database; activeId():string; saved():Promise<readonly {id:string;name:string}[]>; selectSaved(id:string,target:Database):Promise<Database>; close():void } {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const limits=():TransferLimits=>options.limits?.() ?? STANDARD_TRANSFER_LIMITS,maximum=():number=>limits().snapshotBytes;
  const control=openDatabase({location:join(directory,"workspace-slots.db")});
  control.run("PRAGMA synchronous=FULL");
  control.run(`CREATE TABLE IF NOT EXISTS active_slot(id INTEGER PRIMARY KEY CHECK(id=1),filename TEXT NOT NULL,generation INTEGER NOT NULL) STRICT`);
  control.run(`INSERT OR IGNORE INTO active_slot VALUES(1,'kolo.db',1)`);
  const bindings=new WeakMap<Database,{filename:string;generation:number}>();
  const name=(filename:string):string=>{if(!/^(kolo\.db|workspace-[0-9a-f-]+\.db|stage-[0-9a-f-]+\.db)$/.test(filename))throw new TransferError("activation_failed");return join(directory,filename);};
  const allocate=():string=>`stage-${randomUUIDv7()}.db`;
  function handle(filename:string,database:Database):SnapshotHandle {
    let state:"open"|"closed"|"activated"="open";
    return {database,
      async bytes(){
        if(state!=="open")throw new TransferError("invalid_snapshot");
        const exportName=allocate(),path=name(exportName);
        try{database.run("VACUUM INTO ?",[path]);if(statSync(path).size>maximum())throw new TransferError("too_large");return new Uint8Array(readFileSync(path));}
        finally{rmSync(path,{force:true});}
      },
      async discard(){if(state==="activated")return;if(state==="open"){database.close();state="closed";}for(const suffix of ["","-wal","-shm"])rmSync(name(filename)+suffix,{force:true});},
      async activate(target){
        const binding=bindings.get(target);if(state!=="open"||binding===undefined)throw new TransferError("activation_failed");
        database.run("PRAGMA wal_checkpoint(TRUNCATE)");database.run("PRAGMA journal_mode=DELETE");database.close();state="closed";
        const finalName=`workspace-${randomUUIDv7()}.db`,finalPath=name(finalName);
        renameSync(name(filename),finalPath);
        // Windows FlushFileBuffers needs write access: fsync through a read-only handle fails with EPERM there.
        const file=openSync(finalPath,"r+");try{fsyncSync(file);}finally{closeSync(file);}
        // Persist the directory entry before committing the durable active pointer.
        if(process.platform!=="win32"){const dir=openSync(directory,"r");try{fsyncSync(dir);}finally{closeSync(dir);}}
        const finalDb=openDatabase({location:finalPath});
        try{
          control.transaction(tx=>{const current=tx.get(`SELECT * FROM active_slot WHERE id=1`)!;if(current["filename"]!==binding.filename||current["generation"]!==binding.generation)throw new TransferError("activation_failed");tx.run(`UPDATE active_slot SET filename=?,generation=generation+1 WHERE id=1`,[finalName]);});
        }catch(error){finalDb.close();rmSync(finalPath,{force:true});throw error;}
        state="activated";bindings.set(finalDb,{filename:finalName,generation:binding.generation+1});return finalDb;
      },
    };
  }
  return {limits,
    /** File name of the active slot; a failed replacement selects it again. */
    activeId(){return String(control.get(`SELECT filename FROM active_slot WHERE id=1`)!["filename"]);},
    openActive(){const row=control.get(`SELECT * FROM active_slot WHERE id=1`)!;const filename=String(row["filename"]);if(filename!=="kolo.db"&&!existsSync(name(filename)))throw new TransferError("activation_failed");const database=openDatabase({location:name(filename)});bindings.set(database,{filename,generation:Number(row["generation"])});return database;},
    async saved(){
      const active=String(control.get("SELECT filename FROM active_slot WHERE id=1")!["filename"]), result:{id:string;name:string}[]=[];
      for(const filename of readdirSync(directory).sort()){
        if(filename===active||! /^(kolo\.db|workspace-[0-9a-f-]+\.db)$/.test(filename))continue;
        let connection:DatabaseSync|undefined;
        try{if(!lstatSync(name(filename)).isFile())continue;connection=new DatabaseSync(name(filename),{readOnly:true});const shop=connection.prepare("SELECT name FROM businesses ORDER BY id LIMIT 1").get();if(typeof shop?.["name"]==="string")result.push({id:filename,name:shop["name"]});}
        catch{/* Incomplete or damaged files are never offered as shops. */}finally{connection?.close();}
      }
      return result;
    },
    async selectSaved(id,target){
      const binding=bindings.get(target);
      if(binding===undefined||!(await this.saved()).some(shop=>shop.id===id))throw new TransferError("activation_failed");
      const next=openDatabase({location:name(id)});
      try{control.transaction(tx=>{const current=tx.get("SELECT * FROM active_slot WHERE id=1")!;if(current["filename"]!==binding.filename||current["generation"]!==binding.generation)throw new TransferError("activation_failed");tx.run("UPDATE active_slot SET filename=?,generation=generation+1 WHERE id=1",[id]);});}
      catch(error){next.close();throw error;}
      bindings.set(next,{filename:id,generation:binding.generation+1});return next;
    },
    async capture(source){const filename=allocate();try{source.run("VACUUM INTO ?",[name(filename)]);if(statSync(name(filename)).size>maximum())throw new TransferError("too_large");return handle(filename,openDatabase({location:name(filename)}));}catch(error){rmSync(name(filename),{force:true});throw error;}},
    async open(bytes){if(bytes.byteLength<100||bytes.byteLength>maximum())throw new TransferError("invalid_snapshot");const filename=allocate();writeFileSync(name(filename),bytes,{flag:"wx",mode:0o600});try{return handle(filename,openDatabase({location:name(filename)}));}catch{rmSync(name(filename),{force:true});throw new TransferError("invalid_snapshot");}},
    async empty(){const filename=allocate();return handle(filename,openDatabase({location:name(filename)}));},
    close(){control.close();},
  };
}
