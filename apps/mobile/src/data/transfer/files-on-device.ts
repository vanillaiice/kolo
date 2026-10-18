import { Directory, File, FileMode, Paths } from "expo-file-system";
import { MAX_TRANSFER_FILE_BYTES, TransferError, type ByteSink, type TransferDocument } from "@kolo/core/backup/types";
import { newIdOnDevice } from "../auth/local-credentials-on-device.ts";
/** Names KOLO writes: encrypted containers (ADR-035) and plaintext invitation/request JSON. */
const DOCUMENT_NAME = /^[0-9a-f-]+\.(kolo-(?:backup|enrollment|exchange|receipt)|kolo-(?:invite|request)\.json)$/;
const COPY_CHUNK = 1024 * 1024;

/** A picked file read through one native handle in pieces (ADR-035); `bytes` reads a small one whole. */
export interface PickedFile {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  bytes(maximum: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Uses the native picker and bounds the reported size before reading anything; the size checked here is the limit. */
export async function pickTransferFile(): Promise<PickedFile | undefined> {
  const picked = await File.pickFileAsync({ mimeTypes: ["application/octet-stream", "application/json", "text/plain"] }); if (picked.canceled) return undefined;
  const file = picked.result; if (!file.exists || file.size <= 0 || file.size > MAX_TRANSFER_FILE_BYTES) throw new TransferError("too_large");
  const size = file.size, handle = file.open(FileMode.ReadOnly);
  let closed = false;
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    if (closed || !Number.isSafeInteger(offset) || offset < 0 || length < 0) throw new TransferError("invalid_file");
    handle.offset = offset; return handle.readBytes(Math.max(0, Math.min(length, size - offset)));
  };
  return { size, read,
    async bytes(maximum) { if (size > maximum) throw new TransferError("too_large"); const all = await read(0, size); if (all.byteLength !== size) throw new TransferError("invalid_file"); return all; },
    async close() { if (closed) return; closed = true; handle.close(); } };
}
/**
 * Saves only bounded encrypted documents or identity-only pairing proofs to a user-selected directory.
 * Returns false when the user closes the folder picker; the document stays prepared for another try.
 */
export async function saveTransferFile(document: TransferDocument): Promise<boolean> {
  const name = DOCUMENT_NAME.exec(document.filename);
  if (name === null || !(document.bytes instanceof Uint8Array) || document.bytes.byteLength < 1 || document.bytes.byteLength > MAX_TRANSFER_FILE_BYTES) throw new TransferError("invalid_file");
  let directory: Directory;
  try { directory = await Directory.pickDirectoryAsync(); } catch { return false; }
  const file = directory.createFile(document.filename, name[1]!.endsWith(".json") ? "application/json" : "application/octet-stream"); file.write(document.bytes); return true;
}

/** A large file (a backup) written into the app's private cache, ready to be copied out; `discard` deletes it. */
export interface PreparedFile { readonly filename: string; readonly size: number; save(): Promise<boolean>; discard(): void }
const outgoing = (): Directory => { const directory = new Directory(Paths.cache, "outgoing"); if (!directory.exists) directory.create(); return directory; };
/** Removes prepared files an interrupted save left in the private cache. */
export function clearPreparedFiles(): void { try { for (const entry of outgoing().list()) if (entry instanceof File && /^outgoing-[0-9a-f-]+\.tmp$/.test(entry.name)) entry.delete(); } catch { /* Nothing to clear. */ } }
/**
 * Streams a large file into the app's private cache (ADR-035), never holding it in memory. `save` copies it in 1 MiB
 * chunks into a user-selected directory and deletes the private copy; a closed folder picker keeps it for another try.
 */
export async function prepareStreamedFile(write: (sink: ByteSink) => Promise<string>): Promise<PreparedFile> {
  const temporary = new File(outgoing(), `outgoing-${newIdOnDevice()}.tmp`); temporary.create();
  let size = 0, filename: string;
  try {
    const handle = temporary.open(FileMode.ReadWrite);
    try { filename = await write({ write: async bytes => { size += bytes.byteLength; if (size > MAX_TRANSFER_FILE_BYTES) throw new TransferError("too_large"); handle.writeBytes(bytes); } }); }
    finally { handle.close(); }
    const name = DOCUMENT_NAME.exec(filename); if (name === null) throw new TransferError("invalid_file");
  } catch (error) { if (temporary.exists) temporary.delete(); throw error; }
  let done = false;
  return { filename, size,
    async save() {
      if (done) throw new TransferError("invalid_file");
      let directory: Directory;
      try { directory = await Directory.pickDirectoryAsync(); } catch { return false; }
      const target = directory.createFile(filename, "application/octet-stream"), source = temporary.open(FileMode.ReadOnly), sink = target.open(FileMode.WriteOnly);
      try { for (let at = 0; at < size; at += COPY_CHUNK) { source.offset = at; const chunk = source.readBytes(Math.min(COPY_CHUNK, size - at)); if (chunk.byteLength === 0) throw new TransferError("invalid_file"); sink.writeBytes(chunk); } }
      catch (error) { try { target.delete(); } catch { /* The folder may not allow it; the partial copy is visible as such. */ } throw error; }
      finally { source.close(); sink.close(); }
      done = true; if (temporary.exists) temporary.delete(); return true;
    },
    discard() { done = true; if (temporary.exists) temporary.delete(); } };
}
