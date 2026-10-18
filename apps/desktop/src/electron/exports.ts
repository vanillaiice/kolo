import { WorkspaceError } from "@kolo/core/identity/types";
import { MAX_TRANSFER_FILE_BYTES } from "@kolo/core/backup/types";
import { CommandError } from "./host.ts";
import { EXPORT_NAME } from "./transfer-files.ts";
import type { TransferHost } from "./transfer.ts";
import { object } from "./validation.ts";

/**
 * Saves a spreadsheet the renderer assembled (the journal export) through the native save dialog, only for a member
 * holding `data.export`: writing shop data to a file of their choosing is the step that takes it off this computer.
 * The name must be a plain `.csv` name and the text is bounded like any file KOLO writes. False when cancelled.
 */
export async function saveCsv(host: TransferHost, input: unknown): Promise<boolean> {
  const data = object(input, ["sessionId", "filename", "content"]);
  host.actor(data, ["data.export"]);
  const filename = data["filename"], content = data["content"];
  if (typeof filename !== "string" || !EXPORT_NAME.test(filename) || typeof content !== "string" || content.length === 0 || content.length > MAX_TRANSFER_FILE_BYTES) throw new WorkspaceError("invalid_input");
  const save = host.transfer.dialogs.saveExport;
  if (save === undefined) throw new CommandError("unavailable");
  return save(filename, new TextEncoder().encode(content));
}
