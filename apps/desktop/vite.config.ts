import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  base: "./",
  define: { __KOLO_VERSION__: JSON.stringify(version) },
  build: { outDir: "dist/renderer", emptyOutDir: true },
});
