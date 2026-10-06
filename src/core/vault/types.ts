/**
 * Storage abstraction for a vault.
 *
 * A vault is a folder tree of plain files, exactly like an Obsidian vault:
 * notes are `.md` files, attachments are whatever binary files sit next to
 * them, and `.obsidian/` holds Obsidian's own config (which we read but never
 * rewrite). Every backend (in-memory, local filesystem via Tauri, IndexedDB
 * cache in the browser, Google Drive) implements this one interface, so the
 * editor, link index and graph never know where the bytes live.
 *
 * Paths are always vault-relative, forward-slash separated, with no leading
 * slash: `folder/Note.md`. The vault root is the empty string "".
 */

export type EntryKind = "file" | "folder";

export interface VaultEntry {
  /** Vault-relative path, e.g. `Daily/2026-10-06.md`. */
  path: string;
  kind: EntryKind;
  /** Size in bytes (0 for folders). */
  size: number;
  /** Last modification time, ms since epoch (0 if unknown). */
  mtime: number;
}

export type VaultChange =
  | { type: "create" | "modify" | "delete"; path: string }
  | { type: "rename"; path: string; oldPath: string };

export type Unsubscribe = () => void;

export interface VaultAdapter {
  /** Stable id of this backend instance, e.g. `memory:sample` or `fs:/Users/me/Notes`. */
  readonly id: string;
  /** Human-readable vault name (usually the root folder name). */
  readonly name: string;

  /** Every file and folder in the vault, recursively. */
  list(): Promise<VaultEntry[]>;
  /** Metadata for one path, or `null` if it does not exist. */
  stat(path: string): Promise<VaultEntry | null>;

  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;

  /** Create or overwrite a file. Missing parent folders are created. */
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;

  mkdir(path: string): Promise<void>;
  /** Move a file or folder. Fails if `to` already exists. */
  rename(from: string, to: string): Promise<void>;
  /** Delete a file, or a folder with everything inside it. */
  remove(path: string): Promise<void>;

  /**
   * Notified of changes, including ones made outside the app (another editor,
   * a sync pull). Optional: backends that cannot watch simply omit it.
   */
  watch?(listener: (change: VaultChange) => void): Unsubscribe;
}

export class VaultError extends Error {
  constructor(
    readonly code: "not-found" | "exists" | "not-a-file" | "not-a-folder" | "invalid-path",
    readonly path: string,
  ) {
    super(`${code}: ${path}`);
    this.name = "VaultError";
  }
}
