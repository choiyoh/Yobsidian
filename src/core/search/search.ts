import { basename, stem } from "../vault/paths";
import { parseQuery, type ParsedQuery, type SearchTerm } from "./query";

/** What the search needs to know about one note. */
export interface SearchDoc {
  path: string;
  /** Original text split into lines (for snippets). */
  lines: string[];
  /** Whole text lowercased once at indexing time, so a query is a handful of `includes` calls. */
  lower: string;
  tags: string[];
}

export interface SearchMatchLine {
  /** 0-based line number. */
  line: number;
  /** The line text (shortened around the first match when long). */
  text: string;
  /** [start, end) offsets into `text` of every hit, for highlighting. */
  ranges: [number, number][];
}

export interface SearchResult {
  path: string;
  name: string;
  score: number;
  /** Total number of text hits in the note. */
  count: number;
  /** The first few lines that matched (empty if the note matched by name/path/tag only). */
  matches: SearchMatchLine[];
}

export interface SearchOptions {
  limit?: number;
  /** Snippet lines kept per note. */
  linesPerNote?: number;
}

/** Search every note. Results are ranked by name matches first, then by how often the terms occur. */
export function searchDocs(docs: Iterable<SearchDoc>, query: string | ParsedQuery, opts: SearchOptions = {}): SearchResult[] {
  const q = typeof query === "string" ? parseQuery(query) : query;
  if (q.terms.length === 0) return [];
  const { limit = 100, linesPerNote = 3 } = opts;
  const positive = q.terms.filter((t) => !t.negated);
  const hits: { result: SearchResult; doc: SearchDoc }[] = [];

  for (const doc of docs) {
    const lowerPath = doc.path.toLowerCase();
    const lowerName = stem(doc.path).toLowerCase();
    if (!q.terms.every((t) => matches(t, doc, lowerPath) !== t.negated)) continue;

    let score = 0;
    let count = 0;
    for (const t of positive) {
      if (t.field === "tag") score += 5;
      if (t.field === "path" || t.field === "file") score += t.field === "file" || basename(lowerPath).includes(t.value) ? 20 : 8;
      if (t.field === "any" || t.field === "file") {
        if (lowerName === t.value) score += 100;
        else if (lowerName.includes(t.value)) score += 40;
        else if (lowerPath.includes(t.value)) score += 10;
      }
      if (t.field === "any" || t.field === "content") {
        count += countOccurrences(doc.lower, t.value);
      }
    }
    score += Math.min(count, 20);
    hits.push({ result: { path: doc.path, name: stem(doc.path), score, count, matches: [] }, doc });
  }

  hits.sort((a, b) => b.result.score - a.result.score || a.result.path.localeCompare(b.result.path));
  const top = hits.slice(0, limit);
  // Snippets are only worth building for the notes that are actually shown.
  const needles = [...new Set(positive.filter((t) => t.field === "any" || t.field === "content").map((t) => t.value))];
  if (needles.length && linesPerNote > 0) {
    for (const { result, doc } of top) result.matches = snippets(doc, needles, linesPerNote);
  }
  return top.map((h) => h.result);
}

const CONTEXT = 60;

function snippets(doc: SearchDoc, needles: string[], max: number): SearchMatchLine[] {
  const out: SearchMatchLine[] = [];
  for (let i = 0; i < doc.lines.length && out.length < max; i++) {
    const line = doc.lines[i];
    const lower = line.toLowerCase();
    if (lower.length !== line.length) continue; // rare case-mapping length change; offsets would drift
    const ranges: [number, number][] = [];
    for (const needle of needles) {
      for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length]);
    }
    if (!ranges.length) continue;
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    // Long lines: keep a window around the first hit.
    const from = Math.max(0, merged[0][0] - CONTEXT);
    const to = Math.min(line.length, merged[0][1] + CONTEXT * 2);
    const prefix = from > 0 ? "…" : "";
    const text = prefix + line.slice(from, to).trim() + (to < line.length ? "…" : "");
    const lead = line.slice(from, to).length - line.slice(from, to).trimStart().length;
    const shift = prefix.length - from - lead;
    out.push({
      line: i,
      text,
      ranges: merged.filter(([s, e]) => s >= from && e <= to).map(([s, e]) => [s + shift, e + shift] as [number, number]),
    });
  }
  return out;
}

function matches(t: SearchTerm, doc: SearchDoc, lowerPath: string): boolean {
  switch (t.field) {
    case "content":
      return doc.lower.includes(t.value);
    case "path":
      return lowerPath.includes(t.value);
    case "file":
      return basename(lowerPath).includes(t.value);
    case "tag":
      return doc.tags.some((tag) => {
        const lower = tag.toLowerCase();
        return lower === t.value || lower.startsWith(t.value + "/");
      });
    default:
      return doc.lower.includes(t.value) || lowerPath.includes(t.value);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}
