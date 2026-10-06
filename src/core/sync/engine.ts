import { basename, dirname, extname, joinPath, type VaultAdapter, type VaultEntry } from "../vault";
import { DriveClient, DriveError, FOLDER_MIME, type DriveChange } from "./drive-client";
import { md5Hex } from "./hash";
import { merge3 } from "./merge3";
import { freshState, type SyncState, type SyncStore } from "./state";

/**
 * Two-way sync between a local vault (any `VaultAdapter`) and one Google Drive folder.
 *
 * For every path the engine compares three things: the local file, the remote file, and the
 * "base" it remembered from the last sync (their common content hash). Only one side changed
 * -> copy it to the other. Both changed -> try a line-based merge of notes; if that is not
 * clean, keep the local file at its path and save the remote version next to it as
 * `Name (충돌 2026-10-06 1530).md`. Nothing is ever overwritten without a copy surviving, and
 * deletions go to `.trash/` (locally) or Drive's trash (remotely).
 */

export interface SyncOptions {
  /** List the whole remote tree even if Drive reports no relevant changes. */
  force?: boolean;
  /** Go ahead even if the run would delete most of the vault on one side. */
  allowMassDelete?: boolean;
  onProgress?(done: number, total: number): void;
}

export interface SyncIssue {
  path: string;
  message: string;
}

export interface SyncConflict {
  path: string;
  conflictPath: string;
}

export interface SyncSummary {
  startedAt: number;
  finishedAt: number;
  uploaded: number;
  downloaded: number;
  merged: number;
  trashedRemote: number;
  trashedLocal: number;
  conflicts: SyncConflict[];
  issues: SyncIssue[];
  /** True when the whole remote tree was listed (not just a changes check). */
  fullScan: boolean;
  /** Set when the run stopped before changing anything because it looked destructive. */
  aborted?: { reason: "mass-delete"; local: number; remote: number; tracked: number };
}

/** Thrown by a token source when the user has to sign in again. */
export class AuthRequiredError extends Error {
  constructor(message = "Google 로그인이 필요해요") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

const FULL_SCAN_EVERY_MS = 30 * 60 * 1000;
const BASE_TEXT_LIMIT = 1024 * 1024;
const NETWORK_CONCURRENCY = 4;

export interface SyncEngineOptions {
  vault: VaultAdapter;
  drive: DriveClient;
  store: SyncStore;
  /** Drive folder id that is the vault root. */
  rootId: string;
  now?: () => number;
}

interface LocalFile {
  size: number;
  mtime: number;
  hash: string;
  /** Note text, kept only for untracked notes so a first-sync adoption can seed the merge base. */
  text?: string;
}

interface Local {
  files: Map<string, LocalFile>;
  folders: Set<string>;
}

interface RemoteFile {
  id: string;
  md5: string;
}

interface Remote {
  files: Map<string, RemoteFile>;
  folders: Map<string, { id: string }>;
}

export class SyncEngine {
  private readonly vault: VaultAdapter;
  private readonly drive: DriveClient;
  private readonly store: SyncStore;
  private readonly rootId: string;
  private readonly now: () => number;

  constructor(opts: SyncEngineOptions) {
    this.vault = opts.vault;
    this.drive = opts.drive;
    this.store = opts.store;
    this.rootId = opts.rootId;
    this.now = opts.now ?? Date.now;
  }

  async sync(options: SyncOptions = {}): Promise<SyncSummary> {
    const summary: SyncSummary = {
      startedAt: this.now(),
      finishedAt: 0,
      uploaded: 0,
      downloaded: 0,
      merged: 0,
      trashedRemote: 0,
      trashedLocal: 0,
      conflicts: [],
      issues: [],
      fullScan: false,
    };
    let state = await this.store.load();
    if (!state || state.rootId !== this.rootId) {
      await this.store.clear();
      state = freshState(this.rootId);
    }

    const run = new Run(this.vault, this.drive, this.store, this.rootId, this.now, state, summary, options);
    try {
      await run.execute();
    } finally {
      await this.store.save(state);
      summary.finishedAt = this.now();
    }
    return summary;
  }
}

type Action =
  | { type: "upload-new"; path: string }
  | { type: "upload-update"; path: string; id: string }
  | { type: "download"; path: string; remote: RemoteFile }
  | { type: "trash-remote"; path: string; id: string }
  | { type: "trash-local"; path: string }
  | { type: "adopt"; path: string; remote: RemoteFile }
  | { type: "both-changed"; path: string; remote: RemoteFile; hadBase: boolean };

class Run {
  private local!: Local;
  private remote!: Remote;
  private nextToken: string | undefined;
  private fullScan = false;
  /** Something could not be finished this time; make the next run list the remote tree again. */
  private unfinished = false;
  private folderIds = new Map<string, Promise<string>>();
  private opsSinceSave = 0;

