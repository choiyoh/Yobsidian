import { MemoryAdapter } from "./memory-adapter";
import { dirname, isWithin } from "./paths";
import type { Unsubscribe, VaultAdapter, VaultChange, VaultEntry } from "./types";

interface StoredNode {
  path: string;
  kind: "file" | "folder";
  mtime: number;
  data?: Uint8Array;
}

const STORE = "nodes";

/**
 * A vault persisted in the browser's IndexedDB: the web build's local copy.
 * Everything is mirrored in a {@link MemoryAdapter} (fast reads, identical
 * semantics) and each change is written through to IndexedDB, so a reload
 * brings the vault back. Holding the whole vault in memory is fine for notes;
 * very large attachment sets would want a lazy implementation later.
 */
export class IdbAdapter implements VaultAdapter {
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly mem: MemoryAdapter,
    private readonly db: IDBDatabase,
    readonly id: string,
    readonly name: string,
  ) {
    mem.watch((change) => {
      this.queue = this.queue.then(() => this.persist(change)).catch((e) => console.error("IndexedDB write failed", e));
    });
  }

  /** Open (or create) the named vault. A brand-new vault is filled with `seed` (path → text). */
  static async open(name: string, seed: Record<string, string> = {}): Promise<IdbAdapter> {
    const dbName = `yobsidian-vault:${name}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "path" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const records = await run<StoredNode[]>(db, "readonly", (s) => s.getAll());
    const mem = new MemoryAdapter(name, {}, `idb:${name}`);
    const adapter = new IdbAdapter(mem, db, `idb:${name}`, name);

    if (records.length === 0) {
      for (const [path, text] of Object.entries(seed)) await mem.writeText(path, text);
    } else {
      for (const r of records.sort((a, b) => a.path.localeCompare(b.path))) {
        if (r.kind === "folder") await mem.mkdir(r.path);
        else await mem.writeBinary(r.path, r.data ?? new Uint8Array());
      }
    }
    await adapter.queue;
    return adapter;
  }

  list = (): Promise<VaultEntry[]> => this.mem.list();
  stat = (path: string) => this.mem.stat(path);
  readText = (path: string) => this.mem.readText(path);
  readBinary = (path: string) => this.mem.readBinary(path);
  writeText = (path: string, content: string) => this.mem.writeText(path, content);
  writeBinary = (path: string, data: Uint8Array) => this.mem.writeBinary(path, data);
  mkdir = (path: string) => this.mem.mkdir(path);
  rename = (from: string, to: string) => this.mem.rename(from, to);
  remove = (path: string) => this.mem.remove(path);
  watch = (listener: (change: VaultChange) => void): Unsubscribe => this.mem.watch(listener);

  /** Resolves once every change made so far has reached IndexedDB. */
  flush(): Promise<void> {
    return this.queue;
  }

  close() {
    this.db.close();
  }

  private async persist(change: VaultChange): Promise<void> {
    const entries = await this.mem.list();
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const toPut = new Map<string, VaultEntry>();
    const withParents = (path: string) => {
      for (let p = path; p !== ""; p = dirname(p)) {
        const e = byPath.get(p);
        if (e) toPut.set(p, e);
      }
    };

    let removePrefix: string | null = null;
    if (change.type === "delete") removePrefix = change.path;
    else if (change.type === "rename") {
      removePrefix = change.oldPath;
      for (const e of entries) if (isWithin(e.path, change.path)) toPut.set(e.path, e);
      withParents(change.path);
    } else withParents(change.path);

    const records: StoredNode[] = [];
    for (const e of toPut.values()) {
      records.push(
        e.kind === "folder"
          ? { path: e.path, kind: "folder", mtime: e.mtime }
          : { path: e.path, kind: "file", mtime: e.mtime, data: await this.mem.readBinary(e.path) },
      );
    }

    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      if (removePrefix !== null) {
        store.delete(removePrefix);
        store.delete(IDBKeyRange.bound(removePrefix + "/", removePrefix + "/￿"));
      }
      for (const r of records) store.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
