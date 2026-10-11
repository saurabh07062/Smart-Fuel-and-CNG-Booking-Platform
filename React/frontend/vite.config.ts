import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
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

/**
 * The app in the APK must look right with no network, so its icons and type
 * cannot come from a CDN.
 *
 * On the web those two <link>s are the right call -- cached across sites,
 * served from an edge. Inside the app they are two requests that fail on a
 * phone with no signal, leaving every icon an empty box. This plugin, used
 * only by `--mode native`, copies Font Awesome into the bundle and points
 * index.html at the local copy; the Google Fonts link is dropped and the
 * pages fall back to the device's own faces, which every phone has.
 */
function offlineAssets(): Plugin {
  const faRoot = fileURLToPath(new URL("./node_modules/@fortawesome/fontawesome-free", import.meta.url));
  return {
    name: "fuelmart-offline-assets",
    apply: "build",
    transformIndexHtml(html) {
      return html
        .replace(/\s*<link rel="preconnect"[^>]*>/g, "")
        .replace(/\s*<link[^>]+fonts\.googleapis\.com[^>]*>/g, "")
        .replace(
          /\s*<link[^>]+cdnjs\.cloudflare\.com[^>]+font-awesome[^>]*>/g,
          '\n    <link rel="stylesheet" href="./fontawesome/css/all.min.css" />',
        );
    },
    generateBundle() {
      const copy = (from: string, to: string) => {
        this.emitFile({ type: "asset", fileName: to, source: fs.readFileSync(path.join(faRoot, from)) });
      };
      copy("css/all.min.css", "fontawesome/css/all.min.css");
      for (const file of fs.readdirSync(path.join(faRoot, "webfonts"))) {
        // Only the formats the CSS asks for first; the .ttf fallbacks would
        // double the bundle for browsers that do not exist on Android.
        if (file.endsWith(".woff2")) copy(`webfonts/${file}`, `fontawesome/webfonts/${file}`);
      }
    },
  };
}

/**
 * Three builds, one source tree.
 *
 *   (default)  the website, served from /
 *   customer   the customer-only build the backend serves at /app
 *   native     the same customer app, but BUNDLED INSIDE the Android APK
 *
 * The native build exists because a WebView pointed at a server cannot open
 * without that server: no Wi-Fi, no app. Bundled, the app starts from files
 * on the phone and only the data needs the network. Its pages are loaded
 * from a file:// style origin, so the asset paths must be relative ("./")
 * and the router runs on the hash (src/main.tsx).
 */
export default defineConfig(({ mode }) => ({
  base: mode === "native" ? "./" : mode === "customer" ? "/app/" : "/",
  plugins: [react(), ...(mode === "native" ? [offlineAssets()] : [])],
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
  // "hidden": maps are written for debugging but not referenced by the served
  // files, so the original source is not published with the app.
  build: {
    outDir: mode === "native" ? "dist-native" : mode === "customer" ? "dist-customer" : "dist",
    sourcemap: "hidden",
  },
}));
