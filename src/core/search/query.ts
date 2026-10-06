/**
 * Search query syntax (a subset of Obsidian's):
 *   word            the note's text or path contains it (case-insensitive)
 *   "exact phrase"  contains the phrase
 *   -word           must not contain it (also `-"phrase"`, `-tag:x`, `-path:x`)
 *   path:folder     the note's full path contains it
 *   file:name       the file name contains it
 *   tag:x / #x      the note has the tag (`tag:a` also matches `a/b`)
 *   content:word    the text (not the path) contains it
 * Every condition must hold. `path:"my folder"` quotes work for any operator.
 */

export type SearchField = "any" | "content" | "path" | "file" | "tag";

export interface SearchTerm {
  field: SearchField;
  /** Lowercased text to look for. */
  value: string;
  negated: boolean;
}

export interface ParsedQuery {
  terms: SearchTerm[];
}

const TOKEN = /(-?)(?:(path|file|tag|content):)?(?:"([^"]*)"?|(\S+))/gi;

export function parseQuery(input: string): ParsedQuery {
  const terms: SearchTerm[] = [];
  for (const m of input.matchAll(TOKEN)) {
    const negated = m[1] === "-";
    let field = (m[2]?.toLowerCase() ?? "any") as SearchField;
    let value = (m[3] ?? m[4] ?? "").trim().toLowerCase();
    if (field === "any" && m[3] === undefined && value.length > 1 && value.startsWith("#")) {
      field = "tag";
    }
    if (field === "tag") value = value.replace(/^#/, "").replace(/\/+$/, "");
    if (value === "") continue;
    terms.push({ field, value, negated });
  }
  return { terms };
}

/** True when a query has at least one condition that can match (a lone `-word` still counts). */
export function isEmptyQuery(q: ParsedQuery): boolean {
  return q.terms.length === 0;
}
