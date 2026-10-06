/**
 * A small Google Drive v3 client over `fetch`: just the calls the sync engine needs.
 * `fetch` and the token source are injected, so the same code runs in the browser, in the
 * desktop webview (through Tauri's HTTP plugin) and in tests against a fake Drive.
 */

export const FOLDER_MIME = "application/vnd.google-apps.folder";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,mimeType,md5Checksum,size,modifiedTime,createdTime,parents";
/** Above this size a file is sent with the resumable protocol instead of one multipart request. */
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  parents?: string[];
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: { id: string; name?: string; parents?: string[]; trashed?: boolean; md5Checksum?: string };
}

export interface TokenSource {
  getToken(): Promise<string>;
  /** Called when Drive answers 401, so the next `getToken` fetches a fresh token. */
  invalidate?(): void;
}

export class DriveError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(`Drive ${status} ${reason}: ${message}`);
    this.name = "DriveError";
  }
  get isAuth() {
    return this.status === 401 || (this.status === 403 && /insufficientPermissions|forbidden|authError/i.test(this.reason));
  }
}

export interface DriveClientOptions {
  tokens: TokenSource;
  fetch?: typeof fetch;
  /** Waits between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class DriveClient {
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly opts: DriveClientOptions) {
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 4;
  }

  // ------------------------------------------------------------------ reads

  async about(): Promise<{ email?: string; name?: string }> {
    const res = await this.json<{ user?: { emailAddress?: string; displayName?: string } }>(`${API}/about?fields=user(emailAddress,displayName)`);
    return { email: res.user?.emailAddress, name: res.user?.displayName };
  }

  /** Metadata of one file or folder (`"root"` is My Drive). */
  getFile(id: string): Promise<DriveFile> {
    return this.json<DriveFile>(`${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}&supportsAllDrives=true`);
  }

  /** Non-trashed children of a folder. */
  async listChildren(folderId: string, onlyFolders = false): Promise<DriveFile[]> {
    let q = `'${folderId}' in parents and trashed = false`;
    if (onlyFolders) q += ` and mimeType = '${FOLDER_MIME}'`;
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.json<{ files: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`);
      out.push(...res.files);
      pageToken = res.nextPageToken;
    } while (pageToken);
    return out;
  }

  async download(id: string): Promise<Uint8Array> {
    const res = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // ----------------------------------------------------------------- writes

  async createFolder(name: string, parentId: string): Promise<DriveFile> {
    return this.json<DriveFile>(`${API}/files?fields=${FILE_FIELDS}&supportsAllDrives=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
  }

  createFile(name: string, parentId: string, data: Uint8Array): Promise<DriveFile> {
    const meta = { name, parents: [parentId], mimeType: mimeFor(name) };
    return this.upload("POST", `${UPLOAD}/files`, meta, data);
  }

  updateFile(id: string, data: Uint8Array, name?: string): Promise<DriveFile> {
    return this.upload("PATCH", `${UPLOAD}/files/${encodeURIComponent(id)}`, name ? { name, mimeType: mimeFor(name) } : {}, data);
  }

  /** Move to Drive's trash (recoverable for 30 days), never a permanent delete. */
  async trash(id: string): Promise<void> {
    await this.json(`${API}/files/${encodeURIComponent(id)}?fields=id&supportsAllDrives=true`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ trashed: true }),
    });
  }

  // ---------------------------------------------------------------- changes

  async startPageToken(): Promise<string> {
    return (await this.json<{ startPageToken: string }>(`${API}/changes/startPageToken?supportsAllDrives=true`)).startPageToken;
  }

  /** Every change since `pageToken`, plus the token to use next time. */
  async changesSince(pageToken: string): Promise<{ changes: DriveChange[]; nextToken: string }> {
    const changes: DriveChange[] = [];
    let token = pageToken;
    for (;;) {
      const params = new URLSearchParams({
        pageToken: token,
        pageSize: "1000",
        includeRemoved: "true",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,parents,trashed,md5Checksum))",
      });
      const res = await this.json<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>(`${API}/changes?${params}`);
      changes.push(...res.changes);
      if (res.nextPageToken) token = res.nextPageToken;
      else return { changes, nextToken: res.newStartPageToken ?? token };
    }
  }

  // ---------------------------------------------------------------- internals

  private async upload(method: "POST" | "PATCH", base: string, meta: object, data: Uint8Array): Promise<DriveFile> {
    const common = `fields=${FILE_FIELDS}&supportsAllDrives=true`;
    if (data.byteLength > RESUMABLE_THRESHOLD) {
      const init = await this.request(`${base}?uploadType=resumable&${common}`, {
        method,
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(meta),
      });
      const location = init.headers.get("Location");
      if (!location) throw new DriveError(500, "noUploadUrl", "resumable upload returned no Location");
      return (await this.request(location, { method: "PUT", body: data as BodyInit })).json() as Promise<DriveFile>;
    }
    const boundary = `yobsidian-${Math.random().toString(36).slice(2)}`;
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + data.length + tail.length);
    body.set(head);
    body.set(data, head.length);
    body.set(tail, head.length + data.length);
    return this.json<DriveFile>(`${base}?uploadType=multipart&${common}`, {
      method,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: body as BodyInit,
    });
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await this.request(url, init)).json() as Promise<T>;
  }

  /** One authorized request with retries for rate limits, server errors and an expired token. */
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.tokens.getToken();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const res = await this.doFetch(url, { ...init, headers });
      if (res.ok) return res;

      const err = await toError(res);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.opts.tokens.invalidate?.();
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(err.reason));
      if (!retryable || attempt >= this.maxRetries) throw err;
      await this.sleep(Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250);
    }
  }
}

async function toError(res: Response): Promise<DriveError> {
  let reason = res.statusText || "error";
  let message = "";
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } };
    message = body.error?.message ?? "";
    reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? reason;
  } catch {
    // not JSON: keep the status text
  }
  return new DriveError(res.status, reason, message);
}

const MIME: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  canvas: "application/json",
};

function mimeFor(name: string): string {
  const i = name.lastIndexOf(".");
  return (i > 0 && MIME[name.slice(i + 1).toLowerCase()]) || "application/octet-stream";
}