  constructor(
    private readonly vault: VaultAdapter,
    private readonly drive: DriveClient,
    private readonly store: SyncStore,
    private readonly rootId: string,
    private readonly now: () => number,
    private readonly state: SyncState,
    private readonly summary: SyncSummary,
    private readonly options: SyncOptions,
  ) {}

  async execute() {
    const { state, summary } = this;
    this.local = await this.scanLocal();

    let needFull = !!this.options.force || !state.pageToken || this.now() - (state.lastFullAt ?? 0) > FULL_SCAN_EVERY_MS;
    if (!needFull) {
      const { changes, nextToken } = await this.drive.changesSince(state.pageToken!);
      this.nextToken = nextToken;
      needFull = this.anyRelevant(changes);
    }
    if (needFull) {
      // Take the cursor before listing so a change made while listing is seen next time.
      this.nextToken ??= await this.drive.startPageToken();
      this.remote = await this.listRemote();
      this.fullScan = true;
    } else {
      this.remote = this.remoteFromState();
    }
    summary.fullScan = this.fullScan;

    const actions = this.plan();
    const tracked = Object.keys(state.files).length;
    const local = actions.filter((a) => a.type === "trash-local").length;
    const remote = actions.filter((a) => a.type === "trash-remote").length;
    if (!this.options.allowMassDelete && local + remote > 20 && local + remote > tracked / 2) {
      summary.aborted = { reason: "mass-delete", local, remote, tracked };
      return;
    }

    await this.createFolders();
    let done = 0;
    await pool(actions, NETWORK_CONCURRENCY, async (action) => {
      await this.perform(action);
      this.options.onProgress?.(++done, actions.length);
      if (++this.opsSinceSave >= 25) {
        this.opsSinceSave = 0;
        await this.store.save(state);
      }
    });
    await this.removeFolders();

    if (summary.issues.length > 0 || this.unfinished) {
      state.pageToken = undefined;
    } else {
      state.pageToken = this.nextToken;
      if (this.fullScan) state.lastFullAt = this.now();
    }
  }

  // ------------------------------------------------------------------- scanning

  private async scanLocal(): Promise<Local> {
    const entries = await this.vault.list();
    const files = new Map<string, LocalFile>();
    const folders = new Set<string>();
    const toHash: VaultEntry[] = [];
    for (const e of entries) {
      if (isSyncIgnored(e.path)) continue;
      if (e.kind === "folder") folders.add(e.path);
      else {
        const known = this.state.files[e.path];
        if (known && known.size === e.size && known.mtime === e.mtime) files.set(e.path, { size: e.size, mtime: e.mtime, hash: known.hash });
        else toHash.push(e);
      }
    }
    await pool(toHash, 8, async (e) => {
      try {
        const bytes = await this.vault.readBinary(e.path);
        const tracked = !!this.state.files[e.path];
        files.set(e.path, {
          size: e.size,
          mtime: e.mtime,
          hash: md5Hex(bytes),
          text: !tracked && isTextPath(e.path) && bytes.length <= BASE_TEXT_LIMIT ? decodeText(bytes) ?? undefined : undefined,
        });
      } catch (err) {
        this.issue(e.path, err);
      }
    });
    return { files, folders };
  }

