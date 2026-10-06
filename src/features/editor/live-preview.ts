import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { parseLinkInner, TAG_RE, WIKILINK_RE } from "@/core/index/parse";
import { basename, stem } from "@/core/vault";
import { editorEnv, editorMode } from "./env";
import {
  BulletWidget,
  CheckboxWidget,
  ImageWidget,
  NoteEmbedWidget,
  RuleWidget,
  WikilinkWidget,
  isImagePath,
  linkAttrs,
  readLinkAttrs,
} from "./widgets";

/** Dispatch to force decorations to be rebuilt, e.g. after the note index changed what links resolve to. */
export const refreshPreview = StateEffect.define<null>();

const hide = Decoration.replace({});
const mark = (cls: string, attrs?: Record<string, string>) => Decoration.mark({ class: cls, attributes: attrs });
const line = (cls: string) => Decoration.line({ class: cls });

const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "HTMLTag", "CommentBlock", "URL"]);

/**
 * Obsidian-style "live preview": Markdown is rendered in place (headings sized,
 * emphasis styled, link syntax and markers hidden, images and embeds shown) and
 * the raw syntax reappears wherever the cursor is. `source` mode keeps the raw
 * text with only light styling; `reading` is live preview that never reveals
 * markers (the editor is made read-only by the caller).
 */
