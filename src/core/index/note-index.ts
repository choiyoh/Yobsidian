import { basename, isHidden, isMarkdown, stem } from "../vault/paths";
import type { VaultAdapter, VaultEntry } from "../vault/types";
import { parseNote, type ParsedHeading, type ParsedLink, type ParsedNote } from "./parse";
import { linkTextFor, resolveLink, type ResolveContext } from "./resolve";

export interface ResolvedLink extends ParsedLink {
  /** Path of the file this link points at, or `null` if no such file exists (yet). */
  resolved: string | null;
}

export interface Backlink {
  /** The note that contains the link. */
  source: string;
  link: ResolvedLink;
  /** The full text of the line holding the link, for display. */
  context: string;
}

export interface GraphData {
  nodes: { path: string; name: string; tags: string[] }[];
  /** Directed edges between existing notes (self-links and duplicates removed). */
  edges: { source: string; target: string }[];
}

interface NoteRecord extends ParsedNote {
  lines: string[];
}

/**
 * In-memory index of every note's links, backlinks, tags, aliases and headings.
 * The editor, backlinks panel and tag list read from it; the graph view reuses
 * {@link NoteIndex.graph}. It never touches storage itself except in `load`/`refresh`.
 */
export class NoteIndex implements ResolveContext {
  private notes = new Map<string, NoteRecord>();
  private fileSet = new Set<string>();
  private listeners = new Set<() => void>();
  private cache: { links: Map<string, ResolvedLink[]>; backlinks: Map<string, Backlink[]> | null } | null = null;

  get files(): Iterable<string> {
    return this.fileSet;
  }

  filesNamed = (name: string): readonly string[] => {
    if (!this.byName) {
      this.byName = new Map();
      for (const f of this.fileSet) {
        const key = basename(f).toLowerCase();
        (this.byName.get(key) ?? this.byName.set(key, []).get(key)!).push(f);
      }
    }
    return this.byName.get(name) ?? [];
  };
  private byName: Map<string, string[]> | null = null;

  aliasesOf = (path: string): readonly string[] => this.notes.get(path)?.aliases ?? [];

  /** Build the whole index from a vault. */
  async load(vault: VaultAdapter): Promise<void> {
    const entries = (await vault.list()).filter((e) => e.kind === "file" && !isHidden(e.path));
    this.fileSet = new Set(entries.map((e) => e.path));
    this.notes.clear();
    this.stamps.clear();
    await Promise.all(
      entries
        .filter((e) => isMarkdown(e.path))
        .map(async (e) => {
          this.stamps.set(e.path, stamp(e));
          this.notes.set(e.path, toRecord(await vault.readText(e.path)));
        }),
    );
    this.changed();
  }

  /** Bring the index in line with the vault after external changes, reading only notes whose mtime/size moved. */
  async refresh(vault: VaultAdapter, entries?: VaultEntry[]): Promise<void> {
    const files = (entries ?? (await vault.list())).filter((e) => e.kind === "file" && !isHidden(e.path));
    const next = new Set(files.map((e) => e.path));
    let dirty = next.size !== this.fileSet.size || [...next].some((p) => !this.fileSet.has(p));
    for (const p of [...this.notes.keys()]) if (!next.has(p)) this.notes.delete(p);
    this.fileSet = next;
    const stale = files.filter((e) => isMarkdown(e.path) && (!this.notes.has(e.path) || this.stamps.get(e.path) !== stamp(e)));
    for (const e of stale) {
      this.stamps.set(e.path, stamp(e));
      this.notes.set(e.path, toRecord(await vault.readText(e.path)));
      dirty = true;
    }
    if (dirty) this.changed();
  }
  private stamps = new Map<string, string>();

  /** Update one note from fresh text (call after saving or editing). */
  setNote(path: string, text: string, entry?: VaultEntry): void {
    this.fileSet.add(path);
    this.notes.set(path, toRecord(text));
    if (entry) this.stamps.set(path, stamp(entry));
    else this.stamps.delete(path);
    this.changed();
  }

  removeNote(path: string): void {
    this.fileSet.delete(path);
    this.notes.delete(path);
    this.stamps.delete(path);
    this.changed();
  }

