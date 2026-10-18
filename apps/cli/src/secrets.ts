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

/**
 * What opens a backup: the backup recovery key from `--recovery-key-file` or `KOLO_BACKUP_RECOVERY_KEY` (ADR-036) when
 * given, otherwise the password as {@link backupPassword} reads it.
 */
export function backupSecret(passwordFile: string | undefined, recoveryKeyFile: string | undefined, env: NodeJS.ProcessEnv): string | { readonly recoveryKey: string } {
  const key = recoveryKeyFile !== undefined ? readSecretFile(recoveryKeyFile) : env["KOLO_BACKUP_RECOVERY_KEY"];
  if (key !== undefined) {
    if (passwordFile !== undefined) throw new Error("Use either --password-file or --recovery-key-file");
    if (key.trim().length === 0) throw new Error("Backup recovery key is empty");
    return { recoveryKey: key };
  }
  return backupPassword(passwordFile, env);
}

export function backupPassword(file: string | undefined, env: NodeJS.ProcessEnv): string {
  const value = file !== undefined ? readSecretFile(file) : env["KOLO_BACKUP_PASSWORD"];
  if (value === undefined) return DEVELOPMENT_BACKUP_PASSWORD;
  if (value.length === 0) throw new Error("Backup password is empty; set KOLO_BACKUP_PASSWORD or pass --password-file");
  return value;
}
