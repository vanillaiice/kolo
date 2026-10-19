import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT_KINDS } from "@kolo/core/application/report-views";
import { REPORT_DOCUMENT_LABELS, reportHtml } from "@kolo/core/domain/report-document";
import { translate } from "../../app/strings.ts";
import { reportDocumentText } from "./report-output.ts";

test("printed reports have real wording in both languages for every label and report title", () => {
  for (const language of ["fr", "en"] as const) {
    const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]): string => translate(language, key, values);
    for (const kind of REPORT_KINDS) {
      const text = reportDocumentText(t, language, "Boutique Awa", kind, { from: "2026-10-01", to: "2026-10-19" }, new Date(2026, 9, 19, 14, 5));
      assert.ok(text.title.length > 0 && !text.title.startsWith("report."), `${language} ${kind}`);
      for (const key of REPORT_DOCUMENT_LABELS) assert.ok(text.labels[key].trim().length > 0 && !/[{}]/.test(text.labels[key]), `${language} ${key}`);
      assert.doesNotMatch(`${text.period} ${text.generated}`, /[{}]/);
    }
  }
  const fr = reportDocumentText((key, values) => translate("fr", key, values), "fr", "Boutique", "sales", { from: "2026-10-01", to: "2026-10-19" }, new Date(2026, 9, 19, 14, 5));
  assert.equal(fr.period, "Du 1 octobre 2026 au 19 octobre 2026");
  assert.equal(reportDocumentText((key, values) => translate("en", key, values), "en", "Shop", "sales", { from: "2026-10-19", to: "2026-10-19" }).period, "19 October 2026", "one day is written once");
  assert.match(reportDocumentText((key, values) => translate("en", key, values), "en", "Shop", "valuation", undefined).period, /^As of /);
  assert.ok(reportHtml({ kind: "sales", totalMinor: 1_000, transactions: 1, itemsSoldThousandths: 1_000 }, fr).includes("Généré par kolo · made by hblabs"));
});