  /** Register a non-note file (attachment) so `![[image.png]]` resolves. */
  addFile(path: string): void {
    if (this.fileSet.has(path)) return;
    this.fileSet.add(path);
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------------ queries

  has(path: string): boolean {
    return this.fileSet.has(path);
  }

  /** Every note path, sorted. */
  notePaths(): string[] {
    return [...this.notes.keys()].sort((a, b) => a.localeCompare(b));
  }

  resolve(target: string, fromPath: string): string | null {
    return resolveLink(target, fromPath, this);
  }

  /** Text to put in `[[...]]` to link to `path`. */
  linkTextFor(path: string): string {
    return linkTextFor(path, this);
  }

  /** Outgoing links of a note, resolved. */
  linksFrom(path: string): ResolvedLink[] {
    const cache = this.ensureCache();
    let links = cache.links.get(path);
    if (!links) {
      links = (this.notes.get(path)?.links ?? []).map((l) => ({ ...l, resolved: this.resolve(l.target, path) }));
      cache.links.set(path, links);
    }
    return links;
  }

  /** Notes that link to `path`, in note order. */
  backlinksTo(path: string): Backlink[] {
    const cache = this.ensureCache();
    if (!cache.backlinks) {
      cache.backlinks = new Map();
      for (const source of this.notePaths()) {
        for (const link of this.linksFrom(source)) {
          if (!link.resolved || link.resolved === source) continue;
          const rec = this.notes.get(source)!;
          const list = cache.backlinks.get(link.resolved) ?? [];
          list.push({ source, link, context: rec.lines[link.line]?.trim() ?? "" });
          cache.backlinks.set(link.resolved, list);
        }
      }
    }
    return cache.backlinks.get(path) ?? [];
  }

  /** Link targets that do not exist yet, with the notes that mention them. */
  unresolved(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const source of this.notePaths()) {
      for (const link of this.linksFrom(source)) {
        if (link.resolved || !link.target) continue;
        const list = out.get(link.target) ?? [];
        if (!list.includes(source)) list.push(source);
        out.set(link.target, list);
      }
    }
    return out;
  }

  tagsOf(path: string): string[] {
    return this.notes.get(path)?.tags ?? [];
  }

  headingsOf(path: string): ParsedHeading[] {
    return this.notes.get(path)?.headings ?? [];
  }

  /** All tags with the notes that use them. Parent tags include their children (`a` covers `a/b`). */
  tags(): Map<string, string[]> {
    const out = new Map<string, Set<string>>();
    for (const [path, rec] of this.notes) {
      for (const tag of rec.tags) {
        const parts = tag.split("/");
        for (let i = 1; i <= parts.length; i++) {
          const key = parts.slice(0, i).join("/");
          (out.get(key) ?? out.set(key, new Set()).get(key)!).add(path);
        }
      }
    }
    return new Map([...out].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]));
  }

  /** Notes matching a query by name or alias, best matches first. Empty query lists everything. */
  search(query: string, limit = 50): { path: string; name: string; alias?: string }[] {
    const q = query.trim().toLowerCase();
    const results: { path: string; name: string; alias?: string; score: number }[] = [];
    for (const path of this.notes.keys()) {
      const name = stem(path);
      const score = q ? matchScore(name.toLowerCase(), path.toLowerCase(), q) : 1;
      if (score > 0) results.push({ path, name, score });
      if (!q) continue;
      for (const alias of this.aliasesOf(path)) {
        const s = matchScore(alias.toLowerCase(), "", q);
        if (s > 0) results.push({ path, name, alias, score: s * 0.9 });
      }
    }
    results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return results.slice(0, limit).map(({ score: _score, ...r }) => r);
  }

  /** Whole-vault link graph, for the graph view. */
  graph(): GraphData {
    const nodes = this.notePaths().map((path) => ({ path, name: stem(path), tags: this.tagsOf(path) }));
    const seen = new Set<string>();
    const edges: GraphData["edges"] = [];
    for (const { path } of nodes) {
      for (const link of this.linksFrom(path)) {
        if (!link.resolved || link.resolved === path || !this.notes.has(link.resolved)) continue;
        const key = `${path}\0${link.resolved}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: path, target: link.resolved });
      }
    }
    return { nodes, edges };
  }

  // ----------------------------------------------------------------- internals

  private ensureCache() {
    return (this.cache ??= { links: new Map(), backlinks: null });
  }

  /** Bumps on every change; handy as a React `useSyncExternalStore` snapshot. */
  version = 0;

  private changed() {
    this.version++;
    this.cache = null;
    this.byName = null;
    for (const l of this.listeners) l();
  }
}

function toRecord(text: string): NoteRecord {
  return { ...parseNote(text), lines: text.split(/\r?\n/) };
}

function stamp(e: VaultEntry): string {
  return `${e.mtime}:${e.size}`;
}

function matchScore(name: string, path: string, q: string): number {
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (path.includes(q)) return 40;
  // subsequence ("fuzzy") match
  let i = 0;
  for (const ch of name) if (ch === q[i] && ++i === q.length) return 20;
  return 0;
}
