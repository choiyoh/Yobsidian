import { WidgetType, type EditorView } from "@codemirror/view";
import type { VaultAdapter } from "@/core/vault";
import { extname } from "@/core/vault";
import type { LinkTarget } from "./env";

/** Carry a link's target on the DOM so one delegated mousedown handler can open it. */
export function linkAttrs(link: LinkTarget): Record<string, string> {
  const attrs: Record<string, string> = { "data-target": link.target };
  if (link.heading) attrs["data-heading"] = link.heading;
  if (link.block) attrs["data-block"] = link.block;
  return attrs;
}

export function readLinkAttrs(el: HTMLElement): LinkTarget {
  return { target: el.dataset.target ?? "", heading: el.dataset.heading, block: el.dataset.block };
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};

export const isImagePath = (path: string) => extname(path) in IMAGE_TYPES;

export class WikilinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly link: LinkTarget,
    readonly unresolved: boolean,
  ) {
    super();
  }
  eq(other: WikilinkWidget) {
    return (
      other.label === this.label &&
      other.unresolved === this.unresolved &&
      other.link.target === this.link.target &&
      other.link.heading === this.link.heading &&
      other.link.block === this.link.block
    );
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-wikilink" + (this.unresolved ? " cm-wikilink-unresolved" : "");
    span.textContent = this.label;
    for (const [k, v] of Object.entries(linkAttrs(this.link))) span.setAttribute(k, v);
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly vault: VaultAdapter,
    /** Vault path, or `null` when `url` is used directly. */
    readonly path: string | null,
    readonly url: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.path === this.path && other.url === this.url && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-embed-image";
    img.alt = this.alt;
    if (this.path === null) {
      img.src = this.url;
    } else {
      const path = this.path;
      this.vault
        .readBinary(path)
        .then((bytes) => {
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: IMAGE_TYPES[extname(path)] }));
          img.dataset.blobUrl = url;
          img.src = url;
        })
        .catch(() => {
          img.replaceWith(document.createTextNode(`⚠ ${path}`));
        });
    }
    return img;
  }
  destroy(dom: HTMLElement) {
    if (dom instanceof HTMLImageElement && dom.dataset.blobUrl) URL.revokeObjectURL(dom.dataset.blobUrl);
  }
}

/** `![[Note]]` / `![[Note#Heading]]`: shows the embedded note's text under a clickable title. */
export class NoteEmbedWidget extends WidgetType {
  constructor(
    readonly vault: VaultAdapter,
    readonly path: string,
    readonly title: string,
    readonly link: LinkTarget,
  ) {
    super();
  }
  eq(other: NoteEmbedWidget) {
    return other.path === this.path && other.title === this.title && other.link.heading === this.link.heading;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-embed-note";
    const title = document.createElement("div");
    title.className = "cm-embed-title cm-wikilink";
    title.textContent = this.title;
    for (const [k, v] of Object.entries(linkAttrs(this.link))) title.setAttribute(k, v);
    const body = document.createElement("div");
    body.className = "cm-embed-body";
    box.append(title, body);
    this.vault
      .readText(this.path)
      .then((text) => {
        body.textContent = embedExcerpt(text, this.link.heading);
      })
      .catch(() => {
        body.textContent = "⚠";
      });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

/** The text an embed shows: the whole note minus front matter, or just one heading's section. */
export function embedExcerpt(text: string, heading?: string, maxChars = 1200): string {
  let body = text.replace(/^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");
  if (heading) {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((l) => {
      const m = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(l);
      return m !== null && m[2].trim().toLowerCase() === heading.toLowerCase();
    });
    if (start !== -1) {
      const level = /^ {0,3}(#{1,6})/.exec(lines[start])![1].length;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        const m = /^ {0,3}(#{1,6})[ \t]/.exec(lines[i]);
        if (m && m[1].length <= level) {
          end = i;
          break;
        }
      }
      body = lines.slice(start + 1, end).join("\n");
    }
  }
  body = body.trim();
  return body.length > maxChars ? body.slice(0, maxChars).trimEnd() + "…" : body;
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-checkbox";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      view.dispatch({ changes: { from: pos, to: pos + 3, insert: this.checked ? "[ ]" : "[x]" } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-list-bullet";
    span.textContent = "•";
    return span;
  }
}

export class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement("hr");
    hr.className = "cm-hr";
    return hr;
  }
}
