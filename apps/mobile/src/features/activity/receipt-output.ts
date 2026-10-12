import type { Receipt } from "@kolo/core/application/queries";
import { formatMoney, formatQuantity, formatRate } from "@kolo/core/domain/money";
import { lineTotal } from "@kolo/core/rules/pricing";

/** Labels a receipt needs, already in the device language. */
export interface ReceiptLabels {
  readonly receipt: string; readonly customer: string; readonly discount: string; readonly total: string; readonly paid: string; readonly due: string;
  readonly returned: string; readonly date: string; readonly footer: string;
  /** "incl." before each tax line, and the tax-number label printed with the shop's registration (ADR-033). */
  readonly taxIncluded?: string | undefined; readonly taxNumber?: string | undefined;
}
/** One "incl. TVA 19,25 %" line per rate, then the shop's tax number, when the sale carried tax. */
function taxLines(saved: Receipt, labels: ReceiptLabels): { readonly lines: readonly [string, string][]; readonly registration?: string } {
  if (saved.tax === undefined) return { lines: [] };
  const lines = saved.tax.groups.map(group => [`${labels.taxIncluded ?? ""} ${saved.tax!.label} ${formatRate(group.rateBasisPoints)}`.trim(), formatMoney(group.taxMinor)] as [string, string]);
  return saved.tax.registration === undefined ? { lines } : { lines, registration: `${labels.taxNumber ?? ""} ${saved.tax.registration}`.trim() };
}
const escape = (text: string): string => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);

/** Plain-text receipt from saved facts, for the OS share sheet. Business names stay literal. */
export function receiptText(saved: Receipt, shop: string, labels: ReceiptLabels): string {
  return [shop, `${labels.receipt} ${saved.number}`, labels.date, ...(saved.customerName === undefined ? [] : [`${labels.customer}: ${saved.customerName}`]), "",
    ...saved.lines.map(line => `${line.name}\n  ${formatQuantity(line.quantity)} × ${formatMoney(line.unitPriceMinor)} = ${formatMoney(lineTotal(line))}`), "",
    ...(saved.discountMinor > 0 ? [`${labels.discount}: −${formatMoney(saved.discountMinor)}`] : []), `${labels.total}: ${formatMoney(saved.totalMinor)}`,
    ...((tax => [...tax.lines.map(([left, right]) => `${left}: ${right}`), ...(tax.registration === undefined ? [] : [tax.registration])])(taxLines(saved, labels))),
    ...saved.payments.map(payment => `${payment.name}: ${formatMoney(payment.amountMinor)}`),
    ...(saved.outstandingMinor > 0 ? [`${labels.due}: ${formatMoney(saved.outstandingMinor)}`] : []),
    ...(saved.returnedMinor > 0 ? [`${labels.returned}: ${formatMoney(saved.returnedMinor)}`] : []), "", labels.footer].join("\n");
}

/** 72 mm printable receipt from saved facts, for the system print dialog (which also saves PDF). Every value is escaped. */
export function receiptHtml(saved: Receipt, shop: string, labels: ReceiptLabels): string {
  const row = (left: string, right: string, strong = false): string => `<div class="row${strong ? " strong" : ""}"><span>${escape(left)}</span><span>${escape(right)}</span></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:72mm auto;margin:4mm}body{font-family:sans-serif;font-size:11pt;width:64mm;margin:0 auto;color:#000}
h1{font-size:14pt;text-align:center;margin:0 0 2mm}p{margin:1mm 0;text-align:center}.row{display:flex;justify-content:space-between;gap:3mm;margin:1mm 0}
.row span:last-child{white-space:nowrap;font-variant-numeric:tabular-nums}.line{margin:2mm 0}.sub{font-size:9pt;color:#333}.strong{font-weight:700;font-size:13pt}
hr{border:0;border-top:1px dashed #000;margin:3mm 0}</style></head><body>
<h1>${escape(shop)}</h1><p>${escape(`${labels.receipt} ${saved.number}`)}</p><p>${escape(labels.date)}</p>${saved.customerName === undefined ? "" : `<p>${escape(`${labels.customer}: ${saved.customerName}`)}</p>`}<hr>
${saved.lines.map(line => `<div class="line">${row(line.name, formatMoney(lineTotal(line)))}<div class="sub">${escape(`${formatQuantity(line.quantity)} × ${formatMoney(line.unitPriceMinor)}`)}</div></div>`).join("")}<hr>
${saved.discountMinor > 0 ? row(labels.discount, `−${formatMoney(saved.discountMinor)}`) : ""}${row(labels.total, formatMoney(saved.totalMinor), true)}
${((tax) => tax.lines.map(([left, right]) => `<div class="sub">${row(left, right)}</div>`).join("") + (tax.registration === undefined ? "" : `<p class="sub">${escape(tax.registration)}</p>`))(taxLines(saved, labels))}
${saved.payments.map(payment => row(payment.name, formatMoney(payment.amountMinor))).join("")}${saved.outstandingMinor > 0 ? row(labels.due, formatMoney(saved.outstandingMinor)) : ""}
${saved.returnedMinor > 0 ? row(labels.returned, formatMoney(saved.returnedMinor)) : ""}<hr><p class="sub">${escape(labels.footer)}</p></body></html>`;
}