export function buildDecorations(state: EditorState): DecorationSet {
  const env = state.facet(editorEnv);
  const mode = state.facet(editorMode);
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state);

  const live = mode !== "source";
  const sel = mode === "live" ? state.selection.ranges : [];
  const activeLines = new Set<number>();
  for (const r of sel) for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) activeLines.add(n);
  const touches = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  const lineActive = (pos: number) => activeLines.has(doc.lineAt(pos).number);
  const lineEnd = (pos: number) => doc.lineAt(pos).to;

  const tree_: Range<Decoration>[] = []; // decorations from the syntax tree
  const skip: { from: number; to: number }[] = []; // ranges where `[[links]]` and `#tags` are literal text

  const eachLine = (from: number, to: number, fn: (lineFrom: number, index: number, count: number) => void) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) fn(doc.line(n).from, n - first, last - first + 1);
  };

  tree.iterate({
    enter(node) {
      const { name, from, to } = node;
      if (CODE_NODES.has(name)) skip.push({ from, to });

      let m: RegExpExecArray | null;
      if (name === "Frontmatter") {
        skip.push({ from, to });
        eachLine(from, to, (pos, i, count) =>
          tree_.push(line("cm-frontmatter" + (i === 0 ? " cm-frontmatter-first" : "") + (i === count - 1 ? " cm-frontmatter-last" : "")).range(pos)),
        );
        return false;
      }
      if (live && (m = /^ATXHeading([1-6])$/.exec(name))) {
        tree_.push(line(`cm-heading cm-h${m[1]}`).range(doc.lineAt(from).from));
        return;
      }
      if (live && (m = /^SetextHeading([12])$/.exec(name))) {
        tree_.push(line(`cm-heading cm-h${m[1]}`).range(doc.lineAt(from).from));
        return;
      }
      if (!live) return;

      const parent = node.node.parent;
      switch (name) {
        case "HeaderMark":
          if (parent?.name.startsWith("ATXHeading") && !lineActive(from)) {
            const closing = from > parent.from + 6;
            tree_.push(hide.range(from, closing ? to : Math.min(to + 1, lineEnd(from))));
          }
          break;
        case "StrongEmphasis":
          tree_.push(mark("cm-strong").range(from, to));
          break;
        case "Emphasis":
          tree_.push(mark("cm-em").range(from, to));
          break;
        case "Strikethrough":
          tree_.push(mark("cm-strike").range(from, to));
          break;
        case "InlineCode":
          tree_.push(mark("cm-inline-code").range(from, to));
          break;
        case "EmphasisMark":
        case "StrikethroughMark":
          if (parent && !touches(parent.from, parent.to)) tree_.push(hide.range(from, to));
          break;
        case "CodeMark":
          if (parent?.name === "InlineCode" && !touches(parent.from, parent.to)) tree_.push(hide.range(from, to));
          break;
        case "Link": {
          const url = node.node.getChild("URL");
          const marks = node.node.getChildren("LinkMark");
          if (!url || marks.length < 2) break; // `[text]` without a target is plain text (wikilinks are handled below)
          const href = doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
          tree_.push(mark("cm-md-link", { "data-href": href }).range(marks[0].to, marks[1].from));
          if (!touches(from, to)) {
            tree_.push(hide.range(from, marks[0].to));
            tree_.push(hide.range(marks[1].from, to));
          }
          break;
        }
        case "URL":
          if (parent?.name !== "Link" && parent?.name !== "Image") {
            tree_.push(mark("cm-md-link", { "data-href": doc.sliceString(from, to) }).range(from, to));
          }
          break;
        case "Image": {
          const url = node.node.getChild("URL");
          const marks = node.node.getChildren("LinkMark");
          if (!url || marks.length < 2 || touches(from, to)) break;
          const src = doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
          const alt = doc.sliceString(marks[0].to, marks[1].from);
          let widget: ImageWidget;
          if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
            widget = new ImageWidget(env.vault, null, src, alt);
          } else {
            const path = env.index.resolve(safeDecode(src), env.path);
            widget = path ? new ImageWidget(env.vault, path, src, alt) : new ImageWidget(env.vault, null, "", alt);
          }
          tree_.push(Decoration.replace({ widget }).range(from, to));
          return false;
        }
        case "Blockquote":
          eachLine(from, to, (pos) => tree_.push(line("cm-quote").range(pos)));
          break;
        case "QuoteMark":
          if (!lineActive(from)) tree_.push(hide.range(from, doc.sliceString(to, to + 1) === " " ? to + 1 : to));
          break;
        case "ListMark":
          if (parent?.parent?.name === "BulletList" && !lineActive(from)) {
            if (parent.getChild("Task")) tree_.push(hide.range(from, Math.min(to + 1, lineEnd(from))));
            else tree_.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
          }
          break;
        case "TaskMarker": {
          const checked = /\[[xX]\]/.test(doc.sliceString(from, to));
          if (checked && to < lineEnd(from)) tree_.push(mark("cm-task-done").range(to, lineEnd(from)));
          if (!touches(from, to)) tree_.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(from, to));
          break;
        }
        case "HorizontalRule":
          if (!lineActive(from)) tree_.push(Decoration.replace({ widget: new RuleWidget() }).range(from, to));
          break;
        case "FencedCode":
        case "CodeBlock":
          eachLine(from, to, (pos, i, count) =>
            tree_.push(line("cm-codeblock" + (i === 0 ? " cm-codeblock-first" : "") + (i === count - 1 ? " cm-codeblock-last" : "")).range(pos)),
          );
          break;
        case "Table":
          eachLine(from, to, (pos) => tree_.push(line("cm-table-line").range(pos)));
          break;
      }
    },
  });

  const inSkip = (pos: number) => skip.some((r) => pos >= r.from && pos < r.to);

  // Wikilinks and tags are not part of CommonMark, so find them in the text.
  const text = doc.toString();
  const special: Range<Decoration>[] = [];
  const wikiRanges: { from: number; to: number }[] = [];

  for (const m of text.matchAll(WIKILINK_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (inSkip(from)) continue;
    wikiRanges.push({ from, to });
    const embed = m[1] === "!";
    const inner = parseLinkInner(m[2]);
    const link = { target: inner.target, heading: inner.heading, block: inner.block };
    const resolved = env.index.resolve(inner.target, env.path);
    const unresolved = resolved === null;
    const label = inner.alias ?? (inner.target ? inner.target + (inner.heading ? " > " + inner.heading : "") : (inner.heading ?? ""));

    if (live && !touches(from, to)) {
      if (embed && resolved && isImagePath(resolved)) {
        special.push(Decoration.replace({ widget: new ImageWidget(env.vault, resolved, resolved, inner.alias ?? "") }).range(from, to));
      } else if (embed && resolved && resolved.endsWith(".md")) {
        const title = stem(resolved) + (inner.heading ? " > " + inner.heading : "");
        special.push(Decoration.replace({ widget: new NoteEmbedWidget(env.vault, resolved, title, link) }).range(from, to));
      } else {
        special.push(Decoration.replace({ widget: new WikilinkWidget((embed ? "! " : "") + (label || basename(inner.target)), link, unresolved) }).range(from, to));
      }
    } else {
      const cls = "cm-wikilink" + (unresolved ? " cm-wikilink-unresolved" : "") + (live ? " cm-wikilink-raw" : "");
      special.push(mark(cls, linkAttrs(link)).range(from, to));
    }
  }

  for (const m of text.matchAll(TAG_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (/^[\d/_-]+$/.test(m[1]) || inSkip(from) || wikiRanges.some((r) => from >= r.from && from < r.to)) continue;
    special.push(mark("cm-tag", { "data-tag": m[1].replace(/\/+$/, "") }).range(from, to));
  }

  // Drop tree decorations that would collide with a rendered wikilink.
  const kept = tree_.filter((d) => {
    const isLine = d.from === d.to;
    return isLine || !wikiRanges.some((r) => d.from < r.to && d.to > r.from);
  });
  return Decoration.set([...kept, ...special], true);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const previewField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.reconfigured ||
      tr.effects.some((e) => e.is(refreshPreview)) ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return buildDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Clicking a rendered link, tag or URL opens it (live/reading), or Ctrl/Cmd-click in source mode. */
const clickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.target instanceof HTMLElement)) return false;
    const mode = view.state.facet(editorMode);
    const env = view.state.facet(editorEnv);
    const modifier = event.ctrlKey || event.metaKey;
    if (mode === "source" && !modifier) return false;

    const wiki = event.target.closest<HTMLElement>(".cm-wikilink");
    const tag = event.target.closest<HTMLElement>(".cm-tag");
    const href = event.target.closest<HTMLElement>(".cm-md-link");
    if (wiki) env.openLink(readLinkAttrs(wiki));
    else if (tag?.dataset.tag) env.openTag(tag.dataset.tag);
    else if (href?.dataset.href) openHref(env, href.dataset.href);
    else return false;
    event.preventDefault();
    return true;
  },
});

function openHref(env: { openLink: (l: { target: string; heading?: string }) => void; openUrl: (u: string) => void }, href: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) env.openUrl(href);
  else if (href.startsWith("#")) env.openLink({ target: "", heading: safeDecode(href.slice(1)) });
  else {
    const [path, frag] = safeDecode(href).split("#");
    env.openLink({ target: path, heading: frag || undefined });
  }
}

export const livePreview: Extension = [previewField, clickHandler];
