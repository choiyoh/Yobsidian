import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Tauri sets TAURI_ENV_PLATFORM while running `tauri dev` / `tauri build`.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

/**
 * Emits `sw.js` after the build with the list of every built file, so the installed web app
 * opens offline. The cache name carries a hash of that list: a new deploy gets a new cache and
 * the old one is deleted on activate. Only same-origin GETs are handled; Google API calls pass through.
 */
function offlineServiceWorker(): Plugin {
  return {
    name: "yobsidian-sw",
    apply: "build",
    generateBundle(_, bundle) {
      const files = ["./", ...Object.keys(bundle), "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];
      const version = createHash("sha256").update(files.join("\n")).update(Object.values(bundle).map((b) => ("code" in b ? b.code : String(b.source))).join("")).digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `const CACHE = "yobsidian-${version}";
const FILES = ${JSON.stringify(files)};
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === "navigate") return caches.match("./").then((r) => r || fetch(req));
      return fetch(req);
    }),
  );
});
`,
      });
    },
  };
}

export default defineConfig({
  // Relative asset URLs: the same build works at a domain root (Cloudflare Pages) and under
  // /<repo>/ (GitHub Pages), and inside the desktop webview.
  base: "./",
  plugins: [react(), offlineServiceWorker()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Tauri expects a fixed port and must see Rust errors in the terminal.
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    outDir: "dist",
    // Desktop webviews: WebView2 (Windows) is Chromium, WKWebView (macOS) is Safari.
    target: isTauri
      ? process.env.TAURI_ENV_PLATFORM === "windows"
        ? "chrome105"
        : "safari15"
      : "es2022",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
