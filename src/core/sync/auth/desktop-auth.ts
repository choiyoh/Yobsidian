import { AuthRequiredError } from "../engine";
import { DRIVE_SCOPE, type DriveAuth, type GoogleSettings } from "./types";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_KEY = "google-refresh-token";
/** Refresh a little early so a token never expires mid-request. */
const SKEW_MS = 60_000;

export interface DesktopAuthDeps {
  settings: () => GoogleSettings;
  /** Tauri `invoke`: `oauth_listen`, `oauth_wait`, `secret_get/set/delete`. */
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  /** Open a URL in the system browser. */
  openUrl: (url: string) => Promise<void>;
  fetch: typeof fetch;
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
}

/**
 * Google sign-in for the desktop app: OAuth 2.0 authorization-code flow with PKCE and a
 * loopback redirect (RFC 8252). The system browser shows Google's consent page, the Rust side
 * catches the redirect on `http://127.0.0.1:<port>`, and the long-lived refresh token is kept
 * in the OS keychain. Access tokens live only in memory.
 */
export class DesktopAuth implements DriveAuth {
  readonly kind = "desktop" as const;
  readonly fetch: typeof fetch;
  private refreshToken: string | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly deps: DesktopAuthDeps) {
    this.fetch = deps.fetch;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  async ready() {
    this.refreshToken = (await this.deps.invoke<string | null>("secret_get", { key: REFRESH_KEY }).catch(() => null)) ?? null;
  }

  isSignedIn() {
    return this.refreshToken !== null;
  }

  async signIn() {
    const { clientId, clientSecret } = this.deps.settings();
    if (!clientId) throw new Error("Google 클라이언트 ID가 설정되지 않았어요");

    const random = this.deps.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
    const verifier = base64url(random(32));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const state = base64url(random(16));
    const port = await this.deps.invoke<number>("oauth_listen");
    const redirectUri = `http://127.0.0.1:${port}`;

    const url = `${AUTH_URL}?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    })}`;
    const waiting = this.deps.invoke<string>("oauth_wait");
    waiting.catch(() => {}); // surfaced by the await below; avoid an unhandled rejection if opening the browser fails first
    await this.deps.openUrl(url);
    const query = new URLSearchParams(await waiting);

    if (query.get("error")) throw new Error(query.get("error") === "access_denied" ? "Google 로그인이 취소됐어요" : `Google 로그인 오류: ${query.get("error")}`);
    if (query.get("state") !== state) throw new Error("로그인 응답을 확인하지 못했어요. 다시 시도해 주세요");
    const code = query.get("code");
    if (!code) throw new Error("로그인 응답에 코드가 없어요");

    const body = new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri });
    if (clientSecret) body.set("client_secret", clientSecret);
    const tokens = await this.tokenRequest(body);
    if (!tokens.refresh_token) throw new Error("Google이 갱신 토큰을 주지 않았어요. 앱 접근 권한을 취소하고 다시 로그인해 주세요");

    this.refreshToken = tokens.refresh_token;
    this.access = { token: tokens.access_token, expiresAt: this.now() + tokens.expires_in * 1000 };
    await this.deps.invoke("secret_set", { key: REFRESH_KEY, value: tokens.refresh_token });
  }

  async signOut() {
    const token = this.refreshToken;
    this.refreshToken = null;
    this.access = null;
    await this.deps.invoke("secret_delete", { key: REFRESH_KEY }).catch(() => {});
    if (token) await this.deps.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
  }

  async getToken(): Promise<string> {
    if (this.access && this.access.expiresAt - SKEW_MS > this.now()) return this.access.token;
    if (!this.refreshToken) throw new AuthRequiredError();
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  invalidate() {
    this.access = null;
  }

  private async refresh(): Promise<string> {
    const { clientId, clientSecret } = this.deps.settings();
    const body = new URLSearchParams({ client_id: clientId, refresh_token: this.refreshToken!, grant_type: "refresh_token" });
    if (clientSecret) body.set("client_secret", clientSecret);
    try {
      const t = await this.tokenRequest(body);
      this.access = { token: t.access_token, expiresAt: this.now() + t.expires_in * 1000 };
      return t.access_token;
    } catch (e) {
      if (e instanceof TokenError && e.code === "invalid_grant") {
        // Revoked, or a "testing" project's 7-day refresh token expired: sign in again.
        this.refreshToken = null;
        this.access = null;
        await this.deps.invoke("secret_delete", { key: REFRESH_KEY }).catch(() => {});
        throw new AuthRequiredError("Google 로그인이 만료됐어요. 다시 로그인해 주세요");
      }
      throw e;
    }
  }

  private async tokenRequest(body: URLSearchParams): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const res = await this.deps.fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) throw new TokenError(json.error ?? String(res.status), json.error_description);
    return { access_token: json.access_token, expires_in: json.expires_in ?? 3600, refresh_token: json.refresh_token };
  }
}

class TokenError extends Error {
  constructor(
    readonly code: string,
    description?: string,
  ) {
    super(`Google 인증 오류: ${code}${description ? ` (${description})` : ""}`);
  }
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
