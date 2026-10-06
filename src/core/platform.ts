/** Where the app is running. The same React bundle ships to all of these. */
export type Platform = "web" | "desktop";

/** Tauri injects `__TAURI_INTERNALS__` into its webview; a plain browser has none. */
export function detectPlatform(): Platform {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? "desktop" : "web";
}
