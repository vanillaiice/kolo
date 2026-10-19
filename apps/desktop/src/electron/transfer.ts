import { createBackup, writeBackup, previewBackupFile, cancelBackupPreview, restoreWorkspace, type BackupPreview } from "@kolo/core/application/backup";
import { memoryReader, type ByteReader } from "@kolo/core/backup/encryption";
import { MAX_JOURNAL_BATCH_BYTES } from "@kolo/contracts/delivery";
import { createPairingInvite, previewPairingInvite, acceptPairingInvite, previewPairingRequest, confirmPairing, completePairing as finishPairing, cancelPairing as abandonPairing } from "@kolo/core/application/pairing";
import { exportBundle, previewBundle, importBundle, exportReceipt, importReceipt, exchangeDestinations, receivedBatches, exchangeDiagnostics, type BundlePreview } from "@kolo/core/application/file-exchange";
import { exchangeStatus } from "@kolo/core/application/event-delivery";
import { retryDeferred } from "@kolo/core/application/event-application";
import { MAX_TRANSFER_FILE_BYTES, TransferError, type ByteSink, type SnapshotPort, type TransferCrypto, type TransferDocument } from "@kolo/core/backup/types";
import { transferFileKind } from "@kolo/core/backup/file-kind";
import { ExchangeError } from "@kolo/core/exchange/types";
import { currentInstallation } from "@kolo/core/identity/workspace";
import { validateLocalSecret } from "@kolo/core/identity/credentials";
import { migrate } from "@kolo/core/data/database/migrations";
import { WorkspaceError, type OperationContext } from "@kolo/core/identity/types";
import type { Database } from "@kolo/core/data/database/driver";
import type { BackupFileView, BundleView, ExchangeView, InviteView, PairingRequestView, SavedFile } from "../shared/service.js";
import { object, text, uuid, boolean } from "./validation.ts";
import { CommandError, type Host } from "./host.ts";

/** A file the owner picked, read by the main process in pieces; closing it releases the file. */
export interface PickedFile extends ByteReader { close(): Promise<void> }
/** A picked file already in memory (tests, smoke runs). */
export function pickedBytes(bytes: Uint8Array): PickedFile { return { ...memoryReader(bytes), close: async () => undefined }; }
/** Native file access stays in the main process; the renderer never supplies paths or contents. */
export interface TransferDialogs {
  open(): Promise<PickedFile | undefined>;
  save(document: TransferDocument): Promise<boolean>;
  /**
   * Large files (backups): `write` streams the file into a private temporary file and returns its name; the save
   * dialog then offers it and the finished file is copied there. False when the dialog was cancelled.
   */
  saveStream?(write: (sink: ByteSink) => Promise<string>): Promise<boolean>;
  /** A spreadsheet export (`.csv`) offered in the save dialog; false when the dialog was cancelled. */
  saveExport?(filename: string, bytes: Uint8Array): Promise<boolean>;
  /** A self-contained HTML page rendered to PDF and offered in the save dialog; false when the dialog was cancelled. */
  savePdf?(filename: string, html: string): Promise<boolean>;
}
/** What the desktop host provides for backup, pairing and exchange. */
export interface TransferPorts { readonly files: SnapshotPort & { activeId?(): string; saved?(): Promise<readonly {id:string;name:string}[]>; selectSaved?(id:string,target:Database):Promise<Database> }; readonly dialogs: TransferDialogs; readonly crypto: TransferCrypto; }
/** What an imported file turned out to be. */
export type ImportKind = "backup" | "invite";
/** One checked file per installation; checking another or locking forgets it. */
export type StagedFile = { readonly kind: "backup"; readonly preview: BackupPreview } | { readonly kind: "invite"; readonly file: Uint8Array } |
  { readonly kind: "picked"; readonly fileKind: ImportKind; readonly file: PickedFile } |
  { readonly kind: "request"; readonly file: Uint8Array } | { readonly kind: "bundle"; readonly preview: BundlePreview };
