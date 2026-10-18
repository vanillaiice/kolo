import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeWorkspaceFiles, openDatabase } from "@kolo/core/data/database/node-sqlite";
import type { Database } from "@kolo/core/data/database/driver";
import { previewBackupFile, cancelBackupPreview, type BackupPreview } from "@kolo/core/application/backup";
import { MAX_TRANSFER_FILE_BYTES, type SnapshotHandle } from "@kolo/core/backup/types";
import { transferCrypto } from "./crypto.ts";

export async function withBackup<T>(path: string, password: string | { readonly recoveryKey: string }, work: (preview: BackupPreview, handle: SnapshotHandle) => Promise<T>): Promise<T> {
  if (statSync(path).size > MAX_TRANSFER_FILE_BYTES) throw new Error("Backup exceeds the supported size limit");
  const directory = mkdtempSync(join(tmpdir(), "kolo-cli-"));
  const files = nodeWorkspaceFiles(directory);
  let candidate: SnapshotHandle | undefined;
  let preview: BackupPreview | undefined;
  // The backup is read in pieces and decrypted into private staging (ADR-035), never held whole in memory.
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const reader = { size, async read(offset: number, length: number): Promise<Uint8Array> {
      const buffer = new Uint8Array(Math.max(0, Math.min(length, size - offset))); let at = 0;
      while (at < buffer.byteLength) { const { bytesRead } = await file.read(buffer, at, buffer.byteLength - at, offset + at); if (bytesRead === 0) break; at += bytesRead; }
      return buffer.subarray(0, at);
    } };
    preview = await previewBackupFile(reader, password, {
      ...files,
      async receive() { const writer = await files.receive(); return { ...writer, async open() { candidate = await writer.open(); return candidate; } }; },
    }, transferCrypto);
    if (!candidate) throw new Error("Missing backup candidate");
    return await work(preview, candidate);
  } finally {
    await file.close();
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
