/**
 * Pure text parsing for Obsidian-flavoured Markdown: wikilinks, embeds, tags,
 * headings and YAML front matter. No I/O, so it is shared by the note index,
 * the editor and (later) the graph view.
 */

export interface ParsedLink {
  /** Text between the brackets, untouched: `Note#Heading|alias`. */
  raw: string;
  /** Note (or attachment) name/path, without heading, block id or alias. May be empty (`[[#Heading]]`). */
  target: string;
  /** `Heading` for `[[Note#Heading]]`. */
  heading?: string;
  /** `abc123` for `[[Note#^abc123]]`. */
  block?: string;
  /** Display text for `[[Note|alias]]`. */
  alias?: string;
  /** `![[...]]` */
  embed: boolean;
  /** Offsets of the whole `[[...]]` (including a leading `!`) in the source. */
  start: number;
  end: number;
  /** 0-based line number. */
  line: number;
}

export interface ParsedHeading {
  level: number;
  text: string;
  line: number;
}

export interface ParsedNote {
  links: ParsedLink[];
  /** Tags without the leading `#`, deduplicated: body `#tags` plus front matter `tags`. */
  tags: string[];
  aliases: string[];
  headings: ParsedHeading[];
  frontmatter: Record<string, unknown>;
}

export const WIKILINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;
export const TAG_RE = /(?<![\p{L}\p{N}_&/#\\[])#([\p{L}\p{N}_\-/]+)/gu;
export const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function parseNote(text: string): ParsedNote {
  const fm = splitFrontmatter(text);
  const frontmatter = parseFrontmatter(fm.yaml);
  const masked = maskCode(text);

  const links = linksIn(masked);

  // Tags and headings only count in the body, not in front matter.
  const body = masked.slice(0, fm.length).replace(/[^\n]/g, " ") + masked.slice(fm.length);
  const tags = new Set<string>();
  for (const m of body.matchAll(TAG_RE)) {
    if (/^[\d/_-]+$/.test(m[1])) continue; // `#123` is not a tag
    tags.add(m[1].replace(/\/+$/, ""));
  }
  for (const t of toStringList(frontmatter.tags ?? frontmatter.tag)) {
    const clean = t.replace(/^#/, "").trim();
    if (clean) tags.add(clean);
  }

  const aliases = toStringList(frontmatter.aliases ?? frontmatter.alias);
  const headings: ParsedHeading[] = [];
  body.split("\n").forEach((lineText, line) => {
    const m = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lineText);
    if (m) headings.push({ level: m[1].length, text: m[2].trim(), line });
  });

  return { links, tags: [...tags], aliases, headings, frontmatter };
}

/** Wikilinks and embeds in `text`, ignoring ones inside code. */
export function extractLinks(text: string): ParsedLink[] {
  return linksIn(maskCode(text));
}

function linksIn(text: string): ParsedLink[] {
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);

  const links: ParsedLink[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const start = m.index!;
    links.push({ ...parseLinkInner(m[2]), embed: m[1] === "!", start, end: start + m[0].length, line: lineAt(lineStarts, start) });
  }
  return links;
}

/** Split `Note#Heading|alias` (alias after the first unescaped `|`). */
export function parseLinkInner(raw: string): Pick<ParsedLink, "raw" | "target" | "heading" | "block" | "alias"> {
  let target = raw;
  let alias: string | undefined;
  // Inside Markdown tables the separator is written `\|`; both forms mean "alias follows".
  const pipe = /\\?\|/.exec(raw);
  if (pipe) {
    target = raw.slice(0, pipe.index);
    alias = raw.slice(pipe.index + pipe[0].length).trim();
  }

  let heading: string | undefined;
  let block: string | undefined;
  const hash = target.indexOf("#");
  if (hash !== -1) {
    const frag = target.slice(hash + 1).trim();
    target = target.slice(0, hash);
    if (frag.startsWith("^")) block = frag.slice(1);
    else if (frag) heading = frag;
  }
  return { raw, target: target.trim(), heading, block, alias };
}

function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Replace fenced code blocks and inline code with spaces (same length, newlines kept) so offsets stay valid. */
function maskCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text
    .replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[`~]*[ \t]*(?=\n|$)|$)/gm, blank)
    .replace(/(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g, blank);
}

// ---------------------------------------------------------------- front matter

function splitFrontmatter(text: string): { yaml: string; length: number } {
  const m = FRONTMATTER.exec(text);
  return m ? { yaml: m[1] ?? "", length: m[0].length } : { yaml: "", length: 0 };
}

/**
 * Minimal YAML reader for the shapes Obsidian properties use: `key: scalar`,
 * `key: [a, b]`, and block lists (`key:` followed by `- item` lines).
 * Anything fancier is kept as a raw string.
 */
export function parseFrontmatter(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\s#:][^:]*?):(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].trim();
    const value = (m[2] ?? "").trim();
    if (value === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s*-\s+/, "").trim()));
      }
      if (items.length) out[key] = items;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = splitFlowList(value.slice(1, -1));
    } else {
      out[key] = unquote(value);
    }
  }
  return out;
}

function splitFlowList(s: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ",") {
      items.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  items.push(cur.trim());
  return items.filter(Boolean);
}

function unquote(s: string): string {
  const m = /^(["'])(.*)\1$/.exec(s);
  return m ? m[2] : s;
}

function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}