/** Host access for transfer commands, including the swap to an activated database. */
export interface TransferHost extends Host {
  readonly transfer: TransferPorts;
  optionalActor(data: Record<string, unknown>): OperationContext | undefined;
  staged(): StagedFile | undefined;
  stage(file: StagedFile | undefined): Promise<void>;
  /** Resolves once the main process serves the activated database through a new application. */
  activate(database: Database): Promise<void>;
}
/** Core transfer and exchange failures become stable bridge codes. */
export async function translated<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof TransferError) throw new CommandError(error.code === "scope_mismatch" ? "scope_mismatch" : error.code);
    if (error instanceof ExchangeError) {
      if (error.code === "permission_denied" || error.code === "scope_mismatch" || error.code === "locked") throw new WorkspaceError(error.code);
      throw new CommandError("invalid_file");
    }
    throw error;
  }
}
function password(value: unknown): string { return text(value, 256, false); }
/** Size bounds for files read whole: pairing proofs and journal batches are small; only backups stream. */
const PROOF_BYTES = 64 * 1024, BATCH_FILE_BYTES = MAX_JOURNAL_BATCH_BYTES + 1024 * 1024;
/** Recognizes a backup or pairing invite from the file's first bytes; anything else is refused before any work. */
async function importKind(file: PickedFile, crypto: TransferCrypto): Promise<ImportKind> {
  const kind = transferFileKind(await file.read(0, Math.min(file.size, 128 * 1024)), crypto);
  if (kind === "backup" || kind === "invite") return kind;
  throw new CommandError("invalid_file");
}
/** A file chosen on the import screen is used by the matching open command; otherwise the dialog opens. */
async function chosen(host: TransferHost, kind: ImportKind): Promise<{ readonly file: PickedFile; readonly staged: boolean }> {
  const file = host.staged();
  return file?.kind === "picked" && file.fileKind === kind ? { file: file.file, staged: true } : { file: await pick(host), staged: false };
}
/** Import screen: one file dialog for a backup or an invite; the caller continues with the matching steps. */
export async function chooseImportFile(host: TransferHost, input: unknown): Promise<{ readonly kind: ImportKind }> {
  object(input ?? {}, []);
  const file = await pick(host);
  let kind: ImportKind;
  try { kind = await importKind(file, host.transfer.crypto); } catch (error) { await file.close(); throw error; }
  await host.stage({ kind: "picked", fileKind: kind, file });
  return { kind };
}
async function pick(host: TransferHost): Promise<PickedFile> {
  const chosen = await host.transfer.dialogs.open();
  if (chosen === undefined) throw new CommandError("cancelled");
  return chosen;
}
/** Reads a small picked file whole, within `maximum`. */
async function readAll(file: PickedFile, maximum: number): Promise<Uint8Array> {
  if (file.size < 1 || file.size > maximum) throw new CommandError("too_large");
  const bytes = await file.read(0, file.size);
  if (bytes.byteLength !== file.size) throw new CommandError("invalid_file");
  return bytes;
}
/** Picks a small file and reads it whole. */
async function pickBytes(host: TransferHost, maximum: number): Promise<Uint8Array> {
  const file = await pick(host);
  try { return await readAll(file, maximum); } finally { await file.close(); }
}
async function save(host: TransferHost, document: TransferDocument | undefined): Promise<SavedFile> {
  return { saved: document === undefined ? false : await host.transfer.dialogs.save(document) };
}
function staged<K extends StagedFile["kind"]>(host: TransferHost, kind: K): Extract<StagedFile, { kind: K }> {
  const file = host.staged();
  if (file?.kind !== kind) throw new CommandError("no_file");
  return file as Extract<StagedFile, { kind: K }>;
}
function deviceLabel(value: unknown): string { return text(value, 120); }

/** Streams the backup into a private temporary file, then offers it in the save dialog (ADR-035): memory stays a few MiB. */
export async function saveBackup(host: TransferHost, input: unknown): Promise<SavedFile> {
  const data = object(input, ["sessionId", "password", "includePhotos"]), context = host.actor(data, ["business.settings"]);
  const includePhotos = data["includePhotos"] === undefined ? true : boolean(data["includePhotos"]), secret = password(data["password"]);
  const stream = host.transfer.dialogs.saveStream;
  if (stream === undefined) return save(host, await createBackup(context, secret, host.transfer.files, host.transfer.crypto, { includePhotos }));
  return { saved: await stream(async sink => (await writeBackup(context, secret, host.transfer.files, host.transfer.crypto, sink, { includePhotos })).filename) };
}
/** Opens the chosen backup with its password or with the shop's backup recovery key, exactly one of them (ADR-036). */
export async function openBackup(host: TransferHost, input: unknown): Promise<BackupFileView> {
  const data = object(input, ["password", "recoveryKey"]);
  if ((data["password"] === undefined) === (data["recoveryKey"] === undefined)) throw new CommandError("invalid_input");
  const secret = data["recoveryKey"] === undefined ? password(data["password"]) : { recoveryKey: text(data["recoveryKey"], 200, false) }, picked = await chosen(host, "backup");
  // The file stays chosen until it checks out, so a mistyped password can be retried without the dialog.
  let preview: BackupPreview;
  try { preview = await previewBackupFile(picked.file, secret, host.transfer.files, host.transfer.crypto); }
  finally { if (!picked.staged) await picked.file.close(); }
  await host.stage({ kind: "backup", preview });
  return { businessName: preview.businessName, ownerName: preview.ownerName, createdAt: preview.createdAt, appliedEvents: preview.appliedEvents };
}
/**
 * Restores the checked backup. Signed in, the owner replaces the open shop. Signed out, an empty
 * computer restores directly; a computer with a shop needs `replace: true`, and its shop moves aside
 * as a safety copy (as starting a new shop always did) before the backup is restored into a fresh
 * slot. If that restore fails, the previous shop is selected again.
 */
