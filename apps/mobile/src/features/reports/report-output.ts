import type { ReportKind } from "@kolo/core/application/report-views";
import type { ReportDocumentText } from "@kolo/core/domain/report-document";
import type { Language } from "@kolo/core/domain/money";
import type { TextKey, TextValues } from "../../app/strings.ts";

/** The same locales as `app/i18n` `localeOf`; this module stays free of React so it can be tested in Node. */
const localeOf = (language: Language): string => language === "fr" ? "fr-FR" : "en-GB";

/** A local YYYY-MM-DD day in words ("19 octobre 2026"). */
function longDay(value: string, language: Language): string {
  const [year = 1970, month = 1, day = 1] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(localeOf(language), { day: "numeric", month: "long", year: "numeric" }).format(new Date(year, month - 1, day));
}

/**
 * The wording around a printed report, in the device language: its title, the period (or "as of" for snapshot
 * reports, which pass no days), the print time and the credit. Figures come from core `reportHtml`.
 */
export function reportDocumentText(t: (key: TextKey, values?: TextValues) => string, language: Language, shop: string, kind: ReportKind, days: { readonly from: string; readonly to: string } | undefined, now = new Date()): ReportDocumentText {
  const stamp = new Intl.DateTimeFormat(localeOf(language), { dateStyle: "long", timeStyle: "short" }).format(now);
  return { language, shop, title: t(`report.${kind}` as TextKey), credit: t("receiptFooter"), generated: t("pdf.printed", { date: stamp }),
    period: days === undefined ? t("pdf.asOf", { date: stamp }) : days.from === days.to ? longDay(days.from, language) : t("pdf.period", { from: longDay(days.from, language), to: longDay(days.to, language) }),
    labels: { name: t("name"), count: t("pdf.count"), total: t("total"), salesTotal: t("revenue"), transactions: t("transactions"), itemsSold: t("itemsSold"), revenue: t("revenue"),
      grossProfit: t("profit"), expenses: t("expenses"), netResult: t("net"), customerDebt: t("customerDebt"), supplierDebt: t("supplierDebt"), lowStock: t("lowStock"),
      uncostedLines: t("pdf.uncostedLines"), uncostedProducts: t("pdf.uncostedProducts"), purchasesTotal: t("purchasesTotal"), deliveries: t("deliveries"), noSupplier: t("noSupplier"),
      uncategorized: t("uncategorized"), account: t("account"), moneyIn: t("moneyIn"), moneyOut: t("moneyOut"), net: t("netFlow"), closing: t("closingBalance"), stockValue: t("stockValue"),
      stock: t("stock"), unitCost: t("pdf.unitCost"), value: t("pdf.value"), negativeStock: t("negativeStock"), taxRate: t("pdf.taxRate"), taxGross: t("taxGross"), taxAmount: t("taxAmount"),
      taxNet: t("taxNet"), taxNote: t("taxReportHelp"), noData: t("pdf.noData"), truncated: t("pdf.truncated") } };
}
