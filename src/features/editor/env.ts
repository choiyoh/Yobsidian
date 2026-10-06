import { Facet } from "@codemirror/state";
import type { NoteIndex } from "@/core/index";
import type { VaultAdapter } from "@/core/vault";

export type EditorMode = "live" | "source" | "reading";

export interface LinkTarget {
  /** Text before `#`/`|` in the link; empty for same-note links. */
  target: string;
  heading?: string;
  block?: string;
}

/** Everything the editor extensions need to know about the app around them. */
export interface EditorEnv {
  index: NoteIndex;
  vault: VaultAdapter;
  /** Path of the note being edited (links resolve relative to it). */
  path: string;
  openLink(link: LinkTarget): void;
  openUrl(url: string): void;
  openTag(tag: string): void;
}

export const editorEnv = Facet.define<EditorEnv, EditorEnv>({
  combine: (values) => values[0],
});

export const editorMode = Facet.define<EditorMode, EditorMode>({
  combine: (values) => values[0] ?? "live",
});
