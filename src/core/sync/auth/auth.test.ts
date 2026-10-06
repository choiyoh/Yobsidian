import { describe, expect, it } from "vitest";
import { AuthRequiredError } from "../engine";
import { DesktopAuth } from "./desktop-auth";
import { WebAuth, type GisApi } from "./web-auth";

const settings = () => ({ clientId: "cid.apps.googleusercontent.com", clientSecret: "shh" });

function desktop(over: { tokenResponses?: Response[]; callback?: (authUrl: URL, port: number) => string } = {}) {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  const requests: { url: string; body: URLSearchParams }[] = [];
  const responses = [...(over.tokenResponses ?? [])];
  let clock = 1_000_000;
  let opened: URL | null = null;
  let resolveQuery!: (q: string) => void;
  const auth = new DesktopAuth({
    settings,
    now: () => clock,
    randomBytes: (n) => new Uint8Array(n).map((_, i) => i + 1),
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      switch (command) {
        case "oauth_listen":
          return 4321 as T;
        case "oauth_wait":
          return new Promise<string>((r) => (resolveQuery = r)) as T;
        case "secret_get":
          return (secrets.get(args!.key as string) ?? null) as T;
        case "secret_set":
          secrets.set(args!.key as string, args!.value as string);
          return undefined as T;
        default:
          secrets.delete(args!.key as string);
          return undefined as T;
      }
    },
    openUrl: async (url) => {
      opened = new URL(url);
      resolveQuery(over.callback ? over.callback(opened, 4321) : `code=THE_CODE&state=${opened.searchParams.get("state")}`);
    },
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
      return responses.shift() ?? new Response("{}", { status: 400 });
    },
  });
  return { auth, secrets, calls, requests, advance: (ms: number) => (clock += ms), opened: () => opened };
}

const tokenOk = (extra: object = {}) => new Response(JSON.stringify({ access_token: "ACCESS", expires_in: 3600, refresh_token: "REFRESH", ...extra }), { status: 200 });

