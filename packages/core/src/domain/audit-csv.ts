import Papa from "papaparse";
import type { AuditEntry } from "../application/audit.ts";

/**
 * The journal as a spreadsheet (spec §39). Pure, so a renderer can assemble an export from pages it was allowed to read;
 * the client supplies headings and localized cells.
 */

/** Most entries one export holds; a longer journal is narrowed by period or filter first. */
export const AUDIT_EXPORT_LIMIT = 20_000;

/** Spreadsheet columns of an exported journal, in order. */
export const AUDIT_CSV_COLUMNS = ["date", "time", "utc", "member", "device", "operation", "type", "record", "related", "amount", "details", "source", "status", "id"] as const;
export type AuditCsvColumn = typeof AUDIT_CSV_COLUMNS[number];

/** The client's wording: column headings and the localized cells; everything else is written as stored. */
export interface AuditCsvText {
  readonly headings: Readonly<Record<AuditCsvColumn, string>>;
  readonly operation: (entry: AuditEntry) => string;
  readonly details: (entry: AuditEntry) => string;
  readonly source: (entry: AuditEntry) => string;
  readonly status: (entry: AuditEntry) => string;
  /** A record whose name this device does not know. */
  readonly unknown: string;
}

const pad = (value: number): string => String(value).padStart(2, "0");
/** Cells a spreadsheet would run as a formula. Papa's own pattern misses one that continues on another line. */
const FORMULA = /^[=+\-@\t\r]/;

/**
 * The entries as CSV for a spreadsheet: a UTF-8 byte-order mark so accented names open correctly, CRLF lines, and `;`
 * between cells (what French spreadsheets expect) unless `,` is asked for. Dates and times are this device's local time
 * beside the UTC instant; amounts are whole XAF as numbers. Text a spreadsheet would run as a formula is escaped.
 */
export function auditCsv(entries: readonly AuditEntry[], text: AuditCsvText, delimiter: ";" | "," = ";"): string {
  const rows = entries.map(entry => {
    const at = new Date(entry.occurredAt);
    const cells: Record<AuditCsvColumn, string | number> = {
      date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
      utc: entry.occurredAt, member: entry.actor.name ?? text.unknown, device: entry.device.label ?? text.unknown,
      operation: text.operation(entry), type: entry.type, record: entry.subject === undefined ? "" : entry.subject.name ?? text.unknown,
      related: entry.related?.name ?? "", amount: entry.facts.amountMinor ?? "", details: text.details(entry),
      source: text.source(entry), status: text.status(entry), id: entry.id,
    };
    return AUDIT_CSV_COLUMNS.map(column => cells[column]);
  });
  return "\uFEFF" + Papa.unparse({ fields: AUDIT_CSV_COLUMNS.map(column => text.headings[column]), data: rows }, { delimiter, newline: "\r\n", escapeFormulae: FORMULA });
}
