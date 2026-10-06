import { WidgetType, type EditorView } from "@codemirror/view";
import { parseLinkInner } from "@/core/index/parse";
import { basename } from "@/core/vault";
import type { EditorEnv, LinkTarget } from "./env";
import { ImageWidget, isImagePath, linkAttrs } from "./widgets";

export type Align = "left" | "center" | "right" | null;

export type Inline =
  | { t: "text"; s: string }
  | { t: "code"; s: string }
  | { t: "br" }
  | { t: "fmt"; tag: "strong" | "em" | "del"; c: Inline[] }
  | { t: "wiki"; label: string; link: LinkTarget; unresolved: boolean }
  | { t: "image"; path: string; alt: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "tag"; tag: string };

export interface TableModel {
  align: Align[];
  header: Inline[][];
  rows: Inline[][][];
}

const DELIMITER_CELL = /^:?-+:?$/;

/**
 * Split one table row into raw cell strings. A cell ends at the first `|` that is neither
 * backslash-escaped nor inside a `[[wikilink]]` (Obsidian needs `\|` there, but an unescaped
 * `[[Note|alias]]` is common enough in hand-written tables that we keep it in one cell).
 * Leading and trailing pipes are optional.
 */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let wiki = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += ch + s[++i];
    } else if (ch === "[" && s[i + 1] === "[") {
      wiki = true;
      cur += "[[";
      i++;
    } else if (ch === "]" && s[i + 1] === "]") {
      wiki = false;
      cur += "]]";
      i++;
    } else if (ch === "|" && !wiki) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

export function parseAlign(cells: string[]): Align[] | null {
  if (!cells.length || !cells.every((c) => DELIMITER_CELL.test(c))) return null;
  return cells.map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
}

const INLINE_RE = new RegExp(
  [
    String.raw`(?<embed>!?)\[\[(?<wiki>[^\]\n]+?)\]\]`,
    String.raw`(?<ticks>\x60+)(?<code>.+?)\k<ticks>`,
    String.raw`\*\*(?<strong>.+?)\*\*`,
    String.raw`__(?<strong2>.+?)__`,
    String.raw`~~(?<del>.+?)~~`,
    String.raw`\*(?!\s)(?<em>[^*]+?)\*`,
    String.raw`(?<![\p{L}\p{N}_])_(?!\s)(?<em2>[^_]+?)_(?![\p{L}\p{N}_])`,
    String.raw`\[(?<text>[^\]]*)\]\((?<href>[^)\s]+)\)`,
    String.raw`(?<br><br\s*\/?>)`,
    String.raw`(?<![\p{L}\p{N}_&/#\\[])#(?<tag>[\p{L}\p{N}_\-/]+)`,
  ].join("|"),
  "gu",
);

/** Render the inline Markdown of a table cell into a small data model (so widgets can be compared and rebuilt cheaply). */
export function parseInline(s: string, env: Pick<EditorEnv, "index" | "path">): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const text = (end: number) => {
    if (end > last) out.push({ t: "text", s: s.slice(last, end).replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, "$1") });
  };
  for (const m of s.matchAll(INLINE_RE)) {
    const g = m.groups!;
    const start = m.index!;
    let node: Inline | null = null;
    if (g.wiki !== undefined) {
      const inner = parseLinkInner(g.wiki);
      const link = { target: inner.target, heading: inner.heading, block: inner.block };
      const resolved = env.index.resolve(inner.target, env.path);
      if (g.embed && resolved && isImagePath(resolved)) {
        node = { t: "image", path: resolved, alt: inner.alias ?? "" };
      } else {
        const label =
          inner.alias ?? (inner.target ? inner.target + (inner.heading ? " > " + inner.heading : "") : (inner.heading ?? ""));
        node = { t: "wiki", label: (g.embed ? "! " : "") + (label || basename(inner.target)), link, unresolved: resolved === null };
      }
    } else if (g.code !== undefined) {
      node = { t: "code", s: g.code.trim() };
    } else if (g.strong !== undefined || g.strong2 !== undefined) {
      node = { t: "fmt", tag: "strong", c: parseInline(g.strong ?? g.strong2, env) };
    } else if (g.del !== undefined) {
      node = { t: "fmt", tag: "del", c: parseInline(g.del, env) };
    } else if (g.em !== undefined || g.em2 !== undefined) {
      node = { t: "fmt", tag: "em", c: parseInline(g.em ?? g.em2, env) };
    } else if (g.href !== undefined) {
      node = { t: "link", href: g.href, c: parseInline(g.text, env) };
    } else if (g.br !== undefined) {
      node = { t: "br" };
    } else if (g.tag !== undefined && !/^[\d/_-]+$/.test(g.tag)) {
      node = { t: "tag", tag: g.tag.replace(/\/+$/, "") };
    }
    if (!node) continue;
    text(start);
    out.push(node);
    last = start + m[0].length;
  }
  text(s.length);
  return out;
}

