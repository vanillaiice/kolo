import assert from "node:assert/strict";
import { it } from "node:test";
import { AUDIT_GROUPS } from "@kolo/core/application/audit";
import { AUDIT_CSV_COLUMNS } from "@kolo/core/domain/audit-csv";
import { EVENT_PAYLOAD_SCHEMAS } from "@kolo/contracts/events";
import { hasText, text } from "./text.ts";

it("every journal operation, local check, family, status and export column has French and English text", () => {
  const types = [...Object.keys(EVENT_PAYLOAD_SCHEMAS), "STOCK_COUNTED", "CASH_COUNTED", "CASH_RECONCILED", "other"];
  for (const key of [...types.map(type => `j.${type}`), ...AUDIT_GROUPS.map(group => `jg.${group}`), ...["quarantined", "deferred", "unsupported", "stored"].map(status => `jst.${status}`), ...AUDIT_CSV_COLUMNS.map(column => `jc.${column}`)]) {
    assert.ok(hasText(key), key);
    assert.ok(text("fr", key).trim() !== "" && text("en", key).trim() !== "", key);
  }
});
