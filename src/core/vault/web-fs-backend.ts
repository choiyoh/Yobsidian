import { VaultError, type VaultEntry } from "./types";
import type { FsBackend } from "./fs-adapter";

// The File System Access API is not in TypeScript's DOM lib yet; only what we use is declared.
interface PermissionHandle {
  queryPermission(d: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(d: { mode: "readwrite" }): Promise<PermissionState>;
}
type DirHandle = FileSystemDirectoryHandle & PermissionHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };
type PickerWindow = Window & { showDirectoryPicker?(o?: { mode?: "readwrite" }): Promise<FileSystemDirectoryHandle> };

/** Chromium browsers can open a real folder; Firefox and Safari fall back to importing files. */
export function supportsFolderPicker(): boolean {
  return typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";
}

const DB = "yobsidian-folders";
const STORE = "handles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const live = new Map<string, DirHandle>();

/** Show the browser's folder picker and remember the choice (handles survive reloads in IndexedDB). Returns the vault key (the folder name), or null if cancelled. */
export async function pickWebFolder(): Promise<string | null> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await (window as PickerWindow).showDirectoryPicker!({ mode: "readwrite" });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
  await withStore("readwrite", (s) => s.put(handle, handle.name));
  live.set(handle.name, handle as DirHandle);
  return handle.name;
}

/** The remembered folder handle for `key`, with write access granted. Asking the user needs a click, hence `prompt`. */
export async function loadWebFolder(key: string, prompt = false): Promise<DirHandle> {
  let handle = live.get(key);
  if (!handle) {
    handle = (await withStore("readonly", (s) => s.get(key))) as DirHandle | undefined;
    if (!handle) throw new VaultError("not-found", key);
  }
  let state = await handle.queryPermission({ mode: "readwrite" });
  if (state === "prompt" && prompt) state = await handle.requestPermission({ mode: "readwrite" });
  if (state !== "granted") throw new Error(`permission-needed: ${key}`);
  live.set(key, handle);
  return handle;
}

export function isPermissionNeeded(e: unknown): boolean {
  return String(e).includes("permission-needed:");
}

async function dirAt(root: DirHandle, path: string, create = false): Promise<FileSystemDirectoryHandle> {
  let dir: FileSystemDirectoryHandle = root;
  for (const part of path.split("/").filter(Boolean)) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch (e) {
      throw translate(e, path);
    }
  }
  return dir;
}

function translate(e: unknown, path: string): Error {
  if (e instanceof DOMException) {
    if (e.name === "NotFoundError") return new VaultError("not-found", path);
    if (e.name === "TypeMismatchError") return new VaultError("not-a-folder", path);
  }
  return e instanceof Error ? e : new Error(String(e));
}

function split(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
}

/** Handle for a file or folder, or null when absent. */
async function find(root: DirHandle, path: string): Promise<FileSystemHandle | null> {
  if (path === "") return root;
  const [parent, name] = split(path);
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await dirAt(root, parent);
  } catch {
    return null;
  }
  try {
    return await dir.getFileHandle(name);
  } catch (e) {
    if (!(e instanceof DOMException && (e.name === "TypeMismatchError" || e.name === "NotFoundError"))) throw e;
  }
  try {
    return await dir.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

async function copyTree(from: FileSystemHandle, into: FileSystemDirectoryHandle, name: string): Promise<void> {
  if (from.kind === "file") {
    const file = await (from as FileSystemFileHandle).getFile();
    const w = await (await into.getFileHandle(name, { create: true })).createWritable();
    await w.write(file);
    await w.close();
    return;
  }
  const dest = await into.getDirectoryHandle(name, { create: true });
  for await (const [childName, child] of (from as DirHandle).entries()) await copyTree(child, dest, childName);
}

/** An {@link FsBackend} over a browser folder handle; `root` is the key returned by {@link pickWebFolder}. */
export const webFsBackend: FsBackend = {
  async list(key) {
    const root = await loadWebFolder(key);
    const out: VaultEntry[] = [];
    const walk = async (dir: DirHandle, prefix: string) => {
      for await (const [name, handle] of dir.entries()) {
        const path = prefix + name;
        if (handle.kind === "directory") {
          out.push({ path, kind: "folder", size: 0, mtime: 0 });
          await walk(handle as DirHandle, path + "/");
        } else {
          const f = await (handle as FileSystemFileHandle).getFile();
          out.push({ path, kind: "file", size: f.size, mtime: f.lastModified });
        }
      }
    };
    await walk(root, "");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  },

  async stat(key, path) {
    const h = await find(await loadWebFolder(key), path);
    if (!h) return null;
    if (h.kind === "directory") return { path, kind: "folder", size: 0, mtime: 0 };
    const f = await (h as FileSystemFileHandle).getFile();
    return { path, kind: "file", size: f.size, mtime: f.lastModified };
  },

  async read(key, path) {
    const h = await find(await loadWebFolder(key), path);
    if (!h) throw new VaultError("not-found", path);
    if (h.kind !== "file") throw new VaultError("not-a-file", path);
    return new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer());
  },

  async write(key, path, data) {
    const root = await loadWebFolder(key);
    const [parent, name] = split(path);
    const dir = await dirAt(root, parent, true);
    let file: FileSystemFileHandle;
    try {
      file = await dir.getFileHandle(name, { create: true });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TypeMismatchError") throw new VaultError("not-a-file", path);
      throw e;
    }
    const w = await file.createWritable();
    await w.write(data as unknown as FileSystemWriteChunkType);
    await w.close();
  },

  async mkdir(key, path) {
    const root = await loadWebFolder(key);
    if ((await find(root, path))?.kind === "file") throw new VaultError("not-a-folder", path);
    await dirAt(root, path, true);
  },

  async rename(key, from, to) {
    const root = await loadWebFolder(key);
    const src = await find(root, from);
    if (!src) throw new VaultError("not-found", from);
    if (await find(root, to)) throw new VaultError("exists", to);
    if (to === from || to.startsWith(from + "/")) throw new VaultError("invalid-path", to);
    const [toParent, toName] = split(to);
    await copyTree(src, await dirAt(root, toParent, true), toName);
    const [fromParent, fromName] = split(from);
    await (await dirAt(root, fromParent)).removeEntry(fromName, { recursive: true });
  },

  async remove(key, path) {
    if (path === "") throw new VaultError("invalid-path", path);
    const root = await loadWebFolder(key);
    if (!(await find(root, path))) throw new VaultError("not-found", path);
    const [parent, name] = split(path);
    await (await dirAt(root, parent)).removeEntry(name, { recursive: true });
  },
};
