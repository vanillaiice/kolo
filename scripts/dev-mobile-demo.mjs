/** Explicit developer-only Expo seed opt-in; normal start never enrolls demo data. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const child = spawn(process.execPath, [require.resolve("expo/bin/cli"), "start", "--dev-client", ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL("../apps/mobile/", import.meta.url)),
  env: { ...process.env, EXPO_PUBLIC_DEMO_SHOP: "1" },
  stdio: "inherit",
});
child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
