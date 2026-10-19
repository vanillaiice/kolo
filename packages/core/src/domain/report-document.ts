import type { ReportLine, ReportResult } from "../application/report-views.ts";
import { formatMoney, formatQuantity, formatRate, type Language } from "./money.ts";

/**
 * A report as a printable A4 page (spec §39). Pure, so each client turns the report it was allowed to read into the
 * same document: desktop saves it as PDF, mobile hands it to the system print dialog (which also saves PDF).
 */

/**
 * Labels the document needs, already in the device language; business names stay as stored. `uncostedLines` and
 * `uncostedProducts` follow a count ("3 lines without a cost"); `truncated` is shown when a list was cut at the row
 * limit (totals above it stay exact).
 */
export const REPORT_DOCUMENT_LABELS = [
  "name", "count", "total", "salesTotal", "transactions", "itemsSold", "revenue", "grossProfit", "expenses", "netResult",
  "customerDebt", "supplierDebt", "lowStock", "uncostedLines", "uncostedProducts", "purchasesTotal", "deliveries", "noSupplier", "uncategorized",
  "account", "moneyIn", "moneyOut", "net", "closing", "stockValue", "stock", "unitCost", "value", "negativeStock",
  "taxRate", "taxGross", "taxAmount", "taxNet", "taxNote", "noData", "truncated",
] as const;
/** One wording per {@link REPORT_DOCUMENT_LABELS} entry. */
export type ReportDocumentLabels = Readonly<Record<typeof REPORT_DOCUMENT_LABELS[number], string>>;

/** What surrounds the figures: who, which report, which period, when it was produced. */
export interface ReportDocumentText {
  readonly language: Language;
  readonly shop: string;
  readonly title: string;
  /** The period line ("1–19 Oct 2026"), or the "as of" line for a snapshot report. */
  readonly period: string;
  /** "Printed on 19/10/2026 14:03 by Awa". */
  readonly generated: string;
  /** The closing credit line. */
  readonly credit: string;
  readonly labels: ReportDocumentLabels;
}

/** One table cell: its text, whether it is a figure (right-aligned) and whether it is below zero. */
export interface ReportCell { readonly text: string; readonly numeric?: boolean; readonly negative?: boolean }
/** A table's headings and rows. */
export interface ReportTable { readonly columns: readonly ReportCell[]; readonly rows: readonly (readonly ReportCell[])[] }
/** The figures of a report, ready for any layout: headline tiles, notes and at most one table. */
export interface ReportSheet {
  readonly tiles: readonly (readonly [string, string, boolean?])[];
  readonly notes: readonly string[];
  readonly table?: ReportTable;
  /** Shown when the table would be empty. */
  readonly empty?: string;
  readonly truncated: boolean;
}

/** Every line of a grouped report (by product, category, account, user, party). */
function lineTable(lines: readonly ReportLine[], labels: ReportDocumentLabels, count: string, blank: string, money: (minor: number) => string): ReportTable {
  return { columns: [{ text: labels.name }, { text: count, numeric: true }, { text: labels.total, numeric: true }],
    rows: lines.map(line => [{ text: line.label || blank }, { text: String(line.count), numeric: true }, { text: money(line.totalMinor), numeric: true, negative: line.totalMinor < 0 }]) };
}

