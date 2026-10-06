import { VaultError } from "./types";

/**
 * Normalize a user- or OS-supplied path into the canonical vault form:
 * forward slashes, no leading/trailing slash, no `.` segments.
 * `..` segments that would escape the vault are rejected.
 */
export function normalizePath(input: string): string {
  const out: string[] = [];
  for (const seg of input.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) throw new VaultError("invalid-path", input);
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

/** Parent folder path; the root's parent is "". */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Extension without the dot, lowercased: `Note.MD` -> `md`. */
export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

/** File name without extension, as Obsidian shows it: `a/Note.md` -> `Note`. */
export function stem(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf(".");
  return i <= 0 ? base : base.slice(0, i);
}

export function isMarkdown(path: string): boolean {
  return extname(path) === "md";
}

/** Obsidian's config folder. We read it for compatibility but never write it. */
export const CONFIG_DIR = ".obsidian";

/** Hidden paths (dot-folders like `.obsidian`, `.trash`, `.git`) are not shown in the file tree. */
export function isHidden(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith("."));
}

/** True if `path` is `folder` itself or lives somewhere under it. */
export function isWithin(path: string, folder: string): boolean {
  return folder === "" || path === folder || path.startsWith(folder + "/");
}
