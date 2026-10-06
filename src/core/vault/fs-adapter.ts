import { invoke } from "@tauri-apps/api/core";
import { normalizePath } from "./paths";
import { VaultError, type Unsubscribe, type VaultAdapter, type VaultChange, type VaultEntry } from "./types";

/** The native calls behind {@link FsAdapter}; the desktop shell implements them in Rust (`src-tauri/src/vault_fs.rs`). */
export interface FsBackend {
  list(root: string): Promise<VaultEntry[]>;
  stat(root: string, path: string): Promise<VaultEntry | null>;
  read(root: string, path: string): Promise<Uint8Array>;
  write(root: string, path: string, data: Uint8Array): Promise<void>;
  mkdir(root: string, path: string): Promise<void>;
  rename(root: string, from: string, to: string): Promise<void>;
  remove(root: string, path: string): Promise<void>;
}

const CODES = new Set(["not-found", "exists", "not-a-file", "not-a-folder", "invalid-path"]);

/** Rust reports errors as `"<code>: <path> (details)"`; turn the known codes back into VaultError. */
function translate(e: unknown, fallbackPath: string): Error {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  const m = /^([a-z-]+): ([^(]*?)(?: \(|$)/.exec(text);
  if (m && CODES.has(m[1]!)) return new VaultError(m[1] as VaultError["code"], m[2] || fallbackPath);
  return new Error(text);
}

export const tauriFsBackend: FsBackend = {
  list: (root) => invoke<VaultEntry[]>("fs_list", { root }),
  stat: (root, path) => invoke<VaultEntry | null>("fs_stat", { root, path }),
  read: async (root, path) => new Uint8Array(await invoke<ArrayBuffer>("fs_read", { root, path })),
  write: (root, path, data) => invoke("fs_write", data, { headers: { "x-root": encodeURIComponent(root), "x-path": encodeURIComponent(path) } }),
  mkdir: (root, path) => invoke("fs_mkdir", { root, path }),
  rename: (root, from, to) => invoke("fs_rename", { root, from, to }),
  remove: (root, path) => invoke("fs_remove", { root, path }),
};

const POLL_MS = 2500;

/**
 * A vault that is a real folder on disk (desktop only). It is a normal Obsidian vault:
 * `.obsidian/` is just another folder here, and nothing in it is ever written by the app itself.
 *
 * Changes made by other programs (Obsidian, a Drive client, a text editor) are noticed by
 * re-reading the folder listing every couple of seconds and on window focus; our own writes
 * are announced immediately.
 */
export class FsAdapter implements VaultAdapter {
  readonly id: string;
  readonly name: string;
  private listeners = new Set<(change: VaultChange) => void>();
  private snapshot: Map<string, string> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | null = null;

  constructor(
    readonly root: string,
    private readonly backend: FsBackend = tauriFsBackend,
  ) {
    this.id = `fs:${root}`;
    this.name = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root;
  }

  /** Open a folder as a vault, failing early if it is missing. */
  static async open(root: string, backend: FsBackend = tauriFsBackend): Promise<FsAdapter> {
    const adapter = new FsAdapter(root, backend);
    await adapter.list();
    return adapter;
  }

  list = () => this.guard(() => this.backend.list(this.root), "");
  stat = (path: string) => this.guard(() => this.backend.stat(this.root, normalizePath(path)), path);

  readBinary = (path: string) => this.guard(() => this.backend.read(this.root, normalizePath(path)), path);
  readText = async (path: string) => new TextDecoder().decode(await this.readBinary(path));

  writeText = (path: string, content: string) => this.writeBinary(path, new TextEncoder().encode(content));

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const p = normalizePath(path);
    const existed = await this.guard(() => this.backend.stat(this.root, p), p);
    await this.guard(() => this.backend.write(this.root, p, data), p);
    await this.announce({ type: existed ? "modify" : "create", path: p }, p);
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === "") return;
    const existed = await this.guard(() => this.backend.stat(this.root, p), p);
    await this.guard(() => this.backend.mkdir(this.root, p), p);
    if (!existed) await this.announce({ type: "create", path: p }, p);
  }

  async rename(from: string, to: string): Promise<void> {
    const src = normalizePath(from);
    const dst = normalizePath(to);
    await this.guard(() => this.backend.rename(this.root, src, dst), src);
    // Re-baseline silently so the next poll does not report the new location as created.
    if (this.snapshot) this.snapshot = new Map((await this.backend.list(this.root)).map((e) => [e.path, signature(e)]));
    this.emit({ type: "rename", path: dst, oldPath: src });
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    await this.guard(() => this.backend.remove(this.root, p), p);
    this.forget(p);
    this.emit({ type: "delete", path: p });
  }

  watch(listener: (change: VaultChange) => void): Unsubscribe {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.startPolling();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  /** Compare the folder with the last snapshot and emit what changed. Exposed for tests and for "refresh now". */
  poll(): Promise<void> {
    this.polling ??= this.diff().finally(() => (this.polling = null));
    return this.polling;
  }

  // -------------------------------------------------------------------------------

  private async diff() {
    let entries: VaultEntry[];
    try {
      entries = await this.backend.list(this.root);
    } catch {
      return; // folder temporarily unavailable (drive unmounted, ...): try again next time
    }
    const next = new Map(entries.map((e) => [e.path, signature(e)]));
    const prev = this.snapshot;
    this.snapshot = next;
    if (!prev) return;
    for (const [path, sig] of next) {
      const before = prev.get(path);
      if (before === undefined) this.emit({ type: "create", path });
      else if (before !== sig && !sig.startsWith("folder")) this.emit({ type: "modify", path });
    }
    for (const path of prev.keys()) if (!next.has(path)) this.emit({ type: "delete", path });
  }

  private startPolling() {
    this.snapshot = null;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    if (typeof window !== "undefined") window.addEventListener("focus", this.onFocus);
  }

  private stopPolling() {
    clearInterval(this.timer);
    if (typeof window !== "undefined") window.removeEventListener("focus", this.onFocus);
    this.snapshot = null;
  }

  private onFocus = () => void this.poll();

  /** Tell listeners about our own write and fold it into the snapshot so the next poll does not repeat it. */
  private async announce(change: VaultChange, path: string) {
    if (this.snapshot) {
      const entry = await this.backend.stat(this.root, path).catch(() => null);
      if (entry) this.snapshot.set(path, signature(entry));
    }
    this.emit(change);
  }

  private forget(path: string) {
    if (!this.snapshot) return;
    for (const key of [...this.snapshot.keys()]) if (key === path || key.startsWith(path + "/")) this.snapshot.delete(key);
  }

  private emit(change: VaultChange) {
    for (const l of this.listeners) l(change);
  }

  private async guard<T>(fn: () => Promise<T>, path: string): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw translate(e, path);
    }
  }
}

const signature = (e: VaultEntry) => `${e.kind}:${e.size}:${e.mtime}`;