/** The figures of a report under the client's labels; nothing here reads the database. */
export function reportSheet(value: ReportResult, labels: ReportDocumentLabels, language: Language): ReportSheet {
  const money = (minor: number): string => formatMoney(minor, language), quantity = (thousandths: number): string => formatQuantity(thousandths, language);
  const figure = (text: string, negative = false): ReportCell => ({ text, numeric: true, negative });
  switch (value.kind) {
    case "dashboard": return { tiles: [[labels.salesTotal, money(value.salesMinor)], [labels.transactions, String(value.transactions)],
      [labels.grossProfit, money(value.grossProfitMinor), value.grossProfitMinor < 0], [labels.expenses, money(value.expensesMinor)],
      [labels.netResult, money(value.netResultMinor), value.netResultMinor < 0], [labels.customerDebt, money(value.customerDebtMinor)],
      [labels.supplierDebt, money(value.supplierDebtMinor)], [labels.lowStock, String(value.lowStock)]],
      notes: value.linesWithoutCost > 0 ? [`${value.linesWithoutCost} ${labels.uncostedLines}`] : [], truncated: false };
    case "sales": return { tiles: [[labels.salesTotal, money(value.totalMinor)], [labels.transactions, String(value.transactions)], [labels.itemsSold, quantity(value.itemsSoldThousandths)]], notes: [], truncated: false };
    case "salesByProduct": case "salesByCategory": case "salesByAccount": case "salesByUser": case "customerDebt": case "supplierDebt":
      return { tiles: [], notes: [], table: lineTable(value.lines, labels, labels.count, labels.uncategorized, money), empty: labels.noData, truncated: value.truncated };
    case "purchases": return { tiles: [[labels.purchasesTotal, money(value.totalMinor)], [labels.deliveries, String(value.deliveries)]], notes: [],
      table: lineTable(value.bySupplier.map(line => line.key === "" ? { ...line, label: labels.noSupplier } : line), labels, labels.deliveries, labels.noSupplier, money), empty: labels.noData, truncated: value.truncated };
    case "cashFlow": return { tiles: [], notes: [], empty: labels.noData, truncated: false, table: {
      columns: [{ text: labels.account }, { text: labels.moneyIn, numeric: true }, { text: labels.moneyOut, numeric: true }, { text: labels.net, numeric: true }, { text: labels.closing, numeric: true }],
      rows: value.accounts.map(row => [{ text: row.name }, figure(money(row.inMinor)), figure(money(row.outMinor)), figure(money(row.netMinor), row.netMinor < 0), figure(money(row.closingMinor), row.closingMinor < 0)]) } };
    case "valuation": return { tiles: [[labels.stockValue, money(value.totalMinor)]], notes: value.uncosted > 0 ? [`${value.uncosted} ${labels.uncostedProducts}`] : [], empty: labels.noData, truncated: value.truncated, table: {
      columns: [{ text: labels.name }, { text: labels.stock, numeric: true }, { text: labels.unitCost, numeric: true }, { text: labels.value, numeric: true }],
      rows: value.products.map(row => [{ text: row.name }, figure(quantity(row.onHandThousandths), row.onHandThousandths < 0),
        figure(row.unitCostMinor === undefined ? "—" : money(row.unitCostMinor)), figure(row.valueMinor === undefined ? "—" : money(row.valueMinor), (row.valueMinor ?? 0) < 0)]) } };
    case "fastMoving": return { tiles: [], notes: [], empty: labels.noData, truncated: false, table: {
      columns: [{ text: labels.name }, { text: labels.itemsSold, numeric: true }, { text: labels.revenue, numeric: true }, { text: labels.stock, numeric: true }],
      rows: value.products.map(row => [{ text: row.name }, figure(quantity(row.soldThousandths)), figure(money(row.revenueMinor)), figure(quantity(row.onHandThousandths), row.onHandThousandths < 0)]) } };
    case "stockAlerts": return { tiles: [], notes: [], empty: labels.noData, truncated: value.truncated, table: {
      columns: [{ text: labels.name }, { text: labels.stock, numeric: true }],
      rows: value.products.map(row => [{ text: row.onHandThousandths < 0 ? `${row.name} · ${labels.negativeStock}` : row.name }, figure(quantity(row.onHandThousandths), row.onHandThousandths < 0)]) } };
    case "tax": return { tiles: [[labels.taxGross, money(value.grossMinor)], [`${labels.taxAmount} · ${value.label}`, money(value.taxMinor)], [labels.taxNet, money(value.netMinor)]],
      notes: [labels.taxNote], empty: labels.noData, truncated: false, table: {
        columns: [{ text: labels.taxRate }, { text: labels.taxGross, numeric: true }, { text: labels.taxAmount, numeric: true }, { text: labels.taxNet, numeric: true }],
        rows: value.groups.map(row => [{ text: formatRate(row.rateBasisPoints, language) }, figure(money(row.grossMinor), row.grossMinor < 0), figure(money(row.taxMinor)), figure(money(row.netMinor))]) } };
  }
}

