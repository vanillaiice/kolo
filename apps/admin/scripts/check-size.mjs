/** Fails the build when the dashboard's JavaScript outgrows its budget (gzip): it must stay fast on a slow link. */
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_BUDGET = 40 * 1024, TOTAL_BUDGET = 80 * 1024;
const dir = fileURLToPath(new URL("../dist/assets/", import.meta.url));
const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const entry = /src="\/admin\/assets\/([^"]+\.js)"/.exec(html)?.[1];
if (entry === undefined) { console.error("check-size: no entry script in dist/index.html"); process.exit(1); }
const sizes = readdirSync(dir).filter(name => name.endsWith(".js")).map(name => ({ name, gzip: gzipSync(readFileSync(join(dir, name))).length }));
const total = sizes.reduce((sum, file) => sum + file.gzip, 0), first = sizes.find(file => file.name === entry).gzip;
const kib = bytes => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(`dashboard JS (gzip): entry ${kib(first)} / ${kib(ENTRY_BUDGET)}, all ${kib(total)} / ${kib(TOTAL_BUDGET)} in ${sizes.length} files`);
if (first > ENTRY_BUDGET || total > TOTAL_BUDGET) { console.error("check-size: over budget"); process.exit(1); }
