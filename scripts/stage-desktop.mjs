/** Create a self-contained production app; workspace symlinks must never reach installers. */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const destination = join(root, ".packaging/desktop");
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8"));
delete manifest.devDependencies;
delete manifest.scripts;
writeFileSync(join(destination, "package.json"), JSON.stringify(manifest, null, 2));
cpSync(join(root, "apps/desktop/dist"), join(destination, "dist"), { recursive: true });
const installed = new Set();
function copyDependency(name, parent) {
  if (installed.has(name)) return;
  const require = createRequire(join(parent, "package.json"));
  let source = name === "@kolo/core" ? join(root, "packages/core") : name === "@kolo/contracts" ? join(root, "packages/contracts") : dirname(realpathSync(require.resolve(name)));
  while (!existsSync(join(source, "package.json")) || JSON.parse(readFileSync(join(source, "package.json"), "utf8")).name !== name) {
    const next = dirname(source);
    if (next === source) throw new Error(`Cannot find production dependency ${name}`);
    source = next;
  }
  const dependency = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const target = join(destination, "node_modules", name);
  mkdirSync(target, { recursive: true });
  if (name.startsWith("@kolo/")) {
    cpSync(join(source, "dist"), join(target, "dist"), { recursive: true });
    delete dependency.devDependencies;
    delete dependency.scripts;
    writeFileSync(join(target, "package.json"), JSON.stringify(dependency, null, 2));
  } else cpSync(source, target, { recursive: true, dereference: true, filter: path => !path.includes(`${join(source, "node_modules")}`) });
  installed.add(name);
  for (const child of Object.keys(dependency.dependencies ?? {})) copyDependency(child, source);
}
for (const name of Object.keys(manifest.dependencies)) copyDependency(name, join(root, "apps/desktop"));
process.stdout.write(`Staged desktop with ${installed.size} production packages\n`);
