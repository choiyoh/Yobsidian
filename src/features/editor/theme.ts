import { EditorView } from "@codemirror/view";

/** Layout-level editor theme. Colors come from the app's CSS variables so light/dark follow the system. */
export const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size, 16px)", color: "var(--text)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-text)", lineHeight: "1.7", overflow: "auto" },
  ".cm-content": { maxWidth: "760px", margin: "0 auto", padding: "8px 40px 40vh", caretColor: "var(--accent)" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--selection) !important",
  },
  ".cm-line": { padding: "0 2px" },
  ".cm-tooltip": {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
    color: "var(--text)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-ui)", maxHeight: "260px" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--accent-soft)", color: "var(--text)" },
  ".cm-completionDetail": { color: "var(--text-muted)", fontStyle: "normal", marginLeft: "0.8em" },
});
