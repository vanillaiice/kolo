/** Keep platform SDKs out of shared code and Node-only adapters out of renderers. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(join(directory, entry.name)) : /\.(ts|tsx|cts)$/.test(entry.name) ? [join(directory, entry.name)] : []);
}
let errors = 0;
for (const root of ["packages/core/src", "packages/contracts/src", "apps/mobile/src", "apps/desktop/src/renderer", "apps/desktop/src/shared", "apps/server/src"]) {
  for (const nativePath of walk(root)) {
    const path = nativePath.replaceAll("\\", "/");
    if (path.endsWith(".test.ts")) continue;
    const source = readFileSync(path, "utf8");
    const imports = [...source.matchAll(/(?:from\s+|import\s*\(|import\s+)["']([^"']+)["']/g)].map(match => match[1]);
    for (const specifier of imports) {
      let invalid = false;
      if (path.startsWith("packages/")) invalid ||= /^(expo|react|electron|fastify|@fastify)/.test(specifier) || specifier.includes("/apps/");
      if (path.startsWith("packages/contracts/")) invalid ||= /^(node:|@kolo\/core)/.test(specifier);
      if (path.startsWith("packages/core/")) invalid ||= specifier.startsWith("node:") && !path.endsWith("/database/node-sqlite.ts");
      if (path.startsWith("apps/mobile/") || path.startsWith("apps/desktop/src/renderer/") || path.startsWith("apps/desktop/src/shared/")) invalid ||= /^(node:|electron)/.test(specifier) || specifier.includes("database/node-sqlite");
      if (path.startsWith("apps/server/")) invalid ||= specifier.startsWith("@kolo/core/data/");
      if (path.startsWith("apps/")) invalid ||= (specifier.includes("@kolo/core/identity/internal-authority") || specifier.includes("@kolo/core/data/exchange/") || specifier.includes("@kolo/core/exchange/internal-") || specifier.includes("@kolo/core/backup/internal-"));
      if (specifier.includes("packages/") || specifier.includes("apps/")) invalid = true;
      if (invalid) { process.stderr.write(`${path}: forbidden dependency ${specifier}\n`); errors++; }
    }
  }
}
if (errors > 0) process.exit(1);
process.stdout.write("Workspace dependency boundaries passed\n");