  /** Does any Drive change need a look at the remote tree, or are they all echoes of what this device did? */
  private anyRelevant(changes: DriveChange[]): boolean {
    const { state } = this;
    const folderPaths = new Map(Object.entries(state.folders).map(([p, f]) => [f.id, p]));
    const filePaths = new Map(Object.entries(state.files).map(([p, f]) => [f.id, p]));
    const knownFolder = (id: string) => id === this.rootId || folderPaths.has(id);
    return changes.some((c) => {
      const tracked = filePaths.has(c.fileId) || folderPaths.has(c.fileId);
      if (c.removed) return tracked;
      const f = c.file;
      if (!f) return true;
      if (!tracked) return !!f.parents?.some(knownFolder); // something new appeared in a folder we sync
      // Already tracked: only a trash, rename, move or new content matters, not our own upload coming back.
      const folderPath = folderPaths.get(c.fileId);
      const path = folderPath ?? filePaths.get(c.fileId)!;
      if (f.trashed || f.name !== basename(path)) return true;
      if (f.parents && !f.parents.every(knownFolder)) return true;
      return folderPath === undefined && f.md5Checksum !== state.files[path]!.hash;
    });
  }

  private remoteFromState(): Remote {
    const files = new Map<string, RemoteFile>();
    const folders = new Map<string, { id: string }>();
    for (const [p, e] of Object.entries(this.state.files)) files.set(p, { id: e.id, md5: e.hash });
    for (const [p, f] of Object.entries(this.state.folders)) folders.set(p, f);
    return { files, folders };
  }

