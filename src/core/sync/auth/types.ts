import type { TokenSource } from "../drive-client";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export interface GoogleSettings {
  /** OAuth client id from the user's own Google Cloud project (see docs/GOOGLE_SETUP.md). */
  clientId: string;
  /** Desktop clients need the "client secret" Google shows next to the id. It is not secret for installed apps. */
  clientSecret: string;
}

/** Signs in to Google and hands out access tokens. One implementation per platform. */
export interface DriveAuth extends TokenSource {
  readonly kind: "web" | "desktop";
  /** `fetch` to use for Google calls (the desktop webview goes through Tauri's HTTP plugin to avoid CORS). */
  readonly fetch: typeof fetch;
  /** Load whatever was remembered from last time. Call once before `isSignedIn`. */
  ready(): Promise<void>;
  isSignedIn(): boolean;
  /**
   * Interactive sign-in (opens a popup / the system browser). In the browser this must run
   * inside a click or key handler or the popup is blocked.
   */
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}
