import { formatDate } from "./dates";
import type { NoteIndex } from "./index/note-index";
import { readVaultConfig, sanitizeFileName, uniquePath } from "./notes";
import { dirname, joinPath } from "./vault";
import type { VaultAdapter } from "./vault";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "application/pdf": "pdf",
};

/** Folder an attachment goes in, from the app setting (if set) or Obsidian's `attachmentFolderPath`. */
export function attachmentFolder(setting: string, fromPath: string): string {
  const raw = setting.trim();
  if (raw === "" || raw === "/") return "";
  if (raw === "." || raw === "./") return dirname(fromPath);
  if (raw.startsWith("./")) return joinPath(dirname(fromPath), raw.slice(2));
  return raw.replace(/^\/+|\/+$/g, "");
}

export interface SaveAttachmentOptions {
  bytes: Uint8Array;
  /** Original file name if there is one (dropped files); pasted clipboard images have none. */
  name?: string;
  mime?: string;
  /** The note the attachment is added to, for "next to the note" folders. */
  fromPath: string;
  /** The app's own folder setting; blank follows the vault's Obsidian config. */
  folderSetting?: string;
  now?: Date;
}

/** Whether a dropped or pasted file is something we embed with `![[...]]`. */
export const isImageMime = (mime: string | undefined) => (mime ?? "").startsWith("image/");

/** Save an attachment into the vault (never overwriting) and register it in the index. Returns its path. */
export async function saveAttachment(vault: VaultAdapter, index: NoteIndex, opts: SaveAttachmentOptions): Promise<string> {
  const setting = opts.folderSetting?.trim() ? opts.folderSetting : (await readVaultConfig(vault)).attachmentFolderPath;
  const dir = attachmentFolder(setting, opts.fromPath);
  const given = opts.name ? sanitizeFileName(opts.name.split(/[\\/]/).pop() ?? "") : "";
  let base = given.replace(/\.[^.]+$/, "");
  let ext = /\.([^.]+)$/.exec(given)?.[1] ?? "";
  if (!ext) ext = MIME_EXT[opts.mime ?? ""] ?? "bin";
  if (!base) base = `Pasted image ${formatDate(opts.now ?? new Date(), "YYYYMMDDHHmmss")}`;
  const path = uniquePath((p) => index.has(p), dir, base, ext);
  await vault.writeBinary(path, opts.bytes);
  index.addFile(path);
  return path;
}
