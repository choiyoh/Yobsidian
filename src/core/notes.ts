import { extractLinks } from "./index/parse";
import type { NoteIndex } from "./index/note-index";
import { CONFIG_DIR, basename, dirname, isMarkdown, isWithin, joinPath } from "./vault";
import type { VaultAdapter } from "./vault";

/** The few Obsidian settings (`.obsidian/app.json`) that affect where and how notes are created. */
export interface VaultConfig {
  newFileLocation: "root" | "current" | "folder";
  newFileFolderPath: string;
  /** Obsidian's `attachmentFolderPath`: `/` or empty = vault root, `./name` = next to the note, otherwise a vault folder. */
  attachmentFolderPath: string;
}

export async function readVaultConfig(vault: VaultAdapter): Promise<VaultConfig> {
  const config: VaultConfig = { newFileLocation: "root", newFileFolderPath: "", attachmentFolderPath: "" };
  try {
    const raw = JSON.parse(await vault.readText(`${CONFIG_DIR}/app.json`));
    if (raw.newFileLocation === "current" || raw.newFileLocation === "folder") config.newFileLocation = raw.newFileLocation;
    if (typeof raw.newFileFolderPath === "string") config.newFileFolderPath = raw.newFileFolderPath.replace(/^\/+|\/+$/g, "");
    if (typeof raw.attachmentFolderPath === "string") config.attachmentFolderPath = raw.attachmentFolderPath.trim();
  } catch {
    // no config, or not valid JSON: keep defaults
  }
  return config;
}

/** Characters Windows, macOS and Obsidian all refuse in file names. */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/^\.+/, "").trim();
}

/** `dir/name.ext`, or `dir/name 1.ext`, `name 2.ext`... if that is taken. */
export function uniquePath(exists: (path: string) => boolean, dir: string, name: string, ext = "md"): string {
  const suffix = ext ? `.${ext}` : "";
  let candidate = joinPath(dir, name + suffix);
  for (let n = 1; exists(candidate); n++) candidate = joinPath(dir, `${name} ${n}${suffix}`);
  return candidate;
}

export interface CreateNoteOptions {
  /** Note name, or a `folder/name` path (as written in a link). */
  name: string;
  /** The note the user is in; used by the "same folder as current note" setting. */
  fromPath?: string;
  /** Force a folder (e.g. the folder selected in the explorer), overriding the vault setting. */
  folder?: string;
  text?: string;
}

/** Create a note and register it in the index. Returns its path. Never overwrites. */
export async function createNote(vault: VaultAdapter, index: NoteIndex, opts: CreateNoteOptions): Promise<string> {
  const cleanName = opts.name.replace(/\.md$/i, "").split("/").map(sanitizeFileName).filter(Boolean);
  const leaf = cleanName.pop() || "Untitled";
  let dir: string;
  if (cleanName.length) dir = cleanName.join("/");
  else if (opts.folder !== undefined) dir = opts.folder;
  else {
    const config = await readVaultConfig(vault);
    dir =
      config.newFileLocation === "current" ? dirname(opts.fromPath ?? "") : config.newFileLocation === "folder" ? config.newFileFolderPath : "";
  }
  const path = uniquePath((p) => index.has(p), dir, leaf);
  const text = opts.text ?? "";
  await vault.writeText(path, text);
  index.setNote(path, text, (await vault.stat(path)) ?? undefined);
  return path;
}

interface PendingEdit {
  /** Path the source note had before the move. */
  source: string;
  start: number;
  end: number;
  oldPath: string;
  link: ReturnType<typeof extractLinks>[number];
}

/**
 * Move a file or folder and rewrite every `[[link]]` that pointed at something inside it,
 * like Obsidian's "automatically update internal links". Throws (via the adapter) if `to` exists.
 */
export async function movePath(vault: VaultAdapter, index: NoteIndex, from: string, to: string): Promise<void> {
  const moved = [...index.files].filter((f) => isWithin(f, from));
  const mapPath = (p: string) => (isWithin(p, from) ? to + p.slice(from.length) : p);

  // 1. Find the links to fix while the index still describes the old layout.
  const edits: PendingEdit[] = [];
  const sources = new Set<string>();
  for (const oldPath of moved) {
    if (isMarkdown(oldPath)) sources.add(oldPath); // self-links aren't backlinks
    for (const b of index.backlinksTo(oldPath)) sources.add(b.source);
  }
  for (const source of sources) {
    const text = await vault.readText(source);
    for (const link of extractLinks(text)) {
      const target = index.resolve(link.target, source);
      if (target && target !== source && moved.includes(target)) {
        edits.push({ source, start: link.start, end: link.end, oldPath: target, link });
      } else if (target === source && moved.includes(source) && link.target !== "") {
        // a note linking to itself by name
        edits.push({ source, start: link.start, end: link.end, oldPath: target, link });
      }
    }
  }

  // 2. Move on disk and in the index.
  await vault.rename(from, to);
  for (const oldPath of moved) index.removeNote(oldPath);
  for (const oldPath of moved) {
    const newPath = mapPath(oldPath);
    if (isMarkdown(newPath)) index.setNote(newPath, await vault.readText(newPath), (await vault.stat(newPath)) ?? undefined);
    else index.addFile(newPath);
  }

  // 3. Rewrite links, last-to-first within each note so offsets stay valid.
  const bySource = new Map<string, PendingEdit[]>();
  for (const e of edits) (bySource.get(e.source) ?? bySource.set(e.source, []).get(e.source)!).push(e);
  for (const [oldSource, list] of bySource) {
    const source = mapPath(oldSource);
    let text = await vault.readText(source);
    for (const e of list.sort((a, b) => b.start - a.start)) {
      const newTarget = index.linkTextFor(mapPath(e.oldPath));
      text = text.slice(0, e.start) + formatLink(e.link, newTarget) + text.slice(e.end);
    }
    await vault.writeText(source, text);
    index.setNote(source, text, (await vault.stat(source)) ?? undefined);
  }
}

function formatLink(link: PendingEdit["link"], target: string): string {
  let inner = target;
  if (link.heading) inner += "#" + link.heading;
  else if (link.block) inner += "#^" + link.block;
  if (link.alias !== undefined) inner += "|" + link.alias;
  return (link.embed ? "!" : "") + `[[${inner}]]`;
}

/** Move a file or folder into the vault's `.trash/` folder (hidden in the explorer, recoverable by hand). */
export async function trashPath(vault: VaultAdapter, index: NoteIndex, path: string): Promise<void> {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  const isFile = (await vault.stat(path))?.kind === "file";
  const [name, ext] = isFile && dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  let target = joinPath(".trash", base);
  for (let n = 1; await vault.stat(target); n++) target = joinPath(".trash", `${name} ${n}${ext}`);
  await vault.rename(path, target);
  for (const f of [...index.files]) if (isWithin(f, path)) index.removeNote(f);
}
