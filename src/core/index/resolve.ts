import { basename, dirname, isMarkdown, stem } from "../vault/paths";

/** What link resolution needs to know about the vault: every file path, plus per-note aliases. */
export interface ResolveContext {
  files: Iterable<string>;
  /** Optional fast lookup: files whose lowercased base name (with extension) is `name`. */
  filesNamed?: (name: string) => readonly string[];
  aliasesOf?: (path: string) => readonly string[];
}

/**
 * Resolve a wikilink target to a file path, following Obsidian's rules:
 * - A bare name matches by file name (extension optional for notes). With several
 *   matches the shortest path wins; ties prefer the linking note's own folder.
 * - A target containing `/` matches a full path, or a path suffix (`b/Note` finds `a/b/Note.md`).
 * - Front matter aliases are the fallback after file names.
 * - Matching is case-insensitive.
 * Returns `null` when the link is unresolved.
 */
export function resolveLink(target: string, fromPath: string, ctx: ResolveContext): string | null {
  const t = target.trim().replace(/^\/+/, "");
  if (t === "") return fromPath; // `[[#Heading]]` points at the current note
  const found = matchByName(t, ctx);
  if (found.length) return pickClosest(found, fromPath);
  return viaAlias(t, ctx, fromPath);
}

/** Files whose name (or path suffix) equals `target`, ignoring case and the `.md` extension. */
function matchByName(target: string, ctx: ResolveContext): string[] {
  const want = target.toLowerCase();
  const wantMd = isMarkdown(want) ? want : want + ".md";

  const matches = (f: string) => {
    const lower = f.toLowerCase();
    if (want.includes("/")) {
      return [want, wantMd].some((w) => lower === w || lower.endsWith("/" + w));
    }
    // Bare name: notes match without extension, other files need the full name.
    return basename(lower) === want || basename(lower) === wantMd;
  };

  if (!ctx.filesNamed) return [...ctx.files].filter(matches);
  const last = basename(want);
  const lastMd = basename(wantMd);
  return [...new Set([...ctx.filesNamed(last), ...ctx.filesNamed(lastMd)])].filter(matches);
}

function viaAlias(target: string, ctx: ResolveContext, fromPath: string): string | null {
  const want = target.toLowerCase();
  if (!ctx.aliasesOf || want.includes("/")) return null;
  const hits = [...ctx.files].filter((f) => isMarkdown(f) && ctx.aliasesOf!(f).some((a) => a.toLowerCase() === want));
  return hits.length ? pickClosest(hits, fromPath) : null;
}

function pickClosest(candidates: string[], fromPath: string): string {
  const fromDir = dirname(fromPath);
  return [...candidates].sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    if (depth !== 0) return depth;
    const sameDir = Number(dirname(b) === fromDir) - Number(dirname(a) === fromDir);
    return sameDir !== 0 ? sameDir : a.localeCompare(b);
  })[0];
}

/**
 * The text to put inside `[[...]]` when linking to `path` from `fromPath`:
 * the bare note name when it is unambiguous, otherwise the shortest path that is.
 */
export function linkTextFor(path: string, ctx: ResolveContext): string {
  const unique = (candidate: string) => {
    const found = matchByName(candidate, ctx);
    return found.length === 1 && found[0] === path;
  };
  const name = isMarkdown(path) ? stem(path) : basename(path);
  if (unique(name)) return name;
  const parts = (isMarkdown(path) ? path.slice(0, -3) : path).split("/");
  for (let n = 2; n <= parts.length; n++) {
    const candidate = parts.slice(-n).join("/");
    if (unique(candidate)) return candidate;
  }
  return isMarkdown(path) ? path.slice(0, -3) : path;
}

