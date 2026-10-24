import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formText } from "./text-forms.ts";

test("field descriptions are short, in both languages, and never replace other screen text", () => {
  const base = readFileSync(new URL("./text.ts", import.meta.url), "utf8");
  for (const [key, [fr, en]] of Object.entries(formText)) {
    assert.match(key, /^hint\./, key);
    assert.ok(fr.trim() !== "" && en.trim() !== "" && fr.length <= 150 && en.length <= 150, key);
    assert.ok(!base.includes(`"${key}":`) && !base.includes(` ${key}:`), `${key} is defined only once`);
  }
});
