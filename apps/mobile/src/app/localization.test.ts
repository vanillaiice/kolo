import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceError } from "@kolo/core/identity/types";
import { TransferError } from "@kolo/core/backup/types";
import { PERMISSIONS } from "@kolo/core/identity/permissions";
import { AUDIT_GROUPS } from "@kolo/core/application/audit";
import { AUDIT_CSV_COLUMNS } from "@kolo/core/domain/audit-csv";
import { EVENT_PAYLOAD_SCHEMAS } from "@kolo/contracts/events";
import { permissionKeys, strings, translate } from "./strings.ts";
import { mobileStrings } from "./strings-mobile.ts";
import { formStrings } from "./strings-forms.ts";
import { transferErrorKey, workspaceErrorText } from "./identity-errors.ts";

test("French and English messages have matching interpolation fields and all permissions have labels", () => {
  const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort();
  for (const [key, [fr, en]] of Object.entries(strings)) {
    assert.ok(fr.trim() && en.trim(), key);
    assert.deepEqual(placeholders(fr), placeholders(en), key);
  }
  assert.deepEqual(Object.keys(permissionKeys).sort(), [...PERMISSIONS].sort());
  for (const permission of PERMISSIONS) {
    assert.ok(translate("en", permissionKeys[permission]).length > 0, permission);
    assert.ok(translate("fr", permissionKeys[permission]).length > 0, permission);
  }
});

test("interpolated device names, keys and counts are literal and survive changing language", () => {
  const filename = "Boutique {count} $& $` $' .kolo-backup";
  assert.equal(translate("en", "readyFilename", { filename }), `File ready: ${filename}`);
  assert.equal(translate("fr", "readyFilename", { filename }), `Fichier prêt : ${filename}`);
  assert.equal(translate("en", "eventsApplied", { count: 0 }), "0 events applied.");
  assert.equal(translate("en", "keepRecoveryKey", { key: "ABCD-0123" }), "Keep this key safe: ABCD-0123");
});

test("identity failures and retry times follow the selected language without exposing secrets", () => {
  const invalid = new WorkspaceError("invalid_credential");
  assert.equal(workspaceErrorText(invalid, "en"), "Incorrect code or recovery key.");
  assert.equal(workspaceErrorText(invalid, "fr"), "Code ou clé de récupération incorrect.");
  const time = "2026-10-06T12:30:00.000Z";
  const delayed = new WorkspaceError("retry_later", time);
  assert.ok(workspaceErrorText(delayed, "en").includes(new Date(time).toLocaleTimeString("en-GB")));
  assert.ok(workspaceErrorText(delayed, "fr").includes("Réessayez après"));
  assert.equal(workspaceErrorText(new Error("PIN=123456 sqlite failed"), "en"), strings["identity.failedMigration"][1]);
});

test("transfer errors use localized stable codes and hide unknown native errors", () => {
  assert.equal(translate("en", transferErrorKey(new TransferError("authentication_failed"))), "Incorrect password or damaged file.");
  assert.equal(translate("fr", transferErrorKey(new Error("invalid_destination"))), "Choisissez un appareil associé pour cet échange.");
  assert.equal(transferErrorKey(new WorkspaceError("locked")), "transferError.locked");
  assert.equal(transferErrorKey(new Error("native secret path/password")), "transferError.failed");
  assert.equal(transferErrorKey(new Error("constructor")), "transferError.failed");
  assert.equal(transferErrorKey(new Error("__proto__")), "transferError.failed");
});

test("every journal operation, local check, family, status and export column has French and English text", () => {
  const types = [...Object.keys(EVENT_PAYLOAD_SCHEMAS), "STOCK_COUNTED", "CASH_COUNTED", "CASH_RECONCILED", "other"];
  for (const key of [...types.map(type => `j.${type}`), ...AUDIT_GROUPS.map(group => `jg.${group}`), ...["quarantined", "deferred", "unsupported", "stored"].map(status => `jst.${status}`), ...AUDIT_CSV_COLUMNS.map(column => `jc.${column}`)])
    assert.ok(Object.hasOwn(strings, key), key);
});

test("field descriptions are their own keys and never replace another screen's text", () => {
  for (const key of Object.keys(formStrings)) {
    assert.match(key, /^(hint|section)\./, key);
    assert.ok(!Object.hasOwn(mobileStrings, key), key);
  }
  // Descriptions are one or two short sentences under a field, not paragraphs.
  for (const [key, [fr, en]] of Object.entries(formStrings)) assert.ok(fr.length <= 140 && en.length <= 140, key);
  assert.equal(translate("en", "hint.typedConfirm", { text: "Boutique $&" }), "Type exactly “Boutique $&”.");
});
