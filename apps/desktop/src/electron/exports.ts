import { WorkspaceError } from "@kolo/core/identity/types";
import { MAX_TRANSFER_FILE_BYTES } from "@kolo/core/backup/types";
import { unlockedActor } from "@kolo/core/identity/workspace";
import { REPORT_DOCUMENT_LABELS, reportHtml, type ReportDocumentLabels } from "@kolo/core/domain/report-document";
import { CommandError } from "./host.ts";
import { report } from "./reports.ts";
import { EXPORT_NAME, PDF_NAME } from "./transfer-files.ts";
import type { TransferHost } from "./transfer.ts";
import { object, text } from "./validation.ts";

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

/**
 * Saves a report as an A4 PDF through the native save dialog, for a member holding the report's own permission and
 * `data.export` (a file of their choosing takes the figures off this computer, as for {@link saveCsv}). The figures are
 * read here exactly as {@link report} shows them; the renderer supplies only the wording (escaped into the page) and
 * the file name, a plain `.pdf` name. The shop name is the installation's. False when the dialog was cancelled.
 */
export async function saveReportPdf(host: TransferHost, input: unknown): Promise<boolean> {
  const data = object(input, ["sessionId", "kind", "from", "until", "filename", "text"]);
  host.actor(data, ["data.export"]);
  const value = report(host, { sessionId: data["sessionId"], kind: data["kind"], from: data["from"], until: data["until"] });
  const filename = data["filename"];
  if (typeof filename !== "string" || !PDF_NAME.test(filename)) throw new WorkspaceError("invalid_input");
  const wording = object(data["text"], ["language", "title", "period", "generated", "credit", "labels"]), language = wording["language"];
  if (language !== "fr" && language !== "en") throw new WorkspaceError("invalid_input");
  const given = object(wording["labels"], REPORT_DOCUMENT_LABELS);
  const labels = Object.fromEntries(REPORT_DOCUMENT_LABELS.map(key => [key, text(given[key], 300)])) as ReportDocumentLabels;
  const save = host.transfer.dialogs.savePdf;
  if (save === undefined) throw new CommandError("unavailable");
  return save(filename, reportHtml(value, { language, shop: unlockedActor(host.actor(data)).businessName, title: text(wording["title"]),
    period: text(wording["period"], 200), generated: text(wording["generated"], 200), credit: text(wording["credit"], 200), labels }));
}
