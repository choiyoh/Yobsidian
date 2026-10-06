import { dirname, isWithin, normalizePath } from "./paths";
import { VaultError, type VaultAdapter, type VaultChange, type VaultEntry, type Unsubscribe } from "./types";

type Node = { kind: "folder"; mtime: number } | { kind: "file"; mtime: number; data: Uint8Array };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A vault held entirely in memory. Used for the sample vault, for tests, and
 * as the reference implementation of {@link VaultAdapter} semantics that the
 * filesystem and Google Drive backends must match.
 */
export class MemoryAdapter implements VaultAdapter {
  private nodes = new Map<string, Node>();
  private listeners = new Set<(change: VaultChange) => void>();

  constructor(
    readonly name: string,
    files: Record<string, string> = {},
    readonly id = `memory:${name}`,
  ) {
    for (const [path, content] of Object.entries(files)) {
      this.putFile(normalizePath(path), encoder.encode(content));
    }
  }

  async list(): Promise<VaultEntry[]> {
    return [...this.nodes].map(([path, node]) => toEntry(path, node));
  }

  async stat(path: string): Promise<VaultEntry | null> {
    const p = normalizePath(path);
    const node = this.nodes.get(p);
    return node ? toEntry(p, node) : null;
  }

  async readText(path: string): Promise<string> {
    return decoder.decode(this.getFile(path));
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return this.getFile(path).slice();
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.writeBinary(path, encoder.encode(content));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const p = normalizePath(path);
    if (p === "") throw new VaultError("invalid-path", path);
    const existing = this.nodes.get(p);
    if (existing?.kind === "folder") throw new VaultError("not-a-file", p);
    this.putFile(p, data.slice());
    this.emit({ type: existing ? "modify" : "create", path: p });
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    const existing = this.nodes.get(p);
    if (existing?.kind === "file") throw new VaultError("not-a-folder", p);
    if (existing || p === "") return;
    this.ensureFolders(p);
    this.emit({ type: "create", path: p });
  }

  async rename(from: string, to: string): Promise<void> {
    const src = normalizePath(from);
    const dst = normalizePath(to);
    if (!this.nodes.has(src)) throw new VaultError("not-found", src);
    if (this.nodes.has(dst)) throw new VaultError("exists", dst);
    if (isWithin(dst, src)) throw new VaultError("invalid-path", dst);
    this.ensureFolders(dirname(dst));
    for (const [path, node] of [...this.nodes]) {
      if (!isWithin(path, src)) continue;
      this.nodes.delete(path);
      this.nodes.set(dst + path.slice(src.length), node);
    }
    this.emit({ type: "rename", path: dst, oldPath: src });
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === "" || !this.nodes.has(p)) throw new VaultError("not-found", p);
    for (const key of [...this.nodes.keys()]) {
      if (isWithin(key, p)) this.nodes.delete(key);
    }
    this.emit({ type: "delete", path: p });
  }

  watch(listener: (change: VaultChange) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private getFile(path: string): Uint8Array {
    const p = normalizePath(path);
    const node = this.nodes.get(p);
    if (!node) throw new VaultError("not-found", p);
    if (node.kind !== "file") throw new VaultError("not-a-file", p);
    return node.data;
  }

  private putFile(path: string, data: Uint8Array) {
    this.ensureFolders(dirname(path));
    this.nodes.set(path, { kind: "file", mtime: Date.now(), data });
  }

  private ensureFolders(path: string) {
    if (path === "") return;
    const existing = this.nodes.get(path);
    if (existing?.kind === "file") throw new VaultError("not-a-folder", path);
    if (existing) return;
    this.ensureFolders(dirname(path));
    this.nodes.set(path, { kind: "folder", mtime: Date.now() });
  }

  private emit(change: VaultChange) {
    for (const listener of this.listeners) listener(change);
  }
}

function toEntry(path: string, node: Node): VaultEntry {
  return {
    path,
    kind: node.kind,
    size: node.kind === "file" ? node.data.byteLength : 0,
    mtime: node.mtime,
  };
}
