import { invoke } from "@tauri-apps/api/core";
import { detectPlatform } from "../../platform";
import { DesktopAuth } from "./desktop-auth";
import { loadGoogleSettings } from "./settings";
import type { DriveAuth } from "./types";
import { loadGoogleIdentityServices, WebAuth } from "./web-auth";

export * from "./types";
export { loadGoogleSettings, saveGoogleSettings } from "./settings";
export { DesktopAuth } from "./desktop-auth";
export { WebAuth } from "./web-auth";

/** The sign-in flow that fits where the app is running. */
export function createAuth(): DriveAuth {
  if (detectPlatform() === "desktop") {
    return new DesktopAuth({
      settings: loadGoogleSettings,
      invoke: (command, args) => invoke(command, args),
      openUrl: async (url) => (await import("@tauri-apps/plugin-opener")).openUrl(url),
      // Tauri's HTTP plugin sends the request from Rust, so the webview's CORS rules do not apply.
      fetch: async (input, init) => (await import("@tauri-apps/plugin-http")).fetch(input, init),
    });
  }
  return new WebAuth({ settings: loadGoogleSettings, loadGis: loadGoogleIdentityServices });
}
