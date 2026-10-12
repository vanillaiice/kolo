import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { randomBytes, randomUUIDv7, createCipheriv, createDecipheriv } from "node:crypto";
import { protectedCredentials } from "@kolo/core/identity/credentials";
import { nodeWorkspaceFiles } from "@kolo/core/data/database/node-sqlite";
import { migrate } from "@kolo/core/data/database/migrations";
import { currentInstallation, unlockWorkspace, lockWorkspace } from "@kolo/core/identity/workspace";
import type { Database } from "@kolo/core/data/database/driver";
import type { WorkspacePorts, OperationContext } from "@kolo/core/identity/types";
import type { SecretStore } from "@kolo/core/data/auth/secure-store";
import { LARGE_TRANSFER_LIMITS } from "@kolo/core/backup/types";
import { credentialCrypto } from "./crypto.ts";

const marker = "kolo.headless-till.v1\n";
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const handle = openSync(path, "r");
  try { fsyncSync(handle); } finally { closeSync(handle); }
}
export function privatePath(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Till state contains an invalid file or symlink");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Till state requires owner-only file permissions (0700 directories, 0600 files)");
}
export function initializeTill(path: string): void {
  const directory = resolve(path);
  if (existsSync(directory)) {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || readdirSync(directory).length !== 0) throw new Error("Till initialization requires a new or empty directory");
    chmodSync(directory, 0o700);
  } else mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "till.json"), marker, { flag: "wx", mode: 0o600 });
  writeFileSync(join(directory, "vault.key"), randomBytes(32), { flag: "wx", mode: 0o600 });
}
export function atomicPrivateWrite(path: string, text: string): void {
  const temporary = `${path}.${randomUUIDv7()}.pending`;
  const handle = openSync(temporary, "wx", 0o600);
  try { writeFileSync(handle, text); fsyncSync(handle); }
  finally { closeSync(handle); }
  try { renameSync(temporary, path); syncDirectory(dirname(path)); }
  finally { rmSync(temporary, { force: true }); }
}
function fileVault(directory: string): { store: SecretStore; close(): void } {
  const keyPath = join(directory, "vault.key"); privatePath(keyPath);
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error("Invalid till vault key");
  const root = join(directory, "vault");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  privatePath(root, true);
  const path = (reference: string): string => {
    if (!/^kolo\.[a-zA-Z0-9_.-]{1,200}$/.test(reference)) throw new Error("Invalid vault reference");
    return join(root, reference);
  };
  return { store: {
    async read(reference) {
      const file = path(reference);
      if (!existsSync(file)) return undefined;
      privatePath(file);
      const bytes = readFileSync(file);
      if (bytes.length < 28) throw new Error("Invalid vault record");
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(reference)); cipher.setAuthTag(bytes.subarray(-16));
      const partial = cipher.update(bytes.subarray(12, -16));
      try { return Buffer.concat([partial, cipher.final()]).toString("utf8"); }
      finally { partial.fill(0); }
    },
    async write(reference, secret) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(reference));
      const encoded = Buffer.concat([iv, cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
      const file = path(reference);
      if (existsSync(file)) privatePath(file);
      const temporary = `${file}.${randomUUIDv7()}.pending`, handle = openSync(temporary, "wx", 0o600);
      try { writeFileSync(handle, encoded); fsyncSync(handle); } finally { closeSync(handle); }
      try { renameSync(temporary, file); syncDirectory(root); } finally { rmSync(temporary, { force: true }); }
    },
    async forget(reference) { const file = path(reference); if (existsSync(file)) { privatePath(file); rmSync(file); } },
  }, close() { key.fill(0); } };
}

export class TillState {
  readonly directory: string;
  readonly files: ReturnType<typeof nodeWorkspaceFiles>;
  readonly store: SecretStore;
  readonly credentials: WorkspacePorts["credentials"];
  database: Database;
  #vault: ReturnType<typeof fileVault>;
  #lock: number;
  constructor(path: string) {
    this.directory = resolve(path); privatePath(this.directory, true);
    const markerPath = join(this.directory, "till.json"); privatePath(markerPath);
    if (readFileSync(markerPath, "utf8") !== marker) throw new Error("Use a CLI till initialized by kolo till init");
    try { this.#lock = openSync(join(this.directory, "process.lock"), "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Till is busy; after a crash, verify no till command is running before removing process.lock");
      throw error;
    }
    writeFileSync(this.#lock, String(process.pid));
    let vault: ReturnType<typeof fileVault> | undefined;
    let files: ReturnType<typeof nodeWorkspaceFiles> | undefined;
    let database: Database | undefined;
    try {
      vault = fileVault(this.directory); this.#vault = vault; this.store = vault.store;
      this.credentials = protectedCredentials(this.store, credentialCrypto);
      const root = join(this.directory, "data");
      if (existsSync(root)) {
        privatePath(root, true);
        for (const name of readdirSync(root)) {
          const stat = lstatSync(join(root, name));
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Till database files must be regular files owned by this state directory");
        }
      }
      files = nodeWorkspaceFiles(root, { limits: () => LARGE_TRANSFER_LIMITS }); this.files = files;
      database = files.openActive(); this.database = database; migrate(database);
    } catch (error) {
      database?.close(); files?.close(); vault?.close(); closeSync(this.#lock); rmSync(join(this.directory, "process.lock")); throw error;
    }
  }
  ports(now: () => string = () => new Date().toISOString(), newId: () => string = randomUUIDv7): WorkspacePorts {
    return { database: this.database, credentials: this.credentials, now, newId };
  }
  async unlock(secret: string, now: () => string = () => new Date().toISOString(), newId: () => string = randomUUIDv7): Promise<OperationContext> {
    const state = currentInstallation(this.database);
    if (state.state !== "locked" && state.state !== "unlocked") throw new Error("Complete pairing before using this till");
    return unlockWorkspace({ userId: state.installation.ownerId, secret }, this.ports(now, newId));
  }
  adopt(database: Database): void { if (database !== this.database) { this.database.close(); this.database = database; } }
  close(): void {
    try { lockWorkspace(this.database); this.database.close(); this.files.close(); }
    finally { this.#vault.close(); closeSync(this.#lock); rmSync(join(this.directory, "process.lock")); }
  }
}
