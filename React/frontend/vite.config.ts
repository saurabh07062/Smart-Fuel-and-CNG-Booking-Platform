import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

/**
 * Dev server on 3001 so it can run ALONGSIDE the existing Vanilla frontend on
 * 3000. Both talk to the same backend on 5000, which is what makes this
 * migration reversible: at any point you can compare the two side by side.
 */
// The backend the dev proxy talks to. FUELMART_API_TARGET points a second dev
// server at the test API (backend test/helpers/testServer.js on 5055, database
// fuelmart_test) -- scripts/devTestDb.mjs -- so the full flow can be clicked
// through without touching real data.
const API_TARGET = process.env.FUELMART_API_TARGET || "http://localhost:5000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The "@/..." alias must be declared HERE as well as in tsconfig.json.
    // tsconfig only teaches the type-checker; Rollup resolves imports at
    // build time and knows nothing about it -- so `tsc --noEmit` passed
    // while `vite build` failed to resolve the very same import.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 3001,
    strictPort: true,
    proxy: {
      // Same-origin in dev, so no CORS preflight and cookies/headers behave
      // exactly as they will behind a reverse proxy in production.
      "/api": { target: API_TARGET, changeOrigin: true },
      "/uploads": { target: API_TARGET, changeOrigin: true },
      "/socket.io": { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
