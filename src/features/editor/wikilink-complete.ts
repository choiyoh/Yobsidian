import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { editorEnv } from "./env";

/**
 * Autocomplete inside `[[`: note names and aliases, or headings once a `#` is typed
 * (`[[Note#`). Accepting a suggestion closes the link with `]]`.
 */
export function wikilinkCompletion(ctx: CompletionContext): CompletionResult | null {
  const env = ctx.state.facet(editorEnv);
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const open = before.lastIndexOf("[[");
  if (open === -1) return null;

  const inner = before.slice(open + 2);
  if (inner.includes("]") || inner.includes("|")) return null;

  const from = line.from + open + 2;
  const closes = line.text.startsWith("]]", ctx.pos - line.from);
  const finish = (text: string) => (view: import("@codemirror/view").EditorView, _c: Completion, _from: number, to: number) => {
    const end = closes ? to + 2 : to;
    view.dispatch({
      changes: { from: _from, to: end, insert: text + "]]" },
      selection: { anchor: _from + text.length + 2 },
      userEvent: "input.complete",
    });
  };

  const hash = inner.indexOf("#");
  if (hash === -1) {
    const options: Completion[] = env.index.search(inner, 30).map((r) => {
      const linkText = env.index.linkTextFor(r.path);
      return {
        label: r.alias ?? r.name,
        detail: r.alias ? `→ ${r.name}` : r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : undefined,
        type: "text",
        apply: finish(r.alias ? `${linkText}|${r.alias}` : linkText),
      };
    });
    return { from, options, filter: false };
  }

  // `[[Note#` -> headings of Note (or of this note for `[[#`).
  const targetName = inner.slice(0, hash);
  const target = env.index.resolve(targetName, env.path);
  if (!target) return null;
  const query = inner.slice(hash + 1).toLowerCase();
  const prefix = targetName ? env.index.linkTextFor(target) : "";
  const options: Completion[] = env.index
    .headingsOf(target)
    .filter((h) => h.text.toLowerCase().includes(query))
    .map((h) => ({
      label: h.text,
      detail: "#".repeat(h.level),
      type: "keyword",
      apply: finish(`${prefix}#${h.text}`),
    }));
  return { from, options, filter: false };
}