  private async listRemote(): Promise<Remote> {
    const files = new Map<string, RemoteFile>();
    const folders = new Map<string, { id: string }>();
    const created = new Map<string, string>();
    const queue: { id: string; path: string }[] = [{ id: this.rootId, path: "" }];
    while (queue.length > 0) {
      const batch = queue.splice(0, NETWORK_CONCURRENCY);
      const listed = await Promise.all(batch.map(async (f) => ({ ...f, children: await this.drive.listChildren(f.id) })));
      for (const { path, children } of listed) {
        children.sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? "") || a.id.localeCompare(b.id));
        for (const child of children) {
          const childPath = path === "" ? child.name : `${path}/${child.name}`;
          if (child.name.includes("/") || child.name === "." || child.name === "..") {
            this.summary.issues.push({ path: childPath, message: "이름에 쓸 수 없는 글자가 있어서 건너뛰었어요" });
            continue;
          }
          if (isSyncIgnored(childPath)) continue;
          const isFolder = child.mimeType === FOLDER_MIME;
          if (!isFolder && child.mimeType.startsWith("application/vnd.google-apps.")) continue; // Docs, Sheets, shortcuts: no file content
          if (files.has(childPath) || folders.has(childPath)) {
            if (!created.has(childPath)) {
              created.set(childPath, child.id);
              this.summary.issues.push({ path: childPath, message: "드라이브에 같은 이름이 둘 이상 있어요. 먼저 만든 것만 동기화해요" });
            }
            continue;
          }
          if (isFolder) {
            folders.set(childPath, { id: child.id });
            queue.push({ id: child.id, path: childPath });
          } else if (child.md5Checksum) {
            files.set(childPath, { id: child.id, md5: child.md5Checksum });
          }
        }
      }
    }
    return { files, folders };
  }

  // ------------------------------------------------------------------- planning

  private plan(): Action[] {
    const { state, local, remote } = this;
    const paths = new Set<string>([...local.files.keys(), ...remote.files.keys(), ...Object.keys(state.files)]);
    const actions: Action[] = [];
    for (const path of [...paths].sort()) {
      if (isSyncIgnored(path)) continue;
      const l = local.files.get(path);
      const r = remote.files.get(path);
      const b = state.files[path];
      if ((l && remote.folders.has(path)) || (r && local.folders.has(path))) {
        this.summary.issues.push({ path, message: "한쪽은 파일이고 다른 쪽은 폴더라서 건너뛰었어요" });
        continue;
      }

      if (!b) {
        if (l && r) actions.push(l.hash === r.md5 ? { type: "adopt", path, remote: r } : { type: "both-changed", path, remote: r, hadBase: false });
        else if (l) actions.push({ type: "upload-new", path });
        else if (r) actions.push({ type: "download", path, remote: r });
        continue;
      }
      if (!l && !r) {
        delete state.files[path];
        void this.store.deleteBase(path);
      } else if (!l && r) {
        // Deleted here. Delete there too, unless it was edited there since.
        actions.push(r.md5 === b.hash ? { type: "trash-remote", path, id: r.id } : { type: "download", path, remote: r });
      } else if (l && !r) {
        // Deleted there. Move ours to .trash, unless it was edited here since.
        actions.push(l.hash === b.hash ? { type: "trash-local", path } : { type: "upload-new", path });
      } else if (l && r) {
        const lChanged = l.hash !== b.hash;
        const rChanged = r.md5 !== b.hash;
        if (l.hash === r.md5) {
          if (lChanged || r.id !== b.id) actions.push({ type: "adopt", path, remote: r });
        } else if (lChanged && rChanged) actions.push({ type: "both-changed", path, remote: r, hadBase: true });
        else if (rChanged) actions.push({ type: "download", path, remote: r });
        else if (lChanged) actions.push({ type: "upload-update", path, id: r.id });
      }
    }
    return actions;
  }

  // ------------------------------------------------------------------ execution

  private async perform(a: Action) {
    try {
      switch (a.type) {
        case "upload-new":
          return await this.uploadNew(a.path);
        case "upload-update":
          return await this.uploadUpdate(a.path, a.id);
        case "download":
          return await this.download(a.path, a.remote);
        case "trash-remote":
          return await this.trashRemote(a.path, a.id);
        case "trash-local":
          return await this.trashLocal(a.path);
        case "adopt":
          return await this.adopt(a.path, a.remote);
        case "both-changed":
          return await this.bothChanged(a.path, a.remote, a.hadBase);
      }
    } catch (e) {
      if (isFatal(e)) throw e;
      this.issue(a.path, e);
    }
  }

  private async uploadNew(path: string) {
    const scanned = this.local.files.get(path)!;
    const bytes = await this.vault.readBinary(path);
    const parentId = await this.ensureFolder(dirname(path));
    const file = await this.drive.createFile(basename(path), parentId, bytes);
    await this.record(path, file.id, bytes, scanned);
    this.summary.uploaded++;
  }

  private async uploadUpdate(path: string, id: string) {
    const scanned = this.local.files.get(path)!;
    const bytes = await this.vault.readBinary(path);
    await this.drive.updateFile(id, bytes);
    await this.record(path, id, bytes, scanned);
    this.summary.uploaded++;
  }

  private async download(path: string, remote: RemoteFile) {
    const bytes = await this.drive.download(remote.id);
    if (!(await this.localUnchangedSinceScan(path))) return this.defer();
    await this.vault.writeBinary(path, bytes);
    await this.recordFromDisk(path, remote.id, bytes);
    this.summary.downloaded++;
  }

  private async trashRemote(path: string, id: string) {
    try {
      await this.drive.trash(id);
    } catch (e) {
      if (!(e instanceof DriveError && e.status === 404)) throw e;
    }
    this.forget(path);
    this.summary.trashedRemote++;
  }

  private async trashLocal(path: string) {
    if (!(await this.localUnchangedSinceScan(path))) return this.defer();
    const name = basename(path);
    const ext = extname(name) ? name.slice(name.lastIndexOf(".")) : "";
    const stemName = ext ? name.slice(0, -ext.length) : name;
    let target = joinPath(".trash", name);
    for (let n = 1; await this.vault.stat(target); n++) target = joinPath(".trash", `${stemName} ${n}${ext}`);
    await this.vault.rename(path, target);
    this.forget(path);
    this.summary.trashedLocal++;
  }

  /** Local and remote already hold the same bytes: just remember that. */
  private async adopt(path: string, remote: RemoteFile) {
    const scanned = this.local.files.get(path)!;
    this.state.files[path] = { id: remote.id, hash: scanned.hash, size: scanned.size, mtime: scanned.mtime };
    if (isTextPath(path)) {
      const text = scanned.text ?? (scanned.size <= BASE_TEXT_LIMIT ? decodeText(await this.vault.readBinary(path)) : null);
      if (text !== null && text !== undefined) await this.store.setBase(path, text);
      else await this.store.deleteBase(path);
    }
  }

  private async bothChanged(path: string, remote: RemoteFile, hadBase: boolean) {
    const scanned = this.local.files.get(path)!;
    const localBytes = await this.vault.readBinary(path);
    const remoteBytes = await this.drive.download(remote.id);

    if (md5Hex(remoteBytes) === md5Hex(localBytes)) return this.adopt(path, remote);
    if (!(await this.localUnchangedSinceScan(path, scanned))) return this.defer();

    if (isTextPath(path)) {
      const base = hadBase ? await this.store.getBase(path) : undefined;
      const l = decodeText(localBytes);
      const r = decodeText(remoteBytes);
      const merged = base !== undefined && l !== null && r !== null ? merge3(base, l, r) : null;
      if (merged !== null) {
        const bytes = new TextEncoder().encode(merged);
        await this.vault.writeBinary(path, bytes);
        await this.drive.updateFile(remote.id, bytes);
        await this.recordFromDisk(path, remote.id, bytes);
        this.summary.merged++;
        return;
      }
    }

    // Keep both: ours stays at the path (and goes to Drive), theirs is saved beside it.
    const conflictPath = await this.conflictPath(path);
    await this.vault.writeBinary(conflictPath, remoteBytes);
    await this.drive.updateFile(remote.id, localBytes);
    await this.record(path, remote.id, localBytes, scanned);
    const parentId = await this.ensureFolder(dirname(path));
    const copy = await this.drive.createFile(basename(conflictPath), parentId, remoteBytes);
    await this.recordFromDisk(conflictPath, copy.id, remoteBytes);
    this.summary.conflicts.push({ path, conflictPath });
    this.summary.uploaded++;
  }

  private async conflictPath(path: string): Promise<string> {
    const d = new Date(this.now());
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
    const name = basename(path);
    const dot = name.lastIndexOf(".");
    const [stemName, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let candidate = joinPath(dirname(path), `${stemName} (충돌 ${stamp})${ext}`);
    for (let n = 2; await this.vault.stat(candidate); n++) candidate = joinPath(dirname(path), `${stemName} (충돌 ${stamp} ${n})${ext}`);
    return candidate;
  }

  // -------------------------------------------------------------------- folders

  /** Create the folders that exist on only one side (parents before children). */
  private async createFolders() {
    const { state, local, remote } = this;
    const paths = [...new Set([...local.folders, ...remote.folders.keys()])].filter((p) => !isSyncIgnored(p)).sort((a, b) => a.split("/").length - b.split("/").length);
    for (const path of paths) {
      try {
        const l = local.folders.has(path);
        const r = remote.folders.get(path);
        if (l && r) state.folders[path] = { id: r.id };
        else if (state.folders[path]) continue; // gone from one side: handled in removeFolders
        else if (l) await this.ensureFolder(path);
        else if (r) {
          await this.vault.mkdir(path);
          state.folders[path] = { id: r.id };
        }
      } catch (e) {
        if (isFatal(e)) throw e;
        this.issue(path, e);
      }
    }
  }

  /** Propagate folder deletions, but only when the folder is empty on the side we would delete from. */
  private async removeFolders() {
    const { state } = this;
    const entries = await this.vault.list();
    const folders = new Set(entries.filter((e) => e.kind === "folder").map((e) => e.path));
    const hasFilesUnder = (p: string) => Object.keys(state.files).some((f) => f.startsWith(p + "/"));
    const hasAnythingUnder = (p: string) => entries.some((e) => e.path.startsWith(p + "/"));
    const paths = Object.keys(state.folders).sort((a, b) => b.split("/").length - a.split("/").length);
    for (const path of paths) {
      try {
        const l = folders.has(path);
        const r = this.remote.folders.has(path);
        if (l && r) continue;
        if (!l && !r) delete state.folders[path];
        else if (!l) {
          if (hasFilesUnder(path)) continue;
          try {
            await this.drive.trash(state.folders[path]!.id);
          } catch (e) {
            if (!(e instanceof DriveError && e.status === 404)) throw e;
          }
          delete state.folders[path];
        } else {
          if (!hasAnythingUnder(path)) await this.vault.remove(path);
          delete state.folders[path];
        }
      } catch (e) {
        if (isFatal(e)) throw e;
        this.issue(path, e);
      }
    }
  }

  /** Drive folder id for a vault folder path, creating missing folders on Drive. */
  private ensureFolder(path: string): Promise<string> {
    if (path === "") return Promise.resolve(this.rootId);
    const known = this.state.folders[path]?.id ?? this.remote.folders.get(path)?.id;
    if (known) return Promise.resolve(known);
    let pending = this.folderIds.get(path);
    if (!pending) {
      pending = (async () => {
        const parent = await this.ensureFolder(dirname(path));
        const folder = await this.drive.createFolder(basename(path), parent);
        this.state.folders[path] = { id: folder.id };
        this.remote.folders.set(path, { id: folder.id });
        return folder.id;
      })();
      this.folderIds.set(path, pending);
      pending.catch(() => this.folderIds.delete(path));
    }
    return pending;
  }

  // -------------------------------------------------------------------- helpers

  /** Remember `path` as synced, using the size/mtime from the scan taken before reading the bytes. */
  private async record(path: string, id: string, bytes: Uint8Array, scanned: LocalFile) {
    this.state.files[path] = { id, hash: md5Hex(bytes), size: scanned.size, mtime: scanned.mtime };
    await this.setBase(path, bytes);
  }

  /** Remember `path` as synced right after we wrote it ourselves. */
  private async recordFromDisk(path: string, id: string, bytes: Uint8Array) {
    const stat = await this.vault.stat(path);
    this.state.files[path] = { id, hash: md5Hex(bytes), size: stat?.size ?? bytes.length, mtime: stat?.mtime ?? 0 };
    await this.setBase(path, bytes);
  }

  private async setBase(path: string, bytes: Uint8Array) {
    const text = isTextPath(path) && bytes.length <= BASE_TEXT_LIMIT ? decodeText(bytes) : null;
    if (text !== null) await this.store.setBase(path, text);
    else await this.store.deleteBase(path);
  }

  private forget(path: string) {
    delete this.state.files[path];
    void this.store.deleteBase(path);
  }

  /** The user (or another process) may have edited the file since the scan; if so, leave it for the next run. */
  private async localUnchangedSinceScan(path: string, scanned = this.local.files.get(path)): Promise<boolean> {
    const now = await this.vault.stat(path);
    if (!scanned) return now === null;
    return !!now && now.size === scanned.size && now.mtime === scanned.mtime;
  }

  private defer() {
    this.unfinished = true;
  }

  private issue(path: string, e: unknown) {
    this.summary.issues.push({ path, message: e instanceof Error ? e.message : String(e) });
  }
}

/** Errors that mean the whole run should stop (signed out, offline) rather than skip one file. */
export function isFatal(e: unknown): boolean {
  return e instanceof AuthRequiredError || (e instanceof DriveError && (e.isAuth || e.status === 429 || e.status >= 500)) || e instanceof TypeError;
}

const IGNORED_NAMES = new Set([".trash", ".git", ".DS_Store", "Thumbs.db", "desktop.ini"]);
const IGNORED_OBSIDIAN_FILES = new Set([".obsidian/workspace.json", ".obsidian/workspace-mobile.json"]);

/**
 * Paths that never sync: Obsidian's per-device window layout, our trash, VCS folders, OS
 * clutter and half-written temp files.
 */
export function isSyncIgnored(path: string): boolean {
  if (IGNORED_OBSIDIAN_FILES.has(path)) return true;
  return path.split("/").some((seg) => IGNORED_NAMES.has(seg) || seg.endsWith(".yobsidian-tmp"));
}

function isTextPath(path: string): boolean {
  const ext = extname(path);
  return ext === "md" || ext === "txt";
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (e) {
        failed = true;
        failure = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (failed) throw failure;
}
