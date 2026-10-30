import { defineConfig } from "vite";

// Served by the sync server under /admin/ on its own listener (see apps/server/src/admin/admin-app.ts).
// JSX compiles straight to Preact; no React compatibility layer is bundled.
export default defineConfig({
  base: "/admin/",
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { proxy: { "/admin/api": "http://127.0.0.1:8081" } },
});
