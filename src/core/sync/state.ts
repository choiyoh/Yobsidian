/** What the sync engine remembers between runs, per (local vault, Drive folder) pair. */

export interface SyncFileEntry {
  /** Drive file id. */
  id: string;
  /** MD5 of the content as of the last sync; at that moment local and remote were identical. */
  hash: string;
  /** Local size and mtime at that moment: if both still match, the file is unchanged and need not be re-read. */
  size: number;
  mtime: number;
}

export interface SyncState {
  version: 1;
  /** Drive folder id that is the vault root. */
  rootId: string;
  /** Drive `changes` cursor; absent means "list the whole remote tree next time". */
  pageToken?: string;
  /** When the whole remote tree was last listed (ms since epoch). */
  lastFullAt?: number;
  files: Record<string, SyncFileEntry>;
  folders: Record<string, { id: string }>;
}

export function freshState(rootId: string): SyncState {
  return { version: 1, rootId, files: {}, folders: {} };
}

export interface SyncStore {
  load(): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
  /** The text of a note as of the last sync, the "base" for three-way merges. */
  getBase(path: string): Promise<string | undefined>;
  setBase(path: string, text: string): Promise<void>;
  deleteBase(path: string): Promise<void>;
  /** Forget everything (used when a vault is unlinked from Drive). */
  clear(): Promise<void>;
}

export class MemorySyncStore implements SyncStore {
  state: SyncState | null = null;
  bases = new Map<string, string>();
  async load() {
    return this.state ? structuredClone(this.state) : null;
  }
  async save(state: SyncState) {
    this.state = structuredClone(state);
  }
  async getBase(path: string) {
    return this.bases.get(path);
  }
  async setBase(path: string, text: string) {
    this.bases.set(path, text);
  }
  async deleteBase(path: string) {
    this.bases.delete(path);
  }
  async clear() {
    this.state = null;
    this.bases.clear();
  }
}

const META = "meta";
const BASES = "bases";

/** Sync state in IndexedDB (works in the browser and in the desktop webview). */
export class IdbSyncStore implements SyncStore {
  private db: Promise<IDBDatabase>;

  constructor(vaultKey: string) {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(`yobsidian-sync:${vaultKey}`, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(META);
        req.result.createObjectStore(BASES);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  load = () => this.get<SyncState>(META, "state").then((s) => s ?? null);
  save = (state: SyncState) => this.put(META, "state", state);
  getBase = (path: string) => this.get<string>(BASES, path);
  setBase = (path: string, text: string) => this.put(BASES, path, text);
  deleteBase = async (path: string) => void (await this.tx(BASES, "readwrite", (s) => s.delete(path)));
  clear = async () => {
    await this.tx(META, "readwrite", (s) => s.clear());
    await this.tx(BASES, "readwrite", (s) => s.clear());
  };

  async close() {
    (await this.db).close();
  }

  private get<T>(store: string, key: string): Promise<T | undefined> {
    return this.tx<T | undefined>(store, "readonly", (s) => s.get(key));
  }
  private async put(store: string, key: string, value: unknown) {
    await this.tx(store, "readwrite", (s) => s.put(value, key));
  }
  private async tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
