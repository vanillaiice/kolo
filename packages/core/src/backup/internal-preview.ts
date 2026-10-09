import type { SignedSnapshot } from "@kolo/contracts/transfer";
import type { SnapshotHandle, SnapshotPort, TransferCrypto } from "./types.ts";
import type { BackupPreview } from "../application/backup.ts";
/** @internal Exact authenticated bytes and isolated candidate, never manufactured by public preview fields. */
export const backupPreviews=new WeakMap<BackupPreview,{signed:SignedSnapshot;handle:SnapshotHandle;files:SnapshotPort;crypto:TransferCrypto;state:"ready"|"restoring"|"consumed"}>();
