import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(join(directory, entry.name)) : entry.name.endsWith(".md") ? [join(directory, entry.name)] : []);
}
let errors = 0;
const files = ["README.md", "CLAUDE.md", ...walk("docs").filter(path => !path.startsWith("docs/history/"))];
for (const path of files) {
  for (const match of readFileSync(path, "utf8").matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const link = match[1].split("#")[0];
    if (!link || /^https?:|^mailto:/.test(link)) continue;
    if (!existsSync(resolve(dirname(path), link))) { process.stderr.write(`${path}: missing link target ${link}\n`); errors++; }
  }
}
if (errors > 0) process.exit(1);
process.stdout.write("Documentation links passed\n");
