/**
 * Build config for the push-capable service worker, `dist/sw-push.js`.
 *
 * Driven by `scripts/build-workers.mjs`, which binds the classic wrapper's
 * core import to the built `sw.js` SHA-256 and writes into the main `dist/`
 * without emptying it. Its IIFE keeps minified wrapper bindings private when
 * the imported classic core declares its own top-level bindings.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const base = process.env.VITE_BASE ?? "/OpenSesame/";
const osDomainBrowser = fileURLToPath(
  new URL("../../packages/os-domain/src/browser.ts", import.meta.url),
);

export default defineConfig({
  base,
  publicDir: false,
  resolve: {
    alias: { "@opensesame/os-domain": osDomainBrowser },
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  esbuild: { target: "es2022" },
  build: {
    target: ["es2022", "chrome100", "firefox100", "safari15"],
    outDir: fileURLToPath(
      new URL(`./${process.env.PAGES_OUT_DIR ?? "dist"}`, import.meta.url),
    ),
    emptyOutDir: false,
    copyPublicDir: false,
    modulePreload: false,
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./src/sw-push.ts", import.meta.url)),
      output: {
        format: "iife",
        entryFileNames: "sw-push.js",
        inlineDynamicImports: true,
      },
    },
  },
});
