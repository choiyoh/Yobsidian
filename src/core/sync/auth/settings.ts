import { detectPlatform } from "../../platform";
import type { GoogleSettings } from "./types";

const KEY = "yobsidian.google";

/** The project's own OAuth client. Client IDs are public, so it is safe to ship in the bundle. */
export const DEFAULT_GOOGLE_CLIENT_ID = "969756012265-0sjv7sgvua9rlu5h4sd5c2jaa13vhjf5.apps.googleusercontent.com";

/** The desktop-app type client for the Tauri build (public too; its secret is NOT in the repo, see docs/GOOGLE_SETUP.md). */
export const DEFAULT_DESKTOP_GOOGLE_CLIENT_ID = "969756012265-l5692vjd5v6sh0ni3d5t1ojgqpttjsus.apps.googleusercontent.com";

/**
 * The OAuth client the user created. Values entered in the app win, then the build-time env vars
 * (`VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_CLIENT_SECRET`), then the built-in default client ID for the platform (web or desktop).
 * `||` (not `??`) because CI passes an unset repository variable as an empty string.
 */
export function loadGoogleSettings(): GoogleSettings {
  const env = import.meta.env as Record<string, string | undefined>;
  const base = { clientId: env.VITE_GOOGLE_CLIENT_ID?.trim() || (detectPlatform() === "desktop" ? DEFAULT_DESKTOP_GOOGLE_CLIENT_ID : DEFAULT_GOOGLE_CLIENT_ID), clientSecret: env.VITE_GOOGLE_CLIENT_SECRET?.trim() || "" };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<GoogleSettings>;
    return { clientId: saved.clientId?.trim() || base.clientId, clientSecret: saved.clientSecret?.trim() || base.clientSecret };
  } catch {
    return base;
  }
}

export function saveGoogleSettings(settings: GoogleSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ clientId: settings.clientId.trim(), clientSecret: settings.clientSecret.trim() }));
  } catch {
    // storage unavailable: the settings last for this session only
  }
}