describe("DesktopAuth", () => {
  it("signs in with PKCE through the loopback redirect and stores the refresh token in the keychain", async () => {
    const t = desktop({ tokenResponses: [tokenOk()] });
    await t.auth.ready();
    expect(t.auth.isSignedIn()).toBe(false);
    await t.auth.signIn();

    const url = t.opened()!;
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4321");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive");

    const exchange = t.requests[0]!;
    expect(exchange.url).toBe("https://oauth2.googleapis.com/token");
    expect(exchange.body.get("code")).toBe("THE_CODE");
    expect(exchange.body.get("client_secret")).toBe("shh");
    // The verifier sent to Google must hash to the challenge in the auth URL.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.body.get("code_verifier")!)));
    expect(btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).toBe(url.searchParams.get("code_challenge"));

    expect(t.secrets.get("google-refresh-token")).toBe("REFRESH");
    expect(t.auth.isSignedIn()).toBe(true);
    expect(await t.auth.getToken()).toBe("ACCESS");
  });

  it("rejects a redirect with the wrong state, a denied consent, and a missing refresh token", async () => {
    await expect(desktop({ callback: () => "code=X&state=forged" }).auth.signIn()).rejects.toThrow(/확인하지 못했어요/);
    await expect(desktop({ callback: () => "error=access_denied&state=s" }).auth.signIn()).rejects.toThrow(/취소/);
    const t = desktop({ tokenResponses: [tokenOk({ refresh_token: undefined })] });
    await expect(t.auth.signIn()).rejects.toThrow(/갱신 토큰/);
    expect(t.secrets.size).toBe(0);
  });

  it("restores the session from the keychain and refreshes expired access tokens", async () => {
    const t = desktop({ tokenResponses: [new Response(JSON.stringify({ access_token: "A1", expires_in: 3600 })), new Response(JSON.stringify({ access_token: "A2", expires_in: 3600 }))] });
    t.secrets.set("google-refresh-token", "SAVED");
    await t.auth.ready();
    expect(t.auth.isSignedIn()).toBe(true);
    expect(await t.auth.getToken()).toBe("A1");
    expect(t.requests[0]!.body.get("refresh_token")).toBe("SAVED");
    expect(t.requests[0]!.body.get("grant_type")).toBe("refresh_token");
    expect(await t.auth.getToken()).toBe("A1"); // cached
    t.advance(3600_000);
    expect(await t.auth.getToken()).toBe("A2");
    expect(t.requests).toHaveLength(2);
  });

  it("asks for a new sign-in when Google says the refresh token is no longer valid", async () => {
    const t = desktop({ tokenResponses: [new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })] });
    t.secrets.set("google-refresh-token", "OLD");
    await t.auth.ready();
    await expect(t.auth.getToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(t.auth.isSignedIn()).toBe(false);
    expect(t.secrets.has("google-refresh-token")).toBe(false);
  });

  it("signs out: forgets the token and revokes it", async () => {
    const t = desktop({ tokenResponses: [tokenOk(), new Response("{}", { status: 200 })] });
    await t.auth.signIn();
    await t.auth.signOut();
    expect(t.secrets.size).toBe(0);
    expect(t.requests.at(-1)!.url).toContain("/revoke?token=REFRESH");
    await expect(t.auth.getToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("needs a client id", async () => {
    const auth = new DesktopAuth({ settings: () => ({ clientId: "", clientSecret: "" }), invoke: async () => undefined as never, openUrl: async () => {}, fetch });
    await expect(auth.signIn()).rejects.toThrow(/클라이언트 ID/);
  });
});

function web() {
  const store = new Map<string, string>();
  let clock = 5_000;
  let behavior: "ok" | "blocked" = "ok";
  const requested: (string | undefined)[] = [];
  const gis: GisApi = {
    accounts: {
      oauth2: {
        initTokenClient: ({ callback, error_callback }) => ({
          requestAccessToken: (o) => {
            requested.push(o?.prompt);
            if (behavior === "blocked") error_callback?.({ type: "popup_failed_to_open" });
            else callback({ access_token: "WEB_TOKEN", expires_in: "3599" });
          },
        }),
        revoke: () => {},
      },
    },
  };
  const auth = new WebAuth({
    settings,
    loadGis: async () => gis,
    now: () => clock,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
  });
  return { auth, store, requested, advance: (ms: number) => (clock += ms), block: () => (behavior = "blocked"), clone: () => new WebAuth({ settings, loadGis: async () => gis, now: () => clock, storage: { getItem: (k) => store.get(k) ?? null, setItem: () => {}, removeItem: () => {} } }) };
}

describe("WebAuth", () => {
  it("signs in, keeps the token across reloads until it lapses, then asks for a gesture-driven refresh", async () => {
    const t = web();
    await t.auth.ready();
    await expect(t.auth.getToken()).rejects.toBeInstanceOf(AuthRequiredError);
    await t.auth.signIn();
    expect(await t.auth.getToken()).toBe("WEB_TOKEN");
    expect(t.requested).toEqual([""]);

    const reloaded = t.clone();
    await reloaded.ready();
    expect(reloaded.isSignedIn()).toBe(true);
    expect(await reloaded.getToken()).toBe("WEB_TOKEN");

    t.advance(3600_000);
    await expect(t.auth.getToken()).rejects.toThrow(/다시 연결/);
    expect(t.auth.isSignedIn()).toBe(true); // still "connected": one click renews it
    await t.auth.signIn();
    expect(await t.auth.getToken()).toBe("WEB_TOKEN");
  });

  it("explains a blocked popup", async () => {
    const t = web();
    t.block();
    await expect(t.auth.signIn()).rejects.toThrow(/팝업/);
    expect(t.auth.isSignedIn()).toBe(false);
  });

  it("signing out forgets the stored token", async () => {
    const t = web();
    await t.auth.signIn();
    await t.auth.signOut();
    expect(t.store.size).toBe(0);
    expect(t.auth.isSignedIn()).toBe(false);
  });
});
