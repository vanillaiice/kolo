import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/** Every .tsx file under src. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(directory, entry.name))
    : entry.name.endsWith(".tsx") ? [join(directory, entry.name)] : []);
}

test("every Text takes a theme colour, so nothing renders black on the dark background", () => {
  const problems: string[] = [];
  for (const file of sources(join(import.meta.dirname, ".."))) {
    for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
      for (const match of line.matchAll(/<Text\b([^>]*)>/g)) {
        const attributes = match[1] ?? "";
        // A palette style (s.*) or an explicit colour; a bare <Text> or layout-only style falls back to black.
        if (!/style=\{(?:\[?\s*)?s\.|color/.test(attributes)) problems.push(`${file}:${index + 1}: ${match[0].slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
