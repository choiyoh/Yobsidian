/**
 * An in-memory stand-in for the slice of the Google Drive v3 REST API that Yobsidian uses.
 * It speaks HTTP through a `fetch` function, so the real `DriveClient` runs against it
 * unchanged. Test-only: nothing in the app imports this file.
 */
import { createHash } from "node:crypto";
import { FOLDER_MIME } from "../drive-client";

export interface FakeNode {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  data?: Buffer;
  modifiedTime: string;
  createdTime: string;
}

interface Change {
  fileId: string;
  removed: boolean;
}

export const FAKE_TOKEN = "fake-access-token";

export class FakeDrive {
  readonly nodes = new Map<string, FakeNode>();
  /** Every request as `METHOD path`, for assertions about how chatty the client was. */
  readonly requests: string[] = [];
  /** Pages are cut at this many items so tests exercise pagination. */
  pageSize = 1000;
  private changes: Change[] = [];
  private seq = 0;
  private clock = Date.parse("2026-10-06T00:00:00Z");
  private failures: { status: number; reason: string; times: number }[] = [];
  private uploads = new Map<string, { id?: string; meta: Record<string, unknown> }>();
  /** Reject the next request(s) with this status (e.g. 429, 500, 401). */
  failNext(status: number, times = 1, reason = "backendError") {
    this.failures.push({ status, reason, times });
  }

  constructor() {
    this.nodes.set("root", this.make("root", "My Drive", FOLDER_MIME, []));
    this.changes = [];
  }

  // ------------------------------------------------- direct manipulation (as "another device")

  addFolder(parentId: string, name: string): string {
    const id = this.newId();
    this.nodes.set(id, this.make(id, name, FOLDER_MIME, [parentId]));
    this.changes.push({ fileId: id, removed: false });
    return id;
  }

  /** Create a file at `path` below `parentId`, creating folders as needed. */
  putFile(parentId: string, path: string, content: string | Buffer): string {
    const parts = path.split("/");
    let parent = parentId;
    for (const folder of parts.slice(0, -1)) {
      parent = this.children(parent).find((n) => n.name === folder && n.mimeType === FOLDER_MIME)?.id ?? this.addFolder(parent, folder);
    }
    const name = parts[parts.length - 1]!;
    const data = typeof content === "string" ? Buffer.from(content) : content;
    const existing = this.children(parent).find((n) => n.name === name && n.mimeType !== FOLDER_MIME);
    if (existing) {
      this.setContent(existing.id, data);
      return existing.id;
    }
    const id = this.newId();
    const node = this.make(id, name, "application/octet-stream", [parent]);
    node.data = data;
    this.nodes.set(id, node);
    this.changes.push({ fileId: id, removed: false });
    return id;
  }

  setContent(id: string, content: string | Buffer) {
    const n = this.must(id);
    n.data = typeof content === "string" ? Buffer.from(content) : content;
    n.modifiedTime = this.tick();
    this.changes.push({ fileId: id, removed: false });
  }

  trashNode(id: string) {
    const n = this.must(id);
    n.trashed = true;
    this.changes.push({ fileId: id, removed: false });
  }

  /** Find a live file by its path below `parentId`. */
  find(parentId: string, path: string): FakeNode | undefined {
    let cur: FakeNode | undefined;
    let parent = parentId;
    for (const seg of path.split("/")) {
      cur = this.children(parent).find((n) => n.name === seg);
      if (!cur) return undefined;
      parent = cur.id;
    }
    return cur;
  }

  text(parentId: string, path: string): string | undefined {
    return this.find(parentId, path)?.data?.toString("utf8");
  }

  /** Paths of live files and folders below `parentId`, sorted. */
  tree(parentId = "root"): string[] {
    const out: string[] = [];
    const walk = (id: string, prefix: string) => {
      for (const n of this.children(id)) {
        const p = prefix ? `${prefix}/${n.name}` : n.name;
        out.push(n.mimeType === FOLDER_MIME ? p + "/" : p);
        if (n.mimeType === FOLDER_MIME) walk(n.id, p);
      }
    };
    walk(parentId, "");
    return out.sort();
  }

  get changeToken() {
    return String(this.changes.length);
  }