export async function restoreBackup(host: TransferHost, input: unknown): Promise<{ readonly activated: boolean }> {
  const data = object(input, ["sessionId", "confirmedName", "deviceLabel", "secret", "replace"]), recovery = host.optionalActor(data);
  const replace = data["replace"] === undefined ? false : boolean(data["replace"]);
  const { preview } = staged(host, "backup");
  if (text(data["confirmedName"]) !== preview.businessName) throw new CommandError("confirmation_required");
  const request = { confirmedBusinessId: preview.businessId, deviceLabel: deviceLabel(data["deviceLabel"]), platform: "DESKTOP" as const,
    secret: text(data["secret"], 256, false), ...(recovery === undefined ? {} : { recoveryContext: recovery }) };
  validateLocalSecret(request.secret);
  if (recovery !== undefined || currentInstallation(host.ports.database).state === "empty") {
    const result = await restoreWorkspace(preview, request, host.ports);
    await host.stage(undefined); await host.activate(result.database);
    return { activated: true };
  }
  if (!replace) throw new CommandError("not_empty");
  const files = host.transfer.files;
  if (files.activeId === undefined || files.selectSaved === undefined) throw new CommandError("unavailable");
  const previous = files.activeId(), candidate = await files.empty();
  let empty: Database;
  try { migrate(candidate.database); empty = await candidate.activate(host.ports.database); } finally { await candidate.discard(); }
  try {
    const result = await restoreWorkspace(preview, request, { ...host.ports, database: empty });
    empty.close(); await host.stage(undefined); await host.activate(result.database);
    return { activated: true };
  } catch (error) {
    // The open shop never stopped being served; point the active slot back at it.
    try { (await files.selectSaved(previous, empty)).close(); } finally { empty.close(); }
    throw error;
  }
}
export async function saveInvite(host: TransferHost, input: unknown): Promise<SavedFile & { readonly fingerprint: string }> {
  const data = object(input, ["sessionId", "authorityAllowed"]), context = host.actor(data, ["business.settings"]);
  const document = await createPairingInvite(context, host.transfer.crypto, boolean(data["authorityAllowed"]));
  const { fingerprint } = await previewPairingInvite(document.bytes, host.transfer.crypto);
  return { ...(await save(host, document)), fingerprint };
}
export async function openPairingRequest(host: TransferHost, input: unknown): Promise<PairingRequestView> {
  host.actor(object(input, ["sessionId"]), ["business.settings"]);
  const file = await pickBytes(host, PROOF_BYTES), view = await previewPairingRequest(file, host.transfer.crypto);
  await host.stage({ kind: "request", file });
  return view;
}
export async function approvePairingRequest(host: TransferHost, input: unknown): Promise<SavedFile> {
  const data = object(input, ["sessionId", "confirmedCode", "password"]), context = host.actor(data, ["business.settings"]);
  const document = await confirmPairing(context, staged(host, "request").file, text(data["confirmedCode"], 64), password(data["password"]), host.transfer.files, host.transfer.crypto);
  await host.stage(undefined);
  return save(host, document);
}
export async function openInvite(host: TransferHost, input: unknown): Promise<InviteView> {
  object(input ?? {}, []);
  const picked = await chosen(host, "invite");
  let file: Uint8Array;
  try { file = await readAll(picked.file, PROOF_BYTES); } finally { if (!picked.staged) await picked.file.close(); }
  const view = await previewPairingInvite(file, host.transfer.crypto);
  await host.stage({ kind: "invite", file });
  return view;
}
export async function acceptInvite(host: TransferHost, input: unknown): Promise<SavedFile & { readonly verificationCode: string }> {
  const data = object(input, ["sessionId", "confirmedFingerprint", "deviceLabel", "secret"]), existing = host.optionalActor(data);
  const result = await acceptPairingInvite(staged(host, "invite").file, { confirmedFingerprint: text(data["confirmedFingerprint"], 64), label: deviceLabel(data["deviceLabel"]),
    platform: "DESKTOP", secret: text(data["secret"], 256, false), ...(existing === undefined ? {} : { existingContext: existing }) }, host.ports, host.transfer.crypto);
  await host.stage(undefined);
  return { ...(await save(host, result.document)), verificationCode: result.verificationCode };
}
export async function completePairing(host: TransferHost, input: unknown): Promise<{ readonly activated: boolean }> {
  const data = object(input, ["sessionId", "password", "confirmedCode"]), existing = host.optionalActor(data);
  const secret = password(data["password"]), code = text(data["confirmedCode"], 64), file = await pickBytes(host, MAX_TRANSFER_FILE_BYTES);
  const result = await finishPairing(file, secret, code, host.ports, host.transfer.files, host.transfer.crypto, existing);
  if (result.database === host.ports.database) return { activated: false };
  await host.activate(result.database); return { activated: true };
}
export async function cancelPairing(host: TransferHost, input: unknown): Promise<null> {
  object(input ?? {}, []);
  if (currentInstallation(host.ports.database).state === "legacy") throw new WorkspaceError("legacy_installation");
  abandonPairing(host.ports); await host.stage(undefined); return null;
}
export async function exchangeState(host: TransferHost, input: unknown): Promise<ExchangeView> {
  const data = object(input, ["sessionId", "language"]), context = host.actor(data, ["business.settings"]), locale = data["language"] === "en" ? "en" : "fr";
  return { destinations: exchangeDestinations(context).map(item => ({ id: item.id, label: item.label, pending: exchangeStatus(context, item.id)["pending"] ?? 0 })),
    batches: receivedBatches(context).map(({ batchId, senderDeviceId, createdAt }) => ({ batchId, senderDeviceId, createdAt })),
    diagnostics: exchangeDiagnostics(context, locale).map(({ eventId, code, description, action }) => ({ eventId, code, description, action })) };
}
export async function saveExchange(host: TransferHost, input: unknown): Promise<SavedFile & { readonly empty: boolean }> {
  const data = object(input, ["sessionId", "destinationId", "password"]), context = host.actor(data, ["business.settings"]);
  const document = await exportBundle(context, uuid(data["destinationId"]), password(data["password"]), host.transfer.crypto);
  return { ...(await save(host, document)), empty: document === undefined };
}
export async function openExchange(host: TransferHost, input: unknown): Promise<BundleView> {
  const data = object(input, ["sessionId", "password"]), context = host.actor(data, ["business.settings"]), secret = password(data["password"]);
  const file = await pickBytes(host, BATCH_FILE_BYTES); await host.stage(undefined);
  const preview = await previewBundle(context, file, secret, host.transfer.crypto);
  await host.stage({ kind: "bundle", preview });
  const count = (assessment: string): number => preview.events.filter(event => event.assessment === assessment).length;
  return { total: preview.events.length, ready: count("ready"), duplicate: count("duplicate"), deferred: count("deferred"), review: count("review") };
}
export async function importExchange(host: TransferHost, input: unknown): Promise<{ readonly processed: number }> {
  const data = object(input, ["sessionId"]), context = host.actor(data, ["business.settings"]);
  const outcomes = await importBundle(context, staged(host, "bundle").preview, host.transfer.crypto);
  await host.stage(undefined); return { processed: outcomes.length };
}
export async function saveImportReceipt(host: TransferHost, input: unknown): Promise<SavedFile> {
  const data = object(input, ["sessionId", "batchId", "password"]), context = host.actor(data, ["business.settings"]);
  return save(host, await exportReceipt(context, uuid(data["batchId"]), password(data["password"]), host.transfer.crypto));
}
export async function openImportReceipt(host: TransferHost, input: unknown): Promise<{ readonly recorded: number }> {
  const data = object(input, ["sessionId", "destinationId", "password"]), context = host.actor(data, ["business.settings"]);
  const destination = uuid(data["destinationId"]), secret = password(data["password"]), file = await pickBytes(host, BATCH_FILE_BYTES);
  return { recorded: await importReceipt(context, destination, file, secret, host.transfer.crypto) };
}
export async function retryExchange(host: TransferHost, input: unknown): Promise<{ readonly applied: number }> {
  const data = object(input, ["sessionId"]), context = host.actor(data, ["business.settings"]);
  return { applied: retryDeferred(context) };
}
/** Discards a staged backup snapshot and closes a picked file; other staged kinds hold only bytes. */
export async function release(file: StagedFile | undefined): Promise<void> {
  if (file?.kind === "backup") await cancelBackupPreview(file.preview);
  if (file?.kind === "picked") await file.file.close();
}
