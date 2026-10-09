import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceError } from "@kolo/core/identity/types";
import { TransferError } from "@kolo/core/backup/types";
import { PERMISSIONS } from "@kolo/core/identity/permissions";
import { permissionKeys, strings, translate } from "./strings.ts";
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
  const filename = "Boutique {count} $& $` $' .kolo-backup.json";
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