const escape = (text: string): string => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);

/**
 * The report as a self-contained A4 HTML page: no script, no external resource, every value escaped. Table headings
 * repeat on each printed page and rows never split across pages.
 */
export function reportHtml(value: ReportResult, text: ReportDocumentText): string {
  const sheet = reportSheet(value, text.labels, text.language);
  const cell = (tag: "th" | "td", item: ReportCell): string => `<${tag}${item.numeric === true || item.negative === true ? ` class="${[item.numeric === true ? "num" : "", item.negative === true ? "neg" : ""].join(" ").trim()}"` : ""}>${escape(item.text)}</${tag}>`;
  const tiles = sheet.tiles.length === 0 ? "" : `<div class="tiles">${sheet.tiles.map(([label, figure, negative]) => `<div class="tile"><span>${escape(label)}</span><strong${negative === true ? ` class="neg"` : ""}>${escape(figure)}</strong></div>`).join("")}</div>`;
  const table = sheet.table === undefined ? "" : sheet.table.rows.length === 0 ? `<p class="empty">${escape(sheet.empty ?? text.labels.noData)}</p>`
    : `<table><thead><tr>${sheet.table.columns.map(column => cell("th", column)).join("")}</tr></thead><tbody>${sheet.table.rows.map(row => `<tr>${row.map(item => cell("td", item)).join("")}</tr>`).join("")}</tbody></table>`;
  return `<!doctype html><html lang="${text.language}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(`${text.shop} · ${text.title}`)}</title><style>
@page{size:A4;margin:16mm 14mm}*{box-sizing:border-box}body{font-family:"Helvetica Neue",Arial,sans-serif;font-size:10pt;color:#142b21;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
header{border-bottom:2px solid #142b21;padding-bottom:4mm;margin-bottom:6mm}.shop{font-size:9pt;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:0}
h1{font-size:18pt;margin:1.5mm 0 1mm}.meta{margin:0;color:#4a5d53;font-size:9pt}
.tiles{display:flex;flex-wrap:wrap;gap:3mm;margin-bottom:6mm}.tile{flex:1 1 40mm;border:1px solid #c9d3cd;border-radius:2mm;padding:3mm}
.tile span{display:block;font-size:8.5pt;color:#4a5d53}.tile strong{display:block;font-size:13pt;margin-top:1mm;font-variant-numeric:tabular-nums}
.notes p{margin:0 0 2mm;font-size:9pt;color:#4a5d53}table{width:100%;border-collapse:collapse;margin-top:2mm}thead{display:table-header-group}
th{text-align:left;font-size:8.5pt;text-transform:uppercase;letter-spacing:.04em;color:#4a5d53;border-bottom:1px solid #142b21;padding:2mm 2.5mm}
td{padding:2mm 2.5mm;border-bottom:1px solid #e1e7e3;vertical-align:top;overflow-wrap:anywhere}tr{break-inside:avoid}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.neg{color:#a32a1f}.empty{color:#4a5d53;font-style:italic}
footer{margin-top:8mm;padding-top:3mm;border-top:1px solid #c9d3cd;font-size:8pt;color:#4a5d53;display:flex;justify-content:space-between;gap:6mm}</style></head><body>
<header><p class="shop">${escape(text.shop)}</p><h1>${escape(text.title)}</h1><p class="meta">${escape(text.period)}</p></header>
${tiles}${sheet.notes.length === 0 ? "" : `<div class="notes">${sheet.notes.map(note => `<p>${escape(note)}</p>`).join("")}</div>`}${table}
${sheet.truncated ? `<div class="notes"><p>${escape(text.labels.truncated)}</p></div>` : ""}
<footer><span>${escape(text.generated)}</span><span>${escape(text.credit)}</span></footer></body></html>`;
}