  // ---------------------------------------------------------------------------- HTTP

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const marker = url.searchParams.get("uploadType") ?? (url.searchParams.get("alt") === "media" ? "media" : "");
    this.requests.push(`${method} ${url.pathname}${marker ? "?" + marker : ""}`);

    const failure = this.failures[0];
    if (failure) {
      if (--failure.times <= 0) this.failures.shift();
      return this.error(failure.status, failure.reason);
    }
    if (url.pathname.startsWith("/__resumable/")) return this.resumable(url, method, init);
    if (headers.get("Authorization") !== `Bearer ${FAKE_TOKEN}`) return this.error(401, "authError");

    const path = url.pathname;
    const body = init?.body == null ? undefined : toBuffer(init.body);

    if (path === "/drive/v3/about") return this.ok({ user: { emailAddress: "me@example.com", displayName: "Me" } });
    if (path === "/drive/v3/changes/startPageToken") return this.ok({ startPageToken: this.changeToken });
    if (path === "/drive/v3/changes") return this.listChanges(url);
    if (path === "/drive/v3/files" && method === "GET") return this.listFiles(url);
    if (path === "/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(body!.toString());
      const id = this.newId();
      this.nodes.set(id, this.make(id, meta.name, meta.mimeType ?? "application/octet-stream", meta.parents ?? ["root"]));
      this.changes.push({ fileId: id, removed: false });
      return this.ok(this.meta(this.must(id)));
    }
    if (path === "/upload/drive/v3/files" && method === "POST") return this.uploadNew(url, headers, body);
    const fileMatch = /^\/(upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[2]!);
      const node = this.nodes.get(id);
      if (!node) return this.error(404, "notFound");
      if (fileMatch[1]) return this.uploadUpdate(url, headers, node, body);
      if (method === "GET" && url.searchParams.get("alt") === "media") {
        if (node.trashed) return this.error(404, "notFound");
        return new Response(new Uint8Array(node.data ?? Buffer.alloc(0)), { status: 200 });
      }
      if (method === "GET") return this.ok(this.meta(node));
      if (method === "PATCH") {
        const patch = JSON.parse(body!.toString());
        if (patch.trashed !== undefined) node.trashed = patch.trashed;
        if (patch.name) node.name = patch.name;
        node.modifiedTime = this.tick();
        this.changes.push({ fileId: id, removed: false });
        return this.ok(this.meta(node));
      }
    }
    return this.error(404, "notFound", `unhandled ${method} ${path}`);
  };

  // --------------------------------------------------------------------- handlers

  private listFiles(url: URL): Response {
    const q = url.searchParams.get("q") ?? "";
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    let items = [...this.nodes.values()].filter((n) => n.id !== "root" && (!parent || n.parents.includes(parent)));
    if (/trashed = false/.test(q)) items = items.filter((n) => !n.trashed);
    if (q.includes(`mimeType = '${FOLDER_MIME}'`)) items = items.filter((n) => n.mimeType === FOLDER_MIME);
    const start = Number(url.searchParams.get("pageToken") ?? 0);
    const size = Math.min(this.pageSize, Number(url.searchParams.get("pageSize") ?? 100));
    const page = items.slice(start, start + size);
    return this.ok({ files: page.map((n) => this.meta(n)), nextPageToken: start + size < items.length ? String(start + size) : undefined });
  }

  private listChanges(url: URL): Response {
    const start = Number(url.searchParams.get("pageToken"));
    const size = Math.min(this.pageSize, 1000);
    const slice = this.changes.slice(start, start + size);
    const out = slice.map((c) => {
      const n = this.nodes.get(c.fileId);
      return { fileId: c.fileId, removed: c.removed, file: n && !c.removed ? { id: n.id, name: n.name, parents: n.parents, trashed: n.trashed, md5Checksum: this.meta(n).md5Checksum } : undefined };
    });
    const end = start + slice.length;
    return end < this.changes.length ? this.ok({ changes: out, nextPageToken: String(end) }) : this.ok({ changes: out, newStartPageToken: String(end) });
  }

  private uploadNew(url: URL, headers: Headers, body?: Buffer): Response {
    const type = url.searchParams.get("uploadType");
    if (type === "resumable") return this.startResumable({ meta: JSON.parse(body!.toString()) });
    if (type !== "multipart") return this.error(400, "badRequest");
    const { meta, data } = parseMultipart(headers.get("Content-Type") ?? "", body!);
    const id = this.newId();
    const node = this.make(id, meta.name as string, (meta.mimeType as string) ?? "application/octet-stream", (meta.parents as string[]) ?? ["root"]);
    node.data = data;
    this.nodes.set(id, node);
    this.changes.push({ fileId: id, removed: false });
    return this.ok(this.meta(node));
  }

  private uploadUpdate(url: URL, headers: Headers, node: FakeNode, body?: Buffer): Response {
    const type = url.searchParams.get("uploadType");
    if (type === "resumable") return this.startResumable({ id: node.id, meta: {} });
    if (type === "multipart") node.data = parseMultipart(headers.get("Content-Type") ?? "", body!).data;
    else node.data = body ?? Buffer.alloc(0);
    node.modifiedTime = this.tick();
    this.changes.push({ fileId: node.id, removed: false });
    return this.ok(this.meta(node));
  }

  private startResumable(target: { id?: string; meta: Record<string, unknown> }): Response {
    const session = `s${++this.seq}`;
    this.uploads.set(session, target);
    return new Response("{}", { status: 200, headers: { Location: `https://www.googleapis.com/__resumable/${session}` } });
  }

  private resumable(url: URL, method: string, init?: RequestInit): Response {
    const session = this.uploads.get(url.pathname.split("/").pop()!);
    if (!session || method !== "PUT") return this.error(404, "notFound");
    const data = toBuffer(init!.body!);
    if (session.id) {
      const node = this.must(session.id);
      node.data = data;
      node.modifiedTime = this.tick();
      this.changes.push({ fileId: node.id, removed: false });
      return this.ok(this.meta(node));
    }
    const id = this.newId();
    const node = this.make(id, session.meta.name as string, "application/octet-stream", (session.meta.parents as string[]) ?? ["root"]);
    node.data = data;
    this.nodes.set(id, node);
    this.changes.push({ fileId: id, removed: false });
    return this.ok(this.meta(node));
  }

  // ----------------------------------------------------------------------- utils

  private children(parentId: string) {
    return [...this.nodes.values()].filter((n) => n.parents.includes(parentId) && !n.trashed);
  }
  private meta(n: FakeNode) {
    return {
      id: n.id,
      name: n.name,
      mimeType: n.mimeType,
      parents: n.parents,
      md5Checksum: n.mimeType === FOLDER_MIME ? undefined : createHash("md5").update(n.data ?? Buffer.alloc(0)).digest("hex"),
      size: n.mimeType === FOLDER_MIME ? undefined : String(n.data?.length ?? 0),
      modifiedTime: n.modifiedTime,
      createdTime: n.createdTime,
    };
  }
  private make(id: string, name: string, mimeType: string, parents: string[]): FakeNode {
    const t = this.tick();
    return { id, name, mimeType, parents, trashed: false, modifiedTime: t, createdTime: t };
  }
  private must(id: string) {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`fake drive: no node ${id}`);
    return n;
  }
  private newId() {
    return `id${++this.seq}`;
  }
  private tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
  private ok(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  private error(status: number, reason: string, message = reason) {
    return new Response(JSON.stringify({ error: { code: status, message, errors: [{ reason }] } }), { status, headers: { "Content-Type": "application/json" } });
  }
}

function toBuffer(body: BodyInit): Buffer {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("fake drive: unsupported body type");
}

function parseMultipart(contentType: string, body: Buffer): { meta: Record<string, unknown>; data: Buffer } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) throw new Error("fake drive: no multipart boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const first = body.indexOf(delimiter);
  const second = body.indexOf(delimiter, first + delimiter.length);
  const third = body.indexOf(delimiter, second + delimiter.length);
  const part = (from: number, to: number) => {
    const chunk = body.subarray(from + delimiter.length, to);
    const split = chunk.indexOf("\r\n\r\n");
    return chunk.subarray(split + 4, chunk.length - 2); // drop the CRLF before the next delimiter
  };
  return { meta: JSON.parse(part(first, second).toString()), data: Buffer.from(part(second, third)) };
}
