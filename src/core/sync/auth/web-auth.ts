import { AuthRequiredError } from "../engine";
import { DRIVE_SCOPE, type DriveAuth, type GoogleSettings } from "./types";

/** The parts of Google Identity Services (https://accounts.google.com/gsi/client) we use. */
export interface GisApi {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: { access_token?: string; expires_in?: number | string; error?: string; error_description?: string }) => void;
        error_callback?: (error: { type: string; message?: string }) => void;
      }): { requestAccessToken(overrides?: { prompt?: string }): void };
      revoke(token: string, done?: () => void): void;
    };
  };
}

export interface WebAuthDeps {
  settings: () => GoogleSettings;
  loadGis: () => Promise<GisApi>;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  now?: () => number;
}

const STORE_KEY = "yobsidian.google.web";
const SKEW_MS = 60_000;

/**
 * Google sign-in for the browser, with Google Identity Services' token client. It yields a
 * one-hour access token and no refresh token (that needs a server), so after an hour the next
 * click or keypress quietly asks Google for a new one; if Google needs the user, a popup opens.
 */
export class WebAuth implements DriveAuth {
  readonly kind = "web" as const;
  readonly fetch: typeof fetch = (input, init) => fetch(input, init);
  private token: { value: string; expiresAt: number } | null = null;
  private signedIn = false;

  constructor(private readonly deps: WebAuthDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private get storage() {
    return this.deps.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  }

  async ready() {
    try {
      const saved = JSON.parse(this.storage?.getItem(STORE_KEY) ?? "null") as { token?: string; expiresAt?: number; signedIn?: boolean } | null;
      this.signedIn = !!saved?.signedIn;
      if (saved?.token && saved.expiresAt) this.token = { value: saved.token, expiresAt: saved.expiresAt };
    } catch {
      // unreadable: treat as signed out
    }
  }

  /** True once the user has signed in on this browser, even if the hour-long token has lapsed. */
  isSignedIn() {
    return this.signedIn;
  }

  hasValidToken() {
    return !!this.token && this.token.expiresAt - SKEW_MS > this.now();
  }

  async signIn(): Promise<void> {
    const { clientId } = this.deps.settings();
    if (!clientId) throw new Error("Google 클라이언트 ID가 설정되지 않았어요");
    // Load the script first; the click's popup permission lasts long enough for a cached script.
    const gis = await this.deps.loadGis();
    const response = await new Promise<{ access_token?: string; expires_in?: number | string; error?: string; error_description?: string }>((resolve, reject) => {
      const client = gis.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: resolve,
        error_callback: (e) => reject(new Error(e.type === "popup_closed" ? "Google 로그인이 취소됐어요" : e.type === "popup_failed_to_open" ? "팝업이 막혔어요. 팝업을 허용해 주세요" : `Google 로그인 오류: ${e.type}`)),
      });
      client.requestAccessToken({ prompt: "" });
    });
    if (response.error || !response.access_token) throw new Error(`Google 로그인 오류: ${response.error ?? "토큰 없음"}`);
    this.token = { value: response.access_token, expiresAt: this.now() + Number(response.expires_in ?? 3600) * 1000 };
    this.signedIn = true;
    this.persist();
  }

  async signOut() {
    const token = this.token?.value;
    this.token = null;
    this.signedIn = false;
    try {
      this.storage?.removeItem(STORE_KEY);
    } catch {
      // ignore
    }
    if (token) {
      const gis = await this.deps.loadGis().catch(() => null);
      gis?.accounts.oauth2.revoke(token);
    }
  }

  async getToken(): Promise<string> {
    if (this.token && this.hasValidToken()) return this.token.value;
    throw new AuthRequiredError(this.signedIn ? "Google 로그인이 만료됐어요. 아무 곳이나 한 번 누르면 다시 연결해요" : undefined);
  }

  invalidate() {
    this.token = null;
    this.persist();
  }

  private persist() {
    try {
      this.storage?.setItem(STORE_KEY, JSON.stringify({ signedIn: this.signedIn, token: this.token?.value, expiresAt: this.token?.expiresAt }));
    } catch {
      // storage unavailable: the token lasts for this page load only
    }
  }
}

let gisPromise: Promise<GisApi> | null = null;

/** Load Google's sign-in script once. */
export function loadGoogleIdentityServices(): Promise<GisApi> {
  gisPromise ??= new Promise<GisApi>((resolve, reject) => {
    const existing = (window as unknown as { google?: GisApi }).google;
    if (existing?.accounts?.oauth2) return resolve(existing);
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve((window as unknown as { google: GisApi }).google);
    script.onerror = () => {
      gisPromise = null;
      reject(new Error("Google 로그인 스크립트를 불러오지 못했어요. 인터넷 연결을 확인해 주세요"));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}