/** Build the table model from the raw source lines of a GFM table, or `null` when it isn't one. */
export function parseTable(lines: string[], env: Pick<EditorEnv, "index" | "path">): TableModel | null {
  if (lines.length < 2) return null;
  const align = parseAlign(splitRow(lines[1]));
  if (!align) return null;
  const header = splitRow(lines[0]);
  const width = header.length;
  const pad = (cells: string[]) => {
    const row = cells.slice(0, width);
    while (row.length < width) row.push("");
    return row.map((c) => parseInline(c, env));
  };
  return {
    align: Array.from({ length: width }, (_, i) => align[i] ?? null),
    header: pad(header),
    rows: lines.slice(2).map((l) => pad(splitRow(l))),
  };
}

function renderInline(nodes: Inline[], parent: HTMLElement, env: EditorEnv) {
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        parent.append(n.s);
        break;
      case "code": {
        const el = document.createElement("code");
        el.className = "cm-inline-code";
        el.textContent = n.s;
        parent.append(el);
        break;
      }
      case "br":
        parent.append(document.createElement("br"));
        break;
      case "fmt": {
        const el = document.createElement(n.tag === "strong" ? "strong" : n.tag === "em" ? "em" : "del");
        el.className = n.tag === "strong" ? "cm-strong" : n.tag === "em" ? "cm-em" : "cm-strike";
        renderInline(n.c, el, env);
        parent.append(el);
        break;
      }
      case "wiki": {
        const el = document.createElement("span");
        el.className = "cm-wikilink" + (n.unresolved ? " cm-wikilink-unresolved" : "");
        el.textContent = n.label;
        for (const [k, v] of Object.entries(linkAttrs(n.link))) el.setAttribute(k, v);
        parent.append(el);
        break;
      }
      case "image":
        parent.append(new ImageWidget(env.vault, n.path, n.path, n.alt).toDOM());
        break;
      case "link": {
        const el = document.createElement("span");
        el.className = "cm-md-link";
        el.dataset.href = n.href;
        renderInline(n.c, el, env);
        parent.append(el);
        break;
      }
      case "tag": {
        const el = document.createElement("span");
        el.className = "cm-tag";
        el.dataset.tag = n.tag;
        el.textContent = "#" + n.tag;
        parent.append(el);
        break;
      }
    }
  }
}

/** A GFM table drawn as a real `<table>`; clicking the cell text puts the cursor in the source to edit it. */
export class TableWidget extends WidgetType {
  private readonly key: string;
  constructor(
    readonly model: TableModel,
    readonly env: EditorEnv,
  ) {
    super();
    this.key = JSON.stringify(model);
  }
  eq(other: TableWidget) {
    return other.key === this.key;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-table";
    const fill = (tr: HTMLElement, cells: Inline[][], tag: "th" | "td") => {
      cells.forEach((c, i) => {
        const cell = document.createElement(tag);
        const a = this.model.align[i];
        if (a) cell.style.textAlign = a;
        renderInline(c, cell, this.env);
        tr.append(cell);
      });
    };
    const head = table.createTHead().insertRow();
    fill(head, this.model.header, "th");
    const body = table.createTBody();
    for (const row of this.model.rows) fill(body.insertRow(), row, "td");
    wrap.append(table);
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !(e.target instanceof HTMLElement)) return;
      if (e.target.closest(".cm-wikilink, .cm-tag, .cm-md-link")) return; // handled by the link click handler
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) }, scrollIntoView: true });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}
