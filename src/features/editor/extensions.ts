import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightSpecialChars, keymap } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { GFM } from "@lezer/markdown";
import { editorEnv, editorMode, type EditorEnv, type EditorMode } from "./env";
import { frontmatterExtension } from "./frontmatter";
import { livePreview } from "./live-preview";
import { editorTheme } from "./theme";
import { wikilinkCompletion } from "./wikilink-complete";

/** Wrap the selection in `mark` (or unwrap it if already wrapped): the Cmd/Ctrl+B / I behaviour. */
export function toggleWrap(mark: string) {
  return (view: EditorView): boolean => {
    const changes = view.state.changeByRange((range) => {
      const { from, to } = range;
      const doc = view.state.doc;
      const wrapped =
        from >= mark.length &&
        doc.sliceString(from - mark.length, from) === mark &&
        doc.sliceString(to, to + mark.length) === mark;
      if (wrapped) {
        return {
          changes: [
            { from: from - mark.length, to: from },
            { from: to, to: to + mark.length },
          ],
          range: range.extend(from - mark.length, to - mark.length),
        };
      }
      return {
        changes: [
          { from, insert: mark },
          { from: to, insert: mark },
        ],
        range: range.empty ? range.extend(from + mark.length) : range.extend(from + mark.length, to + mark.length),
      };
    });
    view.dispatch(view.state.update(changes, { userEvent: "input" }));
    return true;
  };
}

export const modeCompartment = new Compartment();

function modeExtensions(mode: EditorMode): Extension {
  return [editorMode.of(mode), EditorState.readOnly.of(mode === "reading"), EditorView.editable.of(mode !== "reading")];
}

export function createExtensions(env: EditorEnv, mode: EditorMode, onSave: () => void): Extension {
  return [
    editorEnv.of(env),
    modeCompartment.of(modeExtensions(mode)),
    history(),
    drawSelection(),
    highlightSpecialChars(),
    indentOnInput(),
    closeBrackets(),
    autocompletion({ override: [wikilinkCompletion], icons: false }),
    markdown({ base: markdownLanguage, extensions: [GFM, frontmatterExtension], codeLanguages: languages }),
    syntaxHighlighting(classHighlighter),
    livePreview,
    EditorView.lineWrapping,
    editorTheme,
    keymap.of([
      { key: "Mod-s", run: () => (onSave(), true), preventDefault: true },
      { key: "Mod-b", run: toggleWrap("**") },
      { key: "Mod-i", run: toggleWrap("*") },
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...historyKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
  ];
}

export function reconfigureMode(view: EditorView, mode: EditorMode) {
  view.dispatch({ effects: modeCompartment.reconfigure(modeExtensions(mode)) });
}
