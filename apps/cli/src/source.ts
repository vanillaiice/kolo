import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeWorkspaceFiles, openDatabase } from "@kolo/core/data/database/node-sqlite";
import type { Database } from "@kolo/core/data/database/driver";
import { previewBackup, cancelBackupPreview, type BackupPreview } from "@kolo/core/application/backup";
import { LARGE_TRANSFER_LIMITS, type SnapshotHandle } from "@kolo/core/backup/types";
import { transferCrypto } from "./crypto.ts";

export async function withBackup<T>(path: string, password: string, work: (preview: BackupPreview, handle: SnapshotHandle) => Promise<T>): Promise<T> {
  if (statSync(path).size > LARGE_TRANSFER_LIMITS.fileBytes) throw new Error("Backup exceeds the supported size limit");
  const directory = mkdtempSync(join(tmpdir(), "kolo-cli-"));
  const files = nodeWorkspaceFiles(directory, { limits: () => LARGE_TRANSFER_LIMITS });
  let candidate: SnapshotHandle | undefined;
  let preview: BackupPreview | undefined;
  try {
    preview = await previewBackup(readFileSync(path, "utf8"), password, {
      ...files,
      async open(bytes) { candidate = await files.open(bytes); return candidate; },
    }, transferCrypto);
    if (!candidate) throw new Error("Missing backup candidate");
    return await work(preview, candidate);
  } finally {
    if (preview) await cancelBackupPreview(preview);
    else if (candidate) await candidate.discard();
    files.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function withCopy<T>(path: string, work: (database: Database) => T): Promise<T> {
  // Reject WAL companions: these commands accept standalone offline copies only.
  for (const suffix of ["-wal", "-shm"]) {
    try { statSync(path + suffix); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Use a standalone SQLite copy or backup; WAL/SHM companions are present");
  }
  // SQLite may create WAL/SHM files even for a read-only WAL-mode connection.
  // Open a private copy so the user's directory is never touched.
  const directory = mkdtempSync(join(tmpdir(), "kolo-cli-copy-"));
  let database: Database | undefined;
  try {
    const copy = join(directory, "copy.db");
    copyFileSync(path, copy);
    database = openDatabase({ location: copy, readOnly: true });
    const opened = database;
    return opened.transaction(() => work(opened));
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
