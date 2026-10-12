import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

export const DEVELOPMENT_BACKUP_PASSWORD = "kolo-fixture-2026";
export const MAX_SECRET_FILE_BYTES = 4096;

/** Bound the actual read as well as the file size, including files that grow after opening. */
export function readSecretFile(path: string): string {
  if (!statSync(path).isFile()) throw new Error("Secret files must be regular files");
  const handle = openSync(path, "r");
  const buffer = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) throw new Error("Secret files must be regular files");
    if (stat.size > MAX_SECRET_FILE_BYTES) throw new Error("Secret file exceeds the 4 KB limit");
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(handle, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_SECRET_FILE_BYTES) throw new Error("Secret file exceeds the 4 KB limit");
    return buffer.subarray(0, length).toString("utf8").replace(/\r?\n$/, "");
  } finally { buffer.fill(0); closeSync(handle); }
}

export function backupPassword(file: string | undefined, env: NodeJS.ProcessEnv): string {
  const value = file !== undefined ? readSecretFile(file) : env["KOLO_BACKUP_PASSWORD"];
  if (value === undefined) return DEVELOPMENT_BACKUP_PASSWORD;
  if (value.length === 0) throw new Error("Backup password is empty; set KOLO_BACKUP_PASSWORD or pass --password-file");
  return value;
}
