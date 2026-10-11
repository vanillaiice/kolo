import { defineConfig } from "vite";

// Served by the sync server under /admin/ on its own listener (see apps/server/src/admin/admin-app.ts).
export default defineConfig({
  base: "/admin/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/admin/api": "http://127.0.0.1:8081" } },
});
