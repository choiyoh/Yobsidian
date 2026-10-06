import type { GoogleSettings } from "./types";

const KEY = "yobsidian.google";

/**
 * The OAuth client the user created. Build-time env vars (`VITE_GOOGLE_CLIENT_ID`,
 * `VITE_GOOGLE_CLIENT_SECRET`) are the defaults; values entered in the app override them.
 */
export function loadGoogleSettings(): GoogleSettings {
  const env = import.meta.env as Record<string, string | undefined>;
  const base = { clientId: env.VITE_GOOGLE_CLIENT_ID ?? "", clientSecret: env.VITE_GOOGLE_CLIENT_SECRET ?? "" };
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
